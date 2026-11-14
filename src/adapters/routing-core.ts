import { createClient } from "@lifi/sdk";
import type { ConnectionsRequest, GetStatusRequest } from "@lifi/types";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { createHash } from "node:crypto";
import { publicIp } from "./read-only";
import snapshot from "../routing/catalog-snapshot.json" with { type: "json" };
import { rankRoutes } from "../routing/ranking";
import {
  normalizeChains,
  normalizeTools,
  requirePair,
  normalizeAssets,
} from "../routing/catalog";
import {
  normalizeConnections,
  normalizeQuote,
  normalizeStatus,
  validateQuoteInput,
} from "../routing/normalize";
import {
  RoutingError,
  type Asset,
  type Catalog,
  type QuoteInput,
  type NetworkCatalogProvider,
  type RouteProvider,
  type StatusInput,
} from "../routing/model";
import { CANARY_APPROVAL_BOUNDS } from "../security/canary-approval";
// No wallet providers, preloads, browser storage, version probes or write actions.
const client = createClient({
  integrator: "Otherbridge",
  apiUrl: "https://li.quest/v1",
  providers: [],
  preloadChains: false,
  disableVersionCheck: true,
});
const paths = new Set([
  "chains",
  "tools",
  "connections",
  "tokens",
  "quote",
  "status",
]);
export type ReadTransport = (
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;
const singleRead: ReadTransport = async (path, params, signal) => {
  if (!paths.has(path)) throw new RoutingError("READ_PATH_REJECTED");
  const abort = AbortSignal.any([
    AbortSignal.timeout(10000),
    ...(signal ? [signal] : []),
  ]);
  const url = new URL(`${client.config.apiUrl}/${path}`);
  url.search = new URLSearchParams({
    ...params,
    integrator: client.config.integrator,
  }).toString();
  const resolved = await Promise.race([
    lookup(url.hostname, { all: true }),
    new Promise<never>((_, reject) => {
      abort.addEventListener(
        "abort",
        () => reject(new RoutingError("PROVIDER_TIMEOUT")),
        { once: true },
      );
    }),
  ]);
  if (abort.aborted) throw new RoutingError("PROVIDER_TIMEOUT");
  if (!resolved.length || resolved.some((v) => !publicIp(v.address)))
    throw new RoutingError("UPSTREAM_ADDRESS_REJECTED");
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: "GET",
        signal: abort,
        headers: {
          Accept: "application/json",
          "x-lifi-integrator": client.config.integrator,
          "x-lifi-sdk": "4.10.0",
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
        if (res.statusCode !== 200) {
          res.resume();
          reject(
            new RoutingError(
              res.statusCode === 429
                ? "RATE_LIMITED"
                : res.statusCode === 404 ||
                    ([400, 422].includes(res.statusCode ?? 0) &&
                      path === "quote")
                  ? "NO_EXECUTABLE_ROUTE"
                  : "PROVIDER_UNAVAILABLE",
              res.statusCode,
            ),
          );
          return;
        }
        if (!res.headers["content-type"]?.startsWith("application/json")) {
          res.destroy();
          reject(new RoutingError("INVALID_RESPONSE"));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (b: Buffer) => {
          size += b.length;
          if (size > 4000000) {
            res.destroy();
            reject(new RoutingError("RESPONSE_TOO_LARGE"));
          } else chunks.push(b);
        });
        res.on("error", () => reject(new RoutingError("PROVIDER_UNAVAILABLE")));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8"); // Preserve large non-EVM chain IDs exactly.
            resolve(
              JSON.parse(
                text.replace(
                  /"(id|chainId|fromChainId|toChainId)"\s*:\s*(\d{16,18})(?=\s*[,}])/g,
                  '"$1":"$2"',
                ),
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
    req.end();
  });
};
export const upstreamRead: ReadTransport = async (path, params, signal) => {
  try {
    return await singleRead(path, params, signal);
  } catch (e) {
    if (
      path !== "quote" &&
      e instanceof RoutingError &&
      (e.httpStatus ?? 0) >= 500 &&
      !signal?.aborted
    ) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 250);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new RoutingError("PROVIDER_TIMEOUT"));
          },
          { once: true },
        );
      });
      return await singleRead(path, params, signal);
    }
    throw e;
  }
};
// G14 protected proposal B1 — the SERVER-ONLY fresh executable quote of the one owner-signed canary.
// The request is locked to the canary scope (protected bounds: src/security/canary-approval.ts): Base 8453 Circle
// USDC -> Arbitrum 42161 Circle USDC, LI.FI Across only, sender = recipient, no destination call, fee 0, the amount
// inside the scope. The owner's own account and amount are parameters of a request, never an approval of anything.
// What comes back is taken narrowly and strictly: only the fields below, each well formed and bounded, and only when
// the target, chain, sender, native value, selector, spender and amount are the canary's. It is meant for exactly one
// consumer, verifyCanaryQuote (src/execution/canary/quote-verify.ts), which proves everything else from the calldata.
// It never passes normalizeQuote, never enters getQuotes() or the /api/routing response, and is not cached, logged or
// counted here. `quotedAt` is stamped once, BEFORE the request leaves (the conservative bound), on a frozen object:
// there is no way to re-stamp an old quote as fresh — a newer time needs a new request and yields a new object, whose
// time, calldata and therefore plan / review digests differ, so an earlier review or authorization does not carry over.
export interface CanaryQuoteInput {
  source: string;
  destination: string;
  sourceAsset: string;
  destinationAsset: string;
  /** Raw USDC units, decimal. */
  amount: string;
  sourceAddress: string;
  destinationAddress: string;
}
export interface CanaryExecutableQuote {
  tool: string;
  quotedAt: number;
  transactionRequest: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number;
    gasLimit: string;
  };
  estimate: {
    approvalAddress: string;
    toAmountMin: string;
    fromAmount: string;
  };
}
const CANARY_TOOL = "across";
/** Quotes canaryExecutableQuote returned from the real upstream read in this process (provenance, review 1 F8). */
const canaryQuotes = new WeakSet<object>();
/**
 * True only for the exact frozen object canaryExecutableQuote returned after reading it through this adapter's own
 * upstream transport (upstreamRead). A copy, a spread, a re-stamped or hand-made object of the same shape, or the
 * result of an instance built with another read function, is not one. What this proves: the object passed the strict
 * intake and was stamped when its request left for the real provider. It does not prove what the provider computed;
 * the calldata's own quote timestamp and fill deadline remain the verifier's bound.
 */
