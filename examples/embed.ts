/**
 * The facilitator as a library, inside your own Hono server: your logger, a SQLite store, and a shared secret in front
 * of the API so only your own sellers can make the operator spend gas.
 *
 *   pnpm build
 *   read -rs OPERATOR_KEY; export OPERATOR_KEY        # paste the key, nothing is echoed
 *   read -rs FACILITATOR_TOKEN; export FACILITATOR_TOKEN
 *   node examples/embed.ts
 *
 * A seller then sends the header through the SDK's `fetch` option:
 *
 *   createPaywall({
 *     payTo, price: "0.001", facilitators: ["http://127.0.0.1:8787"],
 *     fetch: (input, init) => fetch(input, { ...init, headers: { ...init?.headers, authorization: `Bearer ${token}` } }),
 *   });
 */
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { createApp, createFacilitator, loadConfig } from "railpay-facilitator";
import { sqliteStore } from "railpay-facilitator/sqlite";

const token = process.env.FACILITATOR_TOKEN;
if (!token) throw new Error("Set FACILITATOR_TOKEN");

const facilitator = createFacilitator({
  ...loadConfig(process.env), // OPERATOR_KEY, RPC_URL, limits: the same variables as `node dist/node.js`
  store: sqliteStore("./facilitator.db"),
  log: (event, fields) => console.log(event, fields), // fields never hold the key or the RPC URL
});

const app = new Hono();
// GET /, /supported and /health stay public; the two endpoints that can spend gas need the token.
app.use("/verify", bearerAuth({ token }));
app.use("/settle", bearerAuth({ token }));
app.route("/", createApp(facilitator, { clientIp: (c) => getConnInfo(c).remote.address }));

serve({ fetch: app.fetch, port: 8787, hostname: "127.0.0.1" }, () => console.log(`facilitator ${facilitator.operator} on http://127.0.0.1:8787`));
