/** "1.5" → 1500000n for 6 decimals. Accepts a non-negative decimal with at most `decimals` places. */
export function toUnits(amount: string | number, decimals: number): bigint {
  const s = typeof amount === "number" ? String(amount) : amount.trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new RangeError(`Not a decimal amount: ${JSON.stringify(amount)}`);
  const whole = m[1] ?? "0";
  const frac = m[2] ?? "";
  if (frac.length > decimals) throw new RangeError(`At most ${decimals} decimals: ${s}`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
}

/** 1500000n → "1.5" for 6 decimals. */
export function fromUnits(units: bigint | number | string, decimals: number): string {
  const v = BigInt(units);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const frac = (abs % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole}${frac ? `.${frac}` : ""}`;
}
