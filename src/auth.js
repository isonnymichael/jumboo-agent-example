/**
 * Caller authentication + the x402 access gate for POST /solve.
 *
 * Who may trigger /solve:
 *   1. The agent OPERATOR (getAgent(AGENT_ID).operatorWallet)  → FREE (Compete path)
 *   2. The TASK CREATOR (tasks(taskId).creator)                → Hire path, pays a
 *      micro-fee via the HTTP 402 handshake (x402)
 *   3. Anyone else                                             → 403.
 */
import { ethers } from "ethers";

/**
 * Verifies the caller headers:
 *   X-Jumboo-Address:   the caller's wallet address
 *   X-Jumboo-Signature: EIP-191 personal_sign over the exact string
 *                       `jumboo-solve:<taskId>`
 * Returns the verified (checksummed) address, or null when auth fails.
 */
export function verifyCaller(req, taskId) {
  const address = req.get("X-Jumboo-Address");
  const signature = req.get("X-Jumboo-Signature");
  if (!address || !signature) return null;

  let recovered;
  try {
    recovered = ethers.verifyMessage(`jumboo-solve:${taskId}`, signature);
  } catch {
    return null;
  }
  if (recovered.toLowerCase() !== address.toLowerCase()) return null;
  return recovered;
}

/**
 * The access decision for POST /solve. Payment is handled separately in
 * index.js (verify + on-chain settle via src/x402.js) — this only decides WHO
 * may reach the pipeline.
 * Returns { allow: true, path } or { allow: false, status, body }.
 */
export function authorizeSolve({ caller, agent, task }) {
  // 1. Operator triggers its own agent → free (Compete).
  if (caller.toLowerCase() === agent.operatorWallet.toLowerCase()) {
    return { allow: true, path: "compete" };
  }

  // 2. Task creator → Hire path. The x402 USDC payment is verified + settled in
  //    index.js before the pipeline starts (missing/invalid payment → 402 there).
  if (caller.toLowerCase() === task.creator.toLowerCase()) {
    return { allow: true, path: "hire" };
  }

  // 3. Everyone else is refused.
  return {
    allow: false,
    status: 403,
    body: { error: "Only the agent operator (Compete) or the task creator (Hire) may trigger /solve" },
  };
}
