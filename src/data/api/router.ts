import { z } from "zod";
import { validAddress } from "../../routing/addresses";
import type { Catalog } from "../../routing/model";
import { scanPortfolio } from "../../portfolio/service";
import { SelfHostedPortfolioProvider } from "../portfolio/provider";
import { effectiveTier } from "../registry/chains";
import { readNative, readTokenBalances } from "../balances/evm";
import type { DataPlane, PlaneState } from "../plane";
import type { DataStore, StoredChain } from "../store/types";
import {
  RateLimitUnavailable,
  type RateLimiter,
} from "../../server/rate-limit";
import {
  ApiError,
  errorResponse,
  json,
  newRequestId,
  type ErrorCode,
} from "./errors";
import { bearer, dummyVerify, parseKey, verifyKey } from "./keys";
import { COST, latencyBucket, planOf, type Scope } from "./plans";
import { openApiDocument } from "./openapi";
import { DOCS_CSP, docsPage } from "./docs-page";
import { logEvent, metrics } from "../observability/log";
import { statusClass } from "../observability/metrics";
import { freshPrice } from "../core/price";
import { indexEligibility } from "../indexer/eligibility";
import { scanDefi } from "../../defi/scanner";
import { deployments } from "../../defi/registry";
import {
  CatalogQueryError,
  categoryReport,
  coverageReport,
  loadCatalog,
  protocolDetail,
  queryChains,
  queryProtocols,
  type CatalogIndex,
} from "../../defi/universe/store";
export interface DataApiDeps {
  store: DataStore;
  plane: DataPlane;
  limiter: RateLimiter;
  routing: (signal?: AbortSignal) => Promise<Catalog>;
  priceRead?: (
    path: string,
    params: Record<string, string>,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  now?: () => number;
  handlerTimeoutMs?: number;
  defiScan?: typeof scanDefi;
  /** V1.14: accepted last-good DeFi universe (server-side index; never an upstream proxy). */
  catalog?: () => Promise<CatalogIndex>;
}
interface Ctx {
  url: URL;
  params: Record<string, string>;
  signal: AbortSignal;
  state: PlaneState;
  plan: ReturnType<typeof planOf>;
  clientId: string;
}
interface Route {
  pattern: RegExp;
  keys: string[];
  scope: Scope | null;
  group: string;
  cost: (ctx: Omit<Ctx, "state">) => number;
  handle: (ctx: Ctx, deps: DataApiDeps) => Promise<unknown>;
}
const chainId = z.string().regex(/^\d{1,18}$/);
const limitParam = (url: URL, max: number, fallback: number) => {
  const raw = url.searchParams.get("limit");
  if (raw === null) return fallback;
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1 || Number(raw) > max)
    throw new ApiError("INVALID_REQUEST");
  return Number(raw);
};
const cursorSchema = z
  .object({
    v: z.literal(1),
    k: z.array(z.union([z.string().max(100), z.number().int()])).max(4),
  })
  .strict();
