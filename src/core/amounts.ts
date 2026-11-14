import { BridgeError } from "./model";
export function parseAmount(raw: string): bigint {
  if (raw.length > 80 || !/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw))
    throw new BridgeError(
      raw.includes(",") ? "AMBIGUOUS_LOCALE" : "INVALID_AMOUNT",
    );
  const [whole, fraction = ""] = raw.split(".");
  const value = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, "0"));
  if (value <= 0n || value >= 2n ** 256n)
    throw new BridgeError("INVALID_AMOUNT");
  return value;
}
export function formatAmount(value: bigint, places = 6): string {
  const whole = value / 10n ** 18n;
  const fraction = (value % 10n ** 18n)
    .toString()
    .padStart(18, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  return `${whole}${fraction ? "." + fraction : ""}`;
}
export function maximum(
  balance: bigint,
  gas: bigint,
  fee: (amount: bigint) => bigint,
  routeLimit?: bigint,
): bigint {
  if (balance <= gas) return 0n;
  let candidate = balance - gas;
  if (routeLimit !== undefined) {
    if (routeLimit <= 0n) return 0n;
    if (candidate > routeLimit) candidate = routeLimit;
  }
  for (let i = 0; i < 24; i++) {
    const f = fee(candidate);
    if (f < 0n) throw new BridgeError("INVALID_FEE");
    const debit = candidate + f + gas;
    if (debit <= balance) return candidate;
    candidate -= debit - balance;
    if (candidate <= 0n) return 0n;
  }
  throw new BridgeError("FEE_NOT_CONVERGED");
}
