import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { VERSION } from "../src/constants.js";
import { createFacilitator, type FacilitatorOptions } from "../src/facilitator.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR, OPERATOR_KEY, signedPayment } from "./helpers.js";

const setup = (over: Partial<FacilitatorOptions> = {}, chain = new FakeChain()) => {
  const f = createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport, receiptTimeoutMs: 60, pollIntervalMs: 5, ...over });
  return { f, chain, app: createApp(f) };
};

describe("low operator gas", () => {
  it("pauses settlement below MIN_OPERATOR_ETH before claiming or counting anything, and resumes once funded", async () => {
    const { f, chain } = setup({ rateLimits: { payToPerHour: 1 } });
    chain.setEth(OPERATOR, 400_000_000_000_000n); // 0.0004 ETH < 0.0005 ETH default
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const out = await f.settleRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(out.status).toBe(503);
    expect(out.retryAfter).toBe(5);
    expect(out.body).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    expect(out.body.errorMessage).toContain("0.0004 ETH, below the 0.0005 ETH minimum");
    expect(chain.sent).toHaveLength(0);
    expect((await f.verify(payload, req)).isValid).toBe(true); // verify is about the payment, not the operator

    chain.setEth(OPERATOR, 10n ** 18n);
    expect((await f.settle(payload, req)).success).toBe(true); // not claimed and not counted by the payTo limit
  });

  it("refuses when the operator balance cannot be read", async () => {
    const { f, chain } = setup();
    chain.failures.set("eth_getBalance", new Error("fetch failed"));
    const { payload, req } = await signedPayment({ key: generatePrivateKey() });
    const out = await f.settleRequest({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(out.status).toBe(503);
    expect(out.body.errorMessage).toContain("operator's ETH balance");
  });

  it("caps the fee: refuses while the base fee is above maxFeePerGas and never offers more", async () => {
    const { f, chain } = setup({ maxFeePerGas: 30_000_000n });
    const ok = await signedPayment({ key: generatePrivateKey() });
    expect((await f.settle(ok.payload, ok.req)).success).toBe(true); // base 0.02 gwei, max fee capped at 0.03
    chain.baseFee = 40_000_000n;
    const high = await signedPayment({ key: generatePrivateKey() });
    const out = await f.settleRequest({ x402Version: 2, paymentPayload: high.payload, paymentRequirements: high.req });
    expect(out.status).toBe(503);
    expect(out.body.errorMessage).toContain("price cap");
    expect(chain.sent).toHaveLength(1);
  });
});

describe("GET /health", () => {
  it("reports the operator, its ETH and that settlement is open", async () => {
    const { app } = setup();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      version: VERSION,
      network: "eip155:4663",
      chainId: 4663,
      rpcChainId: 4663,
      asset: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      operator: OPERATOR,
      ethBalance: "1000000000000000000",
      minEthBalance: "500000000000000",
      canSettle: true,
    });
  });

  it("answers 503 with the reason when gas is low, the RPC is down or on another chain", async () => {
    const low = setup();
    low.chain.setEth(OPERATOR, 0n);
    const a = await low.app.request("/health");
    expect(a.status).toBe(503);
    expect(await a.json()).toMatchObject({ ok: false, canSettle: false, ethBalance: "0", reason: expect.stringContaining("needs to add ETH") });

    const down = setup();
    down.chain.failures.set("eth_chainId", new Error("fetch failed"));
    down.chain.failures.set("eth_getBalance", new Error("fetch failed"));
    expect(await (await down.app.request("/health")).json()).toMatchObject({ ok: false, rpcChainId: null, ethBalance: null, reason: "The RPC is unreachable" });

    const wrong = setup();
    wrong.chain.chainId = 1;
    expect(await (await wrong.app.request("/health")).json()).toMatchObject({ ok: false, rpcChainId: 1, reason: "The RPC is on chain 1, expected 4663" });
  });

  it("never shows the RPC URL", async () => {
    const f = createFacilitator({ operatorKey: OPERATOR_KEY, rpcUrl: "http://127.0.0.1:9/v2/very-secret-key" });
    const text = await (await createApp(f).request("/health")).text();
    expect(text).not.toContain("very-secret-key");
    expect(text).not.toContain("127.0.0.1");
  });
});

describe("gas settings", () => {
  const base = { OPERATOR_KEY: generatePrivateKey() };
  it("reads MIN_OPERATOR_ETH in ETH and MAX_FEE_PER_GAS_GWEI in gwei", () => {
    expect(loadConfig({ ...base, MIN_OPERATOR_ETH: "0.001", MAX_FEE_PER_GAS_GWEI: "0.5" })).toMatchObject({ minOperatorEth: 10n ** 15n, maxFeePerGas: 500_000_000n });
    expect(loadConfig({ ...base, MIN_OPERATOR_ETH: "0" }).minOperatorEth).toBe(0n);
    expect(() => loadConfig({ ...base, MIN_OPERATOR_ETH: "1e-3" })).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, MAX_FEE_PER_GAS_GWEI: "0" })).toThrow(ConfigError);
  });
});
