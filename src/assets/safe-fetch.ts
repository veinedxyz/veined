// V1.11 server-side fetcher for asset/chain metadata and logo ingestion (never used by the browser).
// SSRF posture: https only, port 443, no credentials, no IP literals, exact host allowlist per call, every DNS
// answer must be public and the connection is pinned to the vetted address (no rebinding between check and use),
// redirects are followed manually (bounded) and every hop is re-admitted, the body is capped while streaming,
// and the request has a hard timeout. The caller still validates the bytes (JSON schema / image sanitizer).
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { publicIp } from "../adapters/read-only";

export type SafeFetchCode =
  | "URL_REJECTED"
  | "HOST_NOT_ALLOWED"
  | "UNSAFE_DNS"
  | "DNS_FAILED"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "RATE_LIMITED"
  | "TOO_LARGE"
  | "TIMEOUT"
  | "NETWORK";
export class SafeFetchError extends Error {
  constructor(
    readonly code: SafeFetchCode,
    readonly detail = "",
  ) {
    super(`${code}${detail ? `:${detail}` : ""}`);
    this.name = "SafeFetchError";
  }
}
export interface SafeFetchOptions {
  /** Exact hostnames, or "*.suffix" for a subdomain family. */
  allowedHosts: readonly string[];
  maxBytes: number;
  timeoutMs?: number;
  maxRedirects?: number;
  accept?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}
export interface SafeResponse {
  status: number;
  contentType: string;
  /** V1.14: the raw Content-Encoding; callers that ask for gzip must decompress with an output bound. */
  contentEncoding: string;
  body: Buffer;
  finalUrl: string;
  redirects: string[];
  address: string;
}
type Resolved = { address: string; family: number }[];
export interface SafeFetchDeps {
  lookup: (host: string) => Promise<Resolved>;
  get: (
    url: URL,
    pinned: { address: string; family: number },
    init: {
      headers: Record<string, string>;
      signal: AbortSignal;
      maxBytes: number;
    },
  ) => Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>;
}

const blockedSuffix =
  /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|private|test|example|invalid|onion|arpa)$/i;
export function admitFetchUrl(raw: string, allowedHosts: readonly string[]) {
  if (typeof raw !== "string" || raw.length > 1000 || /[\s<>"'`\\{}]/.test(raw))
    throw new SafeFetchError("URL_REJECTED", "SHAPE");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("URL_REJECTED", "PARSE");
  }
  if (url.protocol !== "https:")
    throw new SafeFetchError("URL_REJECTED", "HTTPS_REQUIRED");
  if (url.username || url.password)
    throw new SafeFetchError("URL_REJECTED", "CREDENTIALS");
  if (url.port && url.port !== "443")
    throw new SafeFetchError("URL_REJECTED", "PORT");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (isIP(host.replace(/^\[|\]$/g, "")))
    throw new SafeFetchError("URL_REJECTED", "IP_LITERAL");
  if (blockedSuffix.test(host))
    throw new SafeFetchError("URL_REJECTED", "HOST");
  const allowed = allowedHosts.some((h) =>
    h.startsWith("*.")
      ? host.endsWith(h.slice(1)) && host.length > h.length - 1
      : host === h,
  );
  if (!allowed) throw new SafeFetchError("HOST_NOT_ALLOWED", host);
  url.hash = "";
  return url;
}

const defaultDeps: SafeFetchDeps = {
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
  get: (url, pinned, init) =>
    new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method: "GET",
          signal: init.signal,
          headers: init.headers,
          lookup: (_h, opts, cb) => {
            if (opts.all) cb(null, [pinned]);
            else cb(null, pinned.address, pinned.family);
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (b: Buffer) => {
            size += b.length;
            if (size > init.maxBytes) {
              res.destroy();
              reject(new SafeFetchError("TOO_LARGE"));
              return;
            }
            chunks.push(b);
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
          res.on("error", (e) => reject(e));
        },
      );
      req.on("error", (e) => reject(e));
      req.end();
    }),
};

export async function safeGet(
  raw: string,
  options: SafeFetchOptions,
  deps: SafeFetchDeps = defaultDeps,
): Promise<SafeResponse> {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 10_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const redirects: string[] = [];
  let url = admitFetchUrl(raw, options.allowedHosts);
  for (let hop = 0; ; hop++) {
    let resolved: Resolved;
    try {
      resolved = await deps.lookup(url.hostname);
    } catch {
      throw new SafeFetchError("DNS_FAILED", url.hostname);
    }
    if (!resolved.length || resolved.some((a) => !publicIp(a.address)))
      throw new SafeFetchError("UNSAFE_DNS", url.hostname);
    let res;
    try {
      res = await deps.get(url, resolved[0], {
        headers: {
          Accept: options.accept ?? "*/*",
          "User-Agent": "otherbridge-asset-registry/1.11",
          ...(options.headers ?? {}),
        },
        signal,
        maxBytes: options.maxBytes,
      });
    } catch (e) {
      if (e instanceof SafeFetchError) throw e;
      if (signal.aborted) throw new SafeFetchError("TIMEOUT");
      throw new SafeFetchError(
        "NETWORK",
        String((e as Error)?.message ?? e).slice(0, 80),
      );
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (hop >= (options.maxRedirects ?? 3))
        throw new SafeFetchError("TOO_MANY_REDIRECTS");
      const location = res.headers.location;
      if (typeof location !== "string")
        throw new SafeFetchError("HTTP_ERROR", "REDIRECT_WITHOUT_LOCATION");
      // Relative redirects resolve against the current URL; every hop is re-admitted from scratch.
      url = admitFetchUrl(
        new URL(location, url).toString(),
        options.allowedHosts,
      );
      redirects.push(url.toString());
      continue;
    }
    if (res.status === 429) throw new SafeFetchError("RATE_LIMITED");
    if (res.status !== 200)
      throw new SafeFetchError("HTTP_ERROR", String(res.status));
    return {
      status: res.status,
      contentType: String(res.headers["content-type"] ?? "").toLowerCase(),
      contentEncoding: String(res.headers["content-encoding"] ?? "")
        .toLowerCase()
        .trim(),
      body: res.body,
      finalUrl: url.toString(),
      redirects,
      address: resolved[0].address,
    };
  }
}
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
/** JSON parse that refuses prototype-pollution keys (untrusted upstream). */
export function safeJsonParse(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (forbiddenKeys.has(key))
      throw new SafeFetchError("URL_REJECTED", "PROTO_KEY");
    return value;
  });
}
