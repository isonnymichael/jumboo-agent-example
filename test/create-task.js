#!/usr/bin/env node
/**
 * Local test helper: create a task on a local chain (e.g. a hardhat node) and
 * print its taskId (parsed from the TaskCreated event).
 *
 *   node test/create-task.js [repoUrl] [issueId] [creatorPrivateKey]
 *
 * With no arguments it points the task at the local bare repo `test-remote.git`
 * in this project root (see the DRY_RUN section of the README), and uses the
 * well-known hardhat dev account #0 as the creator. TEST KEYS ONLY.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { config as loadEnv } from "dotenv";
import { ethers } from "ethers";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "..");
loadEnv({ path: path.join(ROOT_DIR, ".env") });

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const TASK_REGISTRY = process.env.TASK_REGISTRY_ADDRESS;
if (!TASK_REGISTRY) throw new Error("TASK_REGISTRY_ADDRESS not set");

// Default target: a local bare repo in this project root. Portable across
// machines — no hard-coded absolute path.
const defaultRepoUrl = pathToFileURL(path.join(ROOT_DIR, "test-remote.git")).href;

const repoUrl = process.argv[2] || defaultRepoUrl;
const issueId = process.argv[3] || "issue-1";
// hardhat dev account #0 (well-known public test key)
const creatorKey =
  process.argv[4] || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

const ABI = [
  "function createTask(string repoUrl, string issueId, uint256 duration) payable returns (bytes32)",
  "event TaskCreated(bytes32 indexed taskId, string repoUrl, string issueId, uint256 rewardAmount, uint64 deadline, address indexed creator)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL);
const creator = new ethers.Wallet(creatorKey, provider);
const registry = new ethers.Contract(TASK_REGISTRY, ABI, creator);

const tx = await registry.createTask(repoUrl, issueId, 604800, { value: ethers.parseEther("0.1") });
const receipt = await tx.wait();

let taskId = null;
for (const log of receipt.logs) {
  try {
    const parsed = registry.interface.parseLog(log);
    if (parsed?.name === "TaskCreated") taskId = parsed.args.taskId;
  } catch {}
}
if (!taskId) throw new Error("TaskCreated event not found in receipt");

console.log(JSON.stringify({ taskId, repoUrl, issueId, creator: creator.address, tx: tx.hash }, null, 2));
