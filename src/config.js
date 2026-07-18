/**
 * Environment loading + validation. The .env file sits next to package.json so
 * the agent works from any working directory.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "..");

loadEnv({ path: path.join(ROOT_DIR, ".env") });

const SOLVERS = ["echo", "claude", "codex", "opencode", "antigravity", "custom"];

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

const solver = process.env.SOLVER || "echo";
if (!SOLVERS.includes(solver)) {
  throw new Error(`SOLVER must be one of ${SOLVERS.join(" | ")}, got: ${solver}`);
}

// One master mnemonic runs ALL of this operator's agents: each agent's hot
// wallet is HD-derived from it (see chain.js + @jumboo/agent-sdk). You never
// paste a wallet per agent — register more agents in the frontend and this
// backend serves them automatically.
const masterMnemonic = required("AGENT_MASTER_MNEMONIC", "the operator's 12/24-word HD master phrase");

export const config = {
  port: intEnv("PORT", 8917),
  rpcUrl: required("RPC_URL"),
  masterMnemonic,
  // Optional funded wallet that pays the claim gas for every agent. When blank,
  // each agent's own derived hot wallet pays (so it must hold a little ETH).
  agentTxKey: process.env.AGENT_TX_KEY || "",
  githubToken: process.env.GITHUB_TOKEN || "",
  githubUsername: process.env.GITHUB_USERNAME || "jumboo-agent",
  oracleUrl: required("ORACLE_URL", "e.g. https://oracle.jumboo.xyz").replace(/\/+$/, ""),
  taskRegistryAddress: required("TASK_REGISTRY_ADDRESS"),
  identityRegistryAddress: required("IDENTITY_REGISTRY_ADDRESS"),
  validationRegistryAddress: required("VALIDATION_REGISTRY_ADDRESS"),
  workdir: path.resolve(ROOT_DIR, process.env.WORKDIR || "./workspace"),
  solver,
  // Optional CLI-agent overrides (see src/solver.js). Blank/null = use the preset.
  solverCommand: process.env.SOLVER_COMMAND || "",
  solverArgs: process.env.SOLVER_ARGS ? process.env.SOLVER_ARGS.split(" ").filter(Boolean) : null,
  solverPromptVia: process.env.SOLVER_PROMPT_VIA || "",
  hirePrice: {
    amount: process.env.HIRE_PRICE_AMOUNT || "0.50",
    asset: process.env.HIRE_PRICE_ASSET || "USDC",
    network: process.env.HIRE_PRICE_NETWORK || "sepolia",
  },
  dryRun: process.env.DRY_RUN === "1",
  attestationPollSec: intEnv("ATTESTATION_POLL_SEC", 60),
};
