/**
 * x402 v2 wire types for the facilitator API (specs/x402-specification-v2.md, sections 5 and 7).
 * Only what the `exact` scheme with EIP-3009 on EVM needs.
 */

/** Standard x402 error codes (spec section 9). This facilitator returns no other `invalidReason` / `errorReason`. */
export const ErrorReason = {
  insufficientFunds: "insufficient_funds",
  validAfter: "invalid_exact_evm_payload_authorization_valid_after",
  validBefore: "invalid_exact_evm_payload_authorization_valid_before",
  valueMismatch: "invalid_exact_evm_payload_authorization_value_mismatch",
  signature: "invalid_exact_evm_payload_signature",
  recipientMismatch: "invalid_exact_evm_payload_recipient_mismatch",
  invalidNetwork: "invalid_network",
  invalidPayload: "invalid_payload",
  invalidRequirements: "invalid_payment_requirements",
  invalidScheme: "invalid_scheme",
  unsupportedScheme: "unsupported_scheme",
  invalidVersion: "invalid_x402_version",
  invalidTransactionState: "invalid_transaction_state",
  unexpectedVerify: "unexpected_verify_error",
  unexpectedSettle: "unexpected_settle_error",
  settlementPending: "settlement_pending",
} as const;
export type ErrorReason = (typeof ErrorReason)[keyof typeof ErrorReason];

export type ResourceInfo = {
  url: string;
  description?: string;
  mimeType?: string;
  [key: string]: unknown;
};

/** One way to pay (spec 5.1.2). `amount` is in base units. */
export type PaymentRequirements = {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; assetTransferMethod?: string; [key: string]: unknown };
};

/** EIP-3009 TransferWithAuthorization fields, as decimal / hex strings (spec 5.2.2). */
export type AuthorizationFields = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
};

/** The client's signed payment (spec 5.2). */
export type PaymentPayload = {
  x402Version: number;
  resource?: ResourceInfo;
  accepted: PaymentRequirements;
  payload: { signature: string; authorization: AuthorizationFields };
  extensions?: Record<string, unknown>;
};

/** Body of `POST /verify` and `POST /settle` (spec 7.1, 7.2). */
export type FacilitatorRequest = {
  x402Version: number;
  paymentPayload: PaymentPayload;
  paymentRequirements: PaymentRequirements;
};

/**
 * Answer of `POST /verify` (spec 5.4). `invalidMessage` is not in the spec table; it carries a human-readable
 * explanation, the same field the x402 reference implementation uses.
 */
export type VerifyResponse = {
  isValid: boolean;
  invalidReason?: ErrorReason;
  invalidMessage?: string;
  payer?: string;
};

export type SupportedKind = { x402Version: number; scheme: string; network: string; extra?: Record<string, unknown> };

/** Answer of `GET /supported` (spec 7.3). */
export type SupportedResponse = {
  kinds: SupportedKind[];
  extensions: string[];
  signers: Record<string, string[]>;
};
