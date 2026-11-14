import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { publicIp } from "../../adapters/read-only";
import { admitRpcUrl } from "./url-policy";
import { assertAllowed, type CallPolicy, type RpcCall } from "./methods";
export interface RpcEndpoint {
  id: string;
  chainId: string;
  url: string;
  allowPort?: boolean;
}
export class RpcError extends Error {
  constructor(
    public code:
      | "TIMEOUT"
      | "RATE_LIMITED"
      | "HTTP_ERROR"
      | "UNSAFE_DNS"
      | "DNS_FAILED"
      | "URL_REJECTED"
      | "INVALID_RESPONSE"
      | "RESPONSE_TOO_LARGE"
      | "RPC_ERROR"
      | "RANGE_TOO_LARGE"
      | "HISTORY_PRUNED"
      | "POLICY_REJECTED"
      | "EXECUTION_REVERTED"
      | "CAPACITY_EXCEEDED",
    public detail = "",
  ) {
    super(code);
    this.name = "RpcError";
  }
}
export interface TransportOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}
export type RpcTransport = (
  endpoint: RpcEndpoint,
  body: unknown,
  options: TransportOptions,
) => Promise<unknown>;
const forbiddenKeys = new Set(["__proto__", "constructor", "prototype"]);
export function safeJson(text: string): unknown {
  return JSON.parse(text, (key, value) => {
    if (forbiddenKeys.has(key))
      throw new RpcError("INVALID_RESPONSE", "PROTO_KEY");
    return value;
  });
}
// Real transport: admitted URL only, public DNS answers pinned per request, no redirects, bounded.
export const httpsTransport: RpcTransport = async (endpoint, body, options) => {
  const verdict = admitRpcUrl(endpoint.url, { allowPort: endpoint.allowPort });
  if (!verdict.ok) throw new RpcError("URL_REJECTED", verdict.reason);
  const url = new URL(verdict.url);
  const abort = AbortSignal.any([
    AbortSignal.timeout(options.timeoutMs ?? 6000),
    ...(options.signal ? [options.signal] : []),
  ]);
  let stop: (() => void) | undefined;
  const resolved = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      stop = () => reject(new RpcError("TIMEOUT"));
      abort.addEventListener("abort", stop, { once: true });
    }),
  ])
    .catch((e) => {
      throw e instanceof RpcError
        ? e
        : new RpcError("DNS_FAILED", "LOOKUP_FAILED");
    })
    .finally(() => stop && abort.removeEventListener("abort", stop));
  if (!resolved.length || resolved.some((a) => !publicIp(a.address)))
    throw new RpcError("UNSAFE_DNS", "NON_PUBLIC_ADDRESS");
  const payload = JSON.stringify(body);
  const max = options.maxBytes ?? 1000000;
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "POST",
        signal: abort,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          "User-Agent": "otherbridge-data-plane/1.4",
        },
        lookup: (_host, opts, cb) => {
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
          reject(
            new RpcError(
              res.statusCode === 429
                ? "RATE_LIMITED"
                : res.statusCode === 413
                  ? "CAPACITY_EXCEEDED"
                  : "HTTP_ERROR",
              String(res.statusCode),
            ),
          );
          return;
        }
        if (!String(res.headers["content-type"] ?? "").includes("json")) {
          res.destroy();
          reject(new RpcError("INVALID_RESPONSE", "CONTENT_TYPE"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > max) {
            res.destroy();
            reject(new RpcError("RESPONSE_TOO_LARGE"));
          } else chunks.push(b);
        });
        res.on("error", () => reject(new RpcError("HTTP_ERROR", "STREAM")));
        res.on("end", () => {
          try {
            resolve(safeJson(Buffer.concat(chunks).toString("utf8")));
          } catch {
            reject(new RpcError("INVALID_RESPONSE", "JSON"));
          }
        });
      },
    );
    req.on("error", () =>
      reject(new RpcError(abort.aborted ? "TIMEOUT" : "HTTP_ERROR", "REQUEST")),
    );
    req.end(payload);
  });
};
const rangeMessage =
  /too many|limit exceeded|range|block range|exceed|query returned more than|response size|max results|10000 results|log response size/i;
