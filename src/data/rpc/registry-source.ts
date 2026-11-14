import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { z } from "zod";
import { publicIp } from "../../adapters/read-only";
import { safeJson } from "./transport";
import type { Candidate } from "./admission";
// Remote chain registries are untrusted input. Only this fixed public document is read, by the
// offline sync command, through pinned public DNS, without redirects and with a byte cap.
export const PUBLIC_REGISTRY_URL = "https://chainid.network/chains.json";
const entry = z
  .object({
    chainId: z.number().int().positive().safe(),
    name: z.string().max(200).optional(),
    rpc: z.array(z.unknown()).max(80).default([]),
  })
  .passthrough();
export async function fetchPublicRegistry(
  signal?: AbortSignal,
  maxBytes = 12000000,
): Promise<unknown> {
  const url = new URL(PUBLIC_REGISTRY_URL);
  const resolved = await lookup(url.hostname, { all: true });
  if (!resolved.length || resolved.some((a) => !publicIp(a.address)))
    throw Error("UNSAFE_DNS");
  const abort = AbortSignal.any([
    AbortSignal.timeout(20000),
    ...(signal ? [signal] : []),
  ]);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal: abort,
        headers: {
          Accept: "application/json",
          "User-Agent": "otherbridge-data-plane/1.4",
        },
        lookup: (_h, opts, cb) => {
          const pick =
            resolved.find((v) => !opts.family || v.family === opts.family) ??
            resolved[0];
          if (opts.all) cb(null, [pick]);
          else cb(null, pick.address, pick.family);
        },
      },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(Error(`REGISTRY_HTTP_${res.statusCode}`));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > maxBytes) {
            res.destroy();
            reject(Error("REGISTRY_TOO_LARGE"));
          } else chunks.push(b);
        });
        res.on("error", () => reject(Error("REGISTRY_STREAM")));
        res.on("end", () => {
          try {
            resolve(safeJson(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(Error("REGISTRY_JSON"));
          }
        });
      },
    );
    req.on("error", () => reject(Error("REGISTRY_REQUEST")));
    req.end();
  });
}
// Candidate extraction only: every URL still passes the full admission pipeline before use.
export function registryCandidates(
  raw: unknown,
  wanted: Set<string>,
  perChain = 6,
): Candidate[] {
  const rows = z.array(z.unknown()).max(10000).parse(raw);
  const out: Candidate[] = [];
  for (const value of rows) {
    const p = entry.safeParse(value);
    if (!p.success || !wanted.has(String(p.data.chainId))) continue;
    const urls = p.data.rpc
      .filter(
        (u): u is string =>
          typeof u === "string" && u.startsWith("https://") && !/[${}]/.test(u),
      )
      .slice(0, perChain);
    for (const url of urls)
      out.push({
        chainId: String(p.data.chainId),
        ecosystem: "EVM",
        url,
        provenance: "public-registry",
        priority: 100,
      });
  }
  return out;
}
