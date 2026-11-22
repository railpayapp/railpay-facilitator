import {
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  keccak256,
  pad,
  parseAbi,
  parseTransaction,
  recoverTransactionAddress,
  recoverTypedDataAddress,
  serializeSignature,
  toEventSelector,
  toHex,
  type Address,
  type Hex,
} from "viem";

import { AUTHORIZATION_TYPES, USDG } from "../src/constants.js";
import { NOW_S } from "./helpers.js";

const ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
export const ERRORS = parseAbi(["error InsufficientFunds()", "error InvalidSignature()", "error AuthorizationUsed()", "error Error(string)"]);
export const revertData = {
  insufficientFunds: encodeErrorResult({ abi: ERRORS, errorName: "InsufficientFunds" }),
  invalidSignature: encodeErrorResult({ abi: ERRORS, errorName: "InvalidSignature" }),
  reason: (text: string) => encodeErrorResult({ abi: ERRORS, errorName: "Error", args: [text] }),
};

export type Transfer = { from: Address; to: Address; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex; signer: Address | null };

/** A JSON-RPC error object (the node answered) or an Error (the transport failed). */
export type RpcFailure = { code: number; message: string; data?: Hex } | Error;

type CallTx = { from?: string; to: string; data: Hex };

export type FakeReceipt = {
  status: Hex;
  transactionHash: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  effectiveGasPrice: Hex;
  logs: { address: string; topics: Hex[]; data: Hex; logIndex: Hex }[];
};

const TRANSFER = toEventSelector("Transfer(address,address,uint256)");
/** Gas a USDG transferWithAuthorization uses on Robinhood Chain. */
export const TRANSFER_GAS = 48_412n;

/** An in-memory Robinhood Chain with USDG, enough for the facilitator's JSON-RPC calls. */
export class FakeChain {
  chainId = 4663;
  token: Address = USDG;
  /** Token balance of any address without an explicit one (1000 USDG). */
  defaultBalance = 1_000_000_000n;
  balances = new Map<string, bigint>();
  usedNonces = new Set<string>();
  /** Every JSON-RPC method called, in order. */
  calls: string[] = [];
  /** Make a method fail with a JSON-RPC error or a transport error. */
  failures = new Map<string, RpcFailure>();
  /** Block timestamp, seconds. */
  timestamp = NOW_S;
  /** Force every transferWithAuthorization call to revert with this data. */
  transferRevert: Hex | null = null;
  /** `from` of every transferWithAuthorization eth_call. */
  simulatedFrom: (string | undefined)[] = [];

  /** ETH balance of any address without an explicit one (1 ETH). */
  defaultEth = 10n ** 18n;
  eth = new Map<string, bigint>();
  /** Base fee, wei (0.02 gwei, as on Robinhood Chain). */
  baseFee = 20_000_000n;
  /** Answer of eth_estimateGas for a transfer that would succeed. */
  estimate = TRANSFER_GAS;
  /** Mine each transaction as soon as it is sent. False: it waits in `mempool` until `mine()`. */
  autoMine = true;
  /** Raw transactions accepted by eth_sendRawTransaction, in order. */
  sent: Hex[] = [];
  mempool: Hex[] = [];
  receipts = new Map<string, FakeReceipt>();
  /** Account nonces of mined transactions. */
  nonces = new Map<string, number>();
  block = 100;
  /** Accept the transaction, then fail the eth_sendRawTransaction answer (lost response). */
  loseSendResponse = false;
  /** Mine the next transaction without its Transfer log (a token that misbehaves). */
  omitTransferLog = false;
  /** Runs right before a transaction is mined (front-run the settlement, for example). */
  beforeMine: (() => void) | null = null;

