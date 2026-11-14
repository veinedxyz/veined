// Structured, redacted, self-hosted observability. Wallet addresses never appear in logs or labels.
import { registry } from "./metrics";
type Field = string | number | boolean | null | undefined;
const address =
  /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])|(?<![1-9A-HJ-NP-Za-km-z])[1-9A-HJ-NP-Za-km-z]{32,44}(?![1-9A-HJ-NP-Za-km-z])/g;
const secret =
  /(ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]{20,})|(postgres(ql)?:\/\/[^\s]+)|(\bBearer\s+[^\s,;]+)|(\b(api[_-]?key|apikey|token|password|secret|authorization)\s*[=:]\s*[^\s,;&]+)/gi;
// V1.5 log-injection hardening: C0/C1 controls, line/paragraph separators and bidi/zero-width
// formatting characters are removed (JSON escaping alone does not stop misleading terminal output).
const controls = new RegExp(
  "[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]",
  "g",
);
export function redactValue(value: Field, key = ""): Field {
  if (
    /(?:api.?key|token|password|secret|authorization|cookie|headers?|raw.?transaction|provider.?response|response.?body|request.?body)/i.test(
      key,
    )
  )
    return value == null ? value : "[secret]";
  if (typeof value !== "string") return value;
  // Server-generated request IDs are the correlation key; they never contain wallet data.
  if (key === "requestId" && /^req_[a-z0-9]{20,40}$/.test(value)) return value;
  return value
    .replace(controls, " ")
    .replace(secret, "[secret]")
    .replace(/\b(?:cookie|set-cookie)\s*[:=][^\r\n]*/gi, "[secret]")
    .replace(address, "[address]")
    .slice(0, 300);
}
export function logEvent(event: string, fields: Record<string, Field> = {}) {
  if (process.env.OTHERBRIDGE_DATA_LOG === "off") return;
  const line: Record<string, Field> = {
    at: new Date().toISOString(),
    event: /^[a-z][a-z0-9_.-]{0,60}$/.test(event) ? event : "invalid.event",
  };
  for (const [k, v] of Object.entries(fields))
    if (/^[a-zA-Z][\w.]{0,40}$/.test(k)) line[k] = redactValue(v, k);
  process.stdout.write(`${JSON.stringify(line)}\n`);
}
type Labels = Record<string, string>;
// Backward-compatible facade over the V1.5 Prometheus registry.
export const metrics = {
  inc(name: string, labels: Labels = {}, value = 1) {
    registry().inc(name, labels, value);
  },
  set(name: string, labels: Labels, value: number) {
    registry().set(name, labels, value);
  },
  observe(name: string, labels: Labels, value: number) {
    registry().observe(name, labels, value);
  },
  snapshot() {
    return registry().snapshot();
  },
  prometheus() {
    return registry().render();
  },
  reset() {
    registry().reset();
  },
};
