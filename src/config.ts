import type { FacilitatorOptions } from "./facilitator.js";

/** Environment variables read by `loadConfig` (`process.env` or Workers vars). */
export type FacilitatorEnv = {
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

/** Turn environment variables into facilitator options. Throws ConfigError naming the variable. */
export function loadConfig(env: FacilitatorEnv): Omit<FacilitatorOptions, "now"> {
  return {
    validityMarginSeconds: int("VALIDITY_MARGIN_SECONDS", env.VALIDITY_MARGIN_SECONDS),
  };
}
