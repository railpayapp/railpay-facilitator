/**
 * End to end with the real RailPay SDK seller (railpay-sdk v0.1.0): createPaywall pointed at this facilitator, with
 * the SDK's own chain reads and this facilitator's settlement both going to the same fake Robinhood Chain.
 */
import { b64json, createPaywall } from "railpay-sdk";
import { keccak256, type Hex } from "viem";
import { generatePrivateKey } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app.js";
import { createFacilitator } from "../src/facilitator.js";
import { FakeChain } from "./fake-chain.js";
import { NOW_MS, OPERATOR, OPERATOR_KEY, PAY_TO, signedPayment } from "./helpers.js";

const FACILITATOR = "http://localhost:8787";
const RPC = "http://rpc.test/";

function setup() {
  const chain = new FakeChain();
  const app = createApp(createFacilitator({ operatorKey: OPERATOR_KEY, now: () => NOW_MS, transport: chain.transport, receiptTimeoutMs: 60, pollIntervalMs: 5 }));
  const settleCalls: number[] = [];

  /** The SDK's fetch: the facilitator goes to the Hono app, JSON-RPC to the fake chain. */
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(FACILITATOR)) {
      const res = await app.request(url.slice(FACILITATOR.length), init);
      if (url.endsWith("/settle")) settleCalls.push(res.status);
      return res;
    }
    if (url === RPC) {
      const { id, method, params } = JSON.parse(String(init?.body));
      try {
        return Response.json({ jsonrpc: "2.0", id, result: await chain.request({ method, params }) });
      } catch (e) {
        const err = e as { code?: number; message?: string; data?: string };
        return Response.json({ jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message ?? "error", data: err.data } });
      }
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof globalThis.fetch;

  const paywall = createPaywall({ payTo: PAY_TO, price: "0.01", facilitators: [FACILITATOR], rpcUrl: RPC, fetch, now: () => NOW_MS, receiptWaitMs: 100 });
  let served = 0;
  const serve = () => {
    served++;
    return Response.json({ quote: 42 });
  };
  const call = (header?: string) =>
    paywall.handle(new Request("https://api.example.com/quote", { headers: header ? { "PAYMENT-SIGNATURE": header } : {} }), serve);
  return { chain, call, settleCalls, served: () => served };
}

const decode = (header: string | null) => (header ? JSON.parse(Buffer.from(header, "base64").toString("utf8")) : null);

describe("railpay-sdk createPaywall with this facilitator", () => {
  it("settles a payment and serves the resource once", async () => {
    const { chain, call, settleCalls, served } = setup();
    expect((await call()).status).toBe(402);

    const { payload, signer } = await signedPayment({ key: generatePrivateKey() });
    const header = b64json(payload);
    const res = await call(header);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ quote: 42 });
    const receipt = decode(res.headers.get("PAYMENT-RESPONSE"));
    expect(receipt).toMatchObject({ success: true, network: "eip155:4663" });
    expect(receipt.transaction).toBe(keccak256(chain.sent[0] as Hex));
    expect(chain.balanceOf(PAY_TO)).toBe(chain.defaultBalance + 10_000n);
    expect(chain.balanceOf(signer)).toBe(chain.defaultBalance - 10_000n);
    expect(settleCalls).toEqual([200]);

    const replay = await call(header);
    expect(replay.status).toBe(402);
    expect(await replay.json()).toMatchObject({ error: "invalid_payload" });
    expect(chain.sent).toHaveLength(1);
    expect(served()).toBe(1);
  });

  it("passes settlement_pending through, then serves on the retry once it confirms", async () => {
    const { chain, call, served } = setup();
    chain.autoMine = false;
    const { payload } = await signedPayment({ key: generatePrivateKey() });
    const header = b64json(payload);

    const first = await call(header);
    expect(first.status).toBe(402);
    expect(await first.json()).toMatchObject({ error: "settlement_pending" });
    const pending = decode(first.headers.get("PAYMENT-RESPONSE"));
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });
    expect(pending.transaction).toBe(keccak256(chain.sent[0] as Hex));

    await chain.mine();
    const second = await call(header);
    expect(second.status).toBe(200);
    expect(decode(second.headers.get("PAYMENT-RESPONSE"))?.transaction).toBe(pending.transaction);
    expect(served()).toBe(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("a facilitator refusal (operator out of gas) reaches the buyer as unexpected_settle_error, and a retry works", async () => {
    const { chain, call, settleCalls, served } = setup();
    chain.setEth(OPERATOR, 0n);
    const { payload } = await signedPayment({ key: generatePrivateKey() });
    const header = b64json(payload);
    const refused = await call(header);
    expect(refused.status).toBe(402);
    expect(await refused.json()).toMatchObject({ error: "unexpected_settle_error" });
    expect(settleCalls).toEqual([503]);
    expect(chain.sent).toHaveLength(0);

    chain.setEth(OPERATOR, 10n ** 18n);
    expect((await call(header)).status).toBe(200);
    expect(served()).toBe(1);
  });
});
