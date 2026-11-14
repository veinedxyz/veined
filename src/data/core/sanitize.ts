// Untrusted on-chain/RPC strings become inert, bounded plain text. Never HTML, never URLs as links.
const unsafe =
  /[<>"'`\\\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff0-\uffff]/gu;
export function sanitizeText(value: unknown, limit: number): string {
  if (typeof value !== "string") return "";
  return value.normalize("NFKC").replace(unsafe, "").trim().slice(0, limit);
}
export function suspiciousText(...values: string[]): boolean {
  return /https?:|www\.|\.(com|io|xyz|org|net|app|finance)\b|claim|airdrop|visit|reward|voucher|t\.me|discord/i.test(
    values.join(" "),
  );
}
// Base-unit amount grammar shared by DB, API and UI: unsigned integer, at most 78 digits.
export const baseUnits = /^(0|[1-9]\d{0,77})$/;
export function boundedBigint(value: bigint): string {
  if (value < 0n || value >= 1n << 256n) throw Error("AMOUNT_OUT_OF_RANGE");
  return value.toString();
}
