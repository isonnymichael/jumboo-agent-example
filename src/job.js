/**
 * The async job pipeline behind POST /solve:
 *
 *   queued → cloning → solving → pushing → opening-pr → awaiting-merge
 *          → claiming → done | failed:<step>
 *
 * DRY_RUN=1 stops after the push: the PR is not opened, the marker block is
 * logged instead, and attestation polling/claiming is skipped.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { ethers } from "ethers";
import { config } from "./config.js";
import { hotWallet, submitValidation } from "./chain.js";
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// git wrapper that never leaks the token into job logs
const git = (args, opts) => run("git", args, opts);

function markerBlock(taskId, agentId, signature) {
  return `Jumboo-Task: ${taskId}\nJumboo-Agent: ${agentId}\nJumboo-Signature: ${signature}`;
}

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

/** Public JSON view of a job (no secrets are ever stored on the job object). */
export function jobView(job) {
  return {
    jobId: job.id,
    taskId: job.taskId,
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
export function startJob({ taskId, task, caller, path: accessPath }) {
  const job = {
    id: randomBytes(8).toString("hex"),
    taskId,
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
      // Last-resort guard; runJob marks failed:<step> itself.
      job.error = job.error || err.message;
      if (!job.status.startsWith("failed")) job.status = "failed:unknown";
      console.error(`[job ${job.id}] pipeline crashed: ${err.message}`);
    })
  );
  return job;
}

async function runJob(job) {
  const { task, taskId } = job;
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
        "commit", "-m", `Jumboo task ${taskId.slice(0, 10)}… (agent #${config.agentId})`,
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

    // 5. Sign the taskId with the hot wallet — EXACTLY what the oracle
    //    recovers: ethers.verifyMessage(ethers.getBytes(taskId), signature)
    const signature = await hotWallet.signMessage(ethers.getBytes(taskId));
    const markers = markerBlock(taskId, config.agentId, signature);
    job.markerBlock = markers;

    // 6. Open the PR (or log the markers in DRY_RUN) -------------------------
    if (config.dryRun) {
      job.dryRun = true;
      console.log(`[job ${job.id}] DRY_RUN — skipping PR creation. Branch: ${prHead}`);
      console.log(`[job ${job.id}] PR marker block:\n${markers}`);
      setStatus(job, "done", `dry run: branch ${prHead} pushed, PR skipped`);
      return;
    }

    step = "opening-pr";
    setStatus(job, "opening-pr", `head=${prHead}`);
    if (!parsed.isGitHub) {
      throw new Error("cannot open a PR on a non-GitHub repo (use DRY_RUN=1 for local remotes)");
    }
    const base = await getDefaultBranch(parsed.owner, parsed.repo);
    const pr = await createPullRequest(parsed.owner, parsed.repo, {
      title: `Jumboo task ${taskId.slice(0, 10)}… (agent #${config.agentId})`,
      head: prHead,
      base,
      body: `${(job.summary || "").trim()}\n\n---\n${markers}`,
    });
    job.prUrl = pr.url;
    console.log(`[job ${job.id}] PR opened: ${pr.url}`);

    // 7. Poll the oracle for an attestation, then claim on-chain ------------
    step = "awaiting-merge";
    setStatus(job, "awaiting-merge", `polling ${config.oracleUrl} every ${config.attestationPollSec}s`);
    const attestation = await pollAttestation(taskId);
    job.outcome = attestation.outcomeName;

    // Submit whatever outcome the oracle attested — Merged releases the
    // escrow; Superseded/Rejected are submitted too so the on-chain
    // attempt/reputation counters stay honest.
    step = "claiming";
    setStatus(job, "claiming", `outcome=${attestation.outcomeName}`);
    const receipt = await submitValidation({
      taskId,
      agentId: attestation.agentId,
      outcome: Number(attestation.outcome),
      signature: attestation.signature,
    });
    job.claimTx = receipt.hash;
    setStatus(job, "done", `outcome=${attestation.outcomeName}, tx=${receipt.hash}`);
  } catch (err) {
    job.error = err.message;
    setStatus(job, `failed:${step}`, err.message);
  }
}

/**
 * Best-effort issue content for the solver prompt: when the repo is on GitHub,
 * a token is set, and issueId contains an integer, fetch title/body from the
 * API; otherwise fall back to the raw on-chain issueId string.
 */
async function resolveIssue(parsed, issueId) {
  const fallback = { title: "", body: "", ref: String(issueId) };
  if (!parsed.isGitHub || !config.githubToken) return fallback;
  const match = String(issueId).match(/\d+/);
  if (!match) return fallback;
  const issue = await getIssue(parsed.owner, parsed.repo, Number(match[0]));
  if (!issue) return fallback;
  return { ...issue, ref: `#${issue.number} ${issue.title}`.trim() };
}

/** Polls GET {ORACLE_URL}/attestations/{taskId}/{AGENT_ID} until one exists. */
async function pollAttestation(taskId) {
  const url = `${config.oracleUrl}/attestations/${taskId}/${config.agentId}`;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status !== 404) console.warn(`[poll] oracle responded ${res.status} for ${url}`);
    } catch (err) {
      console.warn(`[poll] oracle unreachable: ${err.message}`);
    }
    await sleep(config.attestationPollSec * 1000);
  }
}
