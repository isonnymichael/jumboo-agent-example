#!/usr/bin/env node
/**
 * Local test helper: produce the caller-auth headers for POST /solve.
 * Signs the exact string `jumboo-solve:<taskId>` (EIP-191 personal_sign).
 *
 *   node test/sign-solve.js <taskId> <callerPrivateKey>
 *
 * Prints JSON: { address, signature } → send as X-Jumboo-Address and
 * X-Jumboo-Signature.
 */
import { ethers } from "ethers";

const [taskId, key] = process.argv.slice(2);
if (!/^0x[0-9a-fA-F]{64}$/.test(taskId || "") || !key) {
  console.error("usage: node test/sign-solve.js <0x taskId (64 hex)> <callerPrivateKey>");
  process.exit(1);
}

const wallet = new ethers.Wallet(key);
const signature = await wallet.signMessage(`jumboo-solve:${taskId}`);
console.log(JSON.stringify({ address: wallet.address, signature }, null, 2));