  balanceOf(address: string) {
    return this.balances.get(address.toLowerCase()) ?? this.defaultBalance;
  }
  setBalance(address: string, value: bigint) {
    this.balances.set(address.toLowerCase(), value);
  }
  isUsed(from: string, nonce: string) {
    return this.usedNonces.has(`${from.toLowerCase()}:${nonce.toLowerCase()}`);
  }
  markUsed(from: string, nonce: string) {
    this.usedNonces.add(`${from.toLowerCase()}:${nonce.toLowerCase()}`);
  }
  count(method: string) {
    return this.calls.filter((m) => m === method).length;
  }
  ethOf(address: string) {
    return this.eth.get(address.toLowerCase()) ?? this.defaultEth;
  }
  setEth(address: string, value: bigint) {
    this.eth.set(address.toLowerCase(), value);
  }
  nonceOf(address: string) {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }
  /** Mine every transaction waiting in the mempool, in order. */
  async mine() {
    const txs = this.mempool.splice(0);
    for (const raw of txs) await this.apply(raw);
  }
  /** Forget the mempool, as a node that restarted or evicted the transactions. */
  dropMempool() {
    this.mempool = [];
  }

  async request({ method, params }: { method: string; params?: unknown }): Promise<unknown> {
    this.calls.push(method);
    const failure = this.failures.get(method);
    if (failure) throw failure;
    return this.handle(method, (params ?? []) as unknown[]);
  }

