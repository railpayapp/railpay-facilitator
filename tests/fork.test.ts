/**
 * Opt-in: settles real EIP-3009 payments against a local anvil fork of Robinhood Chain. Nothing touches the real
 * chain except reads through the fork; all keys are generated for this run and the funds are fork-only storage edits.
 *
 *   pnpm test:fork
 *   ANVIL_BIN=~/.foundry/bin/anvil FORK_RPC_URL=https://… pnpm test:fork
 *
 * Needs anvil (Foundry) on PATH or in ANVIL_BIN. FORK_RPC_URL defaults to publicnode; it is never printed.
 */
import { spawn, type ChildProcess } from "node:child_process";

import { createPublicClient, encodeAbiParameters, http, keccak256, numberToHex, pad, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { safe, TOKEN_ABI } from "../src/chain.js";
import { DEFAULT_RPC_URL, USDG } from "../src/constants.js";
import { createFacilitator } from "../src/facilitator.js";
import { requirements, signedPayment } from "./helpers.js";

const enabled = process.env.FORK_TEST === "1";
/** USDG keeps balances in the mapping at storage slot 1 (checked on the fork in beforeAll). */
const BALANCES_SLOT = 1n;

describe.skipIf(!enabled)("anvil fork of Robinhood Chain", () => {
  let anvil: ChildProcess | undefined;
  let stderr = "";
  const port = 20_000 + Math.floor(Math.random() * 10_000);
  const rpcUrl = `http://127.0.0.1:${port}`;
  const client = createPublicClient({ transport: http(rpcUrl) });
  const rpc = (method: string, params: unknown[]) => client.request({ method, params } as never) as Promise<unknown>;

  const operatorKey = generatePrivateKey();
  const operator = privateKeyToAccount(operatorKey).address;
  const facilitator = () => createFacilitator({ operatorKey, rpcUrl, pollIntervalMs: 100 });

  const usdg = (owner: Address) => client.readContract({ address: USDG, abi: TOKEN_ABI, functionName: "balanceOf", args: [owner] });
  const fund = async (owner: Address, units: bigint) => {
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BALANCES_SLOT]));
    await rpc("anvil_setStorageAt", [USDG, slot, pad(numberToHex(units), { size: 32 })]);
  };
  const operatorNonce = () => client.getTransactionCount({ address: operator });
  const now = () => BigInt(Math.floor(Date.now() / 1000));

  /** A funded throwaway payer and a fresh payTo, signed for 0.01 USDG. */
  async function payment(funded = true) {
    const key = generatePrivateKey();
    const payTo = privateKeyToAccount(generatePrivateKey()).address;
    if (funded) await fund(privateKeyToAccount(key).address, 1_000_000n);
    return signedPayment({ key, req: requirements({ payTo, amount: "10000" }), validAfter: now() - 60n, validBefore: now() + 300n });
  }

  beforeAll(async () => {
    const bin = process.env.ANVIL_BIN || "anvil";
    anvil = spawn(bin, ["--fork-url", process.env.FORK_RPC_URL || DEFAULT_RPC_URL, "--port", String(port), "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
    anvil.stderr?.on("data", (d) => (stderr += String(d)));
    const failed = new Promise<never>((_, reject) => anvil?.on("error", (e) => reject(new Error(`could not start ${bin}: ${e.message}`))));
    const ready = (async () => {
      for (let i = 0; i < 120; i++) {
        try {
          return await client.getChainId();
        } catch {
          if (anvil?.exitCode !== null) throw new Error(`anvil exited: ${safe(stderr)}`);
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      throw new Error(`anvil did not answer: ${safe(stderr)}`);
    })();
    expect(await Promise.race([ready, failed])).toBe(4663);

    // The storage layout assumption, checked before any test relies on it.
    const probe = privateKeyToAccount(generatePrivateKey()).address;
    await fund(probe, 123n);
    expect(await usdg(probe)).toBe(123n);

    await rpc("anvil_setBalance", [operator, numberToHex(10n ** 17n)]); // 0.1 ETH, fork only
  }, 90_000);

  afterAll(() => {
    anvil?.kill();
  });

  it("verifies and settles a real payment, and the USDG moves", async () => {
    const f = facilitator();
    const { payload, req, signer } = await payment();
    expect(await f.verify(payload, req)).toEqual({ isValid: true, payer: signer });

    const before = await operatorNonce();
    const res = await f.settle(payload, req);
    expect(res).toMatchObject({ success: true, payer: signer, network: "eip155:4663", amount: "10000" });
    const receipt = await client.getTransactionReceipt({ hash: res.transaction as Hex });
    expect(receipt.status).toBe("success");
    expect(receipt.from.toLowerCase()).toBe(operator.toLowerCase());
    expect(receipt.gasUsed).toBeLessThan(150_000n); // about 102,000 here: a new payTo and a new authorization slot
    expect(await usdg(req.payTo as Address)).toBe(10_000n);
    expect(await usdg(signer)).toBe(990_000n);
    expect(await operatorNonce()).toBe(before + 1);
    const nonce = payload.payload.authorization.nonce as Hex;
    expect(await client.readContract({ address: USDG, abi: TOKEN_ABI, functionName: "authorizationState", args: [signer, nonce] })).toBe(true);
  });

  it("never settles one authorization twice: same store, a fresh store, and concurrent calls", async () => {
    const f = facilitator();
    const { payload, req } = await payment();
    const before = await operatorNonce();
    const results = await Promise.all([f.settle(payload, req), f.settle(payload, req), f.settle(payload, req)]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(await operatorNonce()).toBe(before + 1);

    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
    // Another instance without the record still refuses: the chain says the nonce is used.
    const other = await facilitator().settle(payload, req);
    expect(other).toMatchObject({ success: false, transaction: "" });
    expect(await operatorNonce()).toBe(before + 1);
  });

  it("refuses an unfunded payer without spending gas", async () => {
    const f = facilitator();
    const { payload, req } = await payment(false);
    const before = await operatorNonce();
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "insufficient_funds" });
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "insufficient_funds" });
    expect(await operatorNonce()).toBe(before);
  });

  it("reports health from the fork", async () => {
    expect(await facilitator().health()).toMatchObject({ ok: true, rpcChainId: 4663, operator, canSettle: true });
  });
});
