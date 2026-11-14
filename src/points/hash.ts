import { createHash } from "node:crypto";
// Canonical JSON for reproducible hashes: sorted keys, bigint as decimal strings, no undefined members.
export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isFinite(value))
      throw Error("CANONICAL_NON_FINITE");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}
export const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");
export const digest = (value: unknown) => sha256(canonical(value));