  protected async handle(method: string, params: unknown[]): Promise<unknown> {
    switch (method) {
      case "eth_chainId":
        return toHex(this.chainId);
      case "eth_call":
        return this.call(params[0] as CallTx);
      case "eth_getBalance":
        return toHex(this.ethOf(params[0] as string));
      case "eth_getTransactionCount": {
        const address = String(params[0]).toLowerCase();
        let n = this.nonceOf(address);
        if (params[1] === "pending") {
          for (const raw of this.mempool) if ((await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase() === address) n++;
        }
        return toHex(n);
      }
      case "eth_estimateGas": {
        const tx = params[0] as CallTx;
        await this.call(tx);
        return toHex(this.estimate);
      }
      case "eth_blockNumber":
        return toHex(this.block);
      case "eth_getLogs": {
        // Logs of mined transactions, filtered by address and topics. Like USDG, the fake emits Transfer only.
        const q = params[0] as { address?: string; topics?: (string | null)[] };
        const logs = [...this.receipts.values()].flatMap((r) => r.logs.map((l) => ({ ...l, transactionHash: r.transactionHash, blockNumber: r.blockNumber })));
        return logs.filter(
          (l) =>
            (!q.address || l.address.toLowerCase() === q.address.toLowerCase()) &&
            (q.topics ?? []).every((t, i) => t === null || t === undefined || l.topics[i]?.toLowerCase() === t.toLowerCase()),
        );
      }
      case "eth_getBlockByNumber":
        return { number: toHex(this.block), timestamp: toHex(this.timestamp), baseFeePerGas: toHex(this.baseFee) };
      case "eth_maxPriorityFeePerGas":
        return "0x0";
      case "eth_sendRawTransaction":
        return this.send(params[0] as Hex);
      case "eth_getTransactionReceipt":
        return this.receipts.get(String(params[0]).toLowerCase()) ?? null;
      case "eth_getTransactionByHash": {
        const hash = String(params[0]).toLowerCase();
        const known = this.receipts.has(hash) || this.mempool.some((raw) => keccak256(raw) === hash);
        return known ? { hash } : null;
      }
      default:
        throw { code: -32601, message: `the fake chain does not support ${method}` };
    }
  }

  protected async call(tx: CallTx): Promise<Hex> {
    if (tx.to.toLowerCase() !== this.token.toLowerCase()) return "0x";
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.data });
    if (functionName === "balanceOf") return encodeFunctionResult({ abi: ABI, functionName, result: this.balanceOf(args[0]) });
    if (functionName === "authorizationState") return encodeFunctionResult({ abi: ABI, functionName, result: this.isUsed(args[0], args[1]) });
    this.simulatedFrom.push(tx.from);
    this.checkTransfer(await this.decodeTransfer(tx.data));
    return "0x";
  }

  /** The arguments of a transferWithAuthorization call, with the recovered signer. */
  async decodeTransfer(data: Hex): Promise<Transfer> {
    const { args } = decodeFunctionData({ abi: ABI, data });
    const [from, to, value, validAfter, validBefore, nonce, v, r, s] = args as readonly [Address, Address, bigint, bigint, bigint, Hex, number, Hex, Hex];
    const signer = await recoverTypedDataAddress({
      domain: { name: "Global Dollar", version: "1", chainId: this.chainId, verifyingContract: this.token },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: { from, to, value, validAfter, validBefore, nonce },
      signature: serializeSignature({ r, s, v: BigInt(v) }),
    }).catch(() => null);
    return { from, to, value, validAfter, validBefore, nonce, signer };
  }

  /** What the token checks, reverting like USDG does. */
  checkTransfer(t: Transfer) {
    const revert = (data: Hex) => {
      throw { code: 3, message: "execution reverted", data };
    };
    if (this.transferRevert) revert(this.transferRevert);
    if (this.timestamp <= t.validAfter) revert(revertData.reason("authorization is not yet valid"));
    if (this.timestamp >= t.validBefore) revert(revertData.reason("authorization is expired"));
    if (this.isUsed(t.from, t.nonce)) revert(encodeErrorResult({ abi: ERRORS, errorName: "AuthorizationUsed" }));
    if (t.signer?.toLowerCase() !== t.from.toLowerCase()) revert(revertData.invalidSignature);
    if (this.balanceOf(t.from) < t.value) revert(revertData.insufficientFunds);
  }

  protected async send(raw: Hex): Promise<Hex> {
    const hash = keccak256(raw);
    if (this.receipts.has(hash) || this.mempool.some((r) => keccak256(r) === hash)) throw { code: -32000, message: "already known" };
    const tx = parseTransaction(raw);
    if (tx.chainId !== this.chainId) throw { code: -32000, message: "invalid chain id" };
    const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
    let expected = this.nonceOf(from);
    for (const r of this.mempool) if ((await recoverTransactionAddress({ serializedTransaction: r as never })).toLowerCase() === from.toLowerCase()) expected++;
    if ((tx.nonce ?? 0) < expected) throw { code: -32000, message: "nonce too low" };
    if ((tx.nonce ?? 0) > expected) throw { code: -32000, message: "nonce too high" };
    if (this.ethOf(from) < (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n)) throw { code: -32000, message: "insufficient funds for gas * price + value" };
    this.sent.push(raw);
    this.mempool.push(raw);
    if (this.autoMine) await this.mine();
    if (this.loseSendResponse) throw new Error("socket hang up");
    return hash;
  }

  /** Mine one transaction: nonce, gas, then the token's own checks at mining time. */
  protected async apply(raw: Hex) {
    const hash = keccak256(raw);
    const tx = parseTransaction(raw);
    const from = await recoverTransactionAddress({ serializedTransaction: raw as never });
    this.beforeMine?.();
    this.nonces.set(from.toLowerCase(), this.nonceOf(from) + 1);
    const price = this.baseFee + (tx.maxPriorityFeePerGas ?? 0n);
    this.setEth(from, this.ethOf(from) - TRANSFER_GAS * price);
    this.block++;
    const receipt: FakeReceipt = { status: "0x1", transactionHash: hash, blockNumber: toHex(this.block), gasUsed: toHex(TRANSFER_GAS), effectiveGasPrice: toHex(price), logs: [] };
    try {
      if (tx.to?.toLowerCase() !== this.token.toLowerCase() || !tx.data) throw new Error("not a token call");
      const t = await this.decodeTransfer(tx.data);
      this.checkTransfer(t);
      this.setBalance(t.from, this.balanceOf(t.from) - t.value);
      this.setBalance(t.to, this.balanceOf(t.to) + t.value);
      this.markUsed(t.from, t.nonce);
      if (!this.omitTransferLog) {
        receipt.logs.push({ address: this.token, topics: [TRANSFER, pad(t.from.toLowerCase() as Hex), pad(t.to.toLowerCase() as Hex)], data: pad(toHex(t.value)), logIndex: "0x0" });
      }
      this.omitTransferLog = false;
    } catch {
      receipt.status = "0x0";
    }
    this.receipts.set(hash, receipt);
  }

  /** A viem transport for `createFacilitator({ transport })`. */
  get transport() {
    return custom({ request: (args: { method: string; params?: unknown }) => this.request(args) });
  }
}
