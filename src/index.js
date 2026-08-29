/**
 * jumboo-agent-example — a Jumboo agent backend.
 *
 * Receives POST /solve { taskId, agentId }, enforces the Compete/Hire (x402)
 * access policy, derives the agent's hot wallet from this backend's master
 * mnemonic, then runs the pipeline: clone repo → solve issue → open PR with the
 * Jumboo marker → poll the oracle → auto-claim the escrow (via @jumboo/agent-sdk).
 *
 * One backend serves every agent registered from its master — the frontend says
 * which agentId to compete as; nothing to configure per agent.
 */
import express from "express";
import { ethers } from "ethers";
import { config } from "./config.js";
import { getTask, TaskState, getAgentWithSigner, masterFingerprint, signFeedbackAuth } from "./chain.js";
import { verifyCaller, authorizeSolve } from "./auth.js";
import { buildHireRequirements, verifyAndSettleHire } from "./x402.js";
import { startJob, startReviseJob, findActiveJob, getJob, jobView, jobCount } from "./job.js";

const app = express();

// CORS: the Jumboo frontend calls /health (register flow) and /solve
// (Compete/Hire) cross-origin from the browser. These are public endpoints —
// the real authorization is the wallet signature + x402 payment, not the
// origin — so allow any origin and answer the preflight for the custom headers.
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Jumboo-Address, X-Jumboo-Signature, X-PAYMENT");
  res.set("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    mode: "master",
    master: masterFingerprint, // address of derivation index 0 (identifies the master)
    solver: config.solver,
    dryRun: config.dryRun,
    // Authoritative x402 hire price (from HIRE_PRICE_* env). The frontend reads
    // this so the registry advises exactly what the 402 handshake will charge —
    // one source of truth, no drift between UI and backend.
    hirePrice: config.hirePrice,
    x402Settlement: config.x402Settlement,
    jobs: jobCount(),
  });
});

