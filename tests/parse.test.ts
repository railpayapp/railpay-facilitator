import { describe, expect, it } from "vitest";

import { USDG, USDG_DECIMALS, USDG_EIP712 } from "../src/constants.js";
import { parsePayment, parseRequestBody, type AssetConfig } from "../src/parse.js";
import { mutate, PAY_TO, PAYER, requirements, unsignedPayload } from "./helpers.js";

const asset: AssetConfig = { address: USDG, name: USDG_EIP712.name, version: USDG_EIP712.version, decimals: USDG_DECIMALS };
const NET = "eip155:4663";
const parse = (p: unknown, r: unknown) => parsePayment(p, r, NET, asset);
const reason = (r: ReturnType<typeof parse>) => (r.ok ? "ok" : r.reason);

describe("parsePayment", () => {
  it("accepts the payload the RailPay SDK builds and types the authorization", () => {
    const r = parse(unsignedPayload(), requirements());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.payer).toBe(PAYER);
    expect(r.value.payTo).toBe(PAY_TO);
    expect(r.value.amount).toBe(10_000n);
    expect(r.value.auth.value).toBe(10_000n);
    expect(r.value.auth.validBefore).toBe(4_000_000_000n);
  });

  it("accepts lowercase addresses and checksums them", () => {
    const req = requirements({ payTo: PAY_TO.toLowerCase(), asset: USDG.toLowerCase() });
    const r = parse(unsignedPayload({ from: PAYER.toLowerCase() }, req), req);
    expect(r.ok && r.value.payer).toBe(PAYER);
  });

  it("rejects other schemes, networks and assets", () => {
    expect(reason(parse(unsignedPayload(), requirements({ scheme: "upto" })))).toBe("unsupported_scheme");
    expect(reason(parse(unsignedPayload(), requirements({ network: "eip155:8453" })))).toBe("invalid_network");
    const other = requirements({ asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    expect(reason(parse(unsignedPayload({}, other), other))).toBe("invalid_payment_requirements");
  });

  it("requires the token's EIP-712 domain in extra", () => {
    expect(reason(parse(unsignedPayload(), requirements({ extra: undefined })))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), requirements({ extra: { name: "USD Coin", version: "2" } })))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), requirements({ extra: { name: "Global Dollar", version: "1", assetTransferMethod: "permit2" } })))).toBe(
      "invalid_payment_requirements",
    );
    expect(parse(unsignedPayload(), requirements({ extra: { name: "Global Dollar", version: "1", assetTransferMethod: "eip3009" } })).ok).toBe(true);
  });

  it("rejects malformed requirements", () => {
    expect(reason(parse(unsignedPayload(), null))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), requirements({ amount: "0" })))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), requirements({ amount: "1.5" })))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), requirements({ payTo: "bob" })))).toBe("invalid_payment_requirements");
    expect(reason(parse(unsignedPayload(), mutate(requirements(), (r) => delete r.maxTimeoutSeconds)))).toBe("invalid_payment_requirements");
  });

  it("checks the payload version and that accepted matches the requirements", () => {
    expect(reason(parse(mutate(unsignedPayload(), (p) => (p.x402Version = 1)), requirements()))).toBe("invalid_x402_version");
    expect(reason(parse(mutate(unsignedPayload(), (p) => (p.accepted.scheme = "upto")), requirements()))).toBe("invalid_scheme");
    expect(reason(parse(mutate(unsignedPayload(), (p) => (p.accepted.network = "eip155:1")), requirements()))).toBe("invalid_network");
    expect(reason(parse(mutate(unsignedPayload(), (p) => (p.accepted.amount = "1")), requirements()))).toBe("invalid_payment_requirements");
    expect(reason(parse(mutate(unsignedPayload(), (p) => (p.accepted.payTo = PAYER)), requirements()))).toBe("invalid_payment_requirements");
    expect(reason(parse(mutate(unsignedPayload(), (p) => delete p.accepted), requirements()))).toBe("invalid_payload");
  });

  it("rejects malformed signatures and authorization fields", () => {
    const base = unsignedPayload();
    expect(reason(parse(mutate(base, (p) => (p.payload.signature = "0x1234")), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => (p.payload.authorization.from = "alice")), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => (p.payload.authorization.value = "-1")), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => (p.payload.authorization.value = "1e6")), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => (p.payload.authorization.validBefore = (2n ** 256n).toString())), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => (p.payload.authorization.nonce = "0x12")), requirements()))).toBe("invalid_payload");
    expect(reason(parse(mutate(base, (p) => delete p.payload.authorization), requirements()))).toBe("invalid_payload");
  });

  it("returns the payer on failures when it can", () => {
    const r = parse(unsignedPayload(), requirements({ network: "eip155:1" }));
    expect(!r.ok && r.payer).toBe(PAYER);
  });
});

describe("parseRequestBody", () => {
  it("requires x402Version 2 at the top level", () => {
    const body = { x402Version: 2, paymentPayload: unsignedPayload(), paymentRequirements: requirements() };
    expect(parseRequestBody(body, NET, asset).ok).toBe(true);
    expect(reason(parseRequestBody({ ...body, x402Version: 1 }, NET, asset))).toBe("invalid_x402_version");
    expect(reason(parseRequestBody("nope", NET, asset))).toBe("invalid_payload");
  });
});
