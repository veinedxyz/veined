// Bounded, audited, READ-ONLY JSON-RPC client for the G7 preparation and tracking tools.
// There is no signer, no wallet provider and no write method: every request is checked against the explicit
// read allowlist, a vetted endpoint list and a strict call-object shape BEFORE any network I/O.
import { createHash } from "node:crypto";
import { BSC_STATE_SOURCES, ENDPOINTS, G7_READ_METHODS } from "./policy";
import { ExecutionEvidence } from "./write-evidence";

export class G7RpcError extends Error {
  constructor(
    readonly code: string,
    message?: string,
    readonly rpcError?: { code?: number; message?: string; data?: unknown },
  ) {
    super(message ?? code);
  }
}

export interface RpcAuditRecord {
  seq: number;
  at: string;
  url: string;
  method: string;
  params: unknown[];
  status: number;
  ms: number;
  error: string | null;
  responseSha256: string;
  response: unknown;
  rateLimited?: boolean;
  retryAfterMs?: number | null;
  cooldownUntil?: number | null;
  cacheHit?: boolean;
  retry?: number;
}

export interface RpcHealth {
  cooldownUntil: number;
  rateLimitStreak: number;
  lastSuccessAt: number | null;
  latencyMs: number | null;
}
// Shared by fresh sessions in the same local supervisor. Expired cooldowns never exclude a recovered source.
const providerHealth = new Map<string, RpcHealth>();
export function rpcHealth(url: string): RpcHealth {
  return {
    ...(providerHealth.get(url) ?? {
      cooldownUntil: 0,
      rateLimitStreak: 0,
      lastSuccessAt: null,
      latencyMs: null,
    }),
  };
}
export function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d+(\.\d+)?$/.test(value.trim()))
    return Math.ceil(Number(value) * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}
export function isRateLimit(status: number, error: unknown) {
  return (
    status === 429 ||
    /rate.?limit|too many requests|maximum API usage|quota|credits? exhausted|requests? per (second|minute)/i.test(
      JSON.stringify(error ?? ""),
    )
  );
}

const READ = new Set<string>(G7_READ_METHODS);
const VETTED = new Set<string>([
  ...ENDPOINTS.one,
  ...ENDPOINTS.bsc,
  ...ENDPOINTS.bscLogs,
  // V1.11: independent BSC fallback state sources (vetted operator groups; see policy.ts).
  ...BSC_STATE_SOURCES.map((s) => s.url),
]);
const CALL_FIELDS = new Set(["from", "to", "data", "value"]);

// Validation is exported so tests can prove refusal happens without any request being made.
export function assertReadOnlyRequest(
  url: string,
  method: string,
  params: unknown[],
) {
  if (!READ.has(method)) throw new G7RpcError("METHOD_NOT_ALLOWED", method);
  if (!VETTED.has(url)) throw new G7RpcError("ENDPOINT_NOT_VETTED", url);
  if (!Array.isArray(params)) throw new G7RpcError("BAD_PARAMS");
  if (method === "eth_call" || method === "eth_estimateGas") {
    // No state override / block override objects (a third parameter), no gas-price or nonce fields.
    if (params.length < 1 || params.length > 2)
      throw new G7RpcError("STATE_OVERRIDE_OR_BAD_ARITY");
    const tx = params[0];
    if (!tx || typeof tx !== "object" || Array.isArray(tx))
      throw new G7RpcError("BAD_CALL_OBJECT");
    for (const key of Object.keys(tx))
      if (!CALL_FIELDS.has(key))
        throw new G7RpcError("CALL_FIELD_NOT_ALLOWED", key);
  }
}

export interface ReadOnlyRpcOptions {
  execution?: ExecutionEvidence;
  audit?: (record: RpcAuditRecord) => void;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  requestBudget?: number;
}

export class ReadOnlyRpc {
  readonly execution: ExecutionEvidence;
  private seq = 0;
  private wireRequests = 0;
  readonly counts = new Map<string, number>();
  constructor(private readonly options: ReadOnlyRpcOptions = {}) {
    this.execution = options.execution ?? new ExecutionEvidence();
  }

