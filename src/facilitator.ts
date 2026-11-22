import { recoverTypedDataAddress, type Transport } from "viem";

import { createChain, RpcError, transferCalldata, type Revert } from "./chain.js";
import { AUTHORIZATION_TYPES, CHAIN_ID, DEFAULT_RPC_URL, USDG, USDG_DECIMALS, USDG_EIP712 } from "./constants.js";
import { parsePayment, parseRequestBody, type AssetConfig, type Failure, type ParsedPayment, type ParseResult } from "./parse.js";
import { ErrorReason, type SupportedResponse, type VerifyResponse } from "./types.js";

export type FacilitatorOptions = {
  /** Robinhood Chain JSON-RPC. Default: publicnode. It may contain an API key: it is never logged or returned. */
  rpcUrl?: string;
  /** A viem transport instead of `rpcUrl` (tests pass `custom(...)`). */
  transport?: Transport;
  /** Default 4663 (Robinhood Chain). */
  chainId?: number;
  /** Default USDG with its EIP-712 domain ("Global Dollar", "1"). */
  asset?: AssetConfig;
  /** `validBefore` must be at least this many seconds in the future. Default 6. */
  validityMarginSeconds?: number;
  /** Clock in ms for validity windows (tests). */
  now?: () => number;
};

export function createFacilitator(options: FacilitatorOptions = {}) {
  const chainId = options.chainId ?? CHAIN_ID;
  const network = `eip155:${chainId}`;
  const asset: AssetConfig = options.asset ?? { address: USDG, name: USDG_EIP712.name, version: USDG_EIP712.version, decimals: USDG_DECIMALS };
  const margin = options.validityMarginSeconds ?? 6;
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError("validityMarginSeconds must be a non-negative integer");
  const now = options.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const fail = (reason: ErrorReason, message: string): Failure => ({ ok: false, reason, message });
  const chain = createChain({ asset, rpcUrl: options.rpcUrl ?? DEFAULT_RPC_URL, transport: options.transport });
  let chainChecked = false;

  /** The RPC must be on the configured chain. Checked once; an unreachable RPC is retried on the next call. */
  async function checkChainId(): Promise<string | null> {
    if (chainChecked) return null;
    const id = await chain.chainId();
    if (id !== chainId) return `The RPC is on chain ${id}, expected ${chainId}`;
    chainChecked = true;
    return null;
  }

  // ---------- verification ----------

  /** Recipient, amount and validity window against the requirements and the clock. */
  function authorizationChecks(p: ParsedPayment): Failure | null {
    const a = p.auth;
    if (a.to.toLowerCase() !== p.payTo.toLowerCase()) return fail(ErrorReason.recipientMismatch, `authorization.to must be ${p.payTo}`);
    if (a.value !== p.amount) return fail(ErrorReason.valueMismatch, `authorization.value must be exactly ${p.amount}`);
    const t = BigInt(nowSec());
    if (a.validAfter > t) return fail(ErrorReason.validAfter, "The authorization is not valid yet (validAfter is in the future)");
    if (a.validBefore < t + BigInt(margin)) return fail(ErrorReason.validBefore, `The authorization has expired or expires within ${margin} s`);
    return null;
  }

  /** The EIP-712 signature must recover to authorization.from (EOA payers). */
  async function signatureCheck(p: ParsedPayment): Promise<Failure | null> {
    const signer = await recoverTypedDataAddress({
      domain: { name: asset.name, version: asset.version, chainId, verifyingContract: asset.address },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: p.auth,
      signature: p.signature,
    }).catch(() => null);
    if (signer?.toLowerCase() !== p.payer.toLowerCase()) return fail(ErrorReason.signature, "The signature does not recover to authorization.from");
    return null;
  }

  /** A failed eth_call of transferWithAuthorization, as an x402 error. */
  function fromRevert(r: Revert): Failure {
    const text = `${r.name ?? ""} ${r.message}`;
    if (r.name === "InsufficientFunds" || /insufficient|exceeds balance/i.test(text)) return fail(ErrorReason.insufficientFunds, "The payer does not hold enough of the token");
    if (r.name === "InvalidSignature" || /signature/i.test(text)) return fail(ErrorReason.signature, "The token contract rejected the signature");
    if (/expired/i.test(text)) return fail(ErrorReason.validBefore, "The token contract says the authorization expired");
    if (/not yet valid/i.test(text)) return fail(ErrorReason.validAfter, "The token contract says the authorization is not valid yet");
    if (/used|cancel/i.test(text)) return fail(ErrorReason.invalidPayload, "The authorization was already used or canceled");
    return fail(ErrorReason.invalidTransactionState, `Simulating transferWithAuthorization reverted: ${r.message}`);
  }

  /**
   * On-chain checks: the RPC's chain id, the authorization nonce is unused, the payer holds enough, then an eth_call
   * of transferWithAuthorization (catches anything else the token would refuse: frozen accounts, contract rules).
   */
  async function chainChecks(p: ParsedPayment): Promise<Failure | null> {
    try {
      const wrongChain = await checkChainId();
      if (wrongChain) return fail(ErrorReason.unexpectedVerify, wrongChain);
      const [used, balance] = await Promise.all([chain.authorizationUsed(p.auth.from, p.auth.nonce), chain.tokenBalance(p.auth.from)]);
      if (used) return fail(ErrorReason.invalidPayload, "This authorization nonce was already used on-chain");
      if (balance < p.auth.value) return fail(ErrorReason.insufficientFunds, "The payer does not hold enough of the token");
      const revert = await chain.simulate(transferCalldata(p.auth, p.signature));
      return revert ? fromRevert(revert) : null;
    } catch (e) {
      return fail(ErrorReason.unexpectedVerify, e instanceof RpcError ? `Could not read the chain: ${e.message}` : "Could not read the chain");
    }
  }

  /** Everything `/verify` checks, in order: recipient, amount, window, signature, then the chain. */
  async function checkAll(p: ParsedPayment): Promise<Failure | null> {
    return authorizationChecks(p) ?? (await signatureCheck(p)) ?? (await chainChecks(p));
  }

  async function verifyParsed(r: ParseResult): Promise<VerifyResponse> {
    if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: r.message, ...(r.payer ? { payer: r.payer } : {}) };
    const p = r.value;
    const bad = await checkAll(p);
    if (bad) return { isValid: false, invalidReason: bad.reason, invalidMessage: bad.message, payer: p.payer };
    return { isValid: true, payer: p.payer };
  }

  // ---------- public API ----------

  const supportedResponse: SupportedResponse = {
    kinds: [{ x402Version: 2, scheme: "exact", network }],
    extensions: [],
    signers: {},
  };

  return {
    network,
    chainId,
    asset,

    /** Read-only: is this payment valid right now? Never writes state or sends a transaction. */
    verify: (paymentPayload: unknown, paymentRequirements: unknown): Promise<VerifyResponse> =>
      verifyParsed(parsePayment(paymentPayload, paymentRequirements, network, asset)),
    /** `POST /verify` body: { x402Version, paymentPayload, paymentRequirements }. */
    verifyRequest: (body: unknown): Promise<VerifyResponse> => verifyParsed(parseRequestBody(body, network, asset)),

    supported: (): SupportedResponse => supportedResponse,
  };
}

export type Facilitator = ReturnType<typeof createFacilitator>;