export function isCanaryQuote(quote: unknown): boolean {
  return typeof quote === "object" && quote !== null && canaryQuotes.has(quote);
}
const CANARY_INPUT_KEYS = Object.freeze([
  "source",
  "destination",
  "sourceAsset",
  "destinationAsset",
  "amount",
  "sourceAddress",
  "destinationAddress",
]);
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const UNITS = /^(0|[1-9]\d{0,40})$/;
const QUANTITY = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,31})$/;
const sameText = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
/** The canary request parameters, or CANARY_SCOPE_REJECTED before anything is read. */
function canaryQuoteParams(input: unknown): Record<string, string> {
  const B = CANARY_APPROVAL_BOUNDS;
  const reject = () => new RoutingError("CANARY_SCOPE_REJECTED");
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw reject();
  const i = input as Record<string, unknown>;
  const keys = Object.keys(i);
  if (
    keys.length !== CANARY_INPUT_KEYS.length ||
    CANARY_INPUT_KEYS.some((k) => typeof i[k] !== "string")
  )
    throw reject();
  const owner = i.sourceAddress as string;
  const amount = i.amount as string;
  if (
    i.source !== B.sourceChainId ||
    i.destination !== B.destinationChainId ||
    !sameText(i.sourceAsset, B.token) ||
    !sameText(i.destinationAsset, B.destinationToken) ||
    !EVM_ADDRESS.test(owner) ||
    /^0x0{40}$/i.test(owner) ||
    !sameText(i.destinationAddress, owner) ||
    !UNITS.test(amount) ||
    BigInt(amount) < BigInt(B.minAmount) ||
    BigInt(amount) > BigInt(B.maxAmount)
  )
    throw reject();
  return {
    fromChain: B.sourceChainId,
    toChain: B.destinationChainId,
    fromToken: B.token,
    toToken: B.destinationToken,
    fromAmount: amount,
    fromAddress: owner,
    toAddress: owner,
    slippage: "0.005",
    order: "CHEAPEST",
    fee: "0",
    allowDestinationCall: "false",
    allowBridges: CANARY_TOOL,
  };
}
/** Narrow, strict intake of the provider's answer; anything else is CANARY_QUOTE_REJECTED. */
function canaryQuoteFromProvider(
  raw: unknown,
  params: Record<string, string>,
  quotedAt: number,
): CanaryExecutableQuote {
  const B = CANARY_APPROVAL_BOUNDS;
  const reject = () => new RoutingError("CANARY_QUOTE_REJECTED");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw reject();
  const q = raw as {
    tool?: unknown;
    transactionRequest?: unknown;
    estimate?: unknown;
  };
  const tr = q.transactionRequest as Record<string, unknown> | null | undefined;
  const est = q.estimate as Record<string, unknown> | null | undefined;
  if (
    q.tool !== CANARY_TOOL ||
    !tr ||
    typeof tr !== "object" ||
    Array.isArray(tr) ||
    !est ||
    typeof est !== "object" ||
    Array.isArray(est)
  )
    throw reject();
  const data = tr.data;
  const chainId =
    typeof tr.chainId === "number"
      ? tr.chainId
      : typeof tr.chainId === "string" && /^\d{1,9}$/.test(tr.chainId)
        ? Number(tr.chainId)
        : NaN;
  if (
    typeof tr.to !== "string" ||
    typeof tr.from !== "string" ||
    typeof data !== "string" ||
    typeof tr.value !== "string" ||
    typeof tr.gasLimit !== "string" ||
    typeof est.approvalAddress !== "string" ||
    typeof est.toAmountMin !== "string" ||
    typeof est.fromAmount !== "string" ||
    !EVM_ADDRESS.test(tr.to) ||
    !EVM_ADDRESS.test(tr.from) ||
    !EVM_ADDRESS.test(est.approvalAddress) ||
    !/^0x(?:[0-9a-fA-F]{2}){4,16384}$/.test(data) ||
    !QUANTITY.test(tr.value) ||
    !QUANTITY.test(tr.gasLimit) ||
    !UNITS.test(est.toAmountMin) ||
    !UNITS.test(est.fromAmount)
  )
    throw reject();
  // Foreign target, chain, sender, native value, selector, spender or amount never leaves this adapter.
  if (
    !sameText(tr.to, B.target) ||
    chainId !== Number(B.sourceChainId) ||
    !sameText(tr.from, params.fromAddress) ||
    BigInt(tr.value) !== 0n ||
    !sameText(data.slice(0, 10), B.selector) ||
    !sameText(est.approvalAddress, B.spender) ||
    est.fromAmount !== params.fromAmount ||
    BigInt(tr.gasLimit) <= 0n ||
    BigInt(tr.gasLimit) > BigInt(B.maxGasLimit)
  )
    throw reject();
  const quote: CanaryExecutableQuote = Object.freeze({
    tool: CANARY_TOOL,
    quotedAt,
    transactionRequest: Object.freeze({
      to: tr.to,
      from: tr.from,
      data,
      value: tr.value,
      chainId,
      gasLimit: tr.gasLimit,
    }),
    estimate: Object.freeze({
      approvalAddress: est.approvalAddress,
      toAmountMin: est.toAmountMin,
      fromAmount: est.fromAmount,
    }),
  });
  return quote;
}
export class RoutingCore implements NetworkCatalogProvider, RouteProvider {
  readonly id = "routing-core" as const;
  readonly capabilities = {
    quote: true,
    status: true,
    execution: false as const,
  };
  private cached: Catalog | undefined;
  private pending: Promise<Catalog> | undefined;
  private fillSeq = 0;
  private assetCache = new Map<string, { at: number; assets: Asset[] }>();
  /**
   * G14 closure (H1): the read transport is a runtime-private field (#read), set once in the constructor. Nothing
   * outside this class can read or replace it at run time (a TypeScript `private` / `readonly` would only be a
   * compile-time promise). `read` below is its only accessor for the catalog / quote methods.
   */
  readonly #read: ReadTransport;
  constructor(read: ReadTransport = upstreamRead) {
    this.#read = read;
  }
  private get read(): ReadTransport {
    return this.#read;
  }
  async listNetworks(signal?: AbortSignal, refresh = false): Promise<Catalog> {
    if (
      !refresh &&
      this.cached &&
      Date.now() - this.cached.observedAt < 300000 &&
      !this.cached.stale
    )
      return this.cached;
    void signal; // The shared refresh is never bound to one caller's request signal (bounded by its own timeout).
    // G13 (review F19): an explicit refresh never joins a pending timed refill — it must mint a new generation.
    if (this.pending && !refresh) return this.pending;
    const seq = ++this.fillSeq;
    const fill = (async () => {
      try {
        const [chains, tools] = await Promise.all([
          this.read("chains", { chainTypes: "EVM,SVM,UTXO,MVM,TVM,STL" }),
          this.read("tools", {}),
        ]);
        const networks = normalizeChains(chains),
          normalizedTools = normalizeTools(tools),
          observedAt = Date.now();
        const content = createHash("sha256")
          .update(JSON.stringify([networks, normalizedTools]))
          .digest("hex")
          .slice(0, 20);
        // G13 (VBA-P1-03): a timed refill whose content is identical keeps the generation, so a page left open is not
        // refused with CATALOG_CHANGED; an explicit refresh still invalidates it.
        const keep =
          !refresh &&
          !!this.cached &&
          !this.cached.stale &&
          this.cached.generation.endsWith(`-${content}`);
        const next: Catalog = {
          networks,
          tools: normalizedTools,
          observedAt,
          stale: false,
          // G13 (review R4): the fill sequence makes every new generation unique, even within one millisecond.
          generation: keep
            ? this.cached!.generation
            : `${observedAt}.${seq}-${content}`,
        };
        // G13 (review F19): only the newest fill may replace the cache.
        if (seq === this.fillSeq) this.cached = next;
        return next;
      } catch (e) {
        return {
          ...(this.cached ?? {
            networks: normalizeChains(snapshot.chains),
            tools: normalizeTools(snapshot.tools),
            observedAt: snapshot.observedAt,
            generation: "packaged-stale",
          }),
          stale: true,
          error: e instanceof RoutingError ? e.code : "INVALID_CATALOG",
        };
      }
    })();
    this.pending = fill;
    try {
      return await fill;
    } finally {
      // G13 (review F19): a call clears only its own pending fill.
      if (this.pending === fill) this.pending = undefined;
    }
  }
  async getNetwork(id: string, signal?: AbortSignal) {
    return (await this.listNetworks(signal)).networks.find((n) => n.id === id);
  }
  async getConnections(
    source: string,
    destination: string,
    signal?: AbortSignal,
  ) {
    requirePair(await this.listNetworks(signal), source, destination);
    const params: ConnectionsRequest = {
      fromChain: source,
      toChain: destination,
    };
    const [raw, sourceAssets, destinationAssets] = await Promise.all([
      this.read(
        "connections",
        {
          fromChain: String(params.fromChain),
          toChain: String(params.toChain),
        },
        signal,
      ),
      this.getAssets(source, signal),
      this.getAssets(destination, signal),
    ]);
    return normalizeConnections(raw, source, destination, {
      source: sourceAssets,
      destination: destinationAssets,
    });
  }

