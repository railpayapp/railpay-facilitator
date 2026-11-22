import {
  createPublicClient,
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  http,
  pad,
  parseAbi,
  parseSignature,
  toEventSelector,
  type Address,
  type Hex,
  type Transport,
} from "viem";

import type { AssetConfig, Authorization } from "./parse.js";

export const TOKEN_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
  "function name() view returns (string)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

/**
 * Custom errors used to explain a failed simulation. InsufficientFunds() and InvalidSignature() are what USDG on
 * Robinhood Chain reverts with (checked with eth_call). Error(string) and Panic(uint256) are decoded by viem.
 */
export const TOKEN_ERRORS = parseAbi(["error InsufficientFunds()", "error InvalidSignature()"]);

export const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");

/** An RPC call failed. The message never contains the RPC URL (it may hold an API key) or the request body. */
export class RpcError extends Error {
  constructor(
    readonly method: string,
    message: string,
    /** True when the node answered with a JSON-RPC error (it saw and refused the request). */
    readonly answered: boolean,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

type ErrorInfo = { code?: number; message?: string; data?: Hex; status?: number; name?: string };

/**
 * Pull the JSON-RPC code, node message and revert data out of a viem error chain. The deepest level wins: viem wraps
 * the node's `{ code, message, data }` object in its own errors (some with a generic code such as -1).
 * Only `details` (the node's own message) is read from viem errors, never `message`, which contains the URL.
 */
export function errorInfo(err: unknown): ErrorInfo {
  const info: ErrorInfo = {};
  let cur: unknown = err;
  for (let i = 0; i < 12 && cur && typeof cur === "object"; i++) {
    const e = cur as Record<string, unknown>;
    if (info.name === undefined && typeof e.name === "string") info.name = e.name;
    if (typeof e.status === "number") info.status = e.status;
    if (typeof e.code === "number") {
      info.code = e.code;
      const msg = cur instanceof Error ? e.details : e.message;
      if (typeof msg === "string") info.message = msg;
    }
    if (typeof e.data === "string" && /^0x[0-9a-fA-F]*$/.test(e.data)) info.data = e.data as Hex;
    else if (e.data && typeof e.data === "object" && typeof (e.data as { data?: unknown }).data === "string") {
      const d = (e.data as { data: string }).data;
      if (/^0x[0-9a-fA-F]*$/.test(d)) info.data = d as Hex;
    }
    cur = e.cause;
  }
  return info;
}

/** A call that the contract reverted. */
export type Revert = { data?: Hex; name?: string; message: string };

export type RpcLog = { address: string; topics: string[]; data: string; logIndex?: string };
export type RpcReceipt = { status: string; transactionHash: string; blockNumber: string; gasUsed?: string; effectiveGasPrice?: string; logs: RpcLog[] };

/** A short message that is safe to log and return: no URLs, no request bodies. */
export function safe(text: string) {
  return text.replace(/https?:\/\/\S+/g, "[url]").replace(/\s+/g, " ").slice(0, 200);
}

export function rpcError(method: string, err: unknown): RpcError {
  const info = errorInfo(err);
  // -1 is viem's code for "no JSON-RPC answer" (a thrown fetch error, for example).
  if (info.code !== undefined && info.code !== -1 && info.message) return new RpcError(method, safe(`${method}: ${info.message}`), true);
  if (info.status !== undefined) return new RpcError(method, `${method}: RPC answered HTTP ${info.status}`, false);
  return new RpcError(method, `${method}: RPC unreachable${info.name ? ` (${info.name})` : ""}`, false);
}

function isRevert(info: ErrorInfo) {
  return info.code === 3 || (info.data !== undefined && info.data.length >= 10) || /revert/i.test(info.message ?? "");
}

/** Name and message of a revert, from the token's known errors, Error(string) or Panic(uint256). */
export function decodeRevert(data: Hex | undefined, fallback = "execution reverted"): Revert {
  if (!data || data.length < 10) return { data, message: fallback };
  try {
    // viem also decodes the built-in Error(string) and Panic(uint256).
    const d = decodeErrorResult({ abi: TOKEN_ERRORS, data }) as { errorName: string; args?: readonly unknown[] };
    if (d.errorName === "Error") return { data, name: "Error", message: String(d.args?.[0] ?? fallback) };
    if (d.errorName === "Panic") return { data, name: "Panic", message: `panic ${String(d.args?.[0])}` };
    return { data, name: d.errorName, message: d.errorName };
  } catch {
    return { data, message: `reverted with ${data.slice(0, 10)}` };
  }
}

/** transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s) calldata. */
export function transferCalldata(auth: Authorization, signature: Hex): Hex {
  const { r, s, v, yParity } = parseSignature(signature);
  const vv = Number(v ?? BigInt((yParity ?? 0) + 27));
  return encodeFunctionData({
    abi: TOKEN_ABI,
    functionName: "transferWithAuthorization",
    args: [auth.from, auth.to, auth.value, auth.validAfter, auth.validBefore, auth.nonce, vv, r, s],
  });
}

/** Number of Transfer(from → to, value) logs the token emitted in a receipt. */
export function matchingTransfers(receipt: RpcReceipt, token: Address, from: Address, to: Address, value: bigint) {
  const f = pad(from.toLowerCase() as Hex);
  const t = pad(to.toLowerCase() as Hex);
  return receipt.logs.filter(
    (l) =>
      l.address.toLowerCase() === token.toLowerCase() &&
      l.topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      l.topics[1]?.toLowerCase() === f &&
      l.topics[2]?.toLowerCase() === t &&
      BigInt(l.data) === value,
  ).length;
}

export type ChainOptions = {
  asset: AssetConfig;
  /** JSON-RPC URL. Ignored when `transport` is given. */
  rpcUrl?: string;
  /** A viem transport (tests pass `custom(...)`). */
  transport?: Transport;
};

/** The few JSON-RPC calls the facilitator needs, with errors that never leak the RPC URL. */
export function createChain(options: ChainOptions) {
  const transport = options.transport ?? http(options.rpcUrl, { timeout: 10_000, retryCount: 1 });
  const client = createPublicClient({ transport });
  const token = options.asset.address;

  async function request<T>(method: string, params: unknown[]): Promise<T> {
    try {
      return (await client.request({ method, params } as never)) as T;
    } catch (e) {
      throw rpcError(method, e);
    }
  }

  async function read(functionName: "balanceOf" | "authorizationState", args: readonly unknown[]) {
    const data = encodeFunctionData({ abi: TOKEN_ABI, functionName, args } as never);
    const out = await request<Hex>("eth_call", [{ to: token, data }, "latest"]);
    try {
      return decodeFunctionResult({ abi: TOKEN_ABI, functionName, data: out } as never) as unknown;
    } catch {
      throw new RpcError("eth_call", `eth_call: ${functionName} returned no data (is ${token} the token on this chain?)`, true);
    }
  }

  /** Run a call that may revert. Returns the revert, or throws RpcError for anything else. */
  async function mayRevert<T>(method: string, params: unknown[]): Promise<{ ok: true; value: T } | { ok: false; revert: Revert }> {
    try {
      return { ok: true, value: (await client.request({ method, params } as never)) as T };
    } catch (e) {
      const info = errorInfo(e);
      if (isRevert(info)) return { ok: false, revert: decodeRevert(info.data, safe(info.message ?? "execution reverted")) };
      throw rpcError(method, e);
    }
  }

  return {
    token,
    chainId: async () => Number(BigInt(await request<string>("eth_chainId", []))),
    ethBalance: async (address: Address) => BigInt(await request<string>("eth_getBalance", [address, "latest"])),
    tokenBalance: async (owner: Address) => (await read("balanceOf", [owner])) as bigint,
    authorizationUsed: async (authorizer: Address, nonce: Hex) => (await read("authorizationState", [authorizer, nonce])) as boolean,
    /** eth_call of `data` on the token, from `from` when given. Null when it would succeed. */
    simulate: async (data: Hex, from?: Address): Promise<Revert | null> => {
      const r = await mayRevert<Hex>("eth_call", [{ ...(from ? { from } : {}), to: token, data }, "latest"]);
      return r.ok ? null : r.revert;
    },
    estimateGas: async (from: Address, data: Hex) => {
      const r = await mayRevert<string>("eth_estimateGas", [{ from, to: token, data }]);
      return r.ok ? ({ ok: true, gas: BigInt(r.value) } as const) : ({ ok: false, revert: r.revert } as const);
    },
    nonce: async (address: Address, tag: "pending" | "latest") => Number(BigInt(await request<string>("eth_getTransactionCount", [address, tag]))),
    /** EIP-1559 fees: maxFee = 2 × latest base fee + priority fee (0 if the node has no eth_maxPriorityFeePerGas). */
    fees: async () => {
      const block = await request<{ baseFeePerGas?: string } | null>("eth_getBlockByNumber", ["latest", false]);
      if (!block?.baseFeePerGas) throw new RpcError("eth_getBlockByNumber", "eth_getBlockByNumber: the chain reports no EIP-1559 base fee", true);
      const baseFee = BigInt(block.baseFeePerGas);
      const priority = await request<string>("eth_maxPriorityFeePerGas", [])
        .then((p) => BigInt(p))
        .catch(() => 0n);
      return { baseFee, maxPriorityFeePerGas: priority, maxFeePerGas: baseFee * 2n + priority };
    },
    sendRawTransaction: (raw: Hex) => request<Hex>("eth_sendRawTransaction", [raw]),
    receipt: (hash: Hex) => request<RpcReceipt | null>("eth_getTransactionReceipt", [hash]),
    transaction: (hash: Hex) => request<Record<string, unknown> | null>("eth_getTransactionByHash", [hash]),
    tokenName: async () => {
      const out = await request<Hex>("eth_call", [{ to: token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "name" }) }, "latest"]);
      return decodeFunctionResult({ abi: TOKEN_ABI, functionName: "name", data: out }) as string;
    },
    domainSeparator: async () => {
      const out = await request<Hex>("eth_call", [{ to: token, data: encodeFunctionData({ abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR" }) }, "latest"]);
      return decodeFunctionResult({ abi: TOKEN_ABI, functionName: "DOMAIN_SEPARATOR", data: out }) as Hex;
    },
  };
}

export type Chain = ReturnType<typeof createChain>;
