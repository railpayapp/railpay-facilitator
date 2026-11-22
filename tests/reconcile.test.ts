import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { afterAll, describe, expect, it } from "vitest";

import { createFacilitator, type FacilitatorOptions } from "../src/facilitator.js";
import { sqliteStore } from "../src/sqlite.js";
import { memoryStore } from "../src/store.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR_KEY, signedPayment } from "./helpers.js";

const dir = mkdtempSync(join(tmpdir(), "railpay-facilitator-reconcile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const make = (chain: FakeChain, over: Partial<FacilitatorOptions> = {}) =>
  createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport, receiptTimeoutMs: 60, pollIntervalMs: 5, ...over });

describe("reconcile", () => {
  it("rebroadcasts the identical transaction after the node dropped it", async () => {
    const chain = new FakeChain();
    const f = make(chain);
    chain.autoMine = false;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const pending = await f.settle(payload, req);
    expect(pending.errorReason).toBe("settlement_pending");
    chain.dropMempool();
    chain.autoMine = true;
    const r = await f.settle(payload, req);
    expect(r).toMatchObject({ success: true, transaction: pending.transaction });
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toBe(chain.sent[0]); // the same signed bytes, never a second transaction
  });

  it("recovers after a restart from a SQLite store", async () => {
    const chain = new FakeChain();
    const path = join(dir, "restart.db");
    const before = sqliteStore(path);
    chain.autoMine = false;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const pending = await make(chain, { store: before }).settle(payload, req);
    expect(pending.errorReason).toBe("settlement_pending");
    before.close();

    // The process restarts and the node lost its mempool too.
    chain.dropMempool();
    chain.autoMine = true;
    const after = sqliteStore(path);
    const restarted = make(chain, { store: after });
    expect(await restarted.settle(payload, req)).toMatchObject({ success: true, transaction: pending.transaction });
    expect(await restarted.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    after.close();
  });

  it("settles an unknown send outcome on the next call", async () => {
    const chain = new FakeChain();
    const f = make(chain);
    chain.failures.set("eth_sendRawTransaction", new Error("connect ECONNREFUSED"));
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const pending = await f.settle(payload, req);
    expect(pending.errorReason).toBe("settlement_pending");
    chain.failures.delete("eth_sendRawTransaction");
    expect(await f.settle(payload, req)).toMatchObject({ success: true, transaction: pending.transaction });
  });

  it("starts over once when another transaction took the operator nonce", async () => {
    const chain = new FakeChain();
    const store = memoryStore();
    const f = make(chain, { store });
    chain.autoMine = false;
    const a = await signedPayment({ key: generatePrivateKey() });
    const first = await f.settle(a.payload, a.req);
    expect(first.errorReason).toBe("settlement_pending");
    chain.dropMempool();
    chain.autoMine = true;
    const b = await signedPayment({ key: generatePrivateKey() });
    expect((await f.settle(b.payload, b.req)).success).toBe(true); // reuses operator nonce 0
    expect(parseTransaction(chain.sent[1] as Hex).nonce).toBe(0);

    const g = make(chain, { store }); // a second facilitator on the same store races the restart
    const results = await Promise.all([f.settle(a.payload, a.req), g.settle(a.payload, a.req)]);
    const ok = results.filter((r) => r.success);
    expect(ok).toHaveLength(1);
    expect(ok[0]?.transaction).not.toBe(first.transaction);
    expect(ok[0]?.transaction).toBe(keccak256(chain.sent.at(-1) as Hex));
    expect(parseTransaction(chain.sent.at(-1) as Hex).nonce).toBe(1);
    expect(chain.receipts.get(first.transaction)).toBeUndefined();
  });

  it("does not start over when the authorization was used by someone else meanwhile", async () => {
    const chain = new FakeChain();
    const f = make(chain);
    chain.autoMine = false;
    const a = await signedPayment({ key: generatePrivateKey() });
    expect((await f.settle(a.payload, a.req)).errorReason).toBe("settlement_pending");
    chain.dropMempool();
    chain.autoMine = true;
    const b = await signedPayment({ key: generatePrivateKey() });
    await f.settle(b.payload, b.req); // takes operator nonce 0
    chain.markUsed(a.signer, a.auth.nonce); // another facilitator settled it
    const sent = chain.sent.length;
    expect(await f.settle(a.payload, a.req)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(chain.sent.length).toBe(sent); // the rebroadcast of the dead bytes is refused (nonce too low), nothing new is sent
  });

  it("reports a transaction that can no longer land before the authorization expires", async () => {
    const chain = new FakeChain();
    const f = make(chain);
    chain.autoMine = false;
    const { payload, req, signer } = await signedPayment({ key: generatePrivateKey() });
    const before = chain.balanceOf(signer);
    const pending = await f.settle(payload, req);
    chain.timestamp += 400n; // past validBefore on the chain clock
    const r = await f.settle(payload, req);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_exact_evm_payload_authorization_valid_before", transaction: pending.transaction });
    await chain.mine(); // it is mined later and reverts
    expect(chain.receipts.get(pending.transaction)?.status).toBe("0x0");
    expect(chain.balanceOf(signer)).toBe(before);
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
  });

  it("keeps answering pending while the RPC cannot tell", async () => {
    const chain = new FakeChain();
    const f = make(chain);
    chain.autoMine = false;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const pending = await f.settle(payload, req);
    chain.failures.set("eth_getTransactionReceipt", new Error("fetch failed"));
    expect(await f.settle(payload, req)).toMatchObject({ errorReason: "settlement_pending", transaction: pending.transaction });
    chain.failures.delete("eth_getTransactionReceipt");
    await chain.mine();
    expect((await f.settle(payload, req)).success).toBe(true);
  });
});
