import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";

import { VERSION } from "./constants.js";
import type { Facilitator } from "./facilitator.js";
import { ErrorReason, type VerifyResponse } from "./types.js";

export type AppOptions = {
  /** Largest request body accepted, bytes. Default 16 KiB. */
  maxBodyBytes?: number;
};

/**
 * The x402 facilitator HTTP API (spec section 7): `POST /verify` and `GET /supported`.
 * Protocol outcomes, valid or not, answer 200 with the spec body. Other statuses: 400 malformed JSON, 413 body too
 * large. Every error body keeps the spec shape, so a client that reads the JSON regardless of status still understands it.
 */
export function createApp(facilitator: Facilitator, options: AppOptions = {}) {
  const app = new Hono();
  const maxSize = options.maxBodyBytes ?? 16 * 1024;

  const verifyError = (reason: ErrorReason, message: string): VerifyResponse => ({ isValid: false, invalidReason: reason, invalidMessage: message });

  async function readJson(c: Context): Promise<{ ok: true; body: unknown } | { ok: false; message: string }> {
    const type = c.req.header("content-type") ?? "";
    if (!/application\/json/i.test(type)) return { ok: false, message: "Send the body as application/json" };
    try {
      return { ok: true, body: await c.req.json() };
    } catch {
      return { ok: false, message: "The request body is not valid JSON" };
    }
  }

  app.get("/", (c) =>
    c.json({
      name: "railpay-facilitator",
      version: VERSION,
      network: facilitator.network,
      asset: facilitator.asset.address,
      endpoints: ["POST /verify", "GET /supported"],
      docs: "https://github.com/railpayapp/railpay-facilitator",
    }),
  );

  app.get("/supported", (c) => c.json(facilitator.supported()));

  app.post(
    "/verify",
    bodyLimit({ maxSize, onError: (c) => c.json(verifyError(ErrorReason.invalidPayload, `The request body is larger than ${maxSize} bytes`), 413) }),
    async (c) => {
      const j = await readJson(c);
      if (!j.ok) return c.json(verifyError(ErrorReason.invalidPayload, j.message), 400);
      return c.json(await facilitator.verifyRequest(j.body));
    },
  );

  const routes: Record<string, string> = { "/": "GET", "/supported": "GET", "/verify": "POST" };
  app.all("*", (c) => {
    const allow = routes[c.req.path];
    if (allow) {
      c.header("allow", allow);
      return c.json({ error: "method_not_allowed", message: `Use ${allow} ${c.req.path}` }, 405);
    }
    return c.json({ error: "not_found", message: `Endpoints: ${Object.entries(routes).map(([p, m]) => `${m} ${p}`).join(", ")}` }, 404);
  });

  app.onError((_err, c) => {
    // Never echo the error: it may carry internal details.
    if (c.req.path === "/verify") return c.json(verifyError(ErrorReason.unexpectedVerify, "Internal error"), 500);
    return c.json({ error: "internal_error" }, 500);
  });

  return app;
}