  async raw(
    url: string,
    method: string,
    params: unknown[] = [],
    timeoutMs?: number,
    retry = 0,
  ) {
    this.execution.recordRpcAttempt(method, params);
    assertReadOnlyRequest(url, method, params);
    const seq = ++this.seq;
    const started = (this.options.now ?? Date.now)();
    let health = rpcHealth(url);
    if (health.cooldownUntil > started) {
      this.options.audit?.({
        seq,
        at: new Date(started).toISOString(),
        url,
        method,
        params,
        status: 429,
        ms: 0,
        error: "RATE_LIMITED_COOLDOWN",
        responseSha256: createHash("sha256").update("").digest("hex"),
        response: null,
        rateLimited: true,
        cooldownUntil: health.cooldownUntil,
        cacheHit: true,
        retry,
      });
      return {
        status: 429,
        error: "RATE_LIMITED_COOLDOWN",
        json: null,
        text: "",
        rateLimited: true,
        cooldownUntil: health.cooldownUntil,
      };
    }
    if (
      this.options.requestBudget !== undefined &&
      this.wireRequests >= this.options.requestBudget
    )
      throw new G7RpcError("REQUEST_BUDGET_EXHAUSTED");
    this.wireRequests++;
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
    const at = new Date(started).toISOString();
    const body = JSON.stringify({ jsonrpc: "2.0", id: seq, method, params });
    let status = 0,
      text = "",
      error: string | null = null;
    let retryDelay: number | null = null;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      timeoutMs ?? this.options.timeoutMs ?? 20000,
    );
    try {
      const response = await (this.options.fetchImpl ?? fetch)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
        },
        body,
        signal: controller.signal,
        redirect: "error",
      });
      status = response.status;
      retryDelay = retryAfterMs(response.headers.get("retry-after"), started);
      text = await response.text();
    } catch (e) {
      const err = e as { cause?: { code?: string }; name?: string };
      error = String(err?.cause?.code ?? err?.name ?? e);
    } finally {
      clearTimeout(timer);
    }
    let json: { result?: unknown; error?: G7RpcError["rpcError"] } | null =
      null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    const rateLimited = isRateLimit(status, json?.error ?? text);
    // Merge concurrent observations: a successful in-flight request cannot erase a newer 429 cooldown.
    health = rpcHealth(url);
    if (rateLimited) {
      health.rateLimitStreak++;
      const backoff = Math.min(
        60_000,
        2_000 * 2 ** Math.min(health.rateLimitStreak - 1, 5),
      );
      const jitter = Math.floor(
        (this.options.random ?? Math.random)() * backoff * 0.25,
      );
      health.cooldownUntil = Math.max(
        health.cooldownUntil,
        (this.options.now ?? Date.now)() +
          Math.max(retryDelay ?? 0, backoff + jitter),
      );
    } else if (status === 200 && json && !json.error && "result" in json) {
      if (health.cooldownUntil <= (this.options.now ?? Date.now)()) {
        health.cooldownUntil = 0;
        health.rateLimitStreak = 0;
      }
      health.lastSuccessAt = (this.options.now ?? Date.now)();
      health.latencyMs = health.lastSuccessAt - started;
    }
    providerHealth.set(url, health);
    this.options.audit?.({
      seq,
      at,
      url,
      method,
      params,
      status,
      ms: (this.options.now ?? Date.now)() - started,
      error,
      responseSha256: createHash("sha256").update(text).digest("hex"),
      response: json ?? text.slice(0, 2000),
      rateLimited,
      retryAfterMs: retryDelay,
      cooldownUntil: health.cooldownUntil || null,
      cacheHit: false,
      retry,
    });
    return {
      status,
      error,
      json,
      text,
      rateLimited,
      cooldownUntil: health.cooldownUntil,
    };
  }

  async call<T = unknown>(
    url: string,
    method: string,
    params: unknown[] = [],
    timeoutMs?: number,
    retry = 0,
  ): Promise<T> {
    const r = await this.raw(url, method, params, timeoutMs, retry);
    if (r.rateLimited)
      throw new G7RpcError(
        "RATE_LIMITED",
        `RATE_LIMITED ${method}; cooldown until ${r.cooldownUntil}`,
      );
    if (r.error) throw new G7RpcError("TRANSPORT", `${r.error} ${method}`);
    if (r.status !== 200)
      throw new G7RpcError("HTTP_ERROR", `${r.status} ${method}`);
    if (!r.json)
      throw new G7RpcError("NON_JSON", `${r.status} ${r.text.slice(0, 120)}`);
    if (r.json.error)
      throw new G7RpcError(
        "RPC_ERROR",
        `${method}: ${JSON.stringify(r.json.error).slice(0, 300)}`,
        r.json.error,
      );
    if (!("result" in r.json)) throw new G7RpcError("NO_RESULT", method);
    return r.json.result as T;
  }

  // Bounded retry for transient transport/rate-limit failures only; never retries a contract revert.
  async retry<T = unknown>(
    url: string,
    method: string,
    params: unknown[] = [],
    tries = 3,
  ): Promise<T> {
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await this.call<T>(url, method, params, undefined, i);
      } catch (e) {
        last = e;
        const transient =
          e instanceof G7RpcError &&
          (e.code === "TRANSPORT" ||
            e.code === "NON_JSON" ||
            (e.code === "RPC_ERROR" &&
              /rate|limit|timeout|busy|header not found|block not found|missing trie|unavailable|try again/i.test(
                e.message,
              )));
        if (!transient || i + 1 === tries) throw e;
        const delay =
          Math.min(5000, 800 * 2 ** i) +
          Math.floor((this.options.random ?? Math.random)() * 300);
        await (
          this.options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
        )(delay);
      }
    }
    throw last;
  }
}
