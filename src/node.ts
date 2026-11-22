/**
 * Runnable Node server: `node dist/node.js` (or `pnpm start`).
 * Env: PORT (default 8787), HOST (default 127.0.0.1), STORE (memory | sqlite, default sqlite), SQLITE_PATH
 * (default ./railpay-facilitator.db), TRUST_PROXY (take the client IP from the last X-Forwarded-For entry) and the
 * variables in config.ts. Run one process per operator key.
 */
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";

import { createApp, lastForwardedFor } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { VERSION } from "./constants.js";
import { createFacilitator } from "./facilitator.js";
import { sqliteStore } from "./sqlite.js";
import { memoryStore } from "./store.js";

function fatal(message: string): never {
  console.error(`railpay-facilitator: ${message}`);
  process.exit(1);
}

function main() {
  const env = process.env;
  const kind = (env.STORE || "sqlite").toLowerCase();
  if (kind !== "sqlite" && kind !== "memory") fatal("STORE must be sqlite or memory");
  const sqlitePath = env.SQLITE_PATH || "./railpay-facilitator.db";

  let facilitator;
  try {
    const config = loadConfig(env);
    facilitator = createFacilitator({
      ...config,
      store: kind === "sqlite" ? sqliteStore(sqlitePath) : memoryStore(),
      log: (event, fields) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields })),
    });
  } catch (e) {
    if (e instanceof ConfigError || e instanceof TypeError || e instanceof RangeError) fatal(e.message);
    throw e;
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fatal("PORT must be a port number");
  const hostname = env.HOST || "127.0.0.1";

  const trustProxy = /^(1|true|yes)$/i.test(env.TRUST_PROXY ?? "");
  const app = createApp(facilitator, {
    clientIp: (c) => (trustProxy ? lastForwardedFor(c.req.header("x-forwarded-for")) : undefined) ?? getConnInfo(c).remote.address,
  });
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    const where = kind === "sqlite" ? `sqlite ${sqlitePath}` : "memory (one process, lost on restart)";
    console.log(`railpay-facilitator ${VERSION} on http://${info.address}:${info.port} (${facilitator.network}), operator ${facilitator.operator}, store ${where}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
