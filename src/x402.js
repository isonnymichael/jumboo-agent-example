/**
 * x402 "exact" payment for the Hire path — self-settled, no external facilitator.
 *
 * Two settlement flavors, picked per chain (config.x402Settlement):
 *
 * - "eip3009" (Ethereum Sepolia): EIP-3009 `transferWithAuthorization` is
 *   permissionless — anyone holding the payer's signature can submit it — so
 *   THIS backend acts as its own facilitator: it verifies the signed USDC
 *   authorization, then submits the transfer itself (paying a few cents of
 *   gas). Fully gasless for the payer. Requires a Circle-FiatToken-style USDC.
 *
 * - "transferFrom" (BSC and any chain whose USDC lacks EIP-3009): the b402
 *   pattern used across the BNB ecosystem. The payer approves this backend's
 *   settlement wallet once (an on-chain tx, small gas), signs an off-chain
 *   EIP-712 payment intent bound to (taskId, agentId, nonce, validBefore),
 *   and the backend settles with a plain ERC-20 `transferFrom`. Works with
 *   ANY ERC-20 — no mock tokens, mainnet-real semantics.
 *
 * Reward/bounty stays the native coin (ETH/tBNB); only the hire fee is USDC.
 */
import { ethers } from "ethers";
import { provider } from "./chain.js";
import { config } from "./config.js";

const USDC_ABI = [
  "function decimals() view returns (uint8)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function transferFrom(address from, address to, uint256 value) returns (bool)",
];

const usdc = new ethers.Contract(config.usdcAddress, USDC_ABI, provider);

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// EIP-712 intent for the transferFrom flavor. No verifyingContract — nothing
// on-chain verifies it; the chainId + token binding prevents cross-chain reuse.
const HIRE_PAYMENT_TYPES = {
  HirePayment: [
    { name: "taskId", type: "uint256" },
    { name: "agentId", type: "uint256" },
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "token", type: "address" },
    { name: "value", type: "uint256" },
    { name: "nonce", type: "bytes32" },
    { name: "validBefore", type: "uint256" },
  ],
};

// The token's real EIP-712 domain (name/version can differ per deployment).
// Read once from the contract (ERC-5267 eip712Domain); fall back to USDC/2.
let _domain = null;
async function usdcDomain() {
  if (_domain) return _domain;
  try {
    const d = await usdc.eip712Domain();
    _domain = { name: d.name, version: d.version, chainId: Number(d.chainId), verifyingContract: d.verifyingContract };
  } catch {
    const net = await provider.getNetwork();
    _domain = { name: "USDC", version: "2", chainId: Number(net.chainId), verifyingContract: config.usdcAddress };
  }
  return _domain;
}

let _decimals = null;
async function usdcDecimals() {
  if (_decimals != null) return _decimals;
  try {
    _decimals = Number(await usdc.decimals());
  } catch {
    _decimals = 6; // USDC standard
  }
  return _decimals;
}

// The wallet that submits the settlement tx (and, for transferFrom, the
// spender the payer must approve). AGENT_TX_KEY when configured, else the
// hired agent's own derived hot wallet.
function settlementWallet(hotWallet) {
  return config.agentTxKey ? new ethers.Wallet(config.agentTxKey, provider) : hotWallet.connect(provider);
}

// Anti-replay for the transferFrom flavor: EIP-3009 nonces are enforced by the
// token on-chain, but a plain transferFrom has no such ledger, so we keep our
// own. In-memory is enough — every intent expires within its validBefore
// window (10 min client-side), which also bounds any replay after a restart.
const usedNonces = new Map(); // nonce -> validBefore (unix seconds)
function checkAndBurnNonce(nonce, validBefore) {
  const now = Math.floor(Date.now() / 1000);
  for (const [n, exp] of usedNonces) if (exp <= now) usedNonces.delete(n);
  if (usedNonces.has(nonce)) throw new Error("payment nonce already used");
  usedNonces.set(nonce, Number(validBefore));
}

/** The authoritative x402 payment requirements the client must satisfy. */
export async function buildHireRequirements({ taskId, agentId, operatorWallet, hotWallet }) {
  const decimals = await usdcDecimals();
  const maxAmountRequired = ethers.parseUnits(String(config.hirePrice.amount), decimals).toString();
  const terms = {
    scheme: "exact",
    network: config.hirePrice.network,
    maxAmountRequired,
    asset: config.usdcAddress,
    payTo: operatorWallet,
    resource: "/solve",
    description: `Hire agent #${agentId} to attempt task ${taskId}`,
    // Which self-settle flavor this chain supports. Older deployed frontends
    // that predate this field only know eip3009 — that's also the default.
    settlement: config.x402Settlement,
  };
  if (config.x402Settlement === "transferFrom") {
    // The client needs: who to approve (spender) and what to bind the signed
    // intent to (taskId/agentId echo back so we can verify the binding).
    terms.extra = {
      spender: settlementWallet(hotWallet).address,
      taskId: String(taskId),
      agentId: String(agentId),
    };
  } else {
    // EIP-712 domain the client needs to sign the EIP-3009 authorization.
    const domain = await usdcDomain();
    terms.extra = { name: domain.name, version: domain.version };
  }
  return { x402Version: 1, accepts: [terms] };
}