const prunedMessage =
  /missing trie node|pruned|not available|historical state|state.*not found/i;
// V1.14.1: a contract revert is a deterministic result of the call at that block, not an endpoint fault.
const revertMessage =
  /execution reverted|^reverted|vm execution error.*revert/i;
// V1.14.1: a request heavier than the provider's per-call gas / size / time budget is a capability limit of that
// request (the caller splits it), not an endpoint fault.
const capacityMessage =
  /out of gas|gas required exceeds|exceeds (the )?(block )?gas|gas limit|execution timeout|request (entity )?too large|payload too large|batch (size )?too large|call data too large/i;
function classify(error: unknown): RpcError {
  const e = error as { code?: unknown; message?: unknown };
  const message = typeof e?.message === "string" ? e.message.slice(0, 200) : "";
  if (e?.code === 3 || revertMessage.test(message))
    return new RpcError("EXECUTION_REVERTED", message.slice(0, 80));
  if (capacityMessage.test(message))
    return new RpcError("CAPACITY_EXCEEDED", message.slice(0, 80));
  if (rangeMessage.test(message) || e?.code === -32005)
    return new RpcError("RANGE_TOO_LARGE", message);
  if (prunedMessage.test(message))
    return new RpcError("HISTORY_PRUNED", message);
  return new RpcError(
    "RPC_ERROR",
    `${typeof e?.code === "number" ? e.code : ""}`,
  );
}
function envelope(value: unknown, id: number): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RpcError("INVALID_RESPONSE", "ENVELOPE");
  const v = value as Record<string, unknown>;
  if (v.jsonrpc !== "2.0" || v.id !== id)
    throw new RpcError("INVALID_RESPONSE", "ID_MISMATCH");
  if (v.error !== undefined) throw classify(v.error);
  if (!("result" in v)) throw new RpcError("INVALID_RESPONSE", "NO_RESULT");
  return v.result;
}
export async function rpcCall(
  transport: RpcTransport,
  endpoint: RpcEndpoint,
  call: RpcCall,
  policy: CallPolicy,
  options: TransportOptions = {},
): Promise<unknown> {
  try {
    assertAllowed(call, policy);
  } catch {
    throw new RpcError("POLICY_REJECTED", call.method);
  }
  return envelope(
    await transport(endpoint, { jsonrpc: "2.0", id: 1, ...call }, options),
    1,
  );
}
export type BatchItem =
  { ok: true; value: unknown } | { ok: false; error: RpcError };
// Batch results are matched by id; any missing/duplicate/foreign id invalidates the whole batch.
export async function rpcBatch(
  transport: RpcTransport,
  endpoint: RpcEndpoint,
  calls: RpcCall[],
  policy: CallPolicy,
  options: TransportOptions = {},
): Promise<BatchItem[]> {
  if (!calls.length || calls.length > 20)
    throw new RpcError("POLICY_REJECTED", "BATCH_SIZE");
  for (const call of calls)
    try {
      assertAllowed(call, policy);
    } catch {
      throw new RpcError("POLICY_REJECTED", call.method);
    }
  const raw = await transport(
    endpoint,
    calls.map((c, i) => ({ jsonrpc: "2.0", id: i + 1, ...c })),
    options,
  );
  if (!Array.isArray(raw) || raw.length !== calls.length)
    throw new RpcError("INVALID_RESPONSE", "BATCH_SHAPE");
  const byId = new Map<number, unknown>();
  for (const item of raw) {
    const id = (item as { id?: unknown })?.id;
    if (typeof id !== "number" || id < 1 || id > calls.length || byId.has(id))
      throw new RpcError("INVALID_RESPONSE", "BATCH_ID");
    byId.set(id, item);
  }
  return calls.map((_, i) => {
    try {
      return { ok: true, value: envelope(byId.get(i + 1), i + 1) } as BatchItem;
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof RpcError ? error : new RpcError("INVALID_RESPONSE"),
      } as BatchItem;
    }
  });
}
