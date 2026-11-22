import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp, lastForwardedFor } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createFacilitator, type FacilitatorOptions } from "../src/facilitator.js";
import { Mutex, QueueTimeoutError, RateLimiter } from "../src/limits.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR_KEY, requirements, signedPayment } from "./helpers.js";

const setup = (over: Partial<FacilitatorOptions> = {}) => {
  const chain = new FakeChain();
  let clock = NOW_MS;
  const f = createFacilitator({ operatorKey: OPERATOR_KEY, now: () => clock, transport: chain.transport, receiptTimeoutMs: 60, pollIntervalMs: 5, ...over });
  return { f, chain, advance: (ms: number) => (clock += ms) };
};

describe("RateLimiter", () => {
  it("counts per key in fixed windows and tells how long to wait", () => {
    let t = 0;
    const r = new RateLimiter(2, 60_000, () => t);
    expect(r.take("a")).toBeNull();
    expect(r.take("a")).toBeNull();
    expect(r.take("a")).toBe(60);
    expect(r.take("b")).toBeNull();
    t = 45_000;
    expect(r.take("a")).toBe(15);
    t = 60_000;
    expect(r.take("a")).toBeNull();
  });

  it("0 disables it, negative limits are refused", () => {
    const r = new RateLimiter(0, 1000);
    for (let i = 0; i < 100; i++) expect(r.take("a")).toBeNull();
    expect(() => new RateLimiter(-1, 1000)).toThrow(RangeError);
  });
});

describe("Mutex", () => {
  it("is FIFO and times out waiters", async () => {
    const m = new Mutex();
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => m.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
    const release = await m.acquire();
    await expect(m.acquire(10)).rejects.toBeInstanceOf(QueueTimeoutError);
    release();
    (await m.acquire(10))();
  });
});

describe("settlements per payTo", () => {
  it("answers 429 with Retry-After past the hourly limit, per payTo, and only counts new settlements", async () => {
    const { f, chain, advance } = setup({ rateLimits: { payToPerHour: 2 } });
    const settle = async (req = requirements()) => {
      const p = await signedPayment({ key: generatePrivateKey(), req });
      return { p, out: await f.settleRequest({ x402Version: 2, paymentPayload: p.payload, paymentRequirements: p.req }) };
    };
    const first = await settle();
    expect(first.out.body.success).toBe(true);
    expect((await settle()).out.body.success).toBe(true);
    // A repeat of a settled authorization is answered from the store and does not count.
    expect((await f.settle(first.p.payload, first.p.req)).errorReason).toBe("invalid_payload");

    const third = await settle();
    expect(third.out.status).toBe(429);
    expect(third.out.retryAfter).toBe(3600);
    expect(third.out.body).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    expect(third.out.body.errorMessage).toContain("payTo");

    const other = privateKeyToAccount(generatePrivateKey()).address;
    expect((await settle(requirements({ payTo: other }))).out.body.success).toBe(true);
    expect(chain.sent).toHaveLength(3);

    advance(60 * 60 * 1000);
    chain.timestamp += 3600n;
    const later = await signedPayment({ key: generatePrivateKey(), validAfter: chain.timestamp - 60n, validBefore: chain.timestamp + 300n });
    expect((await f.settle(later.payload, later.req)).success).toBe(true);
  });

  it("verify is not limited per payTo", async () => {
    const { f } = setup({ rateLimits: { payToPerHour: 1 } });
    for (let i = 0; i < 3; i++) {
      const p = await signedPayment({ key: generatePrivateKey() });
      expect((await f.verify(p.payload, p.req)).isValid).toBe(true);
    }
  });
});

describe("requests per IP", () => {
  it("limits /verify and /settle together per client IP, with the spec shapes", async () => {
    const { f } = setup({ rateLimits: { ipPerMinute: 2 } });
    const app = createApp(f, { clientIp: (c) => c.req.header("x-test-ip") });
    const post = (path: string, ip: string) =>
      app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify({ x402Version: 2 }) });
    expect((await post("/verify", "1.1.1.1")).status).toBe(200);
    expect((await post("/settle", "1.1.1.1")).status).toBe(200);
    const v = await post("/verify", "1.1.1.1");
    expect(v.status).toBe(429);
    expect(v.headers.get("retry-after")).toBe("60");
    expect(await v.json()).toMatchObject({ isValid: false, invalidReason: "unexpected_verify_error" });
    const s = await post("/settle", "1.1.1.1");
    expect(s.status).toBe(429);
    expect(await s.json()).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "", network: "eip155:4663" });
    expect((await post("/verify", "2.2.2.2")).status).toBe(200);
    expect((await app.request("/supported")).status).toBe(200);
  });

  it("without a clientIp function nothing is limited by IP", async () => {
    const app = createApp(setup({ rateLimits: { ipPerMinute: 1 } }).f);
    for (let i = 0; i < 3; i++) {
      const res = await app.request("/verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(res.status).toBe(200);
    }
  });

  it("takes the last X-Forwarded-For entry, the one the trusted proxy appended", () => {
    expect(lastForwardedFor("6.6.6.6, 10.0.0.1, 203.0.113.9")).toBe("203.0.113.9");
    expect(lastForwardedFor(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(lastForwardedFor("")).toBeUndefined();
    expect(lastForwardedFor(undefined)).toBeUndefined();
  });
});

describe("rate limit settings", () => {
  it("reads RATE_LIMIT_PAYTO_PER_HOUR and RATE_LIMIT_IP_PER_MINUTE", () => {
    const base = { OPERATOR_KEY: generatePrivateKey() };
    expect(loadConfig({ ...base, RATE_LIMIT_PAYTO_PER_HOUR: "10", RATE_LIMIT_IP_PER_MINUTE: "0" }).rateLimits).toEqual({ payToPerHour: 10, ipPerMinute: 0 });
    expect(loadConfig(base).rateLimits).toEqual({ payToPerHour: undefined, ipPerMinute: undefined });
    expect(() => loadConfig({ ...base, RATE_LIMIT_IP_PER_MINUTE: "lots" })).toThrow(ConfigError);
    const f = setup().f;
    expect(f.limits).toMatchObject({ payToPerHour: 120, ipPerMinute: 60 });
  });
});
