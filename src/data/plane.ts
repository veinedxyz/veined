import { z } from "zod";
import { buildRegistry, type ChainRecord } from "./registry/chains";
import snapshot from "./registry/rpc-registry.snapshot.json" with { type: "json" };
import activeSnapshot from "../catalog/snapshot.json" with { type: "json" };
import routingSnapshot from "../routing/catalog-snapshot.json" with { type: "json" };
import { normalizeChains } from "../routing/catalog";
import { httpsTransport, type RpcTransport } from "./rpc/transport";
import { RpcPool, type ApprovedEndpoint } from "./rpc/pool";
import type { EndpointHealth } from "./rpc/health";
import type {
  Checkpoint,
  DataStore,
  StoredChain,
  WitnessSummary,
} from "./store/types";
import { dataConfig } from "./config";
import {
  profileAllows,
  provenanceForUrl,
  registryProfile,
  type EndpointProvenance,
  type RegistryProfile,
} from "./registry/rpc-provenance";
export interface PlaneState {
  at: number;
  chains: StoredChain[];
  endpoints: Map<string, ApprovedEndpoint[]>;
  checkpoints: Map<string, Checkpoint>;
  tokenCounts: Map<string, number>;
  // V1.5 per-indexed-chain witness summaries (absent => treated as unwitnessed).
  witness?: Map<string, WitnessSummary>;
  status: "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  store: DataStore | null;
}
const endpointSchema = z
  .object({
    id: z.string().max(400),
    chainId: z.string().regex(/^\d{1,18}$/),
    url: z.string().max(300),
    allowPort: z.boolean().optional(),
    priority: z.number().int(),
    supportsLogs: z.boolean(),
    maxLogRange: z.number().int().nonnegative(),
    supportsBatch: z.boolean(),
    supportsFinalized: z.boolean(),
    supportsSafe: z.boolean(),
    archive: z.boolean(),
  })
  .strict();
export const registrySnapshotSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().nullable(),
    note: z.string().max(500).optional(),
    endpoints: z.array(endpointSchema).max(5000),
    multicall: z.record(
      z.string().regex(/^\d{1,18}$/),
      z.string().regex(/^0x[0-9a-f]{40}$/),
    ),
  })
  .strict();
