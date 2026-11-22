import { DatabaseSync } from "node:sqlite";

import { generatePrivateKey } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import worker, { durableObjectStore, RailPayFacilitator, type DurableObjectStateLike, type WorkerEnv } from "../src/worker.js";
import { FakeChain } from "./fake-chain.js";
import { OPERATOR, OPERATOR_KEY, signedPayment } from "./helpers.js";

const RPC = "https://rpc.test/v2/secret-key";

/** A Durable Object state whose SQLite storage is node:sqlite, the way the runtime runs SQL. */
function fakeState(db = new DatabaseSync(":memory:")): DurableObjectStateLike {
  return {
    storage: {
      sql: {
        exec: (query: string, ...bindings: unknown[]) => {
          const rows = db.prepare(query).all(...(bindings as (string | number | null)[]));
          return { toArray: () => rows as Record<string, unknown>[] };
        },
      },
    },
  };
}

/** A namespace with one object per name, like the runtime. `evict()` drops the instance and keeps its storage. */
function fakeNamespace(env: Record<string, string>) {
  const states = new Map<string, DurableObjectStateLike>();
  const objects = new Map<string, RailPayFacilitator>();
  return {
    idFromName: (name: string) => name,
    get: (id: unknown) => ({
      fetch: async (request: Request) => {
        const name = String(id);
        if (!states.has(name)) states.set(name, fakeState());
        if (!objects.has(name)) objects.set(name, new RailPayFacilitator(states.get(name) as DurableObjectStateLike, env));
        return (objects.get(name) as RailPayFacilitator).fetch(request);
      },
    }),
    evict: () => objects.clear(),
    names: () => [...states.keys()],
  };
}

let chain: FakeChain;

beforeEach(() => {
  chain = new FakeChain();
  chain.timestamp = BigInt(Math.floor(Date.now() / 1000));
  // viem's http transport calls the global fetch: answer JSON-RPC from the fake chain.
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== RPC) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body));
    const one = async ({ id, method, params }: { id: number; method: string; params: unknown[] }) => {
      try {
        return { jsonrpc: "2.0", id, result: await chain.request({ method, params }) };
      } catch (e) {
        const err = e as { code?: number; message?: string; data?: string };
        return { jsonrpc: "2.0", id, error: { code: err.code ?? -32000, message: err.message ?? "error", data: err.data } };
      }
    };
    return Response.json(Array.isArray(body) ? await Promise.all(body.map(one)) : await one(body));
  });
});
afterEach(() => vi.unstubAllGlobals());

