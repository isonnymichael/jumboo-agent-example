/**
 * On-chain plumbing: read tasks + agent identity, submit validations.
 * ABI fragments mirror oracle/src/chain.js so both sides decode identically.
 */
import { ethers } from "ethers";
import { config } from "./config.js";

export const provider = new ethers.JsonRpcProvider(config.rpcUrl);

/** The agent's registered hot wallet — signs taskIds for PR markers. */
export const hotWallet = new ethers.Wallet(config.agentHotKey);

// TaskState enum in JumbooTaskRegistry.sol
export const TaskState = {
  Created: 0n,
  Completed: 1n,
  Cancelled: 2n,
};

const TASK_REGISTRY_ABI = [
  "function tasks(bytes32) view returns (bytes32 taskId, string repoUrl, string issueId, uint256 rewardAmount, address creator, uint256 agentId, uint64 deadline, uint8 state)",
];

const IDENTITY_REGISTRY_ABI = [
  "function getAgent(uint256) view returns (address operatorWallet, address agentWallet, string agentURI, bool active)",
];

const VALIDATION_REGISTRY_ABI = [
  "function submitValidation(bytes32 taskId, uint256 agentId, uint8 outcome, bytes calldata signature) external",
];

export const taskRegistry = new ethers.Contract(config.taskRegistryAddress, TASK_REGISTRY_ABI, provider);
export const identityRegistry = new ethers.Contract(config.identityRegistryAddress, IDENTITY_REGISTRY_ABI, provider);

/** Loads a task from the TaskRegistry; returns null when it does not exist. */
export async function getTask(taskId) {
  const task = await taskRegistry.tasks(taskId);
  if (task.creator === ethers.ZeroAddress) return null;
  return task;
}

/** Loads this backend's agent identity; returns null when not registered. */
export async function getAgent(agentId = config.agentId) {
  try {
    const [operatorWallet, agentWallet, agentURI, active] = await identityRegistry.getAgent(agentId);
    return { operatorWallet, agentWallet, agentURI, active };
  } catch {
    return null;
  }
}

/**
 * Submits an oracle attestation to JumbooValidationRegistry — for a Merged
 * outcome this releases the escrow to the agent's operator wallet.
 * Gas is paid by AGENT_TX_KEY (falls back to the hot key).
 */
export async function submitValidation({ taskId, agentId, outcome, signature }) {
  const txWallet = new ethers.Wallet(config.agentTxKey, provider);
  const registry = new ethers.Contract(config.validationRegistryAddress, VALIDATION_REGISTRY_ABI, txWallet);
  const tx = await registry.submitValidation(taskId, BigInt(agentId), outcome, signature);
  const receipt = await tx.wait();
  return { hash: tx.hash, blockNumber: receipt.blockNumber, status: receipt.status };
}
