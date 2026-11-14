import { createHash } from "node:crypto";
import { isIP } from "node:net";
// Browser-app API authorization: exact configured origins, no wildcard, Host must match the origin.
// Developer API authentication is separate (API keys) and never relies on Origin.
export interface OriginPolicy {
  origins: Set<string>;
  proxyHops: number;
  errors: string[];
  configured: boolean;
}
const loopbackHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
export const DEFAULT_LOCAL_ORIGINS = [
  "http://127.0.0.1:3100",
  "http://localhost:3100",
  "http://127.0.0.1:3101",
  "http://localhost:3101",
];
export function normalizeOrigin(raw: string): string {
  const value = raw.trim();
  if (!value || /[*\s,]/.test(value)) throw Error("WILDCARD_OR_LIST");
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname && url.pathname !== "/")
  )
    throw Error("NOT_AN_ORIGIN");
  if (url.protocol === "http:") {
    if (!loopbackHosts.has(url.hostname)) throw Error("HTTPS_REQUIRED");
  } else if (url.protocol !== "https:") throw Error("SCHEME");
  if (
    url.protocol === "https:" &&
    (isIP(url.hostname) || !url.hostname.includes("."))
  )
    throw Error("HOST_REJECTED");
  return url.origin;
}
let cache: { key: string; policy: OriginPolicy } | undefined;
export function originPolicy(
  env: Record<string, string | undefined> = process.env,
): OriginPolicy {
  const key = `${env.OTHERBRIDGE_APP_ORIGINS ?? ""}|${env.OTHERBRIDGE_TRUST_PROXY_HOPS ?? ""}|${env.NODE_ENV ?? ""}|${env.OTHERBRIDGE_PUBLIC_DEPLOYMENT ?? ""}`;
  if (cache?.key === key && env === process.env) return cache.policy;
  const errors: string[] = [];
  const origins = new Set<string>();
  const raw = env.OTHERBRIDGE_APP_ORIGINS;
  if (raw === undefined || raw.trim() === "")
    DEFAULT_LOCAL_ORIGINS.forEach((o) => origins.add(o));
  else
    for (const part of raw.split(","))
      try {
        origins.add(normalizeOrigin(part));
      } catch (e) {
        errors.push(
          `OTHERBRIDGE_APP_ORIGINS:${e instanceof Error ? e.message : "INVALID"}`,
        );
      }
  const hopsRaw = env.OTHERBRIDGE_TRUST_PROXY_HOPS ?? "0";
  const proxyHops = /^[0-3]$/.test(hopsRaw) ? Number(hopsRaw) : -1;
  if (proxyHops < 0) errors.push("OTHERBRIDGE_TRUST_PROXY_HOPS");
  // A public deployment without trusted-proxy attribution would put every user in one limiter
  // bucket (cross-user starvation); it must fail closed instead.
  if (
    env.NODE_ENV === "production" &&
    env.OTHERBRIDGE_PUBLIC_DEPLOYMENT === "true" &&
    proxyHops < 1
  )
    errors.push("TRUST_PROXY_REQUIRED");
  const policy = {
    origins,
    proxyHops: Math.max(0, proxyHops),
    errors,
    configured: raw !== undefined && raw.trim() !== "",
  };
  if (env === process.env) cache = { key, policy };
  return policy;
}
export type OriginVerdict = "OK" | "ORIGIN_REJECTED" | "CONFIG_INVALID";
export function checkOrigin(
  req: Request,
  policy = originPolicy(),
): OriginVerdict {
  if (policy.errors.length || !policy.origins.size) return "CONFIG_INVALID";
  const origin = req.headers.get("origin");
  if (!origin) return "ORIGIN_REJECTED";
  let normalized: string;
  try {
    normalized = normalizeOrigin(origin);
  } catch {
    return "ORIGIN_REJECTED";
  }
  if (normalized !== origin || !policy.origins.has(normalized))
    return "ORIGIN_REJECTED";
  const expected = new URL(normalized);
  // Behind trusted proxies the proxy-overwritten forwarded host/proto is authoritative.
  // Values appended by the trusted proxy chain are read at the trusted hop, like clientKey.
  const hop = (name: string) => {
    const list = (req.headers.get(name) ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    return list[list.length - policy.proxyHops];
  };
  const forwardedHost =
    policy.proxyHops > 0 ? hop("x-forwarded-host") : undefined;
  const forwardedProto =
    policy.proxyHops > 0 ? hop("x-forwarded-proto") : undefined;
  const host =
    policy.proxyHops > 0 && forwardedHost
      ? forwardedHost
      : req.headers.get("host");
  if (!host || host.toLowerCase() !== expected.host) return "ORIGIN_REJECTED";
  if (
    policy.proxyHops > 0 &&
    forwardedProto &&
    `${forwardedProto}:` !== expected.protocol
  )
    return "ORIGIN_REJECTED";
  return "OK";
}
// Per-client attribution only behind configured trusted proxies; otherwise X-Forwarded-For is
// client-controlled and is ignored (limits then apply per scope, never per spoofable header).
export function clientKey(
  req: Request,
  policy = originPolicy(),
): string | null {
  if (policy.proxyHops <= 0) return null;
  const chain = (req.headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const ip = chain[chain.length - policy.proxyHops];
  if (!ip || !isIP(ip)) return null;
  return createHash("sha256").update(`ip:v1:${ip}`).digest("hex").slice(0, 24);
}