/**
 * Verify an X-PAYMENT header (decoded) against the quoted requirements, then
 * settle it on-chain. Throws with a reason on any failure so the caller can
 * answer 402. `hotWallet` is the hired agent's wallet, used to pay settlement
 * gas only when no shared AGENT_TX_KEY is configured.
 */
export async function verifyAndSettleHire({ payment, requirements, hotWallet }) {
  const terms = requirements.accepts[0];
  const flavor = payment?.settlement || "eip3009";
  if (flavor !== (terms.settlement || "eip3009")) {
    throw new Error(`payment settlement "${flavor}" does not match the quote "${terms.settlement || "eip3009"}"`);
  }
  if (flavor === "transferFrom") return settleTransferFrom({ payment, terms, hotWallet });
  return settleEip3009({ payment, terms, hotWallet });
}

async function settleEip3009({ payment, terms, hotWallet }) {
  const auth = payment?.authorization;
  const signature = payment?.signature;
  if (!auth || !signature) throw new Error("X-PAYMENT missing authorization or signature");

  // 1. Terms must match the quote.
  if (String(auth.to).toLowerCase() !== String(terms.payTo).toLowerCase()) throw new Error("payTo mismatch");
  if (String(auth.value) !== String(terms.maxAmountRequired)) throw new Error("amount mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (Number(auth.validBefore) <= now) throw new Error("authorization expired");
  if (Number(auth.validAfter) > now) throw new Error("authorization not yet valid");

  // 2. The EIP-3009 signature must recover to the payer (`from`).
  const domain = await usdcDomain();
  let recovered;
  try {
    recovered = ethers.verifyTypedData(
      domain,
      TRANSFER_WITH_AUTHORIZATION_TYPES,
      {
        from: auth.from,
        to: auth.to,
        value: auth.value,
        validAfter: auth.validAfter,
        validBefore: auth.validBefore,
        nonce: auth.nonce,
      },
      signature
    );
  } catch (e) {
    throw new Error(`bad signature: ${e.message}`);
  }
  if (recovered.toLowerCase() !== String(auth.from).toLowerCase()) {
    throw new Error("signature does not recover to the payer");
  }

  // 3. Settle: submit transferWithAuthorization ourselves (permissionless).
  const gasWallet = settlementWallet(hotWallet);
  const sig = ethers.Signature.from(signature);
  const tx = await usdc
    .connect(gasWallet)
    .transferWithAuthorization(
      auth.from,
      auth.to,
      auth.value,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      sig.v,
      sig.r,
      sig.s
    );
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}

async function settleTransferFrom({ payment, terms, hotWallet }) {
  const intent = payment?.intent;
  const signature = payment?.signature;
  if (!intent || !signature) throw new Error("X-PAYMENT missing intent or signature");

  // 1. Terms must match the quote — including the (taskId, agentId) binding,
  //    so a signed intent can't be replayed to hire a different agent/task.
  if (String(intent.to).toLowerCase() !== String(terms.payTo).toLowerCase()) throw new Error("payTo mismatch");
  if (String(intent.value) !== String(terms.maxAmountRequired)) throw new Error("amount mismatch");
  if (String(intent.token).toLowerCase() !== String(config.usdcAddress).toLowerCase()) throw new Error("token mismatch");
  if (String(intent.taskId) !== String(terms.extra.taskId)) throw new Error("taskId mismatch");
  if (String(intent.agentId) !== String(terms.extra.agentId)) throw new Error("agentId mismatch");
  const now = Math.floor(Date.now() / 1000);
  if (Number(intent.validBefore) <= now) throw new Error("payment intent expired");

  // 2. The intent signature must recover to the payer (`from`).
  const net = await provider.getNetwork();
  const domain = { name: "Jumboo x402", version: "1", chainId: Number(net.chainId) };
  let recovered;
  try {
    recovered = ethers.verifyTypedData(domain, HIRE_PAYMENT_TYPES, intent, signature);
  } catch (e) {
    throw new Error(`bad signature: ${e.message}`);
  }
  if (recovered.toLowerCase() !== String(intent.from).toLowerCase()) {
    throw new Error("signature does not recover to the payer");
  }

  // 3. Anti-replay: burn the nonce before touching the chain.
  checkAndBurnNonce(String(intent.nonce), intent.validBefore);

  // 4. Pull the fee. Clear preflight errors beat a raw revert.
  const gasWallet = settlementWallet(hotWallet);
  const [allowance, balance] = await Promise.all([
    usdc.allowance(intent.from, gasWallet.address),
    usdc.balanceOf(intent.from),
  ]);
  if (allowance < BigInt(intent.value)) throw new Error("insufficient USDC allowance — approve the spender first");
  if (balance < BigInt(intent.value)) throw new Error("insufficient USDC balance");
  const tx = await usdc.connect(gasWallet).transferFrom(intent.from, intent.to, intent.value);
  const receipt = await tx.wait();
  return { txHash: receipt.hash };
}
