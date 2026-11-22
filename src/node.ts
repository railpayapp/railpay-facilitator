/**
 * Runnable Node server: `node dist/node.js` (or `pnpm start`).
 * Env: PORT (default 8787), HOST (default 127.0.0.1) and the variables in config.ts.
 */
import { serve } from "@hono/node-server";

import { createApp } from "./app.js";
import { ConfigError, loadConfig } from "./config.js";
import { VERSION } from "./constants.js";
import { createFacilitator } from "./facilitator.js";

function fatal(message: string): never {
  console.error(`railpay-facilitator: ${message}`);
  process.exit(1);
}

function main() {
  const env = process.env;
  let facilitator;
  try {
    facilitator = createFacilitator(loadConfig(env));
  } catch (e) {
    if (e instanceof ConfigError || e instanceof TypeError || e instanceof RangeError) fatal(e.message);
    throw e;
  }
  const port = Number(env.PORT || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) fatal("PORT must be a port number");
  const hostname = env.HOST || "127.0.0.1";

  const app = createApp(facilitator);
  const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`railpay-facilitator ${VERSION} on http://${info.address}:${info.port} (${facilitator.network})`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main();
