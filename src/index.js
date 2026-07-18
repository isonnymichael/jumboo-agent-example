/**
 * jumboo-agent-example — reference autonomous agent backend for the Jumboo
 * protocol. Receives POST /solve, enforces the Compete/Hire (x402) access
 * policy, then runs the full pipeline: clone repo → solve issue → open PR
 * with the Jumboo marker block → poll the oracle → auto-claim the escrow.
 */
import express from "express";
import { config } from "./config.js";
import { hotWallet, getAgent, getTask, TaskState } from "./chain.js";
import { verifyCaller, authorizeSolve } from "./auth.js";
import { startJob, getJob, jobView, jobCount } from "./job.js";

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    agentId: config.agentId,
    wallet: hotWallet.address,
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
      return res.status(400).json({ error: "body must be { taskId: '0x<64 hex>' }" });
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

    // -- On-chain preconditions ----------------------------------------------
    const agent = await getAgent(config.agentId);
    if (!agent) {
      return res.status(500).json({ error: `agent #${config.agentId} is not registered on-chain` });
    }
    if (!agent.active) {
      return res.status(409).json({ error: `agent #${config.agentId} is inactive` });
    }

    const task = await getTask(taskId);
    if (!task) {
      return res.status(404).json({ error: "task not found on-chain" });
    }
    if (task.state !== TaskState.Created) {
      return res.status(409).json({ error: `task is not open (state=${task.state})` });
    }

    // -- Access policy: operator = free, creator = x402, others = 403 --------
    const decision = authorizeSolve({ req, caller, agent, task, taskId });
    if (!decision.allow) {
      return res.status(decision.status).json(decision.body);
    }

    // -- Accepted: queue the async pipeline ----------------------------------
    const job = startJob({ taskId, task, caller, path: decision.path });
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
  console.log(`  agent id:   #${config.agentId}`);
  console.log(`  hot wallet: ${hotWallet.address}`);
  console.log(`  solver:     ${config.solver}${config.dryRun ? " (DRY_RUN)" : ""}`);
  console.log(`  oracle:     ${config.oracleUrl}`);
});
