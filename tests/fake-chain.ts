import { custom, decodeFunctionData, encodeFunctionResult, parseAbi, toHex, type Address, type Hex } from "viem";

import { USDG } from "../src/constants.js";

const ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

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

  protected handle(method: string, params: unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return toHex(this.chainId);
      case "eth_call":
        return this.call(params[0] as CallTx);
      default:
        throw { code: -32601, message: `the fake chain does not support ${method}` };
    }
  }

  protected call(tx: CallTx): Hex {
    if (tx.to.toLowerCase() !== this.token.toLowerCase()) return "0x";
    const { functionName, args } = decodeFunctionData({ abi: ABI, data: tx.data });
    if (functionName === "balanceOf") return encodeFunctionResult({ abi: ABI, functionName, result: this.balanceOf(args[0]) });
    return encodeFunctionResult({ abi: ABI, functionName, result: this.isUsed(args[0], args[1]) });
  }

  /** A viem transport for `createFacilitator({ transport })`. */
  get transport() {
    return custom({ request: (args: { method: string; params?: unknown }) => this.request(args) });
  }
}
