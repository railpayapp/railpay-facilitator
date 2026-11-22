/**
 * Cloudflare Workers entry: `main` in wrangler.json points at the built `dist/worker.js`.
 *
 * Every request goes to one Durable Object (`RailPayFacilitator`, named "operator"). The facilitator runs inside it:
 * a Durable Object instance is single-threaded and unique, so there is exactly one sender for the operator key (no
 * nonce collisions between isolates), one settlement store (its SQLite storage, atomic and persistent), and one set
 * of rate limits. Throughput is one object's worth, which matches settlement: one transaction at a time per key.
 *
 * Secrets: OPERATOR_KEY (and RPC_URL when it holds an API key), with `wrangler secret put`. Other settings are vars.
 */
import { createApp } from "./app.js";
import { ConfigError, loadConfig, type FacilitatorEnv } from "./config.js";
import { createFacilitator } from "./facilitator.js";
import { sqlStore, type SettlementStore } from "./store.js";

// Minimal shapes of the Workers runtime types used here, so the package does not depend on @cloudflare/workers-types.
type SqlCursor = { toArray(): Record<string, unknown>[] };
/** The part of `DurableObjectState` this module uses: SQLite storage (`new_sqlite_classes` in wrangler.json). */
export type DurableObjectStateLike = { storage: { sql: { exec(query: string, ...bindings: unknown[]): SqlCursor } } };
type DurableObjectStubLike = { fetch(request: Request): Promise<Response> };
export type DurableObjectNamespaceLike = { idFromName(name: string): unknown; get(id: unknown): DurableObjectStubLike };

export type WorkerEnv = FacilitatorEnv & {
  /** Durable Object binding for RailPayFacilitator. */
  FACILITATOR: DurableObjectNamespaceLike;
};

/** A settlement store on a Durable Object's SQLite storage. */
export function durableObjectStore(state: DurableObjectStateLike): SettlementStore {
  const sql = state.storage.sql;
  return sqlStore({
    exec: (query, ...params) => {
      sql.exec(query, ...params).toArray();
    },
    one: (query, ...params) => sql.exec(query, ...params).toArray()[0],
  });
}

/** The Durable Object that runs the facilitator. Export it from your Worker module under this name. */
export class RailPayFacilitator {
  private readonly app: { fetch(request: Request): Response | Promise<Response> } | null = null;
  private readonly configError: string | null = null;

  constructor(state: DurableObjectStateLike, env: FacilitatorEnv) {
    try {
      const facilitator = createFacilitator({
        ...loadConfig(env),
        store: durableObjectStore(state),
        log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
      });
      // cf-connecting-ip is set by Cloudflare's edge; a client cannot forge it.
      this.app = createApp(facilitator, { clientIp: (c) => c.req.header("cf-connecting-ip") });
    } catch (e) {
      // Config messages name the variable, never its value.
      this.configError = e instanceof ConfigError || e instanceof TypeError || e instanceof RangeError ? e.message : "The facilitator could not start";
    }
  }

  fetch(request: Request): Response | Promise<Response> {
    if (this.app) return this.app.fetch(request);
    return Response.json({ error: "misconfigured", message: this.configError }, { status: 500 });
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (!env.FACILITATOR) return Promise.resolve(Response.json({ error: "misconfigured", message: "The FACILITATOR Durable Object binding is missing" }, { status: 500 }));
    return env.FACILITATOR.get(env.FACILITATOR.idFromName("operator")).fetch(request);
  },
};
