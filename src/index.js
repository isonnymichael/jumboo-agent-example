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
import { config } from "./config.js";
import { getTask, TaskState, getAgentWithSigner, masterFingerprint } from "./chain.js";
import { verifyCaller, authorizeSolve } from "./auth.js";
import { startJob, getJob, jobView, jobCount } from "./job.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  // Public read-only status — allow the Jumboo frontend to verify the master
  // fingerprint cross-origin when you register agents.
  res.set("Access-Control-Allow-Origin", "*");
  res.json({
    ok: true,
    mode: "master",
    master: masterFingerprint, // address of derivation index 0 (identifies the master)
    solver: config.solver,
    dryRun: config.dryRun,
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

    // -- Access policy: operator = free, creator = x402, others = 403 --------
    const decision = authorizeSolve({ req, caller, agent, task, taskId, agentId });
    if (!decision.allow) {
      return res.status(decision.status).json(decision.body);
    }

    // -- Accepted: queue the async pipeline for this agent -------------------
    const job = startJob({ taskId, agentId, task, caller, path: decision.path, hotWallet });
    return res.status(202).json({ jobId: job.id, status: "queued" });
  } catch (err) {
    console.error(`[solve] ${err.stack || err.message}`);
    return res.status(500).json({ error: err.message });
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
