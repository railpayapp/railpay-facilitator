import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createFacilitator } from "../src/facilitator.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR, OPERATOR_KEY, signedPayment } from "./helpers.js";

const key = generatePrivateKey();
const chain = new FakeChain();
const app = createApp(createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport, receiptTimeoutMs: 50, pollIntervalMs: 5 }));
const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("HTTP API", () => {
  it("GET /supported answers the spec shape", async () => {
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: { "eip155:*": [OPERATOR] } });
  });

  it("POST /verify answers 200 with isValid for a valid payment", async () => {
    const { payload, req, signer } = await signedPayment({ key });
    const res = await post("/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ isValid: true, payer: signer });
  });

  it("POST /verify answers 200 with the spec reason for an invalid payment", async () => {
    const { payload, req, signer } = await signedPayment({ key, value: 1n });
    const res = await post("/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_authorization_value_mismatch", payer: signer });
  });

  it("malformed bodies keep the VerifyResponse shape", async () => {
    const bad = await post("/verify", "{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
    const text = await post("/verify", "{}", { "content-type": "text/plain" });
    expect(text.status).toBe(400);
    const big = await post("/verify", JSON.stringify({ pad: "x".repeat(20_000) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ isValid: false, invalidReason: "invalid_payload" });
    const version = await post("/verify", { x402Version: 1 });
    expect(await version.json()).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
  });

  it("POST /settle answers the SettleResponse shape", async () => {
    const { payload, req, signer } = await signedPayment({ key });
    const res = await post("/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/), network: "eip155:4663", payer: signer, amount: "10000" });
    const again = await post("/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "", network: "eip155:4663", payer: signer });
  });

  it("POST /settle failures keep the shape, malformed bodies included", async () => {
    const { payload, req } = await signedPayment({ key, value: 1n });
    const res = await post("/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
    expect(await res.json()).toMatchObject({ success: false, errorReason: "invalid_exact_evm_payload_authorization_value_mismatch", transaction: "", network: "eip155:4663" });
    const bad = await post("/settle", "{not json");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ success: false, errorReason: "invalid_payload", errorMessage: expect.any(String), transaction: "", network: "eip155:4663" });
    const big = await post("/settle", JSON.stringify({ pad: "x".repeat(20_000) }));
    expect(big.status).toBe(413);
  });

  it("POST /settle answers 503 with Retry-After when the operator cannot pay gas", async () => {
    chain.setEth(OPERATOR, 0n);
    try {
      const { payload, req } = await signedPayment({ key });
      const res = await post("/settle", { x402Version: 2, paymentPayload: payload, paymentRequirements: req });
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(await res.json()).toMatchObject({ success: false, errorReason: "unexpected_settle_error", transaction: "" });
    } finally {
      chain.setEth(OPERATOR, 10n ** 18n);
    }
  });

  it("wrong methods answer 405 with Allow, unknown paths 404", async () => {
    const res = await app.request("/verify");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await app.request("/settle")).status).toBe(405);
    expect((await app.request("/supported", { method: "POST" })).status).toBe(405);
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("GET / describes the service", async () => {
    expect(await (await app.request("/")).json()).toMatchObject({
      name: "railpay-facilitator",
      network: "eip155:4663",
      operator: OPERATOR,
      endpoints: ["POST /verify", "POST /settle", "GET /supported"],
    });
  });
});

describe("loadConfig", () => {
  const base = { OPERATOR_KEY: key };

  it("requires OPERATOR_KEY and never echoes it", () => {
    expect(() => loadConfig({})).toThrow(/OPERATOR_KEY is not set/);
    expect(loadConfig(base).operatorKey).toBe(key);
    expect(loadConfig({ OPERATOR_KEY: key.slice(2) }).operatorKey).toBe(key);
    const bad = `${key.slice(0, -1)}z`;
    try {
      loadConfig({ OPERATOR_KEY: bad });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).not.toContain(bad.slice(2, 20));
    }
  });

  it("reads RPC_URL and defaults to publicnode", () => {
    expect(loadConfig(base).rpcUrl).toBe("https://robinhood-rpc.publicnode.com");
    expect(loadConfig({ ...base, RPC_URL: " https://rpc.example/v2/abc " }).rpcUrl).toBe("https://rpc.example/v2/abc");
    expect(() => loadConfig({ ...base, RPC_URL: "ws://rpc.example/secret" })).toThrow(ConfigError);
    try {
      loadConfig({ ...base, RPC_URL: "nope-secret" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("reads VALIDITY_MARGIN_SECONDS, RECEIPT_TIMEOUT_MS and MAX_GAS", () => {
    expect(loadConfig({ ...base, VALIDITY_MARGIN_SECONDS: "10" }).validityMarginSeconds).toBe(10);
    expect(loadConfig(base).validityMarginSeconds).toBeUndefined();
    expect(() => loadConfig({ ...base, VALIDITY_MARGIN_SECONDS: "-1" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, RECEIPT_TIMEOUT_MS: "5000" }).receiptTimeoutMs).toBe(5000);
    expect(() => loadConfig({ ...base, RECEIPT_TIMEOUT_MS: "10" })).toThrow(ConfigError);
    expect(loadConfig({ ...base, MAX_GAS: "200000" }).maxGas).toBe(200_000n);
    expect(loadConfig(base).maxGas).toBeUndefined();
    expect(() => loadConfig({ ...base, MAX_GAS: "100" })).toThrow(ConfigError);
  });
});
