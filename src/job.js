/**
 * The async job pipeline behind POST /solve:
 *
 *   queued → cloning → solving → pushing → opening-pr → awaiting-merge
 *          → claiming → done | failed:<step>
 *
 * The protocol-critical steps use @jumboo/agent-sdk:
 *   - buildMarker: sign the taskId + build the PR marker block
 *   - claim:       poll the oracle for the attestation, then submit it on-chain
 *
 * DRY_RUN=1 stops after the push: the PR is not opened, the marker block is
 * logged instead, and attestation polling/claiming is skipped.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";
import { buildMarker, claim, OUTCOME_NAME } from "@jumboo/agent-sdk";
import { config } from "./config.js";
import { provider } from "./chain.js";
import { getSolver } from "./solver.js";
import {
  parseRepoUrl,
  authenticatedCloneUrl,
  getIssue,
  getDefaultBranch,
  createFork,
  createPullRequest,
} from "./github.js";

const jobs = new Map();

/** Run a child process, resolving stdout or rejecting with combined output. */
function run(cmd, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => reject(new Error(`${cmd} failed to start: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args[0]} exited ${code}: ${(err || out).trim().slice(0, 2000)}`));
      } else {
        resolve(out);
      }
    });
  });
}

const git = (args, opts) => run("git", args, opts);

