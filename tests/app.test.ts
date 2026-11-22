import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { ConfigError, loadConfig } from "../src/config.js";
import { createFacilitator } from "../src/facilitator.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, signedPayment } from "./helpers.js";

const key = generatePrivateKey();
const app = createApp(createFacilitator({ now: () => NOW_MS, transport: new FakeChain().transport }));
const post = (path: string, body: unknown, headers: Record<string, string> = { "content-type": "application/json" }) =>
  app.request(path, { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("HTTP API", () => {
  it("GET /supported answers the spec shape", async () => {
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: {} });
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

  it("wrong methods answer 405 with Allow, unknown paths 404", async () => {
    const res = await app.request("/verify");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect((await app.request("/supported", { method: "POST" })).status).toBe(405);
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("GET / describes the service", async () => {
    expect(await (await app.request("/")).json()).toMatchObject({ name: "railpay-facilitator", network: "eip155:4663" });
  });
});

describe("loadConfig", () => {
  it("reads RPC_URL and defaults to publicnode", () => {
    expect(loadConfig({}).rpcUrl).toBe("https://robinhood-rpc.publicnode.com");
    expect(loadConfig({ RPC_URL: " https://rpc.example/v2/abc " }).rpcUrl).toBe("https://rpc.example/v2/abc");
    expect(() => loadConfig({ RPC_URL: "ws://rpc.example/secret" })).toThrow(ConfigError);
    try {
      loadConfig({ RPC_URL: "nope-secret" });
    } catch (e) {
      expect((e as Error).message).not.toContain("secret");
    }
  });

  it("reads VALIDITY_MARGIN_SECONDS", () => {
    expect(loadConfig({ VALIDITY_MARGIN_SECONDS: "10" }).validityMarginSeconds).toBe(10);
    expect(loadConfig({}).validityMarginSeconds).toBeUndefined();
    expect(() => loadConfig({ VALIDITY_MARGIN_SECONDS: "-1" })).toThrow(ConfigError);
  });
});