  async getAssets(chain: string, signal?: AbortSignal) {
    const catalog = await this.listNetworks(signal);
    if (
      catalog.stale ||
      !catalog.networks.some(
        (n) => n.id === chain && n.provider === "routing-core",
      )
    )
      throw new RoutingError("STALE_OR_UNKNOWN_NETWORK");
    const cached = this.assetCache.get(chain);
    if (cached && Date.now() - cached.at < 300000) return cached.assets;
    const raw = await this.read("tokens", { chains: chain }, signal);
    const tokens = (raw as { tokens?: Record<string, unknown> })?.tokens?.[
      chain
    ];
    const assets = normalizeAssets(tokens, chain);
    if (!assets.length) throw new RoutingError("INVALID_ASSET_CATALOG");
    if (this.assetCache.size >= 20)
      this.assetCache.delete(this.assetCache.keys().next().value!);
    this.assetCache.set(chain, { at: Date.now(), assets });
    return assets;
  }
  async getQuotes(input: QuoteInput, signal?: AbortSignal) {
    const catalog = await this.listNetworks(signal);
    validateQuoteInput(input, catalog);
    const params = {
      fromChain: input.source,
      toChain: input.destination,
      fromToken: input.sourceAsset,
      toToken: input.destinationAsset,
      fromAmount: input.amount,
      fromAddress: input.sourceAddress,
      toAddress: input.destinationAddress,
      slippage: String(input.slippage),
      order: input.preference === "time" ? "FASTEST" : "CHEAPEST",
      fee: "0",
      allowDestinationCall: "false",
    };
    // Two documented objectives may yield one or two real quotes. Do not invent alternatives.
    const results = await Promise.allSettled([
      this.read("quote", params, signal),
      this.read(
        "quote",
        {
          ...params,
          order: params.order === "FASTEST" ? "CHEAPEST" : "FASTEST",
        },
        signal,
      ),
    ]);
    if (this.cached?.generation !== catalog.generation)
      throw new RoutingError("CATALOG_CHANGED");
    const normalized = results.flatMap((r) => {
      if (r.status !== "fulfilled") return [];
      // Invalid payloads never become a route merely because another response succeeded.
      return [normalizeQuote(r.value, input, catalog)];
    });
    if (!normalized.length) {
      const failure = results.find((r) => r.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
      throw new RoutingError("NO_EXECUTABLE_ROUTE");
    }
    return rankRoutes(
      normalized,
      input.preference === "time" ? "time" : "value",
    );
  }
  /**
   * G14 protected proposal B1: one fresh executable Across quote for the canary scope, for the server's canary
   * engine only (see the note above CanaryQuoteInput). No catalog, cache or generation state is read or written, so
   * the catalog refresh logic is untouched. No retry: upstreamRead never repeats a quote.
   */
  async canaryExecutableQuote(
    input: CanaryQuoteInput,
    signal?: AbortSignal,
  ): Promise<CanaryExecutableQuote> {
    if (typeof window !== "undefined")
      throw new RoutingError("CANARY_SCOPE_REJECTED");
    const params = canaryQuoteParams(input);
    // H1: the function that will ACTUALLY be called is captured here, before the call, and the provenance decision
    // is made about that captured function — never about a field read again after the await.
    const read = this.#read;
    const fromUpstream = read === upstreamRead;
    const quotedAt = Date.now();
    const quote = canaryQuoteFromProvider(
      await read("quote", params, signal),
      params,
      quotedAt,
    );
    // Provenance only for the adapter's own upstream transport (review 2 G4): an instance built with any other read
    // function (a test double, a replay) returns the same checked shape but never an "adapter quote".
    if (fromUpstream) canaryQuotes.add(quote);
    return quote;
  }
  async getStatus(input: StatusInput, signal?: AbortSignal) {
    requirePair(
      await this.listNetworks(signal),
      input.source,
      input.destination,
    );
    const params: GetStatusRequest = {
      fromChain: input.source,
      toChain: input.destination,
      txHash: input.hash,
    };
    return normalizeStatus(
      await this.read(
        "status",
        {
          fromChain: String(params.fromChain),
          toChain: String(params.toChain),
          txHash: params.txHash!,
        },
        signal,
      ),
      input,
    );
  }
}
export const routingCore = new RoutingCore();