// Registry used when the datastore is unavailable: accepted catalogs + committed admitted endpoints.
export function fallbackRegistry() {
  const routing = normalizeChains(
    (routingSnapshot as { chains: unknown }).chains,
  );
  const active = (
    activeSnapshot as {
      raw: {
        name?: unknown;
        chainId?: unknown;
        tvl?: unknown;
        tokenSymbol?: unknown;
        gasTokenGeckoId?: unknown;
      }[];
    }
  ).raw
    .filter(
      (r) =>
        typeof r.tvl === "number" && r.tvl > 0 && typeof r.name === "string",
    )
    .map((r) => ({
      name: String(r.name).slice(0, 120),
      chainId:
        r.chainId == null || !/^\d{1,18}$/.test(String(r.chainId))
          ? null
          : String(r.chainId),
      tvlUsd: Number(r.tvl),
      symbol: typeof r.tokenSymbol === "string" ? r.tokenSymbol : null,
      gasToken:
        typeof r.gasTokenGeckoId === "string" ? r.gasTokenGeckoId : null,
    }));
  const chains = buildRegistry(routing, active);
  const parsed = registrySnapshotSchema.parse(snapshot);
  return {
    chains,
    routing,
    endpoints: parsed.endpoints as ApprovedEndpoint[],
    multicall: parsed.multicall,
  };
}
function group(endpoints: ApprovedEndpoint[]) {
  const out = new Map<string, ApprovedEndpoint[]>();
  for (const e of endpoints)
    out.set(e.chainId, [...(out.get(e.chainId) ?? []), e]);
  return out;
}
export type ProvenanceResolver = (url: string) => EndpointProvenance;
// V1.5: every admitted endpoint carries its operator group / review status; the deployment profile
// removes endpoints its policy does not allow (release: legally approved only; never PROHIBITED).
export function annotateEndpoints(
  endpoints: ApprovedEndpoint[],
  resolve: ProvenanceResolver,
  profile: RegistryProfile,
) {
  const out: ApprovedEndpoint[] = [];
  for (const e of endpoints) {
    const p = resolve(e.url);
    if (!profileAllows(profile, p)) continue;
    out.push({
      ...e,
      operatorGroup: p.operatorGroup,
      witnessEligible: p.witnessEligible,
      reviewStatus: p.reviewStatus,
    });
  }
  return out;
}
export class DataPlane {
  readonly health = new Map<string, EndpointHealth>();
  private cached: PlaneState | undefined;
  private loading: Promise<PlaneState> | undefined;
  private healthLoaded = false;
  readonly profile: RegistryProfile;
  constructor(
    readonly store: DataStore | null,
    readonly transport: RpcTransport = httpsTransport,
    private ttlMs = 60000,
    private fallback = fallbackRegistry,
    private provenance: ProvenanceResolver = provenanceForUrl,
    profile?: RegistryProfile,
  ) {
    this.profile = profile ?? registryProfile().profile;
  }
  async state(): Promise<PlaneState> {
    if (this.cached && Date.now() - this.cached.at < this.ttlMs)
      return this.cached;
    if (this.loading) return this.loading;
    this.loading = this.load().finally(() => (this.loading = undefined));
    return (this.cached = await this.loading);
  }
  invalidate() {
    this.cached = undefined;
  }
  private async load(): Promise<PlaneState> {
    const at = Date.now();
    if (this.store && (await this.store.ping())) {
      try {
        let chains = await this.store.listChains();
        const endpoints = group(
          annotateEndpoints(
            await this.store.listEndpoints(),
            this.provenance,
            this.profile,
          ),
        );
        if (!chains.length) chains = this.fromFallback().chains;
        if (!this.healthLoaded) {
          for (const [id, h] of await this.store.loadHealth())
            if (!this.health.has(id)) this.health.set(id, h);
          this.healthLoaded = true;
        }
        const checkpoints = new Map(
          (await this.store.listCheckpoints()).map((c) => [c.chainId, c]),
        );
        const witness = new Map<string, WitnessSummary>();
        for (const id of checkpoints.keys())
          try {
            witness.set(id, await this.store.witnessSummary(id));
          } catch {
            /* Missing summary => reported as unwitnessed, never as verified. */
          }
        return {
          at,
          chains,
          endpoints,
          checkpoints,
          witness,
          tokenCounts: await this.store.tokenCounts(),
          status: endpoints.size ? "AVAILABLE" : "DEGRADED",
          store: this.store,
        };
      } catch {
        /* Datastore error: fall through to the committed registry, reported as DEGRADED. */
      }
    }
    const f = this.fromFallback();
    const fallbackEndpoints = annotateEndpoints(
      f.endpoints,
      this.provenance,
      this.profile,
    );
    return {
      at,
      chains: f.chains,
      endpoints: group(fallbackEndpoints),
      checkpoints: new Map(),
      tokenCounts: new Map(),
      status: fallbackEndpoints.length ? "DEGRADED" : "UNAVAILABLE",
      store: null,
    };
  }
  private fromFallback() {
    const f = this.fallback();
    const chains: StoredChain[] = f.chains.map((c: ChainRecord) => ({
      ...c,
      multicall: f.multicall[c.chainId] ?? null,
      multicallVerifiedAt: f.multicall[c.chainId] ? 0 : null,
    }));
    return { chains, endpoints: f.endpoints };
  }
  pool(state: PlaneState, chainId: string): RpcPool | null {
    const chain = state.chains.find((c) => c.chainId === chainId);
    const endpoints = state.endpoints.get(chainId) ?? [];
    if (
      !chain ||
      !endpoints.length ||
      (chain.ecosystem !== "EVM" && chain.ecosystem !== "SVM")
    )
      return null;
    return new RpcPool(
      chainId,
      {
        ecosystem: chain.ecosystem,
        multicall: chain.multicall,
        maxLogRange: 10001,
      },
      endpoints,
      this.transport,
      this.health,
    );
  }
}
// Catalog-facing portfolio capability per chain from the current effective tiers.
export async function portfolioCapabilities(plane: DataPlane) {
  const { effectiveTier } = await import("./registry/chains");
  const state = await plane.state();
  const out = new Map<string, "full" | "native-only" | "unsupported">();
  for (const c of state.chains) {
    const endpoints = state.endpoints.get(c.chainId) ?? [];
    const cp = state.checkpoints.get(c.chainId);
    const tier = effectiveTier(c, {
      healthyRpc: endpoints.length > 0,
      logs: endpoints.some((e) => e.supportsLogs),
      tokenUniverse: (state.tokenCounts.get(c.chainId) ?? 0) > 0,
      indexStarted: !!cp && cp.indexedThroughBlock >= cp.indexedFromBlock,
    });
    out.set(
      c.chainId,
      tier === "FULL_INDEXED" || tier === "ON_DEMAND_FUNGIBLE"
        ? "full"
        : tier === "NATIVE_ONLY"
          ? "native-only"
          : "unsupported",
    );
  }
  return out;
}
let shared: DataPlane | undefined;
// One process-wide plane for the app server; the datastore is optional and never required for UI.
export async function getDataPlane(): Promise<DataPlane> {
  if (shared) return shared;
  const config = dataConfig();
  let store: DataStore | null = null;
  if (config.databaseUrl) {
    const { connect, PostgresStore } = await import("./store/postgres");
    store = new PostgresStore(
      connect(config.databaseUrl, { max: 5, application: "otherbridge-app" }),
    );
  }
  return (shared = new DataPlane(store));
}
export function setDataPlaneForTests(plane: DataPlane | undefined) {
  shared = plane;
}
