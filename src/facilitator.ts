import { getAddress, isAddress, keccak256, recoverTypedDataAddress, type Address, type Hex, type Transport } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createChain, matchingTransfers, RpcError, transferCalldata, type Revert, type RpcReceipt } from "./chain.js";
import { AUTHORIZATION_TYPES, CHAIN_ID, DEFAULT_MAX_AMOUNT, DEFAULT_MIN_AMOUNT, DEFAULT_RPC_URL, USDG, USDG_DECIMALS, USDG_EIP712 } from "./constants.js";
import { Mutex, QueueTimeoutError } from "./limits.js";
import { parsePayment, parseRequestBody, type AssetConfig, type Failure, type ParsedPayment, type ParseResult } from "./parse.js";
import { memoryStore, type SettlementRecord, type SettlementStore } from "./store.js";
import { ErrorReason, type SettleResponse, type SupportedResponse, type VerifyResponse } from "./types.js";
import { fromUnits } from "./units.js";

export type FacilitatorOptions = {
  /** Operator private key (0x + 64 hex). It pays the gas of every settlement. Never logged or returned. */
  operatorKey: Hex;
  /** Robinhood Chain JSON-RPC. Default: publicnode. It may contain an API key: it is never logged or returned. */
  rpcUrl?: string;
  /** A viem transport instead of `rpcUrl` (tests pass `custom(...)`). */
  transport?: Transport;
  /** Default 4663 (Robinhood Chain). */
  chainId?: number;
  /** Default USDG with its EIP-712 domain ("Global Dollar", "1"). */
  asset?: AssetConfig;
  /** Smallest payment settled, base units. Default 1000 (0.001 USDG). */
  minAmount?: bigint;
  /** Largest payment settled, base units. Default 100000000 (100 USDG). */
  maxAmount?: bigint;
  /** Settle only payments to these addresses. Default: any payTo. */
  payToAllowlist?: readonly string[];
  /** `validBefore` must be at least this many seconds in the future. Default 6. */
  validityMarginSeconds?: number;
  /** Refuse to settle when the gas estimate is above this. Default 300000 (a USDG transferWithAuthorization uses about 50000). */
  maxGas?: bigint;
  /**
   * How long `settle` waits for the receipt before answering `settlement_pending`. Default 20000 ms.
   * A later `settle` with the same payload reconciles: it rebroadcasts the identical signed transaction and waits up to
   * min(receiptTimeoutMs, 5000) ms again.
   */
  receiptTimeoutMs?: number;
  /** Receipt polling interval. Default 500 ms. */
  pollIntervalMs?: number;
  /** How long a settlement may wait for the single sender. Default 10000 ms. */
  queueTimeoutMs?: number;
  /** Default memoryStore(): one process only. */
  store?: SettlementStore;
  /** Clock in ms for validity windows and record timestamps (tests). Polling uses real time. */
  now?: () => number;
  /** Structured events (submitted, settled, reverted, refused). Never receives secrets. */
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/** An answer plus the HTTP status the server should use. */
export type Outcome<T> = { status: number; body: T };

/** Keep a record this long after the authorization's validBefore, then it may be pruned. */
const RETAIN_AFTER_EXPIRY_MS = 60 * 60 * 1000;
const PRUNE_EVERY_MS = 10 * 60 * 1000;

export function createFacilitator(options: FacilitatorOptions) {
  if (typeof options.operatorKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(options.operatorKey)) {
    throw new TypeError("operatorKey must be a 32-byte hex private key (0x + 64 hex)");
  }
  const account = privateKeyToAccount(options.operatorKey);
  const operator = account.address;
  const chainId = options.chainId ?? CHAIN_ID;
  const network = `eip155:${chainId}`;
  const asset: AssetConfig = options.asset ?? { address: USDG, name: USDG_EIP712.name, version: USDG_EIP712.version, decimals: USDG_DECIMALS };
  const minAmount = options.minAmount ?? DEFAULT_MIN_AMOUNT;
  const maxAmount = options.maxAmount ?? DEFAULT_MAX_AMOUNT;
  if (minAmount < 1n) throw new RangeError("minAmount must be at least 1 base unit");
  if (maxAmount < minAmount) throw new RangeError("maxAmount must be at least minAmount");
  for (const a of options.payToAllowlist ?? []) if (!isAddress(a, { strict: false })) throw new TypeError(`payToAllowlist has an invalid address: ${a}`);
  const allowlist = options.payToAllowlist?.length ? new Set(options.payToAllowlist.map((a) => a.toLowerCase())) : null;
  const margin = options.validityMarginSeconds ?? 6;
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError("validityMarginSeconds must be a non-negative integer");
  const maxGas = options.maxGas ?? 300_000n;
  const receiptTimeoutMs = options.receiptTimeoutMs ?? 20_000;
  const pollMs = options.pollIntervalMs ?? 500;
  const queueTimeoutMs = options.queueTimeoutMs ?? 10_000;
  const now = options.now ?? Date.now;
  const nowSec = () => Math.floor(now() / 1000);
  const log = options.log ?? (() => {});
  const store = options.store ?? memoryStore();
  const fail = (reason: ErrorReason, message: string): Failure => ({ ok: false, reason, message });
  const chain = createChain({ asset, rpcUrl: options.rpcUrl ?? DEFAULT_RPC_URL, transport: options.transport });
  const sender = new Mutex();
  /** Authorizations this process is settling right now. */
  const inflight = new Set<string>();
  let chainChecked = false;
  let lastPrune = Date.now();

  const keyOf = (p: ParsedPayment) => `${network}:${asset.address.toLowerCase()}:${p.auth.from.toLowerCase()}:${p.auth.nonce}`;

  /** The RPC must be on the configured chain. Checked once; an unreachable RPC is retried on the next call. */
  async function checkChainId(): Promise<string | null> {
    if (chainChecked) return null;
    const id = await chain.chainId();
    if (id !== chainId) return `The RPC is on chain ${id}, expected ${chainId}`;
    chainChecked = true;
    return null;
  }

  // ---------- verification ----------

  const usdg = (units: bigint) => `${fromUnits(units, asset.decimals)} USDG`;

  /** Operator policy: amount range, payTo allowlist, no self-payments (they would only burn the operator's gas). */
  function policy(p: ParsedPayment): Failure | null {
    if (p.amount < minAmount) return fail(ErrorReason.invalidRequirements, `The amount is below the smallest payment this facilitator settles (${usdg(minAmount)})`);
    if (p.amount > maxAmount) return fail(ErrorReason.invalidRequirements, `The amount is above the largest payment this facilitator settles (${usdg(maxAmount)})`);
    if (allowlist && !allowlist.has(p.payTo.toLowerCase())) return fail(ErrorReason.invalidRequirements, "This facilitator does not settle payments to this payTo address");
    if (p.payer.toLowerCase() === p.payTo.toLowerCase()) return fail(ErrorReason.invalidPayload, "The payer and payTo are the same address");
    return null;
  }

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

  /** A failed eth_call / eth_estimateGas of transferWithAuthorization, as an x402 error. */
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
   * of transferWithAuthorization from the operator (catches anything else the token would refuse).
   */
  async function chainChecks(p: ParsedPayment, unexpected: ErrorReason): Promise<Failure | null> {
    try {
      const wrongChain = await checkChainId();
      if (wrongChain) return fail(unexpected, wrongChain);
      const [used, balance] = await Promise.all([chain.authorizationUsed(p.auth.from, p.auth.nonce), chain.tokenBalance(p.auth.from)]);
      if (used) return fail(ErrorReason.invalidPayload, "This authorization nonce was already used on-chain");
      if (balance < p.auth.value) return fail(ErrorReason.insufficientFunds, "The payer does not hold enough of the token");
      const revert = await chain.simulate(transferCalldata(p.auth, p.signature), operator);
      return revert ? fromRevert(revert) : null;
    } catch (e) {
      return fail(unexpected, e instanceof RpcError ? `Could not read the chain: ${e.message}` : "Could not read the chain");
    }
  }

  /** Everything `/verify` checks, in order: policy, recipient, amount, window, signature, then the chain. */
  async function checkAll(p: ParsedPayment, unexpected: ErrorReason): Promise<Failure | null> {
    return policy(p) ?? authorizationChecks(p) ?? (await signatureCheck(p)) ?? (await chainChecks(p, unexpected));
  }

  async function verifyParsed(r: ParseResult): Promise<VerifyResponse> {
    if (!r.ok) return { isValid: false, invalidReason: r.reason, invalidMessage: r.message, ...(r.payer ? { payer: r.payer } : {}) };
    const p = r.value;
    const bad = await checkAll(p, ErrorReason.unexpectedVerify);
    if (bad) return { isValid: false, invalidReason: bad.reason, invalidMessage: bad.message, payer: p.payer };
    // Read-only look at this facilitator's own records: an authorization it is settling is not payable again.
    const prior = await store.get(keyOf(p)).catch(() => undefined);
    if (prior?.state === "failed") {
      return { isValid: false, invalidReason: ErrorReason.invalidTransactionState, invalidMessage: "An earlier settlement of this authorization failed", payer: p.payer };
    }
    if (prior) return { isValid: false, invalidReason: ErrorReason.invalidPayload, invalidMessage: "This authorization is already being settled or was settled", payer: p.payer };
    return { isValid: true, payer: p.payer };
  }

  // ---------- settlement ----------

  async function waitReceipt(hash: Hex, timeoutMs: number): Promise<RpcReceipt | null> {
    const until = Date.now() + timeoutMs;
    for (;;) {
      const r = await chain.receipt(hash).catch(() => null);
      if (r) return r;
      if (Date.now() >= until) return null;
      await new Promise((res) => setTimeout(res, Math.min(pollMs, Math.max(1, until - Date.now()))));
    }
  }

  async function maybePrune() {
    if (Date.now() - lastPrune < PRUNE_EVERY_MS) return;
    lastPrune = Date.now();
    await store.prune(now()).catch(() => 0);
  }

  async function settleParsed(r: ParseResult): Promise<Outcome<SettleResponse>> {
    const no = (reason: ErrorReason, message: string, opts: { status?: number; tx?: string; payer?: string } = {}): Outcome<SettleResponse> => ({
      status: opts.status ?? 200,
      body: { success: false, errorReason: reason, errorMessage: message, transaction: opts.tx ?? "", network, ...(opts.payer ? { payer: opts.payer } : {}) },
    });
    if (!r.ok) return no(r.reason, r.message, { payer: r.payer });
    const p = r.value;
    const payer = p.payer;
    const k = keyOf(p);
    await maybePrune();

    const pending = (tx: string): Outcome<SettleResponse> =>
      no(ErrorReason.settlementPending, "The settlement transaction was broadcast and is not confirmed yet. Call /settle again with the same payload to reconcile.", { tx, payer });

    /** The receipt decides. Exactly one caller ever gets success for an authorization. */
    async function finish(rec: SettlementRecord, receipt: RpcReceipt): Promise<Outcome<SettleResponse>> {
      const tx = rec.tx as string;
      if (receipt.status !== "0x1") {
        await store.put(k, { ...rec, state: "failed", raw: undefined, error: "reverted", updatedAt: now() });
        log("settle.reverted", { tx, payer, payTo: p.payTo, amount: p.amount.toString() });
        return no(ErrorReason.invalidTransactionState, "The settlement transaction reverted", { tx, payer });
      }
      const n = matchingTransfers(receipt, asset.address, p.auth.from, p.auth.to, p.auth.value);
      if (n !== 1) {
        await store.put(k, { ...rec, state: "failed", raw: undefined, error: `${n} matching Transfer logs`, updatedAt: now() });
        log("settle.transfer_mismatch", { tx, matches: n });
        return no(ErrorReason.invalidTransactionState, `The settlement transaction confirmed without exactly one matching Transfer log (found ${n})`, { tx, payer });
      }
      const done: SettlementRecord = { ...rec, state: "settled", raw: undefined, updatedAt: now() };
      if (!(await store.claim(`${k}#success`, done))) {
        await store.put(k, done);
        return no(ErrorReason.invalidPayload, `This authorization was already settled in ${tx}`, { payer });
      }
      await store.put(k, done);
      log("settle.settled", { tx, payer, payTo: p.payTo, amount: p.amount.toString() });
      return { status: 200, body: { success: true, transaction: tx, network, payer, amount: p.amount.toString() } };
    }

    /**
     * An earlier attempt left a submitted transaction (a receipt timeout, a lost answer, a restart). Look for its
     * receipt, rebroadcast the identical signed bytes (same hash, so it can never become a second transaction), or
     * prove it can never transfer. "dead" = another transaction took its operator nonce: it can never be mined.
     */
    async function reconcile(rec: SettlementRecord): Promise<Outcome<SettleResponse> | "dead"> {
      const tx = rec.tx as Hex;
      const first = await chain.receipt(tx).catch(() => undefined);
      if (first) return finish(rec, first);
      if (first === undefined) return pending(tx); // the RPC is in trouble: nothing can be proven
      if (rec.raw) {
        await chain.sendRawTransaction(rec.raw as Hex).catch(() => undefined); // "already known" and "nonce too low" are fine
        log("settle.rebroadcast", { tx, operatorNonce: rec.operatorNonce });
      }
      const second = await waitReceipt(tx, Math.min(receiptTimeoutMs, 5_000));
      if (second) return finish(rec, second);
      // Chain time and the operator nonce first, then the receipt once more: a transaction mined in between shows up.
      const facts = await Promise.all([
        chain.blockTimestamp(),
        rec.operator && rec.operatorNonce !== undefined ? chain.nonce(rec.operator as Address, "latest") : Promise.resolve(undefined),
      ]).catch(() => null);
      if (!facts) return pending(tx);
      const third = await chain.receipt(tx).catch(() => undefined);
      if (third) return finish(rec, third);
      if (third === undefined) return pending(tx);
      const [blockTime, latestNonce] = facts;
      if (latestNonce !== undefined && rec.operatorNonce !== undefined && latestNonce > rec.operatorNonce) {
        log("settle.dropped", { tx, operatorNonce: rec.operatorNonce });
        return "dead";
      }
      if (blockTime >= p.auth.validBefore) {
        // Mined from now on, the token reverts it: no transfer can happen.
        await store.put(k, { ...rec, state: "failed", raw: undefined, error: "expired before it was mined", updatedAt: now() });
        log("settle.expired", { tx });
        return no(ErrorReason.validBefore, "The authorization expired before the settlement transaction was mined. Nothing was transferred.", { tx, payer });
      }
      return pending(tx);
    }

    // 1. An authorization this facilitator already touched.
    let restartFrom: SettlementRecord | null = null;
    const prior = await store.get(k);
    if (prior) {
      if (inflight.has(k) || prior.state === "settling") return no(ErrorReason.invalidTransactionState, "This authorization is already being settled by this facilitator", { payer });
      if (prior.state === "settled") return no(ErrorReason.invalidPayload, `This authorization was already settled in ${prior.tx}`, { payer });
      if (prior.state === "failed") return no(ErrorReason.invalidTransactionState, `An earlier settlement of this authorization failed (${prior.error ?? "unknown"})`, { payer });
      inflight.add(k);
      let out: Outcome<SettleResponse> | "dead";
      try {
        out = await reconcile(prior);
      } finally {
        inflight.delete(k);
      }
      if (out !== "dead") return out;
      // Exactly one caller may start over after a provably dead transaction.
      const marker: SettlementRecord = { ...prior, state: "failed", raw: undefined, error: "dropped", updatedAt: now() };
      if (!(await store.claim(`${k}#dropped:${prior.tx}`, marker))) {
        return no(ErrorReason.invalidTransactionState, "This authorization is already being settled by this facilitator", { payer });
      }
      restartFrom = prior;
    }

    // 2. Re-verify everything, including the simulation from the operator.
    const bad = await checkAll(p, ErrorReason.unexpectedSettle);
    if (bad) {
      if (restartFrom) await store.delete(k); // the dead transaction can never land, and this caller owns the restart
      return no(bad.reason, bad.message, { payer });
    }

    // 3. Claim: one settlement per authorization, across every process sharing the store.
    const t = now();
    const claimed: SettlementRecord = {
      state: "settling",
      payer,
      payTo: p.payTo,
      amount: p.amount.toString(),
      createdAt: t,
      updatedAt: t,
      expiresAt: Number(p.auth.validBefore) * 1000 + RETAIN_AFTER_EXPIRY_MS,
    };
    if (restartFrom) await store.put(k, { ...claimed, createdAt: restartFrom.createdAt });
    else if (!(await store.claim(k, claimed))) return no(ErrorReason.invalidTransactionState, "This authorization is already being settled by this facilitator", { payer });
    inflight.add(k);

    // 4. One sender: gas, nonce, sign, persist, broadcast, receipt.
    let release: (() => void) | null = null;
    let persisted = false;
    try {
      try {
        release = await sender.acquire(queueTimeoutMs);
      } catch (e) {
        if (e instanceof QueueTimeoutError) {
          await store.delete(k);
          return no(ErrorReason.unexpectedSettle, "The settlement queue is busy. Retry shortly.", { status: 503, payer });
        }
        throw e;
      }
      const giveUp = async (reason: ErrorReason, message: string, status = 200) => {
        await store.delete(k);
        return no(reason, message, { status, payer });
      };
      if (p.auth.validBefore < BigInt(nowSec() + margin)) return await giveUp(ErrorReason.validBefore, `The authorization expires within ${margin} s`);
      const data = transferCalldata(p.auth, p.signature);
      const est = await chain.estimateGas(operator, data);
      if (!est.ok) {
        const f = fromRevert(est.revert);
        return await giveUp(f.reason, f.message);
      }
      if (est.gas > maxGas) return await giveUp(ErrorReason.unexpectedSettle, `The gas estimate (${est.gas}) is above this facilitator's limit (${maxGas})`, 503);
      const padded = est.gas + est.gas / 4n;
      const gas = padded > maxGas ? maxGas : padded;
      const { maxFeePerGas, maxPriorityFeePerGas } = await chain.fees();
      const [nonce, balance] = await Promise.all([chain.nonce(operator, "pending"), chain.ethBalance(operator)]);
      if (balance < gas * maxFeePerGas) return await giveUp(ErrorReason.unexpectedSettle, "The operator cannot cover the gas of this settlement. The operator needs to add ETH.", 503);

      const raw = await account.signTransaction({ chainId, type: "eip1559", to: asset.address, data, nonce, gas, maxFeePerGas, maxPriorityFeePerGas, value: 0n });
      const tx = keccak256(raw);
      const submitted: SettlementRecord = { ...claimed, state: "submitted", tx, raw, operator, operatorNonce: nonce, updatedAt: now() };
      await store.put(k, submitted); // before broadcasting: the store always knows every hash that may be on the wire
      persisted = true;
      try {
        await chain.sendRawTransaction(raw);
      } catch (e) {
        // The node answered with a refusal and does not know the transaction: it was not broadcast.
        if (e instanceof RpcError && e.answered && !/already known|known transaction|already imported/i.test(e.message)) {
          const seen = await chain.transaction(tx).catch(() => undefined);
          if (seen === null) {
            persisted = false;
            log("settle.refused", { tx, error: e.message });
            return await giveUp(ErrorReason.unexpectedSettle, `The RPC refused the settlement transaction: ${e.message}`, 502);
          }
        }
        // Otherwise it may be on the wire: the receipt decides.
      }
      log("settle.submitted", { tx, payer, payTo: p.payTo, amount: p.amount.toString(), operatorNonce: nonce });
      const receipt = await waitReceipt(tx, receiptTimeoutMs);
      return receipt ? await finish(submitted, receipt) : pending(tx);
    } catch (e) {
      const message = e instanceof RpcError ? e.message : "internal error";
      if (!persisted) {
        await store.delete(k).catch(() => {});
        return no(ErrorReason.unexpectedSettle, `Settlement failed before anything was broadcast: ${message}`, { status: 502, payer });
      }
      const rec = await store.get(k).catch(() => undefined);
      return rec?.tx ? pending(rec.tx) : no(ErrorReason.unexpectedSettle, message, { status: 500, payer });
    } finally {
      release?.();
      inflight.delete(k);
    }
  }

  // ---------- public API ----------

  const supportedResponse: SupportedResponse = {
    kinds: [{ x402Version: 2, scheme: "exact", network }],
    extensions: [],
    signers: { "eip155:*": [operator] },
  };

  return {
    operator: operator as Address,
    network,
    chainId,
    asset,
    limits: { minAmount, maxAmount, payToAllowlist: allowlist ? [...allowlist].map((a) => getAddress(a)) : null },

    /** Read-only: is this payment valid right now? Never writes state or sends a transaction. */
    verify: (paymentPayload: unknown, paymentRequirements: unknown): Promise<VerifyResponse> =>
      verifyParsed(parsePayment(paymentPayload, paymentRequirements, network, asset)),
    /** `POST /verify` body: { x402Version, paymentPayload, paymentRequirements }. */
    verifyRequest: (body: unknown): Promise<VerifyResponse> => verifyParsed(parseRequestBody(body, network, asset)),

    /** Re-verify, simulate, send transferWithAuthorization from the operator and confirm the Transfer log. */
    settle: async (paymentPayload: unknown, paymentRequirements: unknown): Promise<SettleResponse> =>
      (await settleParsed(parsePayment(paymentPayload, paymentRequirements, network, asset))).body,
    /** `POST /settle` body, with the HTTP status to answer with. */
    settleRequest: (body: unknown): Promise<Outcome<SettleResponse>> => settleParsed(parseRequestBody(body, network, asset)),

    supported: (): SupportedResponse => supportedResponse,
  };
}

export type Facilitator = ReturnType<typeof createFacilitator>;
