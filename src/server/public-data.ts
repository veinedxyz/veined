import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicIp } from "../adapters/read-only";
import { RoutingError } from "../routing/model";
import { z } from "zod";

const hosts = new Set([
  "api.llama.fi",
  "ethereum-rpc.publicnode.com",
  "base-rpc.publicnode.com",
  "bsc-dataseed.bnbchain.org",
  "solana-rpc.publicnode.com",
]);
export function allowedDataUrl(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    !hosts.has(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new RoutingError("HOST_NOT_ALLOWED");
  if (url.hostname === "api.llama.fi" && url.pathname !== "/v2/chains")
    throw new RoutingError("READ_PATH_REJECTED");
  if (!url.hostname.startsWith("api.") && url.pathname !== "/")
    throw new RoutingError("READ_PATH_REJECTED");
  return url;
}
// Only internal callers choose an allowlisted endpoint. There is no public URL proxy.
export async function publicData(
  value: string,
  options: {
    body?: unknown;
    signal?: AbortSignal;
    maxBytes?: number;
  } = {},
): Promise<unknown> {
  const url = allowedDataUrl(value),
    abort = AbortSignal.any([
      AbortSignal.timeout(8000),
      ...(options.signal ? [options.signal] : []),
    ]);
  if (!url.hostname.startsWith("api.")) {
    const rpc = z
      .object({
        jsonrpc: z.literal("2.0"),
        id: z.literal(1),
        method: z.string(),
        params: z.array(z.unknown()).max(2),
      })
      .strict()
      .parse(options.body);
    const evm =
      (rpc.method === "eth_chainId" && rpc.params.length === 0) ||
      (rpc.method === "eth_getBalance" &&
        rpc.params.length === 2 &&
        /^0x[0-9a-fA-F]{40}$/.test(String(rpc.params[0])) &&
        rpc.params[1] === "latest");
    const svm =
      rpc.method === "getBalance" &&
      rpc.params.length === 2 &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(rpc.params[0])) &&
      JSON.stringify(rpc.params[1]) === '{"commitment":"finalized"}';
    if (url.hostname === "solana-rpc.publicnode.com" ? !svm : !evm)
      throw new RoutingError("RPC_NOT_ALLOWED");
  } else if (options.body !== undefined)
    throw new RoutingError("READ_PATH_REJECTED");
  if (abort.aborted) throw new RoutingError("PROVIDER_TIMEOUT");
  let stop: (() => void) | undefined;
  const resolved = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      stop = () => reject(new RoutingError("PROVIDER_TIMEOUT"));
      abort.addEventListener("abort", stop, { once: true });
    }),
  ]).finally(() => {
    if (stop) abort.removeEventListener("abort", stop);
  });
  if (
    abort.aborted ||
    !resolved.length ||
    resolved.some((v) => !publicIp(v.address))
  )
    throw new RoutingError("UNSAFE_DNS");
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: payload ? "POST" : "GET",
        signal: abort,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json" } : {}),
        },
        lookup: (_host, opts, cb) => {
          const selected =
            resolved.find((v) => !opts.family || v.family === opts.family) ??
            resolved[0];
          if (opts.all) cb(null, [selected]);
          else cb(null, selected.address, selected.family);
        },
      },
      (res) => {
        if (
          res.statusCode !== 200 ||
          !res.headers["content-type"]?.includes("application/json")
        ) {
          res.resume();
          reject(new RoutingError("PROVIDER_UNAVAILABLE"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > (options.maxBytes ?? 2000000)) {
            res.destroy();
            reject(new RoutingError("RESPONSE_TOO_LARGE"));
          } else chunks.push(b);
        });
        res.on("error", () => reject(new RoutingError("PROVIDER_UNAVAILABLE")));
        res.on("end", () => {
          try {
            resolve(
              JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
                (key, child) => {
                  if (["__proto__", "constructor", "prototype"].includes(key))
                    throw new Error("INVALID_RESPONSE");
                  return child;
                },
              ),
            );
          } catch {
            reject(new RoutingError("INVALID_RESPONSE"));
          }
        });
      },
    );
    req.on("error", () =>
      reject(
        new RoutingError(
          abort.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
        ),
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}
