import { keccak256, parseTransaction, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createFacilitator, type FacilitatorOptions } from "../src/facilitator.js";
import { memoryStore } from "../src/store.js";
import { FakeChain, TRANSFER_GAS } from "./fake-chain.js";
import { NOW_MS, OPERATOR, OPERATOR_KEY, PAY_TO, signedPayment } from "./helpers.js";

const setup = (over: Partial<FacilitatorOptions> = {}, chain = new FakeChain()) => {
  const events: { event: string; fields: Record<string, unknown> }[] = [];
  const f = createFacilitator({
    operatorKey: OPERATOR_KEY,
    now: () => NOW_MS,
    transport: chain.transport,
    receiptTimeoutMs: 60,
    pollIntervalMs: 5,
    log: (event, fields) => events.push({ event, fields }),
    ...over,
  });
  return { f, chain, events };
};

describe("settle", () => {
  it("sends transferWithAuthorization from the operator and confirms the Transfer log", async () => {
    const { f, chain } = setup();
    const key = generatePrivateKey();
    const { payload, req, signer, auth } = await signedPayment({ key });
    const before = chain.balanceOf(signer);

    const r = await f.settle(payload, req);
    expect(r).toEqual({ success: true, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), network: "eip155:4663", payer: signer, amount: "10000" });
    expect(chain.sent).toHaveLength(1);
    const raw = chain.sent[0] as Hex;
    expect(keccak256(raw)).toBe(r.transaction);
    expect(chain.balanceOf(signer)).toBe(before - 10_000n);
    expect(chain.balanceOf(PAY_TO)).toBe(chain.defaultBalance + 10_000n);
    expect(chain.isUsed(signer, auth.nonce)).toBe(true);

    const tx = parseTransaction(raw);
    expect(tx.type).toBe("eip1559");
    expect(tx.chainId).toBe(4663);
    expect(tx.to?.toLowerCase()).toBe(chain.token.toLowerCase());
    expect(tx.value ?? 0n).toBe(0n);
    expect(tx.nonce).toBe(0);
    expect(tx.gas).toBe(TRANSFER_GAS + TRANSFER_GAS / 4n);
    expect(tx.maxFeePerGas).toBe(chain.baseFee * 2n);
    expect(tx.maxPriorityFeePerGas ?? 0n).toBe(0n);
    expect(chain.simulatedFrom.at(-1)).toBe(OPERATOR);
  });

  it("two concurrent settles of one authorization produce one transaction and one success", async () => {
    const { f, chain } = setup();
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const results = await Promise.all([f.settle(payload, req), f.settle(payload, req)]);
    expect(chain.count("eth_sendRawTransaction")).toBe(1);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)).toMatchObject({ errorReason: "invalid_transaction_state", transaction: "" });
  });

  it("two facilitators sharing a store never both send", async () => {
    const chain = new FakeChain();
    const store = memoryStore();
    const a = setup({ store }, chain).f;
    const b = setup({ store }, chain).f;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const results = await Promise.all([a.settle(payload, req), b.settle(payload, req), a.settle(payload, req), b.settle(payload, req)]);
    expect(chain.count("eth_sendRawTransaction")).toBe(1);
    expect(results.filter((r) => r.success)).toHaveLength(1);
  });

  it("serializes many settlements with consecutive operator nonces", async () => {
    const { f, chain } = setup();
    const payments = await Promise.all(Array.from({ length: 8 }, () => signedPayment({ key: generatePrivateKey() })));
    const results = await Promise.all(payments.map(({ payload, req }) => f.settle(payload, req)));
    expect(results.every((r) => r.success)).toBe(true);
    expect(chain.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(results.map((r) => r.transaction)).size).toBe(8);
  });

  it("refuses a replay of a settled authorization without sending", async () => {
    const { f, chain } = setup();
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const first = await f.settle(payload, req);
    expect(first.success).toBe(true);
    const again = await f.settle(payload, req);
    expect(again).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
    expect(again.errorMessage).toContain(first.transaction);
    expect(chain.sent).toHaveLength(1);
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("an authorization already used on-chain (settled elsewhere) is refused before sending", async () => {
    const { f, chain } = setup();
    const { payload, req, signer, auth } = await signedPayment({ key: generatePrivateKey() });
    chain.markUsed(signer, auth.nonce);
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(chain.sent).toHaveLength(0);
  });

  it("runs every verify check first and sends nothing when one fails", async () => {
    const { f, chain } = setup();
    const key = generatePrivateKey();
    const wrongValue = await signedPayment({ key, value: 1n });
    expect(await f.settle(wrongValue.payload, wrongValue.req)).toMatchObject({ errorReason: "invalid_exact_evm_payload_authorization_value_mismatch" });
    const expired = await signedPayment({ key, validBefore: BigInt(NOW_MS / 1000) + 2n });
    expect(await f.settle(expired.payload, expired.req)).toMatchObject({ errorReason: "invalid_exact_evm_payload_authorization_valid_before" });
    const poor = await signedPayment({ key });
    chain.setBalance(poor.signer, 5n);
    expect(await f.settle(poor.payload, poor.req)).toMatchObject({ errorReason: "insufficient_funds", payer: poor.signer });
    expect(await f.settle({ nope: true }, poor.req)).toMatchObject({ success: false, errorReason: "invalid_x402_version", transaction: "", network: "eip155:4663" });
    expect(chain.sent).toHaveLength(0);
  });

  it("answers settlement_pending with the hash, then success once it confirms", async () => {
    const { f, chain } = setup();
    chain.autoMine = false;
    const { payload, req, signer } = await signedPayment({ key: generatePrivateKey() });
    const pending = await f.settle(payload, req);
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending", payer: signer, network: "eip155:4663" });
    expect(pending.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });

    expect(await f.settle(payload, req)).toMatchObject({ errorReason: "settlement_pending", transaction: pending.transaction });
    await chain.mine();
    expect(await f.settle(payload, req)).toEqual({ success: true, transaction: pending.transaction, network: "eip155:4663", payer: signer, amount: "10000" });
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(chain.sent).toHaveLength(1);
  });

  it("only one caller gets success when two facilitators reconcile the same pending settlement", async () => {
    const chain = new FakeChain();
    const store = memoryStore();
    const a = setup({ store }, chain).f;
    const b = setup({ store }, chain).f;
    chain.autoMine = false;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    expect((await a.settle(payload, req)).errorReason).toBe("settlement_pending");
    await chain.mine();
    const results = await Promise.all([a.settle(payload, req), b.settle(payload, req)]);
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(results.find((r) => !r.success)).toMatchObject({ errorReason: "invalid_payload" });
  });

  it("reports a transaction that reverted on-chain and never retries it", async () => {
    const { f, chain, events } = setup();
    const { payload, req, signer } = await signedPayment({ key: generatePrivateKey() });
    chain.beforeMine = () => chain.setBalance(signer, 0n); // the payer moves the funds between simulation and mining
    const r = await f.settle(payload, req);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_transaction_state", payer: signer });
    expect(r.transaction).toBe(keccak256(chain.sent[0] as Hex));
    chain.beforeMine = null;
    chain.setBalance(signer, 10n ** 9n);
    expect(await f.settle(payload, req)).toMatchObject({ success: false, errorReason: "invalid_transaction_state", transaction: "" });
    expect(await f.verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "invalid_transaction_state" });
    expect(chain.sent).toHaveLength(1);
    expect(events.map((e) => e.event)).toContain("settle.reverted");
  });

  it("does not trust a confirmed transaction without the exact Transfer log", async () => {
    const { f, chain } = setup();
    chain.omitTransferLog = true;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const r = await f.settle(payload, req);
    expect(r).toMatchObject({ success: false, errorReason: "invalid_transaction_state" });
    expect(r.errorMessage).toContain("found 0");
  });

  it("still confirms when the send answer is lost after broadcast", async () => {
    const { f, chain } = setup();
    chain.loseSendResponse = true;
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const r = await f.settle(payload, req);
    expect(r.success).toBe(true);
    expect(r.transaction).toBe(keccak256(chain.sent[0] as Hex));
  });

  it("forgets the claim when the RPC refuses the transaction, so a retry can settle", async () => {
    const { f, chain } = setup();
    chain.failures.set("eth_sendRawTransaction", { code: -32000, message: "txpool is full" });
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const refused = await f.settleRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(refused.status).toBe(502);
    expect(refused.body).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    expect(refused.body.errorMessage).toContain("txpool is full");
    chain.failures.delete("eth_sendRawTransaction");
    expect((await f.settle(payload, req)).success).toBe(true);
    expect(chain.sent).toHaveLength(1);
  });

  it("answers pending, never failure, when the send outcome is unknown", async () => {
    const { f, chain } = setup();
    chain.failures.set("eth_sendRawTransaction", new Error("connect ECONNREFUSED"));
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const r = await f.settle(payload, req);
    expect(r).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(r.transaction).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("refuses with 503 and sends nothing when the operator cannot pay the gas", async () => {
    const { f, chain } = setup();
    chain.setEth(OPERATOR, 1000n);
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const out = await f.settleRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(out.status).toBe(503);
    expect(out.body).toMatchObject({ success: false, errorReason: "unexpected_settle_error" });
    expect(chain.sent).toHaveLength(0);
    chain.setEth(OPERATOR, 10n ** 18n);
    expect((await f.settle(payload, req)).success).toBe(true);
  });

  it("refuses a gas estimate above maxGas", async () => {
    const { f, chain } = setup({ maxGas: 40_000n });
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const out = await f.settleRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(out.status).toBe(503);
    expect(out.body.errorMessage).toContain("40000");
    expect(chain.sent).toHaveLength(0);
  });

  it("answers 503 when the single sender is busy for too long", async () => {
    const { f, chain } = setup({ receiptTimeoutMs: 300, queueTimeoutMs: 20 });
    chain.autoMine = false;
    const one = await signedPayment({ key: generatePrivateKey() });
    const two = await signedPayment({ key: generatePrivateKey() });
    const [first, second] = await Promise.all([
      f.settleRequest({ x402Version: 2, paymentPayload: one.payload, paymentRequirements: one.req }),
      new Promise((r) => setTimeout(r, 5)).then(() => f.settleRequest({ x402Version: 2, paymentPayload: two.payload, paymentRequirements: two.req })),
    ]);
    expect(first.body.errorReason).toBe("settlement_pending");
    expect(second.status).toBe(503);
    expect(chain.sent).toHaveLength(1);
    await chain.mine();
    chain.autoMine = true;
    expect((await f.settle(two.payload, two.req)).success).toBe(true);
  });

  it("logs events without the operator key or the RPC URL", async () => {
    const { f, events } = setup();
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    await f.settle(payload, req);
    const text = JSON.stringify(events);
    expect(events.map((e) => e.event)).toEqual(["settle.submitted", "settle.settled"]);
    expect(text).not.toContain(OPERATOR_KEY.slice(2));
  });

  it("rejects a malformed operator key", () => {
    expect(() => createFacilitator({ operatorKey: "0x1234" as Hex })).toThrow(TypeError);
  });
});