export function encodeCursor(k: (string | number)[]) {
  return Buffer.from(JSON.stringify({ v: 1, k })).toString("base64url");
}
export function decodeCursor(raw: string | null): (string | number)[] | null {
  if (raw === null) return null;
  if (raw.length > 400 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new ApiError("INVALID_CURSOR");
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(raw, "base64url").toString("utf8")),
    ).k;
  } catch {
    throw new ApiError("INVALID_CURSOR");
  }
}
function requireChain(state: PlaneState, id: string): StoredChain {
  if (!chainId.safeParse(id).success) throw new ApiError("INVALID_REQUEST");
  const chain = state.chains.find((c) => c.chainId === id && c.mainnet);
  if (!chain) throw new ApiError("NOT_FOUND");
  return chain;
}
function requireAddress(
  chain: StoredChain | null,
  raw: string,
  ecosystem?: string,
) {
  const eco = chain ? chain.ecosystem : ecosystem === "solana" ? "SVM" : "EVM";
  if (eco !== "EVM" && eco !== "SVM") throw new ApiError("CHAIN_UNSUPPORTED");
  if (!validAddress(eco, raw)) throw new ApiError("INVALID_ADDRESS");
  return { address: eco === "EVM" ? raw.toLowerCase() : raw, eco };
}
function tierOf(state: PlaneState, c: StoredChain) {
  const endpoints = state.endpoints.get(c.chainId) ?? [];
  const cp = state.checkpoints.get(c.chainId);
  return effectiveTier(c, {
    healthyRpc: endpoints.length > 0,
    logs: endpoints.some((e) => e.supportsLogs),
    tokenUniverse: (state.tokenCounts.get(c.chainId) ?? 0) > 0,
    indexStarted: !!cp && cp.indexedThroughBlock >= cp.indexedFromBlock,
  });
}
export function indexCoverage(state: PlaneState, c: StoredChain, now: number) {
  const cp = state.checkpoints.get(c.chainId);
  if (!cp) return null;
  const lag =
    cp.headBlock !== null ? cp.headBlock - cp.indexedThroughBlock : null;
  const tolerance = BigInt(Math.max(64, c.finality.depth * 2 + 16));
  const current =
    lag !== null &&
    lag <= tolerance &&
    now - cp.updatedAt < 600000 &&
    !cp.haltedReason;
  const integrity = indexEligibility({
    chainId: c.chainId,
    endpoints: state.endpoints.get(c.chainId) ?? [],
    checkpoint: cp,
    witness: state.witness?.get(c.chainId),
    indexCurrent: current,
    releaseAllowed: (e) => e.reviewStatus === "APPROVED_FOR_RELEASE",
  });
  return {
    chainId: c.chainId,
    indexedFromBlock: cp.indexedFromBlock.toString(),
    indexedThroughBlock:
      cp.indexedThroughBlock >= cp.indexedFromBlock
        ? cp.indexedThroughBlock.toString()
        : null,
    headBlock: cp.headBlock?.toString() ?? null,
    safeBlock: cp.safeBlock?.toString() ?? null,
    finalityLag: lag === null ? null : lag.toString(),
    historicalComplete: cp.historicalComplete,
    current,
    lastError: cp.lastError
      ? cp.lastError.replace(/[^A-Z0-9_:-]/gi, "").slice(0, 60)
      : null,
    observedAt: cp.updatedAt,
    // V1.5: live/historical lanes and witness-backed integrity (engineering labels, API only).
    liveIndexedThrough: integrity.liveIndexedThrough,
    historicalIndexedFrom: integrity.historicalIndexedFrom,
    integrity: {
      level: integrity.level,
      engineeringEligible: integrity.engineeringEligible,
      witnessVerified: integrity.witnessVerified,
      paused: integrity.paused,
      independentOperators: integrity.independentOperators,
      windows: integrity.windows,
      trustedWindows: integrity.trustedWindows,
      developmentWindows: integrity.developmentWindows,
      unwitnessedWindows: integrity.unwitnessedWindows,
      blockers: integrity.blockers,
    },
  };
}
function chainView(state: PlaneState, c: StoredChain, now: number) {
  return {
    chainId: c.chainId,
    canonicalId: c.canonicalId,
    name: c.name,
    ecosystem: c.ecosystem,
    tier: tierOf(state, c),
    configuredTier: c.configuredTier,
    routable: c.routable,
    tvlUsd: c.tvlUsd,
    native: {
      symbol: c.native.symbol,
      decimals: c.ecosystem === "EVM" ? 18 : c.native.decimals,
    },
    vettedRpcEndpoints: state.endpoints.get(c.chainId)?.length ?? 0,
    multicallVerified: !!c.multicall,
    index: indexCoverage(state, c, now),
  };
}
const intParam = (url: URL, name: string) => {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  if (!/^\d{1,4}$/.test(raw)) throw new ApiError("INVALID_REQUEST");
  return Number(raw);
};
async function catalogIndex(deps: DataApiDeps) {
  try {
    return await (deps.catalog ?? loadCatalog)();
  } catch {
    throw new ApiError("SERVICE_UNAVAILABLE");
  }
}
function catalogQuery<T>(work: () => T): T {
  try {
    return work();
  } catch (e) {
    if (e instanceof CatalogQueryError)
      throw new ApiError(
        e.message === "INVALID_CURSOR" ? "INVALID_CURSOR" : "INVALID_REQUEST",
      );
    throw e;
  }
}
const q = (url: URL, name: string) => url.searchParams.get(name);
// V1.14 global DeFi catalog: every cataloged protocol/chain with its coverage truth. Catalog TVL is context only.
const CATALOG_ROUTES: Route[] = [
  {
    pattern: /^\/v1\/defi\/catalog\/protocols$/,
    keys: [],
    scope: "chains:read",
    group: "defi-catalog",
    cost: () => COST.catalog,
    handle: async ({ url }, deps) => {
      const index = await catalogIndex(deps);
      return catalogQuery(() =>
        queryProtocols(index, {
          q: q(url, "q"),
          category: q(url, "category"),
          chain: q(url, "chain"),
          coverage: q(url, "coverage"),
          status: q(url, "status"),
          vm: q(url, "vm"),
          sort: q(url, "sort"),
          cursor: q(url, "cursor"),
          limit: intParam(url, "limit"),
        }),
      );
    },
  },
  {
    pattern: /^\/v1\/defi\/catalog\/protocols\/([^/]{1,200})$/,
    keys: ["id"],
    scope: "chains:read",
    group: "defi-catalog",
    cost: () => COST.catalog,
    handle: async ({ params }, deps) => {
      const index = await catalogIndex(deps);
      const detail = catalogQuery(() => protocolDetail(index, params.id));
      if (!detail) throw new ApiError("NOT_FOUND");
      return detail;
    },
  },
  {
    pattern: /^\/v1\/defi\/catalog\/chains$/,
    keys: [],
    scope: "chains:read",
    group: "defi-catalog",
    cost: () => COST.catalog,
    handle: async ({ url }, deps) => {
      const index = await catalogIndex(deps);
      return catalogQuery(() =>
        queryChains(index, {
          q: q(url, "q"),
          vm: q(url, "vm"),
          capability: q(url, "capability"),
          status: q(url, "status"),
          sort: q(url, "sort"),
          cursor: q(url, "cursor"),
          limit: intParam(url, "limit"),
        }),
      );
    },
  },
  {
    pattern: /^\/v1\/defi\/catalog\/categories$/,
    keys: [],
    scope: "chains:read",
    group: "defi-catalog",
    cost: () => COST.catalog,
    handle: async (_ctx, deps) => categoryReport(await catalogIndex(deps)),
  },
  {
    pattern: /^\/v1\/defi\/catalog\/coverage$/,
    keys: [],
    scope: "chains:read",
    group: "defi-catalog",
    cost: () => COST.catalog,
    handle: async (_ctx, deps) => coverageReport(await catalogIndex(deps)),
  },
];
const ROUTES: Route[] = [
  ...CATALOG_ROUTES,
  {
    pattern: /^\/v1\/address\/([^/]+)\/defi(?:\/(coverage|protocols|[^/]+))?$/,
    keys: ["address", "view"],
    scope: "portfolio:read",
    group: "defi",
    cost: () => 200,
    handle: async ({ params, url, clientId, signal, state, plan }, deps) => {
      const { address, eco } = requireAddress(null, params.address);
      if (eco !== "EVM") throw new ApiError("CHAIN_UNSUPPORTED");
      const chains = url.searchParams.get("chains")?.split(",");
      if (
        chains &&
        (chains.length > Math.min(4, plan.maxPortfolioChains) ||
          chains.some(
            (id) =>
              !state.chains.some(
                (c) => c.chainId === id && c.mainnet && c.ecosystem === "EVM",
              ),
          ))
      )
        throw new ApiError("INVALID_REQUEST");
      const selected = url.searchParams.get("deployments")?.split(",");
      if (
        selected &&
        (selected.length > 32 ||
          selected.some((id) => !deployments.some((d) => d.id === id)))
      )
        throw new ApiError("INVALID_REQUEST");
      const scan = await (deps.defiScan ?? scanDefi)(address, deps.plane, {
        chains,
        deploymentIds: selected,
        clientScope: clientId,
        signal,
        priceRead: deps.priceRead,
        maxDeployments: 12,
      });
      if (params.view === "coverage")
        return {
          coverage: scan.coverage,
          continuation: scan.continuation,
          nonEvm: scan.nonEvm,
          observedAt: scan.observedAt,
        };
      if (params.view === "protocols")
        return {
          protocols: [...new Set(scan.coverage.map((c) => c.protocolId))],
          coverage: scan.coverage,
        };
      if (params.view) {
        const p = scan.positions.find(
          (p) => p.id === decodeURIComponent(params.view),
        );
        if (!p) throw new ApiError("NOT_FOUND");
        return p;
      }
      const limit = limitParam(url, 100, 50),
        cursor = decodeCursor(url.searchParams.get("cursor"));
      if (cursor && (cursor.length !== 2 || cursor[0] !== scan.scanId))
        throw new ApiError("INVALID_CURSOR");
      const sorted = [...scan.positions].sort((a, b) =>
          a.id.localeCompare(b.id),
        ),
        after = cursor?.[1],
        start =
          after === undefined
            ? 0
            : sorted.findIndex((p) => p.id > String(after));
      const positions = start < 0 ? [] : sorted.slice(start, start + limit);
      return {
        ...scan,
        positions,
        totalPositions: scan.positions.length,
        nextCursor:
          start >= 0 && start + limit < sorted.length
            ? encodeCursor([scan.scanId, positions.at(-1)!.id])
            : null,
      };
    },
  },
  {
    pattern: /^\/v1\/chains$/,
    keys: [],
    scope: "chains:read",
    group: "chains",
    cost: () => COST.chains,
    handle: async ({ url, state }, deps) => {
      const limit = limitParam(url, 200, 100);
      const after = decodeCursor(url.searchParams.get("cursor"))?.[0];
      const sorted = [...state.chains]
        .filter((c) => c.mainnet)
        .sort((a, b) => a.chainId.localeCompare(b.chainId));
      const start =
        after === undefined
          ? 0
          : sorted.findIndex((c) => c.chainId > String(after));
      const page = start < 0 ? [] : sorted.slice(start, start + limit);
      const now = (deps.now ?? Date.now)();
      return {
        chains: page.map((c) => chainView(state, c, now)),
        nextCursor:
          start >= 0 && start + limit < sorted.length
            ? encodeCursor([page[page.length - 1].chainId])
            : null,
        total: sorted.length,
      };
    },
  },
  {
    pattern: /^\/v1\/chains\/([^/]+)$/,
    keys: ["chainId"],
    scope: "chains:read",
    group: "chains",
    cost: () => COST.chain,
    handle: async ({ params, state }, deps) =>
      chainView(
        state,
        requireChain(state, params.chainId),
        (deps.now ?? Date.now)(),
      ),
  },
  {
    pattern: /^\/v1\/chains\/([^/]+)\/coverage$/,
    keys: ["chainId"],
    scope: "chains:read",
    group: "coverage",
    cost: () => COST.coverage,
    handle: async ({ params, state }, deps) => {
      const c = requireChain(state, params.chainId);
      const now = (deps.now ?? Date.now)();
      return {
        chainId: c.chainId,
        tier: tierOf(state, c),
        index: indexCoverage(state, c, now) ?? {
          chainId: c.chainId,
          indexedFromBlock: null,
          indexedThroughBlock: null,
          headBlock: null,
          safeBlock: null,
          finalityLag: null,
          historicalComplete: false,
          current: false,
          lastError: null,
          observedAt: null,
        },
      };
    },
  },
  {
    pattern: /^\/v1\/address\/([^/]+)\/activity$/,
    keys: ["address"],
    scope: "activity:read",
    group: "activity",
    cost: () => COST.activityPage,
    handle: async ({ url, params, state }, deps) => {
      const { address } = requireAddress(null, params.address, "evm");
      const limit = limitParam(url, 200, 50);
      const k = decodeCursor(url.searchParams.get("cursor"));
      const cursor =
        k &&
        k.length === 3 &&
        chainId.safeParse(k[0]).success &&
        /^\d{1,19}$/.test(String(k[1])) &&
        BigInt(String(k[1])) <= 9223372036854775807n &&
        typeof k[2] === "number" &&
        Number.isSafeInteger(k[2]) &&
        k[2] >= 0
          ? {
              chainId: String(k[0]),
              blockNumber: BigInt(String(k[1])),
              logIndex: k[2],
            }
          : k
            ? (() => {
                throw new ApiError("INVALID_CURSOR");
              })()
            : null;
      const rows = await deps.store.walletActivity(address, cursor, limit + 1);
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        address,
        items: page.map((r) => ({
          ...r,
          blockNumber: r.blockNumber.toString(),
          value: r.value.toString(),
        })),
        nextCursor:
          rows.length > limit && last
            ? encodeCursor([
                last.chainId,
                last.blockNumber.toString(),
                last.logIndex,
              ])
            : null,
        coverage: [...state.checkpoints.values()].map((cp) => ({
          chainId: cp.chainId,
          indexedFromBlock: cp.indexedFromBlock.toString(),
          indexedThroughBlock: cp.indexedThroughBlock.toString(),
          historicalComplete: cp.historicalComplete,
        })),
        note: "Activity covers only the indexed block windows listed in coverage.",
      };
    },
  },
  {
    pattern: /^\/v1\/(\d{1,18})\/address\/([^/]+)\/native-balance$/,
    keys: ["chainId", "address"],
    scope: "balances:read",
    group: "native-balance",
    cost: () => COST.nativeBalance,
    handle: async ({ params, state, signal }, deps) => {
      const chain = requireChain(state, params.chainId);
      const { address, eco } = requireAddress(chain, params.address);
      const pool = deps.plane.pool(state, chain.chainId);
      if (!pool) throw new ApiError("CHAIN_UNSUPPORTED");
      if (eco === "SVM") {
        const r = z
          .object({
            context: z
              .object({ slot: z.number().int().nonnegative() })
              .passthrough(),
            value: z.number().int().nonnegative().safe(),
          })
          .passthrough()
          .parse(
            (
              await pool.call(
                {
                  method: "getBalance",
                  params: [address, { commitment: "finalized" }],
                },
                { signal, timeoutMs: 6000 },
              )
            ).value,
          );
        return {
          chainId: chain.chainId,
          address,
          balance: String(r.value),
          decimals: 9,
          observedBlock: String(r.context.slot),
          observedAt: Date.now(),
        };
      }
      const n = await readNative(pool, address, signal);
      return {
        chainId: chain.chainId,
        address,
        balance: n.balance.toString(),
        decimals: 18,
        nonce: n.nonce?.toString() ?? null,
        observedBlock: n.block.toString(),
        observedAt: n.observedAt,
      };
    },
  },
  {
    pattern: /^\/v1\/(\d{1,18})\/address\/([^/]+)\/token-balances$/,
    keys: ["chainId", "address"],
    scope: "balances:read",
    group: "token-balances",
    cost: () => COST.tokenBalancesPage,
    handle: async (ctx, deps) => tokenPage(ctx, deps),
  },
  {
    pattern: /^\/v1\/(\d{1,18})\/address\/([^/]+)\/balances$/,
    keys: ["chainId", "address"],
    scope: "balances:read",
    group: "balances",
    cost: () => COST.balances,
    handle: async (ctx, deps) => tokenPage(ctx, deps, true),
  },
  {
    pattern: /^\/v1\/address\/([^/]+)\/portfolio$/,
    keys: ["address"],
    scope: "portfolio:read",
    group: "portfolio",
    cost: ({ url, plan }) =>
      COST.portfolio(maxChains(url, plan.maxPortfolioChains)),
    handle: async ({ url, params, signal, plan }, deps) => {
      const ecosystem = url.searchParams.get("ecosystem") ?? "evm";
      if (!["evm", "solana"].includes(ecosystem))
        throw new ApiError("INVALID_REQUEST");
      const { address } = requireAddress(null, params.address, ecosystem);
      const routing = await deps.routing(signal);
      const identity =
        ecosystem === "evm" ? { evm: params.address } : { solana: address };
      return scanPortfolio(
        identity,
        routing,
        signal,
        [
          new SelfHostedPortfolioProvider(
            deps.plane,
            routing,
            deps.priceRead ?? null,
          ),
        ],
        {
          continuation: url.searchParams.get("cursor"),
          concurrency: 6,
          deadlineMs: 15000,
          perChainMs: 6000,
          maxChains: maxChains(url, plan.maxPortfolioChains),
        },
      );
    },
  },
  {
    pattern: /^\/v1\/(\d{1,18})\/token\/([^/]+)$/,
    keys: ["chainId", "token"],
    scope: "tokens:read",
    group: "token",
    cost: () => COST.token,
    handle: async ({ params, state }, deps) => {
      const chain = requireChain(state, params.chainId);
      const { address: token } = requireAddress(chain, params.token);
      const [row] = await deps.store.getTokens(chain.chainId, [token]);
      // Only tokens already in the index/universe are served: callers cannot steer RPC calls at
      // arbitrary contracts through this endpoint.
      if (!row) throw new ApiError("NOT_FOUND");
      return {
        chainId: row.chainId,
        address: row.address,
        symbol: row.symbol,
        name: row.name,
        decimals: row.decimals,
        metadataStatus: row.metadataStatus,
        suspicious: row.suspicious,
        spam: row.spam,
        sources: row.sources,
        price:
          row.price && freshPrice(row.price, (deps.now ?? Date.now)())
            ? row.price
            : null,
      };
    },
  },
  // V1.5: operational metrics left the public API listener; they are served only by the internal,
  // token-protected metrics listener (services/data-api.ts). /v1/metrics is now NOT_FOUND for everyone.
];
function maxChains(url: URL, planMax: number) {
  const raw = url.searchParams.get("maxChains");
  if (raw === null) return planMax;
  if (!/^\d{1,4}$/.test(raw) || Number(raw) < 1)
    throw new ApiError("INVALID_REQUEST");
  return Math.min(planMax, Number(raw));
}
async function tokenPage(
  { url, params, state, signal }: Ctx,
  deps: DataApiDeps,
  includeNative = false,
) {
  const chain = requireChain(state, params.chainId);
  const { address, eco } = requireAddress(chain, params.address);
  if (eco !== "EVM") throw new ApiError("CHAIN_UNSUPPORTED");
  const pool = deps.plane.pool(state, chain.chainId);
  if (!pool) throw new ApiError("CHAIN_UNSUPPORTED");
  const tier = tierOf(state, chain);
  if (tier !== "FULL_INDEXED" && tier !== "ON_DEMAND_FUNGIBLE")
    throw new ApiError("CHAIN_UNSUPPORTED");
  const limit = limitParam(url, 200, 200);
  const after = decodeCursor(url.searchParams.get("cursor"))?.[0];
  if (after !== undefined && !/^0x[0-9a-f]{40}$/.test(String(after)))
    throw new ApiError("INVALID_CURSOR");
  const discovered =
    tier === "FULL_INDEXED"
      ? await deps.store.discoveredTokens(chain.chainId, address)
      : [];
  const universe = await deps.store.tokenUniverse(chain.chainId, 1000);
  const candidates = [
    ...new Set([...discovered.map((d) => d.token), ...universe]),
  ]
    .filter(
      (t) =>
        /^0x[0-9a-f]{40}$/.test(t) &&
        t !== "0x0000000000000000000000000000000000000000",
    )
    .sort();
  const remaining =
    after === undefined
      ? candidates
      : candidates.filter((t) => t > String(after));
  const batch = remaining.slice(0, limit);
  const native = await readNative(pool, address, signal);
  const { reads, unchecked } = await readTokenBalances(
    pool,
    address,
    batch,
    native.block,
    chain.multicall,
    signal,
  );
  const meta = new Map(
    (
      await deps.store.getTokens(
        chain.chainId,
        reads.filter((r) => r.balance && r.balance > 0n).map((r) => r.token),
      )
    ).map((t) => [t.address, t]),
  );
  const indexed = new Set(discovered.map((d) => d.token));
  const cp = state.checkpoints.get(chain.chainId);
  return {
    chainId: chain.chainId,
    address,
    observedBlock: native.block.toString(),
    observedAt: native.observedAt,
    ...(includeNative
      ? { native: { balance: native.balance.toString(), decimals: 18 } }
      : {}),
    tokens: reads
      .filter((r) => r.balance !== null && r.balance > 0n)
      .map((r) => {
        const m = meta.get(r.token);
        return {
          token: r.token,
          balance: r.balance!.toString(),
          decimals: m?.decimals ?? null,
          symbol: m?.symbol ?? null,
          discovery: indexed.has(r.token) ? "indexed" : "known-token",
        };
      }),
    failedReads: reads.filter((r) => r.balance === null).map((r) => r.token),
    unchecked,
    checkedCandidates: batch.length - unchecked.length,
    totalCandidates: candidates.length,
    nextCursor:
      remaining.length > batch.length
        ? encodeCursor([batch[batch.length - 1]])
        : null,
    coverage: {
      tier,
      tokens: tier === "FULL_INDEXED" ? "INDEXED" : "KNOWN_TOKENS",
      historicalComplete: !!cp?.historicalComplete,
      indexedFromBlock: cp?.indexedFromBlock.toString() ?? null,
      indexedThroughBlock: cp?.indexedThroughBlock.toString() ?? null,
    },
  };
}
// V1.5: a datastore outage fails closed with 503 (never 500, never partial data, never details).
const DATASTORE_CODES =
  /^(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CONNECT_TIMEOUT|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|57P0[1-3]|08\d{3})$/;