app.post("/solve", async (req, res) => {
  try {
    // -- Request shape ------------------------------------------------------
    const taskId = req.body?.taskId;
    if (!/^0x[0-9a-fA-F]{64}$/.test(taskId || "")) {
      return res.status(400).json({ error: "body must include taskId: '0x<64 hex>'" });
    }
    const agentId = req.body?.agentId;
    if (!/^\d+$/.test(String(agentId ?? ""))) {
      return res.status(400).json({ error: "body must include agentId (the agent to compete as)" });
    }

    // -- Caller authentication (EIP-191 over `jumboo-solve:<taskId>`) --------
    const caller = verifyCaller(req, taskId);
    if (!caller) {
      return res.status(401).json({
        error:
          "invalid caller auth: send X-Jumboo-Address and X-Jumboo-Signature " +
          `(personal_sign of the string "jumboo-solve:${taskId}")`,
      });
    }

    // -- Resolve the agent + derive its hot wallet from our master ------------
    const resolved = await getAgentWithSigner(agentId);
    if (!resolved) {
      return res.status(404).json({ error: `agent #${agentId} is not registered on-chain` });
    }
    const { agent, hotWallet, ownedByUs } = resolved;
    if (!agent.active) {
      return res.status(409).json({ error: `agent #${agentId} is inactive` });
    }
    if (!hotWallet) {
      return res.status(409).json({ error: `agent #${agentId} has no hotWalletIndex in its metadata` });
    }
    if (!ownedByUs) {
      return res.status(403).json({ error: `agent #${agentId} was not registered from this backend's master mnemonic` });
    }

    // -- On-chain task preconditions ----------------------------------------
    const task = await getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: "task not found on-chain" });
    }
    if (task.state !== TaskState.Created) {
      return res.status(409).json({ error: `task is not open (state=${task.state})` });
    }

    // -- Access policy: operator = free (Compete), creator = Hire, else 403 --
    const decision = authorizeSolve({ caller, agent, task });
    if (!decision.allow) {
      return res.status(decision.status).json(decision.body);
    }

    // -- Dedupe: a solve already running for this (task, agent) → return it ---
    // Checked BEFORE settling any hire payment so a duplicate request is never
    // charged and never spawns a second solver run / second PR.
    const existing = findActiveJob(taskId, agentId, "solve");
    if (existing) {
      return res.status(202).json({ jobId: existing.id, status: existing.status, deduped: true });
    }

    // -- Hire path: verify + self-settle the x402 USDC payment before compute -
    if (decision.path === "hire") {
      const requirements = await buildHireRequirements({ taskId, agentId, operatorWallet: agent.operatorWallet, hotWallet });
      const header = req.get("X-PAYMENT");
      if (!header) {
        return res.status(402).json({ error: "Payment required", ...requirements });
      }
      let payment;
      try {
        payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
      } catch {
        return res.status(402).json({ error: "X-PAYMENT is not base64-encoded JSON", ...requirements });
      }
      try {
        const settled = await verifyAndSettleHire({ payment, requirements, hotWallet });
        console.log(`[solve] hire fee settled on-chain: ${settled.txHash}`);
      } catch (err) {
        return res.status(402).json({ error: `Payment failed: ${err.message}`, ...requirements });
      }
    }

    // -- Accepted: queue the async pipeline for this agent -------------------
    const job = startJob({ taskId, agentId, task, caller, path: decision.path, hotWallet });
    return res.status(202).json({ jobId: job.id, status: "queued" });
  } catch (err) {
    console.error(`[solve] ${err.stack || err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// The oracle's signer address, fetched once from its /health and cached. Used
// to verify that a /revise trigger really came from the oracle we trust (the
// same one we poll for attestations), not an arbitrary caller.
let oracleSignerCache = null;
async function oracleSignerAddress() {
  if (oracleSignerCache) return oracleSignerCache;
  const res = await fetch(`${config.oracleUrl}/health`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`oracle /health → ${res.status}`);
  const data = await res.json();
  if (!data.oracle) throw new Error("oracle /health did not return a signer address");
  oracleSignerCache = ethers.getAddress(data.oracle);
  return oracleSignerCache;
}

/**
 * Revise loop: the oracle calls this when a task creator requests changes on the
 * agent's PR (instead of merging). It's authenticated by an oracle signature
 * over `jumboo-revise:<taskId>:<agentId>:<prNumber>`. The agent re-runs its
 * solver on the SAME PR branch with the review feedback and pushes — the PR is
 * updated in place (a synchronize), no duplicate PR.
 */
app.post("/revise", async (req, res) => {
  try {
    const { taskId, agentId, prNumber, branch, headRepoFullName, feedback, signature } = req.body || {};
    if (!/^0x[0-9a-fA-F]{64}$/.test(taskId || "")) {
      return res.status(400).json({ error: "body must include taskId: '0x<64 hex>'" });
    }
    if (!/^\d+$/.test(String(agentId ?? ""))) {
      return res.status(400).json({ error: "body must include agentId" });
    }
    if (!prNumber || !branch || !headRepoFullName) {
      return res.status(400).json({ error: "body must include prNumber, branch and headRepoFullName" });
    }
    if (!signature) {
      return res.status(400).json({ error: "body must include the oracle signature" });
    }

    // -- Trust check: the trigger must be signed by the oracle ---------------
    const message = `jumboo-revise:${taskId}:${agentId}:${prNumber}`;
    let recovered;
    try {
      recovered = ethers.verifyMessage(message, signature);
    } catch {
      return res.status(401).json({ error: "invalid oracle signature" });
    }
    let oracleAddr;
    try {
      oracleAddr = await oracleSignerAddress();
    } catch (e) {
      return res.status(503).json({ error: `cannot verify oracle right now: ${e.message}` });
    }
    if (recovered.toLowerCase() !== oracleAddr.toLowerCase()) {
      return res.status(401).json({ error: "revise trigger not signed by the trusted oracle" });
    }

    // -- Must be one of our agents ------------------------------------------
    const resolved = await getAgentWithSigner(agentId);
    if (!resolved) {
      return res.status(404).json({ error: `agent #${agentId} is not registered on-chain` });
    }
    const { hotWallet, ownedByUs } = resolved;
    if (!hotWallet) {
      return res.status(409).json({ error: `agent #${agentId} has no hotWalletIndex in its metadata` });
    }
    if (!ownedByUs) {
      return res.status(403).json({ error: `agent #${agentId} was not registered from this backend's master mnemonic` });
    }

    // -- Revise only makes sense while the task is still open ----------------
    const task = await getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: "task not found on-chain" });
    }
    if (task.state !== TaskState.Created) {
      return res.status(409).json({ error: `task is not open (state=${task.state})` });
    }

    const job = startReviseJob({
      taskId,
      agentId,
      task,
      hotWallet,
      revise: { prNumber, branch, headRepoFullName, feedback: feedback || "" },
    });
    return res.status(202).json({ jobId: job.id, status: job.status });
  } catch (err) {
    console.error(`[revise] ${err.stack || err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * Sign a FeedbackAuth so a task creator can leave on-chain feedback for one of
 * this backend's agents (ERC-8004 anti-spam: the auth names the client and caps
 * them at one more entry). Public — the auth only lets the named clientAddress
 * submit, and giveFeedback requires msg.sender == clientAddress.
 */
app.post("/feedback-auth", async (req, res) => {
  try {
    const agentId = req.body?.agentId;
    if (!/^\d+$/.test(String(agentId ?? ""))) {
      return res.status(400).json({ error: "body must include agentId" });
    }
    const clientAddress = req.body?.clientAddress;
    if (!/^0x[0-9a-fA-F]{40}$/.test(clientAddress || "")) {
      return res.status(400).json({ error: "body must include clientAddress: '0x<40 hex>'" });
    }
    const result = await signFeedbackAuth({ agentId, clientAddress });
    return res.json(result);
  } catch (err) {
    const msg = err.message || "feedback-auth failed";
    const status = /not configured/.test(msg) ? 503 : /control|not found|invalid/.test(msg) ? 400 : 500;
    return res.status(status).json({ error: msg });
  }
});

app.get("/jobs/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) return res.status(404).json({ error: "job not found" });
  res.json(jobView(job));
});

app.listen(config.port, () => {
  console.log(`jumboo-agent-example listening on :${config.port}`);
  console.log(`  master:   ${masterFingerprint} (derivation index 0)`);
  console.log(`  solver:   ${config.solver}${config.dryRun ? " (DRY_RUN)" : ""}`);
  console.log(`  oracle:   ${config.oracleUrl}`);
});
