import type { Hex } from "viem";

import { DEFAULT_RPC_URL } from "./constants.js";
import type { FacilitatorOptions } from "./facilitator.js";

/** Environment variables read by `loadConfig` (`process.env` or Workers vars). */
export type FacilitatorEnv = {
  OPERATOR_KEY?: string;
  RPC_URL?: string;
  VALIDITY_MARGIN_SECONDS?: string;
  RECEIPT_TIMEOUT_MS?: string;
  MAX_GAS?: string;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const blank = (v: string | undefined) => v === undefined || v.trim() === "";

function int(name: string, v: string | undefined, min = 0): number | undefined {
  if (blank(v)) return undefined;
  const s = (v as string).trim();
  if (!/^\d+$/.test(s) || Number(s) < min || !Number.isSafeInteger(Number(s))) throw new ConfigError(`${name} must be an integer ≥ ${min}`);
  return Number(s);
}

/**
 * Turn environment variables into facilitator options. Throws ConfigError with a message that names the variable and
 * never contains its value (OPERATOR_KEY is a secret, RPC_URL may carry an API key).
 */
export function loadConfig(env: FacilitatorEnv): Omit<FacilitatorOptions, "transport" | "store" | "now" | "log"> {
  const key = env.OPERATOR_KEY?.trim();
  if (!key) throw new ConfigError("OPERATOR_KEY is not set. Set it as a secret (wrangler secret put OPERATOR_KEY, or the environment).");
  const operatorKey = key.startsWith("0x") ? key : `0x${key}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(operatorKey)) throw new ConfigError("OPERATOR_KEY must be a 32-byte hex private key (64 hex characters, optional 0x)");

  const rpcUrl = blank(env.RPC_URL) ? DEFAULT_RPC_URL : (env.RPC_URL as string).trim();
  if (!/^https?:\/\/\S+$/.test(rpcUrl)) throw new ConfigError("RPC_URL must be an http(s) URL");
  const maxGas = int("MAX_GAS", env.MAX_GAS, 21_000);
  return {
    operatorKey: operatorKey as Hex,
    rpcUrl,
    validityMarginSeconds: int("VALIDITY_MARGIN_SECONDS", env.VALIDITY_MARGIN_SECONDS),
    receiptTimeoutMs: int("RECEIPT_TIMEOUT_MS", env.RECEIPT_TIMEOUT_MS, 1000),
    maxGas: maxGas === undefined ? undefined : BigInt(maxGas),
  };
}
