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
import { config } from "./config.js";

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

/** The authoritative x402 payment requirements for one /solve attempt. */
export function paymentRequirements({ taskId, agentId, operatorWallet }) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.hirePrice.network,
        asset: config.hirePrice.asset,
        amount: config.hirePrice.amount,
        payTo: operatorWallet,
        resource: "/solve",
        description: `Hire agent #${agentId} to attempt task ${taskId}`,
      },
    ],
  };
}

/**
 * Validates the X-PAYMENT header against the quoted requirements.
 *
 * ============================ TODO — PRODUCTION ============================
 * This DEMO implementation only checks that the caller echoed the quoted
 * terms back. It TRUSTS the header. In production the X-PAYMENT payload must
 * be verified AND settled through an x402 facilitator before any compute is
 * spent. Never ship this trust-the-header shortcut.
 * ===========================================================================
 */
export function verifyPayment(req, requirements) {
  const header = req.get("X-PAYMENT");
  if (!header) return { ok: false, reason: "no X-PAYMENT header" };

  let payment;
  try {
    payment = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  } catch {
    return { ok: false, reason: "X-PAYMENT is not base64-encoded JSON" };
  }

  const terms = requirements.accepts[0];
  const mismatches = [];
  if (payment.scheme !== terms.scheme) mismatches.push("scheme");
  if (payment.asset !== terms.asset) mismatches.push("asset");
  if (String(payment.amount) !== String(terms.amount)) mismatches.push("amount");
  if (String(payment.payTo || "").toLowerCase() !== terms.payTo.toLowerCase()) mismatches.push("payTo");
  if (mismatches.length > 0) {
    return { ok: false, reason: `X-PAYMENT does not match quoted terms: ${mismatches.join(", ")}` };
  }
  return { ok: true, payment };
}

/**
 * The full access decision for POST /solve.
 * Returns { allow: true, path } or { allow: false, status, body }.
 */
export function authorizeSolve({ req, caller, agent, task, taskId, agentId }) {
  // 1. Operator triggers its own agent → free (Compete).
  if (caller.toLowerCase() === agent.operatorWallet.toLowerCase()) {
    return { allow: true, path: "compete" };
  }

  // 2. Task creator hires this agent → x402 handshake (Hire).
  if (caller.toLowerCase() === task.creator.toLowerCase()) {
    const requirements = paymentRequirements({ taskId, agentId, operatorWallet: agent.operatorWallet });
    const payment = verifyPayment(req, requirements);
    if (!payment.ok) {
      return {
        allow: false,
        status: 402,
        body: { error: `Payment required: ${payment.reason}`, ...requirements },
      };
    }
    return { allow: true, path: "hire" };
  }

  // 3. Everyone else is refused.
  return {
    allow: false,
    status: 403,
    body: { error: "Only the agent operator (Compete) or the task creator (Hire) may trigger /solve" },
  };
}
