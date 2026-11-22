import { getAddress, isAddress, type Address, type Hex } from "viem";

import { ErrorReason, type PaymentPayload, type PaymentRequirements } from "./types.js";

/** The token this facilitator settles: an EIP-3009 ERC-20 and its EIP-712 domain. */
export type AssetConfig = { address: Address; name: string; version: string; decimals: number };

/** EIP-3009 authorization with typed values. */
export type Authorization = { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };

/** A request that passed the structural checks: version, scheme, network, asset, field formats. */
export type ParsedPayment = {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  auth: Authorization;
  signature: Hex;
  payer: Address;
  payTo: Address;
  amount: bigint;
};

export type Failure = { ok: false; reason: ErrorReason; message: string; payer?: string };
export type ParseResult = { ok: true; value: ParsedPayment } | Failure;

const MAX_UINT256 = 2n ** 256n - 1n;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const sameAddress = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** A uint256 as a decimal string (spec) or a safe non-negative integer. Null otherwise. */
function uint(v: unknown): bigint | null {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v !== "string" || !/^\d{1,78}$/.test(v)) return null;
  const n = BigInt(v);
  return n <= MAX_UINT256 ? n : null;
}

const fail = (reason: ErrorReason, message: string, payer?: string): Failure => ({ ok: false, reason, message, ...(payer ? { payer } : {}) });

/** `authorization.from` if it is an address, for error answers. */
function payerOf(payload: unknown): string | undefined {
  if (!isObject(payload) || !isObject(payload.payload) || !isObject(payload.payload.authorization)) return undefined;
  const from = payload.payload.authorization.from;
  return typeof from === "string" && isAddress(from, { strict: false }) ? getAddress(from) : undefined;
}

/** Parse the body of `POST /verify` or `POST /settle`. */
export function parseRequestBody(body: unknown, network: string, asset: AssetConfig): ParseResult {
  if (!isObject(body)) return fail(ErrorReason.invalidPayload, "The request body must be a JSON object");
  const payer = payerOf(body.paymentPayload);
  if (body.x402Version !== 2) return fail(ErrorReason.invalidVersion, "x402Version must be 2", payer);
  return parsePayment(body.paymentPayload, body.paymentRequirements, network, asset);
}

/**
 * Structural checks, in this order: requirements, scheme, network, asset and EIP-712 domain, payload version,
 * `accepted` against the requirements, then the signature and authorization formats.
 * No signature, time, amount policy or chain check happens here.
 */
