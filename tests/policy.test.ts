import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createFacilitator, type FacilitatorOptions } from "../src/facilitator.js";
import { fromUnits, toUnits } from "../src/units.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR_KEY, PAY_TO, requirements, signedPayment } from "./helpers.js";

const setup = (over: Partial<FacilitatorOptions> = {}) => {
  const chain = new FakeChain();
  const f = createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport, receiptTimeoutMs: 60, pollIntervalMs: 5, ...over });
  return { f, chain };
};

describe("amount limits", () => {
  it("refuses below 0.001 USDG and above 100 USDG by default, before reading the chain", async () => {
    const { f, chain } = setup();
    const low = await signedPayment({ key: generatePrivateKey(), req: requirements({ amount: "999" }) });
    expect(await f.verify(low.payload, low.req)).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements", invalidMessage: expect.stringContaining("0.001 USDG") });
    expect(await f.settle(low.payload, low.req)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    const high = await signedPayment({ key: generatePrivateKey(), req: requirements({ amount: "100000001" }) });
    expect(await f.settle(high.payload, high.req)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements", errorMessage: expect.stringContaining("100 USDG") });
    expect(chain.calls).toEqual([]);
    expect(chain.sent).toHaveLength(0);
  });

  it("settles exactly at the limits", async () => {
    const { f } = setup();
    for (const amount of ["1000", "100000000"]) {
      const p = await signedPayment({ key: generatePrivateKey(), req: requirements({ amount }) });
      expect((await f.settle(p.payload, p.req)).success).toBe(true);
    }
  });

  it("takes custom limits and validates them", async () => {
    const { f } = setup({ minAmount: 5_000n, maxAmount: 20_000n });
    expect(f.limits).toMatchObject({ minAmount: 5_000n, maxAmount: 20_000n, payToAllowlist: null });
    const big = await signedPayment({ key: generatePrivateKey(), req: requirements({ amount: "20001" }) });
    expect((await f.verify(big.payload, big.req)).invalidReason).toBe("invalid_payment_requirements");
    expect(() => setup({ minAmount: 0n })).toThrow(RangeError);
    expect(() => setup({ minAmount: 10n, maxAmount: 5n })).toThrow(RangeError);
  });
});

describe("payTo allowlist", () => {
  it("settles only to listed addresses, compared without case", async () => {
    const other = privateKeyToAccount(generatePrivateKey()).address;
    const { f, chain } = setup({ payToAllowlist: [PAY_TO.toLowerCase()] });
    const ok = await signedPayment({ key: generatePrivateKey() });
    expect((await f.settle(ok.payload, ok.req)).success).toBe(true);
    const no = await signedPayment({ key: generatePrivateKey(), req: requirements({ payTo: other }) });
    expect(await f.verify(no.payload, no.req)).toMatchObject({ isValid: false, invalidReason: "invalid_payment_requirements" });
    expect(await f.settle(no.payload, no.req)).toMatchObject({ success: false, errorReason: "invalid_payment_requirements" });
    expect(chain.sent).toHaveLength(1);
    expect(f.limits.payToAllowlist).toEqual([PAY_TO]);
    expect(() => setup({ payToAllowlist: ["0x1234"] })).toThrow(TypeError);
  });

  it("refuses self-payments, which would only burn the operator's gas", async () => {
    const key = generatePrivateKey();
    const self = privateKeyToAccount(key).address;
    const { f, chain } = setup();
    const p = await signedPayment({ key, req: requirements({ payTo: self }) });
    expect(await f.settle(p.payload, p.req)).toMatchObject({ success: false, errorReason: "invalid_payload", errorMessage: expect.stringContaining("same address") });
    expect(chain.sent).toHaveLength(0);
  });

  it("GET / shows the limits", async () => {
    const app = createApp(setup({ payToAllowlist: [PAY_TO] }).f);
    expect(await (await app.request("/")).json()).toMatchObject({ limits: { minAmount: "1000", maxAmount: "100000000", payToAllowlist: [PAY_TO] } });
  });
});

describe("limit settings", () => {
  const base = { OPERATOR_KEY: generatePrivateKey() };

  it("reads MIN_AMOUNT, MAX_AMOUNT and PAY_TO_ALLOWLIST in USDG", () => {
    const c = loadConfig({ ...base, MIN_AMOUNT: "0.01", MAX_AMOUNT: "25.5", PAY_TO_ALLOWLIST: ` ${PAY_TO}, ${PAY_TO.toLowerCase()} ` });
    expect(c.minAmount).toBe(10_000n);
    expect(c.maxAmount).toBe(25_500_000n);
    expect(c.payToAllowlist).toEqual([PAY_TO, PAY_TO.toLowerCase()]);
    expect(loadConfig(base)).toMatchObject({ minAmount: undefined, maxAmount: undefined, payToAllowlist: [] });
  });

  it("rejects bad values", () => {
    expect(() => loadConfig({ ...base, MIN_AMOUNT: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MIN_AMOUNT: "0.0000001" })).toThrow(/MIN_AMOUNT is not a valid amount/);
    expect(() => loadConfig({ ...base, MAX_AMOUNT: "-1" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MIN_AMOUNT: "2", MAX_AMOUNT: "1" })).toThrow(/MAX_AMOUNT must be at least MIN_AMOUNT/);
    expect(() => loadConfig({ ...base, PAY_TO_ALLOWLIST: "0xnope" })).toThrow(/PAY_TO_ALLOWLIST/);
  });
});

describe("units", () => {
  it("converts USDG decimals and base units", () => {
    expect(toUnits("1.5", 6)).toBe(1_500_000n);
    expect(toUnits("0.001", 6)).toBe(1_000n);
    expect(toUnits(2, 6)).toBe(2_000_000n);
    expect(() => toUnits("1.0000001", 6)).toThrow(RangeError);
    expect(() => toUnits("1e3", 6)).toThrow(RangeError);
    expect(fromUnits(1_500_000n, 6)).toBe("1.5");
    expect(fromUnits(1_000n, 6)).toBe("0.001");
    expect(fromUnits(100_000_000n, 6)).toBe("100");
  });
});
