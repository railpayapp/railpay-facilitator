import { isAddress, parseEther, parseGwei, type Hex } from "viem";

import { DEFAULT_RPC_URL, USDG_DECIMALS } from "./constants.js";
import type { FacilitatorOptions } from "./facilitator.js";
import { toUnits } from "./units.js";

/** Environment variables read by `loadConfig` (`process.env` or Workers vars). */
export type FacilitatorEnv = {
  OPERATOR_KEY?: string;
  RPC_URL?: string;
  /** USDG decimal, e.g. "0.001". */
  MIN_AMOUNT?: string;
  /** USDG decimal, e.g. "100". */
  MAX_AMOUNT?: string;
  /** Comma or space separated addresses. */
  PAY_TO_ALLOWLIST?: string;
  RATE_LIMIT_PAYTO_PER_HOUR?: string;
  RATE_LIMIT_IP_PER_MINUTE?: string;
  /** ETH decimal, e.g. "0.0005". */
  MIN_OPERATOR_ETH?: string;
  /** Gwei decimal, e.g. "1". */
  MAX_FEE_PER_GAS_GWEI?: string;
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

function wrap<T>(name: string, f: () => T): T {
  try {
    return f();
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`${name} is not a valid amount`);
  }
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
  const allow = blank(env.PAY_TO_ALLOWLIST)
    ? []
    : (env.PAY_TO_ALLOWLIST as string)
        .split(/[\s,]+/)
        .map((s) => s.trim())
        .filter(Boolean);
  for (const a of allow) if (!isAddress(a, { strict: false })) throw new ConfigError(`PAY_TO_ALLOWLIST has an invalid address: ${a}`);

  const minAmount = blank(env.MIN_AMOUNT) ? undefined : wrap("MIN_AMOUNT", () => toUnits(env.MIN_AMOUNT as string, USDG_DECIMALS));
  const maxAmount = blank(env.MAX_AMOUNT) ? undefined : wrap("MAX_AMOUNT", () => toUnits(env.MAX_AMOUNT as string, USDG_DECIMALS));
  if (minAmount !== undefined && minAmount < 1n) throw new ConfigError("MIN_AMOUNT must be more than 0");
  if (minAmount !== undefined && maxAmount !== undefined && maxAmount < minAmount) throw new ConfigError("MAX_AMOUNT must be at least MIN_AMOUNT");

  const decimal = (name: string, v: string | undefined, parse: (s: string) => bigint) =>
    blank(v)
      ? undefined
      : wrap(name, () => {
          const t = (v as string).trim();
          if (!/^\d+(\.\d+)?$/.test(t)) throw new Error();
          return parse(t);
        });
  const minOperatorEth = decimal("MIN_OPERATOR_ETH", env.MIN_OPERATOR_ETH, parseEther);
  const maxFeePerGas = decimal("MAX_FEE_PER_GAS_GWEI", env.MAX_FEE_PER_GAS_GWEI, parseGwei);
  if (maxFeePerGas === 0n) throw new ConfigError("MAX_FEE_PER_GAS_GWEI must be more than 0");

  const maxGas = int("MAX_GAS", env.MAX_GAS, 21_000);
  return {
    operatorKey: operatorKey as Hex,
    rpcUrl,
    minAmount,
    maxAmount,
    payToAllowlist: allow,
    rateLimits: { payToPerHour: int("RATE_LIMIT_PAYTO_PER_HOUR", env.RATE_LIMIT_PAYTO_PER_HOUR), ipPerMinute: int("RATE_LIMIT_IP_PER_MINUTE", env.RATE_LIMIT_IP_PER_MINUTE) },
    validityMarginSeconds: int("VALIDITY_MARGIN_SECONDS", env.VALIDITY_MARGIN_SECONDS),
    receiptTimeoutMs: int("RECEIPT_TIMEOUT_MS", env.RECEIPT_TIMEOUT_MS, 1000),
    maxGas: maxGas === undefined ? undefined : BigInt(maxGas),
    minOperatorEth,
    maxFeePerGas,
  };
}