const now = () => BigInt(Math.floor(Date.now() / 1000));
const pay = (key = generatePrivateKey()) => signedPayment({ key, validAfter: now() - 60n, validBefore: now() + 300n });
const settleBody = async () => {
  const { payload, req } = await pay();
  return JSON.stringify({ x402Version: 2, paymentPayload: payload, paymentRequirements: req });
};
const post = (env: WorkerEnv, path: string, body: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://facilitator.example${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }), env);

describe("Cloudflare Workers entry", () => {
  const vars = { OPERATOR_KEY, RPC_URL: RPC };

  it("routes every request to the one Durable Object and settles there", async () => {
    const ns = fakeNamespace(vars);
    const env = { FACILITATOR: ns } as WorkerEnv;
    const supported = await worker.fetch(new Request("https://facilitator.example/supported"), env);
    expect(await supported.json()).toEqual({ kinds: [{ x402Version: 2, scheme: "exact", network: "eip155:4663" }], extensions: [], signers: { "eip155:*": [OPERATOR] } });

    const body = await settleBody();
    const res = await post(env, "/settle", body);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/) });
    const replay = await post(env, "/settle", body);
    expect(await replay.json()).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(chain.sent).toHaveLength(1);
    expect(ns.names()).toEqual(["operator"]);

    const health = await worker.fetch(new Request("https://facilitator.example/health"), env);
    expect(await health.json()).toMatchObject({ ok: true, operator: OPERATOR });
  });

  it("keeps settlement records in Durable Object storage across evictions", async () => {
    const ns = fakeNamespace({ ...vars, RECEIPT_TIMEOUT_MS: "1000" });
    const env = { FACILITATOR: ns } as WorkerEnv;
    chain.autoMine = false;
    const body = await settleBody();
    const pending = await (await post(env, "/settle", body)).json();
    expect(pending).toMatchObject({ success: false, errorReason: "settlement_pending" });

    ns.evict(); // the object is evicted; a new instance reads the same storage
    chain.dropMempool();
    chain.autoMine = true;
    expect(await (await post(env, "/settle", body)).json()).toMatchObject({ success: true, transaction: pending.transaction });
    ns.evict();
    expect(await (await post(env, "/settle", body)).json()).toMatchObject({ success: false, errorReason: "invalid_payload" });
    expect(chain.sent).toHaveLength(2);
    expect(chain.sent[1]).toBe(chain.sent[0]);
  });

  it("concurrent settles of one authorization send one transaction", async () => {
    const env = { FACILITATOR: fakeNamespace(vars) } as WorkerEnv;
    const body = await settleBody();
    const results = await Promise.all(Array.from({ length: 4 }, async () => (await post(env, "/settle", body)).json()));
    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(chain.sent).toHaveLength(1);
  });

  it("rate limits by cf-connecting-ip", async () => {
    const env = { FACILITATOR: fakeNamespace({ ...vars, RATE_LIMIT_IP_PER_MINUTE: "1" }) } as WorkerEnv;
    expect((await post(env, "/verify", "{}", { "cf-connecting-ip": "203.0.113.1" })).status).toBe(200);
    const limited = await post(env, "/verify", "{}", { "cf-connecting-ip": "203.0.113.1" });
    expect(limited.status).toBe(429);
    expect((await post(env, "/verify", "{}", { "cf-connecting-ip": "203.0.113.2" })).status).toBe(200);
  });

  it("answers 500 with the variable's name, never its value, when misconfigured", async () => {
    const missing = await worker.fetch(new Request("https://facilitator.example/supported"), { FACILITATOR: fakeNamespace({ RPC_URL: RPC }) } as WorkerEnv);
    expect(missing.status).toBe(500);
    expect(await missing.json()).toEqual({ error: "misconfigured", message: expect.stringContaining("OPERATOR_KEY is not set") });

    const bad = "0x" + "zz".repeat(32);
    const wrong = await worker.fetch(new Request("https://facilitator.example/supported"), { FACILITATOR: fakeNamespace({ OPERATOR_KEY: bad }) } as WorkerEnv);
    expect(await wrong.text()).not.toContain("zzzz");

    const noBinding = await worker.fetch(new Request("https://facilitator.example/"), {} as WorkerEnv);
    expect(noBinding.status).toBe(500);
  });

  it("never returns the RPC URL", async () => {
    const env = { FACILITATOR: fakeNamespace(vars) } as WorkerEnv;
    chain.failures.set("eth_call", { code: -32000, message: `upstream ${RPC} failed` });
    const text = await (await post(env, "/verify", await settleBody())).text();
    expect(text).toContain("unexpected_verify_error");
    expect(text).not.toContain("secret-key");
  });
});

describe("durableObjectStore", () => {
  it("claims atomically and persists", async () => {
    const db = new DatabaseSync(":memory:");
    const s = durableObjectStore(fakeState(db));
    const rec = { state: "settling" as const, payer: "0xa", payTo: "0xb", amount: "1000", createdAt: 1, updatedAt: 1, expiresAt: 100 };
    expect(await s.claim("k", rec)).toBe(true);
    expect(await s.claim("k", rec)).toBe(false);
    const again = durableObjectStore(fakeState(db));
    expect(await again.get("k")).toEqual(rec);
    expect(await again.prune(1000)).toBe(1);
    expect(await again.get("k")).toBeUndefined();
  });
});
