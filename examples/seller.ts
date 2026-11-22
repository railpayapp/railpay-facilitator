/**
 * A seller API that charges 0.001 USDG per request with the RailPay SDK and settles through your own facilitator
 * instead of Toll or Primer.
 *
 *   # terminal 1: the facilitator (see the README quick start)
 *   pnpm build && node dist/node.js
 *
 *   # terminal 2: this seller (Node 22.18+ runs TypeScript directly)
 *   PAY_TO=0xYourWallet node examples/seller.ts
 *   curl -i http://localhost:3000/quote          # 402 with PAYMENT-REQUIRED
 *
 * A buyer pays with the SDK's `withPayment(fetch, …)` or the RailPay MCP server; the paywall verifies the signature,
 * POSTs it to http://localhost:8787/settle, reads the USDG transfer back from the chain, and serves the response.
 */
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { createPaywall } from "railpay-sdk";

const payTo = process.env.PAY_TO;
if (!payTo) throw new Error("Set PAY_TO to the wallet that receives the USDG");

const paywall = createPaywall({
  payTo,
  price: "0.001",
  description: "One quote",
  // Your facilitator only. Add "https://x402.t0ll.xyz" after it as a fallback if you want one.
  facilitators: [process.env.FACILITATOR_URL ?? "http://localhost:8787"],
});

const app = new Hono();
app.get("/quote", (c) => paywall.handle(c.req.raw, () => Response.json({ quote: 42, at: new Date().toISOString() })));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }, (info) => console.log(`seller on http://localhost:${info.port}/quote`));
