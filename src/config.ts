import { DEFAULT_RPC_URL } from "./constants.js";
import type { FacilitatorOptions } from "./facilitator.js";

/** Environment variables read by `loadConfig` (`process.env` or Workers vars). */
export type FacilitatorEnv = {
  RPC_URL?: string;
  VALIDITY_MARGIN_SECONDS?: string;
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
 * never contains its value (RPC_URL may carry an API key).
 */
export function loadConfig(env: FacilitatorEnv): Omit<FacilitatorOptions, "transport" | "now"> {
  const rpcUrl = blank(env.RPC_URL) ? DEFAULT_RPC_URL : (env.RPC_URL as string).trim();
  if (!/^https?:\/\/\S+$/.test(rpcUrl)) throw new ConfigError("RPC_URL must be an http(s) URL");
  return {
    rpcUrl,
    validityMarginSeconds: int("VALIDITY_MARGIN_SECONDS", env.VALIDITY_MARGIN_SECONDS),
  };
}