export function datastoreUnavailable(error: unknown) {
  const e = error as { name?: unknown; code?: unknown } | null;
  return (
    !!e &&
    typeof e.code === "string" &&
    (DATASTORE_CODES.test(e.code) ||
      (e.name === "PostgresError" && /^(08|57P)/.test(e.code)))
  );
}
// V1.5: methods are refused before any WHATWG Request is built (TRACE/CONNECT/TRACK would make the
// Request constructor throw and surface as 500); the API is GET/HEAD only.
export function preRoute(method: string | undefined): Response | null {
  if (method === "GET" || method === "HEAD") return null;
  return errorResponse("METHOD_NOT_ALLOWED", newRequestId(), { Allow: "GET" });
}
// RFC 9112 §3.2: a request with more than one Host field line is answered with 400, even when the
// values are identical, so a front proxy and this service can never disagree about the target host.
export function hostFieldLines(rawHeaders: readonly string[]): number {
  let n = 0;
  for (let i = 0; i < rawHeaders.length; i += 2)
    if (rawHeaders[i]!.toLowerCase() === "host") n++;
  return n;
}
// Read-only versioned API. Browser Origin is never an authentication factor; CORS is disabled.
export function createDataApi(deps: DataApiDeps) {
  const now = deps.now ?? Date.now;
  let health: { at: number; ok: boolean } | undefined;
  // Unauthenticated traffic (health, docs, failed auth) shares a bounded global bucket so it cannot
  // amplify database work; authenticated clients are limited per client before any other work.
  // V1.5: "unavailable" (durable limiter down) is distinguished from "exhausted" so a datastore
  // outage is reported as 503, never as a misleading 429.
  const anonymous = async (): Promise<
    "allowed" | "limited" | "unavailable"
  > => {
    try {
      return (
        await deps.limiter.consume("api:anonymous", {
          limit: 300,
          windowSeconds: 60,
        })
      ).allowed
        ? "allowed"
        : "limited";
    } catch {
      return "unavailable";
    }
  };
  const refuseAnonymous = async () => {
    const verdict = await anonymous();
    if (verdict === "limited") throw new ApiError("RATE_LIMITED");
    if (verdict === "unavailable") throw new RateLimitUnavailable();
  };
  return async function handle(req: Request): Promise<Response> {
    const requestId = newRequestId();
    const started = now();
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return errorResponse("INVALID_REQUEST", requestId);
    }
    if (req.method !== "GET" && req.method !== "HEAD")
      return errorResponse("METHOD_NOT_ALLOWED", requestId, { Allow: "GET" });
    const path = url.pathname.replace(/\/+$/, "") || "/";
    // Static/cached public paths: an exhausted bucket is 429; an unavailable limiter still serves
    // them (health is cached for 5 s, docs/spec are static) so outages are visible, not hidden.
    if (
      path === "/v1/health" ||
      path === "/v1/openapi.json" ||
      path === "/v1/docs"
    )
      if ((await anonymous()) === "limited")
        return errorResponse("RATE_LIMITED", requestId, {
          "Retry-After": "60",
        });
    if (path === "/v1/health") {
      if (!health || now() - health.at > 5000)
        health = { at: now(), ok: await deps.store.ping() };
      return json(
        {
          status: health.ok ? "ok" : "degraded",
          version: "v1",
          billingEnabled: false,
        },
        requestId,
      );
    }
    if (path === "/v1/openapi.json") return json(openApiDocument(), requestId);
    if (path === "/v1/docs")
      return new Response(docsPage(openApiDocument()), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": DOCS_CSP,
          "X-Content-Type-Options": "nosniff",
          "X-Request-Id": requestId,
        },
      });
    let route: Route | undefined,
      params: Record<string, string> = {};
    for (const r of ROUTES) {
      const m = r.pattern.exec(path);
      if (m) {
        route = r;
        try {
          params = Object.fromEntries(
            r.keys.flatMap((k, i) =>
              m[i + 1] === undefined ? [] : [[k, decodeURIComponent(m[i + 1])]],
            ),
          );
        } catch {
          return errorResponse("INVALID_REQUEST", requestId);
        }
        break;
      }
    }
    if (!route) return errorResponse("NOT_FOUND", requestId);
    let clientId = "anonymous",
      keyId: string | null = null,
      status = 500,
      cost = 0,
      charged = false,
      slot = false,
      limiterUnavailable = false;
    try {
      const parsed = parseKey(bearer(req));
      if (!parsed) {
        await refuseAnonymous();
        throw new ApiError("UNAUTHORIZED");
      }
      const key = await deps.store.findKey(parsed.prefix);
      if (!key) {
        dummyVerify(parsed.plaintext);
        await refuseAnonymous();
        throw new ApiError("UNAUTHORIZED");
      }
      if (
        !verifyKey(parsed.plaintext, key.verifier) ||
        key.status !== "ACTIVE"
      ) {
        await refuseAnonymous();
        throw new ApiError("UNAUTHORIZED");
      }
      const client = await deps.store.getClient(key.clientId);
      if (!client || client.status !== "ACTIVE")
        throw new ApiError("CLIENT_SUSPENDED");
      clientId = client.id;
      keyId = key.id;
      const plan = planOf(client.planId);
      const minute = await deps.limiter.consume(`api:${clientId}:m`, {
        limit: plan.requestsPerMinute,
        windowSeconds: 60,
      });
      if (!minute.allowed) throw new ApiError("RATE_LIMITED");
      if (route.scope && !client.scopes.includes(route.scope))
        throw new ApiError("SCOPE_DENIED");
      const ac = new AbortController();
      const signal = AbortSignal.any([
        ac.signal,
        req.signal,
        AbortSignal.timeout(deps.handlerTimeoutMs ?? 25000),
      ]);
      cost = route.cost({ url, params, signal, plan, clientId });
      const day = await deps.limiter.consume(`api:${clientId}:d`, {
        limit: plan.requestsPerDay,
        windowSeconds: 86400,
      });
      if (!day.allowed) throw new ApiError("QUOTA_EXCEEDED");
      const units = await deps.limiter.consume(`api:${clientId}:cu`, {
        limit: plan.costUnitsPerDay,
        windowSeconds: 86400,
        cost,
      });
      charged = true;
      if (!units.allowed) throw new ApiError("QUOTA_EXCEEDED");
      slot = await deps.store.acquireSlot(
        clientId,
        requestId,
        plan.concurrentRequests,
        30000,
      );
      if (!slot) throw new ApiError("CONCURRENCY_LIMIT");
      void deps.store.touchKey(key.id, now()).catch(() => {});
      const state = await deps.plane.state();
      const body = await route.handle(
        { url, params, signal, state, plan, clientId },
        deps,
      );
      status = 200;
      return json(body, requestId, {
        "X-Cost-Units": String(cost),
        "X-RateLimit-Remaining": String(minute.remaining),
      });
    } catch (error) {
      const code: ErrorCode =
        error instanceof ApiError
          ? error.code
          : error instanceof RateLimitUnavailable
            ? ((limiterUnavailable = true), "RATE_LIMIT_UNAVAILABLE")
            : error instanceof z.ZodError
              ? "UPSTREAM_UNAVAILABLE"
              : error instanceof Error &&
                  (error.name === "TimeoutError" || error.name === "AbortError")
                ? "TIMEOUT"
                : error instanceof Error &&
                    /^(RpcError|RoutingError)$/.test(error.name)
                  ? "UPSTREAM_UNAVAILABLE"
                  : error instanceof Error && /CONTINUATION/.test(error.message)
                    ? "INVALID_CURSOR"
                    : datastoreUnavailable(error)
                      ? "SERVICE_UNAVAILABLE"
                      : "INTERNAL";
      const response = errorResponse(
        code,
        requestId,
        code === "RATE_LIMITED" ? { "Retry-After": "60" } : {},
      );
      status = response.status;
      return response;
    } finally {
      if (slot) void deps.store.releaseSlot(requestId).catch(() => {});
      const latency = now() - started;
      metrics.inc("api_requests_total", {
        group: route.group,
        status: String(status),
        status_class: statusClass(status),
      });
      metrics.observe("api_latency_ms", { group: route.group }, latency);
      if (status === 429)
        metrics.inc("api_rate_limited_total", { group: route.group });
      if (status === 401)
        metrics.inc("api_auth_failures_total", { group: route.group });
      if (limiterUnavailable)
        metrics.inc("api_limiter_unavailable_total", { group: route.group });
      if (clientId !== "anonymous")
        void deps.store
          .recordUsage({
            clientId,
            keyId,
            at: now(),
            endpointGroup: route.group,
            status,
            costUnits: charged ? cost : 0,
            latencyBucket: latencyBucket(latency),
            requestId,
          })
          .catch(() => {});
      logEvent("api.request", {
        requestId,
        group: route.group,
        status,
        latency,
        cost: status === 200 ? cost : 0,
      });
    }
  };
}
