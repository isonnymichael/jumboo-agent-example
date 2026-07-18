/**
 * Environment loading + validation for the autonomous agent backend.
 * The .env file sits next to package.json so the service works from any cwd.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT_DIR, ".env") });

const SOLVERS = ["claude-cli", "echo"];

function required(name, hint = "") {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var ${name}${hint ? ` (${hint})` : ""} — see .env.example`);
  }
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got: ${raw}`);
  return n;
}

const agentId = required("AGENT_ID", "on-chain agent NFT id");
if (!/^\d+$/.test(agentId)) throw new Error(`AGENT_ID must be a positive integer, got: ${agentId}`);

const solver = process.env.SOLVER || "claude-cli";
if (!SOLVERS.includes(solver)) {
  throw new Error(`SOLVER must be one of ${SOLVERS.join(" | ")}, got: ${solver}`);
}

const hotKey = required("AGENT_HOT_KEY", "the agent's registered hot wallet private key");
if (!/^0x[0-9a-fA-F]{64}$/.test(hotKey)) throw new Error("AGENT_HOT_KEY must be a 0x-prefixed 32-byte hex private key");

export const config = {
  port: intEnv("PORT", 8917),
  rpcUrl: required("RPC_URL"),
  agentId,
  agentHotKey: hotKey,
  // Optional separate gas wallet for submitValidation; falls back to the hot key.
  agentTxKey: process.env.AGENT_TX_KEY || hotKey,
  githubToken: process.env.GITHUB_TOKEN || "",
  githubUsername: process.env.GITHUB_USERNAME || "jumboo-agent",
  oracleUrl: required("ORACLE_URL", "e.g. http://localhost:8787").replace(/\/+$/, ""),
  taskRegistryAddress: required("TASK_REGISTRY_ADDRESS"),
  identityRegistryAddress: required("IDENTITY_REGISTRY_ADDRESS"),
  validationRegistryAddress: required("VALIDATION_REGISTRY_ADDRESS"),
  workdir: path.resolve(ROOT_DIR, process.env.WORKDIR || "./workspace"),
  solver,
  // Advisory copies live in the agent's ERC-8004 metadata (`pricing.solve`);
  // THESE values are the authoritative price a 402 response quotes.
  hirePrice: {
    amount: process.env.HIRE_PRICE_AMOUNT || "0.50",
    asset: process.env.HIRE_PRICE_ASSET || "USDC",
    network: process.env.HIRE_PRICE_NETWORK || "sepolia",
  },
  // DRY_RUN=1: run the full local pipeline (clone/solve/commit/push) but skip
  // PR creation and attestation polling — the marker block is logged instead.
  dryRun: process.env.DRY_RUN === "1",
  attestationPollSec: intEnv("ATTESTATION_POLL_SEC", 60),
};
