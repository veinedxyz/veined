// G13 (review F24): the canonical encoding for execution digests. Object keys are sorted by UTF-16 code unit (not by
// locale), non-finite numbers are refused (never silently null), and a bigint is tagged so "5" and 5n differ.
// Guardian keeps its own accepted encoding (src/guardian/support.ts, unchanged), so no Guardian digest moves.
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new RangeError("NON_FINITE_NUMBER");
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(`bigint:${value.toString()}`);
    case "object": {
      if (Array.isArray(value))
        return `[${value.map(canonicalJson).join(",")}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
    }
    default:
      throw new TypeError("NOT_SERIALIZABLE");
  }
}
export const digest = (value: unknown) =>
  bytesToHex(sha256(utf8ToBytes(canonicalJson(value))));
