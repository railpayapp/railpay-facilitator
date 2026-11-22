import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, parseAbi, type Address, type Hex, type Transport } from "viem";

import type { AssetConfig } from "./parse.js";

export const TOKEN_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
]);

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

  return {
    token,
    chainId: async () => Number(BigInt(await request<string>("eth_chainId", []))),
    tokenBalance: async (owner: Address) => (await read("balanceOf", [owner])) as bigint,
    authorizationUsed: async (authorizer: Address, nonce: Hex) => (await read("authorizationState", [authorizer, nonce])) as boolean,
  };
}

export type Chain = ReturnType<typeof createChain>;
