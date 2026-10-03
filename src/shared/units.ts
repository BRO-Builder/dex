export function toBigInt(value: unknown) {
  return BigInt(typeof value === "object" && value !== null && "toFixed" in value
    ? (value as { toFixed(): string }).toFixed()
    : String(value));
}

export function formatUnits(value: bigint, decimals: number, maximumFractionDigits = decimals) {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = value % base;
  if (fraction === 0n) return whole.toString();
  const raw = fraction.toString().padStart(decimals, "0").slice(0, maximumFractionDigits).replace(/0+$/, "");
  return raw ? `${whole}.${raw}` : whole.toString();
}

export function parseUnits(value: string, decimals: number) {
  if (!/^\d*\.?\d*$/.test(value) || !value || value === ".") return null;
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) return null;
  return BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}
