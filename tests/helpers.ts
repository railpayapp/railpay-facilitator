import { getAddress, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

import { AUTHORIZATION_TYPES, USDG } from "../src/constants.js";
import type { PaymentPayload, PaymentRequirements } from "../src/types.js";

export const PAY_TO = getAddress("0x00000000000000000000000000000000000b0b0b");
export const PAYER = getAddress("0x0000000000000000000000000000000000a11ce0");
export const NONCE = `0x${"11".repeat(32)}` as Hex;
export const FAKE_SIGNATURE = `0x${"ab".repeat(65)}` as Hex;

/** A throwaway operator key, generated for this test run. It never holds anything. */
export const OPERATOR_KEY = generatePrivateKey();
export const OPERATOR = privateKeyToAccount(OPERATOR_KEY).address;

/** Requirements the way the RailPay SDK seller sends them. */
export function requirements(over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: "eip155:4663",
    amount: "10000",
    asset: USDG,
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    extra: { name: "Global Dollar", version: "1" },
    ...over,
  };
}

export type AuthorizationInput = { from: string; to: string; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex };

export function payload(auth: AuthorizationInput, signature: Hex, req: PaymentRequirements = requirements()): PaymentPayload {
  return {
    x402Version: 2,
    resource: { url: "https://api.example.com/quote", description: "Paid resource", mimeType: "application/json" },
    accepted: req,
    payload: {
      signature,
      authorization: {
        from: auth.from,
        to: auth.to,
        value: auth.value.toString(),
        validAfter: auth.validAfter.toString(),
        validBefore: auth.validBefore.toString(),
        nonce: auth.nonce,
      },
    },
  };
}

/** A structurally valid payload with a fake signature (enough for parse tests). */
export function unsignedPayload(over: Partial<AuthorizationInput> = {}, req: PaymentRequirements = requirements()): PaymentPayload {
  return payload({ from: PAYER, to: req.payTo, value: BigInt(req.amount), validAfter: 0n, validBefore: 4_000_000_000n, nonce: NONCE, ...over }, FAKE_SIGNATURE, req);
}

/** Deep copy then mutate: for one-off malformed bodies. */
export function mutate<T>(value: T, f: (draft: any) => void): T {
  const copy = structuredClone(value);
  f(copy);
  return copy;
}

// ---------- real EIP-3009 signatures from throwaway keys ----------

export const NOW_MS = 1_800_000_000_000;
export const NOW_S = BigInt(NOW_MS / 1000);

export type SignOptions = Partial<Omit<AuthorizationInput, "from">> & {
  key: Hex;
  req?: PaymentRequirements;
  /** Sign over another domain (wrong chain, wrong token name). */
  domain?: Partial<{ name: string; version: string; chainId: number; verifyingContract: Hex }>;
};

let nonceCounter = 0;
export const freshNonce = () => `0x${(++nonceCounter).toString(16).padStart(64, "0")}` as Hex;

/** A payload signed the way an x402 client (or the RailPay agent wallet) signs it. */
export async function signedPayment(o: SignOptions): Promise<{ payload: PaymentPayload; req: PaymentRequirements; auth: AuthorizationInput; signer: Hex }> {
  const account = privateKeyToAccount(o.key);
  const req = o.req ?? requirements();
  const auth: AuthorizationInput = {
    from: account.address,
    to: o.to ?? req.payTo,
    value: o.value ?? BigInt(req.amount),
    validAfter: o.validAfter ?? NOW_S - 60n,
    validBefore: o.validBefore ?? NOW_S + 300n,
    nonce: o.nonce ?? freshNonce(),
  };
  const signature = await account.signTypedData({
    domain: { name: "Global Dollar", version: "1", chainId: 4663, verifyingContract: USDG, ...o.domain },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: { ...auth, from: getAddress(auth.from), to: getAddress(auth.to) },
  });
  return { payload: payload(auth, signature, req), req, auth, signer: account.address };
}