function setStatus(job, status, detail) {
  job.status = status;
  job.steps.push({ status, at: new Date().toISOString(), ...(detail ? { detail } : {}) });
  console.log(`[job ${job.id}] ${status}${detail ? ` — ${detail}` : ""}`);
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function jobCount() {
  return jobs.size;
}

/** A job is terminal once it has finished (done) or failed. */
function isTerminal(job) {
  return job.status === "done" || String(job.status).startsWith("failed");
}

/**
 * The still-running job for a (task, agent) pair of a given kind, if any.
 * Used to dedupe: a second /solve while one is in flight would spawn a duplicate
 * solver run and a duplicate PR; a second /revise while one is running would
 * push twice. A solve that reached "awaiting-merge" still counts as in-flight
 * (its PR exists) so re-solving is blocked — but a revise is a DIFFERENT kind,
 * so it's allowed to run against that open PR.
 */
export function findActiveJob(taskId, agentId, kind = "solve") {
  for (const job of jobs.values()) {
    if (
      job.kind === kind &&
      job.taskId === taskId &&
      Number(job.agentId) === Number(agentId) &&
      !isTerminal(job)
    ) {
      return job;
    }
  }
  return null;
}

/** Public JSON view of a job (no secrets are ever stored on the job object). */
export function jobView(job) {
  return {
    jobId: job.id,
    kind: job.kind ?? "solve",
    taskId: job.taskId,
    agentId: job.agentId ?? null,
    path: job.path,
    caller: job.caller,
    solver: job.solver,
    status: job.status,
    steps: job.steps,
    branch: job.branch ?? null,
    prUrl: job.prUrl ?? null,
    markerBlock: job.markerBlock ?? null,
    outcome: job.outcome ?? null,
    claimTx: job.claimTx ?? null,
    dryRun: job.dryRun ?? false,
    error: job.error ?? null,
    createdAt: job.createdAt,
  };
}

/** Registers a queued job and kicks off the async pipeline. */
export function startJob({ taskId, agentId, task, caller, path: accessPath, hotWallet }) {
  // Dedupe: never run two solves for the same (task, agent) at once — that would
  // produce two solver runs and two PRs. Return the one already in flight.
  const inFlight = findActiveJob(taskId, agentId, "solve");
  if (inFlight) return inFlight;

  const job = {
    id: randomBytes(8).toString("hex"),
    kind: "solve",
    taskId,
    agentId,
    hotWallet, // the agent's derived hot wallet (never serialized in jobView)
    task,
    caller,
    path: accessPath, // "compete" | "hire"
    solver: config.solver,
    status: "queued",
    steps: [],
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  setStatus(job, "queued", `${accessPath} path, caller ${caller}`);
  setImmediate(() =>
    runJob(job).catch((err) => {
      job.error = job.error || err.message;
      if (!job.status.startsWith("failed")) job.status = "failed:unknown";
      console.error(`[job ${job.id}] pipeline crashed: ${err.message}`);
    })
  );
  return job;
}

async function runJob(job) {
  const { task, taskId, agentId, hotWallet } = job;
  const parsed = parseRepoUrl(task.repoUrl);
  const repoDir = path.join(config.workdir, job.id);
  const branch = `jumboo/task-${taskId.slice(2, 10)}`;
  job.branch = branch;
  let step = "cloning";

  try {
    // 1+2. Clone the task repo and create the working branch --------------
    setStatus(job, "cloning", `${task.repoUrl} → ${repoDir}`);
    await mkdir(config.workdir, { recursive: true });
    await git(["clone", authenticatedCloneUrl(parsed), repoDir]);
    await git(["checkout", "-b", branch], { cwd: repoDir });

    // 3. Solve -------------------------------------------------------------
    step = "solving";
    const issue = await resolveIssue(parsed, task.issueId);
    setStatus(job, "solving", `driver=${config.solver}, issue=${issue.ref}`);
    const solver = getSolver();
    const { summary } = await solver.solve({ repoDir, task, issue });
    job.summary = summary;

    // 4. Commit as the machine user, push (fork fallback) -------------------
    step = "pushing";
    setStatus(job, "pushing", branch);
    await git(["add", "-A"], { cwd: repoDir });
    const changed = await git(["status", "--porcelain"], { cwd: repoDir });
    if (!changed.trim()) {
      throw new Error("solver produced no changes — nothing to commit");
    }
    const user = config.githubUsername;
    await git(
      [
        "-c", `user.name=${user}`,
        "-c", `user.email=${user}@users.noreply.github.com`,
        "commit", "-m", `Jumboo task ${taskId.slice(0, 10)}… (agent #${agentId})`,
      ],
      { cwd: repoDir }
    );

    let prHead = branch;
    try {
      await git(["push", "-u", "origin", branch], { cwd: repoDir });
    } catch (pushErr) {
      // No write access to origin → fork-and-push (GitHub repos only).
      if (!parsed.isGitHub || !config.githubToken) throw pushErr;
      setStatus(job, "pushing", `origin push rejected, forking as ${user}`);
      const fork = await createFork(parsed.owner, parsed.repo);
      const forkUrl = `https://x-access-token:${config.githubToken}@github.com/${fork.owner}/${fork.repo}.git`;
      await git(["remote", "add", "fork", forkUrl], { cwd: repoDir });
      await git(["push", "-u", "fork", branch], { cwd: repoDir });
      prHead = `${fork.owner}:${branch}`;
    }

    // 5. Build the marker block (SDK signs the RAW taskId bytes for us) ------
    const { marker } = await buildMarker({ taskId, agentId, hotWallet });
    job.markerBlock = marker;

    // 6. Open the PR (or log the markers in DRY_RUN) -------------------------
    if (config.dryRun) {
      job.dryRun = true;
      console.log(`[job ${job.id}] DRY_RUN — skipping PR creation. Branch: ${prHead}`);
      console.log(`[job ${job.id}] PR marker block:\n${marker}`);
      setStatus(job, "done", `dry run: branch ${prHead} pushed, PR skipped`);
      return;
    }

    step = "opening-pr";
    setStatus(job, "opening-pr", `head=${prHead}`);
    if (!parsed.isGitHub) {
      throw new Error("cannot open a PR on a non-GitHub repo (use DRY_RUN=1 for local remotes)");
    }
    const base = await getDefaultBranch(parsed.owner, parsed.repo);
    // Link the PR to the task's issue so merging it closes the issue — the
    // oracle verifies the merged PR actually resolves task.issueId before
    // attesting, so the marker block alone is not enough.
    const issueNum = String(task.issueId ?? "").match(/\d+/)?.[0];
    const closingLine = issueNum ? `\n\nCloses #${issueNum}` : "";
    const pr = await createPullRequest(parsed.owner, parsed.repo, {
      title: `Jumboo task ${taskId.slice(0, 10)}… (agent #${agentId})`,
      head: prHead,
      base,
      body: `${(job.summary || "").trim()}${closingLine}\n\n---\n${marker}`,
    });
    job.prUrl = pr.url;
    console.log(`[job ${job.id}] PR opened: ${pr.url}`);

    // 7. Wait for the oracle's attestation, then claim on-chain (SDK) --------
    step = "awaiting-merge";
    setStatus(job, "awaiting-merge", `polling ${config.oracleUrl} every ${config.attestationPollSec}s`);
    // Gas payer: a shared funded wallet if AGENT_TX_KEY is set, else this agent's
    // own derived hot wallet (which then needs a little ETH).
    const txWallet = config.agentTxKey
      ? new ethers.Wallet(config.agentTxKey, provider)
      : hotWallet.connect(provider);
    const { attestation, receipt } = await claim({
      oracleUrl: config.oracleUrl,
      registryAddress: config.validationRegistryAddress,
      taskId,
      agentId,
      wallet: txWallet,
      intervalMs: config.attestationPollSec * 1000,
      onPoll: ({ error }) => {
        if (error) console.warn(`[job ${job.id}] poll: ${error.message}`);
      },
    });
    job.outcome = OUTCOME_NAME[Number(attestation.outcome)] ?? String(attestation.outcome);

    step = "claiming";
    setStatus(job, "claiming", `outcome=${job.outcome}`);
    job.claimTx = receipt.hash;
    setStatus(job, "done", `outcome=${job.outcome}, tx=${receipt.hash}`);
  } catch (err) {
    job.error = err.message;
    setStatus(job, `failed:${step}`, err.message);
  }
}

/**
 * Registers a queued REVISE job and kicks off its pipeline. Triggered by the
 * oracle when a task creator requests changes on the agent's PR (review → revise
 * loop). Reuses the SAME PR branch, so the update lands as a PR synchronize — no
 * new PR. Deduped against a revise already running for the pair.
 */
export function startReviseJob({ taskId, agentId, task, hotWallet, revise }) {
  const inFlight = findActiveJob(taskId, agentId, "revise");
  if (inFlight) return inFlight;

  const job = {
    id: randomBytes(8).toString("hex"),
    kind: "revise",
    taskId,
    agentId,
    hotWallet,
    task,
    path: "revise",
    solver: config.solver,
    status: "queued",
    steps: [],
    revise, // { prNumber, branch, headRepoFullName, feedback }
    createdAt: new Date().toISOString(),
  };
  jobs.set(job.id, job);
  setStatus(job, "queued", `revise PR #${revise.prNumber} on ${revise.headRepoFullName}@${revise.branch}`);
  setImmediate(() =>
    runReviseJob(job).catch((err) => {
      job.error = job.error || err.message;
      if (!job.status.startsWith("failed")) job.status = "failed:unknown";
      console.error(`[job ${job.id}] revise pipeline crashed: ${err.message}`);
    })
  );
  return job;
}

async function runReviseJob(job) {
  const { task, taskId, agentId, revise } = job;
  const { prNumber, branch, headRepoFullName, feedback } = revise;
  const repoDir = path.join(config.workdir, job.id);
  let step = "cloning";

  try {
    if (!branch || !headRepoFullName) {
      throw new Error("revise trigger missing branch/headRepoFullName");
    }
    const [hOwner, hRepo] = headRepoFullName.split("/");

    // 1. Clone the PR's head repo at its branch (a fork when the agent had no
    //    push access to origin) — pushing back updates the same PR.
    setStatus(job, "cloning", `${headRepoFullName}@${branch} → ${repoDir}`);
    await mkdir(config.workdir, { recursive: true });
    const cloneUrl = config.githubToken
      ? `https://x-access-token:${config.githubToken}@github.com/${hOwner}/${hRepo}.git`
      : `https://github.com/${hOwner}/${hRepo}.git`;
    await git(["clone", "--branch", branch, cloneUrl, repoDir]);

    // 2. Re-solve with the review feedback folded into the prompt.
    step = "solving";
    const parsed = parseRepoUrl(task.repoUrl);
    const issue = await resolveIssue(parsed, task.issueId);
    issue.reviewFeedback = feedback || "";
    setStatus(job, "solving", `driver=${config.solver}, addressing review on PR #${prNumber}`);
    const solver = getSolver();
    const { summary } = await solver.solve({ repoDir, task, issue });
    job.summary = summary;

    // 3. Commit + push to the SAME branch → PR synchronize.
    step = "pushing";
    await git(["add", "-A"], { cwd: repoDir });
    const changed = await git(["status", "--porcelain"], { cwd: repoDir });
    if (!changed.trim()) {
      setStatus(job, "done", "revision produced no changes — nothing to push");
      return;
    }
    if (config.dryRun) {
      job.dryRun = true;
      setStatus(job, "done", `dry run: revision computed for PR #${prNumber}, push skipped`);
      return;
    }
    const user = config.githubUsername;
    await git(
      [
        "-c", `user.name=${user}`,
        "-c", `user.email=${user}@users.noreply.github.com`,
        "commit", "-m", `Address review feedback — Jumboo task ${taskId.slice(0, 10)}… (agent #${agentId})`,
      ],
      { cwd: repoDir }
    );
    step = "pushing";
    setStatus(job, "pushing", `${headRepoFullName}@${branch}`);
    await git(["push", "origin", branch], { cwd: repoDir });
    setStatus(job, "done", `revised PR #${prNumber} — pushed to ${headRepoFullName}@${branch}`);
  } catch (err) {
    job.error = err.message;
    setStatus(job, `failed:${step}`, err.message);
  }
}

/** Best-effort issue content for the solver prompt. */
async function resolveIssue(parsed, issueId) {
  const fallback = { title: "", body: "", ref: String(issueId) };
  if (!parsed.isGitHub || !config.githubToken) return fallback;
  const match = String(issueId).match(/\d+/);
  if (!match) return fallback;
  const issue = await getIssue(parsed.owner, parsed.repo, Number(match[0]));
  if (!issue) return fallback;
  return { ...issue, ref: `#${issue.number} ${issue.title}`.trim() };
}