export function parsePayment(rawPayload: unknown, rawRequirements: unknown, network: string, asset: AssetConfig): ParseResult {
  const payer = payerOf(rawPayload);
  const bad = (reason: ErrorReason, message: string) => fail(reason, message, payer);

  // ---- paymentRequirements
  if (!isObject(rawRequirements)) return bad(ErrorReason.invalidRequirements, "paymentRequirements must be an object");
  const r = rawRequirements;
  if (typeof r.scheme !== "string") return bad(ErrorReason.invalidRequirements, "paymentRequirements.scheme is required");
  if (typeof r.network !== "string") return bad(ErrorReason.invalidRequirements, "paymentRequirements.network is required");
  const amount = typeof r.amount === "string" ? uint(r.amount) : null;
  if (amount === null || amount === 0n) return bad(ErrorReason.invalidRequirements, "paymentRequirements.amount must be a positive integer string (base units)");
  if (typeof r.asset !== "string" || !isAddress(r.asset, { strict: false })) return bad(ErrorReason.invalidRequirements, "paymentRequirements.asset must be a token address");
  if (typeof r.payTo !== "string" || !isAddress(r.payTo, { strict: false })) return bad(ErrorReason.invalidRequirements, "paymentRequirements.payTo must be an address");
  if (typeof r.maxTimeoutSeconds !== "number" || !Number.isInteger(r.maxTimeoutSeconds) || r.maxTimeoutSeconds <= 0) {
    return bad(ErrorReason.invalidRequirements, "paymentRequirements.maxTimeoutSeconds must be a positive integer");
  }
  if (r.scheme !== "exact") return bad(ErrorReason.unsupportedScheme, `Scheme "${r.scheme}" is not supported. This facilitator settles "exact" only`);
  if (r.network !== network) return bad(ErrorReason.invalidNetwork, `Network must be ${network}`);
  if (!sameAddress(r.asset, asset.address)) return bad(ErrorReason.invalidRequirements, `Asset must be ${asset.address}`);
  const extra = r.extra;
  if (!isObject(extra) || extra.name !== asset.name || extra.version !== asset.version) {
    return bad(ErrorReason.invalidRequirements, `paymentRequirements.extra must carry the token's EIP-712 domain: name "${asset.name}", version "${asset.version}"`);
  }
  if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== "eip3009") {
    return bad(ErrorReason.invalidRequirements, 'Only assetTransferMethod "eip3009" is supported');
  }

  // ---- paymentPayload
  if (!isObject(rawPayload)) return bad(ErrorReason.invalidPayload, "paymentPayload must be an object");
  if (rawPayload.x402Version !== 2) return bad(ErrorReason.invalidVersion, "paymentPayload.x402Version must be 2");
  const accepted = rawPayload.accepted;
  if (!isObject(accepted)) return bad(ErrorReason.invalidPayload, "paymentPayload.accepted is required");
  if (accepted.scheme !== r.scheme) return bad(ErrorReason.invalidScheme, "paymentPayload.accepted.scheme does not match paymentRequirements.scheme");
  if (accepted.network !== r.network) return bad(ErrorReason.invalidNetwork, "paymentPayload.accepted.network does not match paymentRequirements.network");
  if (!sameAddress(accepted.asset, r.asset) || !sameAddress(accepted.payTo, r.payTo) || String(accepted.amount) !== r.amount) {
    return bad(ErrorReason.invalidRequirements, "paymentPayload.accepted does not match paymentRequirements (asset, payTo, amount)");
  }
  if (isObject(accepted.extra) && accepted.extra.assetTransferMethod !== undefined && accepted.extra.assetTransferMethod !== "eip3009") {
    return bad(ErrorReason.invalidRequirements, 'Only assetTransferMethod "eip3009" is supported');
  }

  const inner = rawPayload.payload;
  if (!isObject(inner)) return bad(ErrorReason.invalidPayload, "paymentPayload.payload is required");
  const signature = inner.signature;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return bad(ErrorReason.invalidPayload, "paymentPayload.payload.signature must be a 65-byte hex signature");
  }
  const a = inner.authorization;
  if (!isObject(a)) return bad(ErrorReason.invalidPayload, "paymentPayload.payload.authorization is required");
  const value = uint(a.value);
  const validAfter = uint(a.validAfter);
  const validBefore = uint(a.validBefore);
  if (typeof a.from !== "string" || !isAddress(a.from, { strict: false })) return bad(ErrorReason.invalidPayload, "authorization.from must be an address");
  if (typeof a.to !== "string" || !isAddress(a.to, { strict: false })) return bad(ErrorReason.invalidPayload, "authorization.to must be an address");
  if (value === null || validAfter === null || validBefore === null) {
    return bad(ErrorReason.invalidPayload, "authorization.value, validAfter and validBefore must be uint256 decimal strings");
  }
  if (typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce)) return bad(ErrorReason.invalidPayload, "authorization.nonce must be 32 bytes of hex");

  const auth: Authorization = {
    from: getAddress(a.from),
    to: getAddress(a.to),
    value,
    validAfter,
    validBefore,
    nonce: a.nonce.toLowerCase() as Hex,
  };
  const requirements: PaymentRequirements = {
    scheme: r.scheme,
    network: r.network,
    amount: r.amount as string,
    asset: getAddress(r.asset),
    payTo: getAddress(r.payTo),
    maxTimeoutSeconds: r.maxTimeoutSeconds,
    extra: extra as PaymentRequirements["extra"],
  };
  return {
    ok: true,
    value: {
      payload: rawPayload as unknown as PaymentPayload,
      requirements,
      auth,
      signature: signature as Hex,
      payer: auth.from,
      payTo: getAddress(r.payTo),
      amount,
    },
  };
}
