// Read-only check against Robinhood Chain. Sends no transaction, needs no key, spends nothing.
// Usage: pnpm build && pnpm smoke [rpcUrl]
import { createPublicClient, domainSeparator, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AUTHORIZATION_TYPES, CHAIN_ID, DEFAULT_RPC_URL, USDG, USDG_DECIMALS, USDG_EIP712, createChain, createFacilitator, transferCalldata } from "../dist/index.js";

const rpcUrl = process.argv[2] ?? DEFAULT_RPC_URL;
const shown = rpcUrl === DEFAULT_RPC_URL ? rpcUrl : "(custom RPC)";
const asset = { address: USDG, name: USDG_EIP712.name, version: USDG_EIP712.version, decimals: USDG_DECIMALS };
const chain = createChain({ asset, rpcUrl });
const check = (ok, message) => {
  if (!ok) throw new Error(`smoke failed: ${message}`);
  console.log(`ok   ${message}`);
};
console.log(`rpc  ${shown}`);

// 1. The RPC is Robinhood Chain.
const id = await chain.chainId();
check(id === CHAIN_ID, `chain id ${id}`);

// 2. USDG's EIP-712 domain is what the facilitator signs against.
const name = await chain.tokenName();
check(name === USDG_EIP712.name, `USDG name() = "${name}"`);
const onchain = (await chain.domainSeparator()).toLowerCase();
const computed = domainSeparator({ domain: { name: USDG_EIP712.name, version: USDG_EIP712.version, chainId: CHAIN_ID, verifyingContract: USDG } }).toLowerCase();
check(onchain === computed, `DOMAIN_SEPARATOR() = ${onchain} matches name "${USDG_EIP712.name}", version "${USDG_EIP712.version}", chain ${CHAIN_ID}`);
const client = createPublicClient({ transport: http(rpcUrl) });
const version = await client.readContract({ address: USDG, abi: parseAbi(["function version() view returns (string)"]), functionName: "version" }).then(
  (v) => `"${v}"`,
  () => "reverts",
);
console.log(`info USDG version() ${version} (the version is confirmed through DOMAIN_SEPARATOR above)`);

// 3. authorizationState is callable.
const account = privateKeyToAccount(generatePrivateKey());
const nonce = `0x${[...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
const used = await chain.authorizationUsed(account.address, nonce);
check(used === false, `authorizationState(fresh address, random nonce) = ${used}`);

// 4. A transferWithAuthorization eth_call from a fresh, empty wallet reverts and the revert is decoded.
const now = BigInt(Math.floor(Date.now() / 1000));
const auth = { from: account.address, to: "0x000000000000000000000000000000000000dEaD", value: 1000n, validAfter: now - 60n, validBefore: now + 300n, nonce };
const signature = await account.signTypedData({
  domain: { name: USDG_EIP712.name, version: USDG_EIP712.version, chainId: CHAIN_ID, verifyingContract: USDG },
  types: AUTHORIZATION_TYPES,
  primaryType: "TransferWithAuthorization",
  message: auth,
});
const revert = await chain.simulate(transferCalldata(auth, signature));
check(revert !== null, `simulated transferWithAuthorization from an empty wallet reverts: ${revert?.name ?? revert?.message}`);

// 5. End to end: /verify logic on a real signature from an empty wallet.
const req = { scheme: "exact", network: `eip155:${CHAIN_ID}`, amount: "1000", asset: USDG, payTo: auth.to, maxTimeoutSeconds: 300, extra: { ...USDG_EIP712 } };
const payload = {
  x402Version: 2,
  accepted: req,
  payload: { signature, authorization: { ...auth, value: "1000", validAfter: auth.validAfter.toString(), validBefore: auth.validBefore.toString() } },
};
const verdict = await createFacilitator({ rpcUrl }).verify(payload, req);
check(verdict.isValid === false && verdict.invalidReason === "insufficient_funds", `verify(empty wallet) = ${verdict.invalidReason}`);

console.log("smoke ok");
