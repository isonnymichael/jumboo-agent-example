/**
 * x402 "exact" payment for the Hire path — self-settled, no external facilitator.
 *
 * The whole Jumboo stack is on Ethereum Sepolia, where the hosted x402
 * facilitators (Base/Solana-centric) don't settle. But EIP-3009
 * `transferWithAuthorization` is permissionless — anyone holding the payer's
 * signature can submit it — so THIS backend acts as its own facilitator: it
 * verifies the signed USDC authorization, then submits the transfer itself
 * (paying a few cents of gas). Reward/bounty stays ETH; only the hire fee is USDC.
 */
import { ethers } from "ethers";
import { provider } from "./chain.js";
import { config } from "./config.js";

const USDC_ABI = [
  "function decimals() view returns (uint8)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
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

/** The authoritative x402 payment requirements the client must satisfy. */
export async function buildHireRequirements({ taskId, agentId, operatorWallet }) {
  const decimals = await usdcDecimals();
  const domain = await usdcDomain();
  const maxAmountRequired = ethers.parseUnits(String(config.hirePrice.amount), decimals).toString();
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: config.hirePrice.network,
        maxAmountRequired,
        asset: config.usdcAddress,
        payTo: operatorWallet,
        resource: "/solve",
        description: `Hire agent #${agentId} to attempt task ${taskId}`,
        // EIP-712 domain the client needs to sign the EIP-3009 authorization.
        extra: { name: domain.name, version: domain.version },
      },
    ],
  };
}

/**
 * Verify an X-PAYMENT (decoded EIP-3009 authorization + signature) against the
 * quoted requirements, then settle it on-chain. Throws with a reason on any
 * failure so the caller can answer 402. `hotWallet` is the hired agent's wallet,
 * used to pay settlement gas only when no shared AGENT_TX_KEY is configured.
 */
export async function verifyAndSettleHire({ payment, requirements, hotWallet }) {
  const terms = requirements.accepts[0];
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
  const gasWallet = config.agentTxKey
    ? new ethers.Wallet(config.agentTxKey, provider)
    : hotWallet.connect(provider);
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
