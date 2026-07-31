/**
 * On-chain reads + deriving the right hot wallet for an agent.
 *
 * This backend runs MANY agents from one master mnemonic (config.masterMnemonic).
 * Each agent's hot wallet is HD-derived from the master at the per-agent index
 * stored in its ERC-8004 metadata (`hotWalletIndex`). The marker signing + escrow
 * claim themselves live in @jumboo/agent-sdk.
 */
import { ethers } from "ethers";
import { deriveHotWallet } from "@jumboo/agent-sdk";
import { config } from "./config.js";

export const provider = new ethers.JsonRpcProvider(config.rpcUrl);

/** Address of the master's index-0 wallet — a public fingerprint, not a key. */
export const masterFingerprint = deriveHotWallet(config.masterMnemonic, 0).address;

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

export const taskRegistry = new ethers.Contract(config.taskRegistryAddress, TASK_REGISTRY_ABI, provider);
export const identityRegistry = new ethers.Contract(config.identityRegistryAddress, IDENTITY_REGISTRY_ABI, provider);

// Only instantiated when REPUTATION_REGISTRY_ADDRESS is set (for /feedback-auth).
const REPUTATION_REGISTRY_ABI = [
  "function clientFeedbackCount(uint256, address) view returns (uint256)",
];
export const reputationRegistry = config.reputationRegistryAddress
  ? new ethers.Contract(config.reputationRegistryAddress, REPUTATION_REGISTRY_ABI, provider)
  : null;

/** Loads a task from the TaskRegistry; returns null when it does not exist. */
export async function getTask(taskId) {
  const task = await taskRegistry.tasks(taskId);
  if (task.creator === ethers.ZeroAddress) return null;
  return task;
}

/** Loads an agent's identity; returns null when it does not exist. */
export async function getAgent(agentId) {
  try {
    const [operatorWallet, agentWallet, agentURI, active] = await identityRegistry.getAgent(agentId);
    return { operatorWallet, agentWallet, agentURI, active };
  } catch {
    return null;
  }
}

/** Read the per-agent hot-wallet index out of the ERC-8004 data-URI metadata. */
function hotWalletIndexFromUri(agentURI) {
  try {
    const m = String(agentURI).match(/^data:application\/json;base64,(.+)$/);
    if (!m) return null;
    const json = JSON.parse(Buffer.from(m[1], "base64").toString("utf8"));
    return Number.isInteger(json.hotWalletIndex) ? json.hotWalletIndex : null;
  } catch {
    return null;
  }
}

/**
 * Load an agent AND derive its hot wallet from our master mnemonic.
 *
 * Returns { agent, index, hotWallet, ownedByUs } or null when the agent does not
 * exist. `ownedByUs` is true only when the derived wallet matches the agent's
 * registered `agentWallet` — i.e. this agent was registered from OUR master, so
 * we're allowed to sign for it. This is the trustless ownership check.
 */
export async function getAgentWithSigner(agentId) {
  const agent = await getAgent(agentId);
  if (!agent) return null;
  const index = hotWalletIndexFromUri(agent.agentURI);
  let hotWallet = null;
  let ownedByUs = false;
  if (index !== null) {
    hotWallet = deriveHotWallet(config.masterMnemonic, index);
    ownedByUs = hotWallet.address.toLowerCase() === agent.agentWallet.toLowerCase();
  }
  return { agent, index, hotWallet, ownedByUs };
}

/**
 * Sign an EIP-712 FeedbackAuth (ERC-8004) with the agent's hot wallet,
 * authorizing `clientAddress` to leave ONE on-chain feedback for `agentId`. The
 * creator then submits it via JumbooReputationRegistry.giveFeedback. We can only
 * sign for agents derived from OUR master (ownedByUs) — the contract also
 * requires signerAddress to be the agent's current wallet at submit time.
 */
export async function signFeedbackAuth({ agentId, clientAddress }) {
  if (!reputationRegistry) throw new Error("REPUTATION_REGISTRY_ADDRESS not configured");
  if (!/^0x[0-9a-fA-F]{40}$/.test(clientAddress || "")) throw new Error("invalid clientAddress");
  const resolved = await getAgentWithSigner(agentId);
  if (!resolved) throw new Error("agent not found");
  const { hotWallet, ownedByUs } = resolved;
  if (!hotWallet || !ownedByUs) throw new Error("this backend does not control that agent");

  // indexLimit must be strictly greater than the client's current feedback
  // count so the contract admits exactly one more entry from them.
  const count = await reputationRegistry.clientFeedbackCount(agentId, clientAddress);
  const { chainId } = await provider.getNetwork();

  const domain = {
    name: "JumbooReputationRegistry",
    version: "1",
    chainId: Number(chainId),
    verifyingContract: config.reputationRegistryAddress,
  };
  const types = {
    FeedbackAuth: [
      { name: "agentId", type: "uint256" },
      { name: "clientAddress", type: "address" },
      { name: "indexLimit", type: "uint256" },
      { name: "expiry", type: "uint256" },
      { name: "signerAddress", type: "address" },
    ],
  };
  const auth = {
    agentId: String(agentId),
    clientAddress,
    indexLimit: (count + 1n).toString(),
    expiry: String(Math.floor(Date.now() / 1000) + 3600), // 1 hour
    signerAddress: hotWallet.address,
  };
  const signature = await hotWallet.signTypedData(domain, types, auth);
  return { auth, signature };
}
