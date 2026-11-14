import { createHmac, randomBytes } from "node:crypto";
// Keyed pseudonyms for short-lived caches/analytics. Raw wallet addresses never enter usage tables,
// metric labels or logs. Without a configured key, a per-process key makes pseudonyms unlinkable
// across restarts (development only; production config requires a stable secret).
let processKey: Buffer | undefined;
function key(): Buffer {
  const configured = process.env.OTHERBRIDGE_DATA_PSEUDONYM_KEY;
  if (configured && configured.length >= 32)
    return Buffer.from(configured, "utf8");
  return (processKey ??= randomBytes(32));
}
export function walletPseudonym(address: string): string {
  return (
    createHmac("sha256", key())
      // EVM hex is case-insensitive; base58/bech32 identities stay case-exact.
      .update(
        `wallet:v1:${/^0x[0-9a-fA-F]{40}$/.test(address) ? address.toLowerCase() : address.trim()}`,
      )
      .digest("hex")
  );
}
// V1.14.2: keyed integrity tag for server-issued opaque tokens (wallet-scan continuation cursors). Same key as the
// pseudonyms, separated by purpose so a tag can never be confused with a wallet pseudonym.
export function keyedTag(purpose: string, payload: string): string {
  return createHmac("sha256", key())
    .update(`tag:v1:${purpose}:${payload}`)
    .digest("base64url");
}
export function redact(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : "[redacted]";
}
