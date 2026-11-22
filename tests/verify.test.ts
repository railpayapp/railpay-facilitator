import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createFacilitator } from "../src/facilitator.js";
import { FakeChain, revertData } from "./fake-chain.js";
import { mutate, NOW_MS, NOW_S, OPERATOR, OPERATOR_KEY, PAY_TO, requirements, signedPayment } from "./helpers.js";

const key = generatePrivateKey();
const facilitator = (chain = new FakeChain()) => createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport });

describe("verify (signature, amount, recipient, window)", () => {
  it("accepts a correctly signed EIP-3009 authorization", async () => {
    const { payload, req, signer } = await signedPayment({ key });
    expect(await facilitator().verify(payload, req)).toEqual({ isValid: true, payer: signer });
  });

  it("accepts the POST /verify body shape", async () => {
    const { payload, req } = await signedPayment({ key });
    const r = await facilitator().verifyRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(r.isValid).toBe(true);
  });

  it("rejects a payment to another recipient", async () => {
    const { payload, req, signer } = await signedPayment({ key, to: "0x000000000000000000000000000000000000dEaD" });
    expect(await facilitator().verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_recipient_mismatch", payer: signer });
  });

  it("rejects an amount that is not exactly the price", async () => {
    for (const value of [9_999n, 10_001n]) {
      const { payload, req } = await signedPayment({ key, value });
      expect((await facilitator().verify(payload, req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_value_mismatch");
    }
  });

  it("rejects a payment for another network", async () => {
    const req = requirements({ network: "eip155:8453" });
    const { payload } = await signedPayment({ key, req });
    expect((await facilitator().verify(payload, req)).invalidReason).toBe("invalid_network");
  });

  it("rejects an expired authorization and one that expires within the safety margin", async () => {
    const expired = await signedPayment({ key, validBefore: NOW_S - 1n });
    expect((await facilitator().verify(expired.payload, expired.req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
    const tooSoon = await signedPayment({ key, validBefore: NOW_S + 5n });
    expect((await facilitator().verify(tooSoon.payload, tooSoon.req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
    const justEnough = await signedPayment({ key, validBefore: NOW_S + 6n });
    expect((await facilitator().verify(justEnough.payload, justEnough.req)).isValid).toBe(true);
  });

  it("rejects an authorization that is not valid yet", async () => {
    const { payload, req } = await signedPayment({ key, validAfter: NOW_S + 30n });
    expect((await facilitator().verify(payload, req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_after");
  });

  it("rejects a signature from another key", async () => {
    const other = await signedPayment({ key: generatePrivateKey() });
    const mine = await signedPayment({ key });
    const forged = mutate(other.payload, (p) => (p.payload.authorization.from = mine.signer));
    expect((await facilitator().verify(forged, other.req)).invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects fields changed after signing", async () => {
    const { payload, req } = await signedPayment({ key });
    const tampered = mutate(payload, (p) => (p.payload.authorization.nonce = `0x${"22".repeat(32)}`));
    expect((await facilitator().verify(tampered, req)).invalidReason).toBe("invalid_exact_evm_payload_signature");
  });

  it("rejects signatures over another EIP-712 domain", async () => {
    for (const domain of [{ chainId: 1 }, { name: "USD Coin" }, { version: "2" }, { verifyingContract: PAY_TO }]) {
      const { payload, req } = await signedPayment({ key, domain });
      expect((await facilitator().verify(payload, req)).invalidReason).toBe("invalid_exact_evm_payload_signature");
    }
  });

  it("checks the window against the injected clock", async () => {
    const { payload, req } = await signedPayment({ key });
    const later = createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS + 600_000, transport: new FakeChain().transport });
    expect((await later.verify(payload, req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });
});

describe("verify (on-chain)", () => {
  it("reads the nonce state and the balance of the payer", async () => {
    const chain = new FakeChain();
    const { payload, req } = await signedPayment({ key });
    expect((await facilitator(chain).verify(payload, req)).isValid).toBe(true);
    expect(chain.count("eth_call")).toBe(3); // nonce state, balance, simulation
  });

  it("simulates transferWithAuthorization and maps the token's revert", async () => {
    const { payload, req } = await signedPayment({ key });
    const cases: [string, string][] = [
      [revertData.insufficientFunds, "insufficient_funds"],
      [revertData.invalidSignature, "invalid_exact_evm_payload_signature"],
      [revertData.reason("FiatToken: account is blacklisted"), "invalid_transaction_state"],
      ["0xdeadbeef", "invalid_transaction_state"],
    ];
    for (const [data, expected] of cases) {
      const chain = new FakeChain();
      chain.transferRevert = data as `0x${string}`;
      const r = await facilitator(chain).verify(payload, req);
      expect(r, data).toMatchObject({ isValid: false, invalidReason: expected });
    }
    const chain = new FakeChain();
    chain.transferRevert = revertData.reason("FiatToken: account is blacklisted");
    expect((await facilitator(chain).verify(payload, req)).invalidMessage).toContain("blacklisted");
  });

  it("the simulation runs the real token checks (expiry on the chain clock)", async () => {
    const chain = new FakeChain();
    chain.timestamp = NOW_S + 400n; // the chain is ahead of the facilitator's clock
    const { payload, req } = await signedPayment({ key });
    expect((await facilitator(chain).verify(payload, req)).invalidReason).toBe("invalid_exact_evm_payload_authorization_valid_before");
  });

  it("rejects an authorization whose nonce was already used", async () => {
    const chain = new FakeChain();
    const { payload, req, auth } = await signedPayment({ key });
    chain.markUsed(auth.from, auth.nonce);
    expect(await facilitator(chain).verify(payload, req)).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
  });

  it("rejects a payer without enough USDG", async () => {
    const chain = new FakeChain();
    const { payload, req, signer } = await signedPayment({ key });
    chain.setBalance(signer, 9_999n);
    expect((await facilitator(chain).verify(payload, req)).invalidReason).toBe("insufficient_funds");
    chain.setBalance(signer, 10_000n);
    expect((await facilitator(chain).verify(payload, req)).isValid).toBe(true);
  });

  it("refuses an RPC on another chain", async () => {
    const chain = new FakeChain();
    chain.chainId = 1;
    const { payload, req } = await signedPayment({ key });
    const r = await facilitator(chain).verify(payload, req);
    expect(r).toMatchObject({ isValid: false, invalidReason: "unexpected_verify_error" });
    expect(r.invalidMessage).toContain("chain 1");
  });

  it("answers unexpected_verify_error when the RPC fails", async () => {
    const chain = new FakeChain();
    chain.failures.set("eth_call", new Error("socket hang up"));
    const { payload, req } = await signedPayment({ key });
    expect((await facilitator(chain).verify(payload, req)).invalidReason).toBe("unexpected_verify_error");
    chain.failures.set("eth_call", { code: -32005, message: "rate limited" });
    const r = await facilitator(chain).verify(payload, req);
    expect(r.invalidReason).toBe("unexpected_verify_error");
    expect(r.invalidMessage).toContain("rate limited");
  });

  it("never puts the RPC URL in an answer", async () => {
    const secret = "k3y-do-not-leak";
    const f = createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, rpcUrl: `http://127.0.0.1:9/v2/${secret}` });
    const { payload, req } = await signedPayment({ key });
    const r = await f.verify(payload, req);
    expect(r.invalidReason).toBe("unexpected_verify_error");
    expect(JSON.stringify(r)).not.toContain(secret);
    expect(JSON.stringify(r)).not.toContain("127.0.0.1");
  });

  it("does not touch the chain when an offline check fails", async () => {
    const chain = new FakeChain();
    const { payload, req } = await signedPayment({ key, value: 1n });
    await facilitator(chain).verify(payload, req);
    expect(chain.calls).toEqual([]);
  });
});

describe("supported", () => {
  it("lists exact on Robinhood Chain", () => {
    expect(facilitator().supported()).toEqual({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: { "eip155:*": [OPERATOR] } });
  });
});
