import {
  createHash,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
// API keys: strong random secret shown once; only a one-way verifier and a public lookup prefix
// are stored. The plaintext is never logged or persisted.
export const KEY_PATTERN =
  /^ob_(live|test)_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
export function randomId(prefix: "cli" | "key", length = 24) {
  let out = "";
  for (let i = 0; i < length; i++) out += alphabet[randomInt(alphabet.length)];
  return `${prefix}_${out}`;
}
export function verifierOf(plaintext: string): string {
  return createHash("sha256")
    .update(`otherbridge-api-key:v1:${plaintext}`)
    .digest("hex");
}
export function generateKey(environment: "live" | "test" = "live") {
  let prefix = "";
  for (let i = 0; i < 12; i++) prefix += alphabet[randomInt(alphabet.length)];
  const plaintext = `ob_${environment}_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { plaintext, prefix, verifier: verifierOf(plaintext) };
}
export function parseKey(
  raw: string | null | undefined,
): { prefix: string; plaintext: string } | null {
  if (!raw || raw.length > 80) return null;
  const m = KEY_PATTERN.exec(raw);
  return m ? { prefix: m[2], plaintext: raw } : null;
}
export function verifyKey(plaintext: string, verifier: string): boolean {
  const a = Buffer.from(verifierOf(plaintext), "hex"),
    b = Buffer.from(
      /^[0-9a-f]{64}$/.test(verifier) ? verifier : "0".repeat(64),
      "hex",
    );
  return a.length === b.length && timingSafeEqual(a, b);
}
// Equalizes work for unknown prefixes so lookup misses and wrong secrets look the same.
export function dummyVerify(plaintext: string) {
  verifyKey(plaintext, "f".repeat(64));
}
export function bearer(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header) {
    const m = /^Bearer ([^\s]{1,80})$/.exec(header);
    return m ? m[1] : null;
  }
  return req.headers.get("x-api-key");
}
