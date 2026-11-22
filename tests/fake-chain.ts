import {
  custom,
  decodeFunctionData,
  encodeErrorResult,
  encodeFunctionResult,
  parseAbi,
  recoverTypedDataAddress,
  serializeSignature,
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

  /** A viem transport for `createFacilitator({ transport })`. */
  get transport() {
    return custom({ request: (args: { method: string; params?: unknown }) => this.request(args) });
  }
}
