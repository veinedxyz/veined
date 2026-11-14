import type { Catalog, Network } from "../../routing/model";
import type {
  ChainScanHooks,
  Holding,
  PortfolioIdentity,
  PortfolioProvider,
  ScanEvidence,
} from "../../portfolio/model";
import type { ChainCoverage } from "../core/coverage";
import { effectiveTier } from "../registry/chains";
import { readMetadata, readNative, readTokenBalances } from "../balances/evm";
import { readSolana } from "../balances/solana";
import { freshPrice, usdValue, type PriceEvidence } from "../core/price";
import { walletPseudonym } from "../core/privacy";
import { suspiciousText } from "../core/sanitize";
import { fetchRoutingTokens } from "../registry/routing-tokens";
import type { DataPlane, PlaneState } from "../plane";
import type { StoredChain, TokenRow } from "../store/types";
import { verifyMulticall } from "../evm/multicall";
import { registryFor, knownAsset } from "../../assets/registry";
import type { RpcPool } from "../rpc/pool";
import { positionsForChain, receiptCoverage } from "../../portfolio/positions";
import { deployments } from "../../defi/registry";
import { sharedChainScan, walletResultEpoch } from "./chain-cache";
// V1.11: a Multicall3 is used for a curated sweep only after its runtime code hash matched (cached per chain).
// Cached per data plane (its endpoints/transport) and chain, never process-wide across planes.
const multicallChecks = new WeakMap<
  object,
  Map<string, { at: number; address: string | null }>
>();
async function verifiedMulticall(
  owner: object,
  pool: RpcPool,
  chainId: string,
  signal?: AbortSignal,
) {
  const checks = multicallChecks.get(owner) ?? new Map();
  multicallChecks.set(owner, checks);
  const hit = checks.get(chainId);
  if (hit && Date.now() - hit.at < 3600_000) return hit.address;
  const v = await verifyMulticall(pool, signal);
  checks.set(chainId, {
    at: Date.now(),
    address: v.verified ? v.address : null,
  });
  return v.verified ? v.address : null;
}
/** Curated registry contracts of a chain (exact addresses; never by symbol), with display metadata and logo. */
export function curatedUniverse(chainId: string) {
  return registryFor(chainId).filter(
    (a) =>
      !a.native && a.level !== "BLOCKED" && /^0x[0-9a-f]{40}$/.test(a.address),
  );
}
const MAX_EXTRA_TOKENS = 25;
export const ZERO = "0x0000000000000000000000000000000000000000";
const IMPLAUSIBLE = 1n << 128n;
const SOLANA = "1151111081099710";
const SOL_NATIVE = "11111111111111111111111111111111";
type PriceRead = (
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;
const priceCache = new Map<
  string,
  { at: number; prices: Map<string, PriceEvidence> }
>();
const priceInflight = new Map<string, Promise<Map<string, PriceEvidence>>>();
/** Test hook: an empty process price cache (equivalence tests compare two scans from the same starting state). */
export function clearPortfolioPriceCacheForTests() {
  priceCache.clear();
}
export interface ProviderLimits {
  tokenCandidates: number;
  metadataOnDemand: number;
  priceChains: number;
}
const DEFI_CHAINS = new Set(deployments.map((d) => d.chainId));
// Otherbridge-owned portfolio provider: vetted RPC registry + own index + own datastore.
export class SelfHostedPortfolioProvider implements PortfolioProvider {
  private state: PlaneState | undefined;
  private priceChainsUsed = 0;
  // V1.14.2: upstream price chains of this round, fixed from the accepted canonical plan order (planScan), so the
  // wave scheduling order can never change which networks are priced. Absent → first-come (V1.14.1).
  private priceAllow: Set<string> | null = null;
  private active: Set<string> | null = null;
  constructor(
    private plane: DataPlane,
    private routing: Catalog,
    private priceRead: PriceRead | null = null,
    private limits: ProviderLimits = {
      tokenCandidates: 1000,
      metadataOnDemand: 20,
      priceChains: 8,
    },
    /** V1.11: user-imported exact contracts per chain (bounded; fixed balanceOf calldata only). */
    private extraTokens: Map<string, string[]> = new Map(),
  ) {}
  capabilities() {
    return {
      ecosystems: ["EVM", "SVM"],
      fungible: true,
      native: true,
      discovery: true,
    };
  }
  status() {
    return this.state?.status ?? "UNAVAILABLE";
  }
  private async load() {
    return (this.state ??= await this.plane.state());
  }
  private scannable(s: PlaneState, c: StoredChain) {
    return (
      c.enabled && c.mainnet && (s.endpoints.get(c.chainId)?.length ?? 0) > 0
    );
  }
  async discoverActivity(identity: PortfolioIdentity) {
    const s = await this.load();
    const ids: string[] = [];
    if (identity.evm) {
      const evm = s.chains.filter(
        (c) => c.ecosystem === "EVM" && this.scannable(s, c),
      );
      const active = new Set(
        s.store ? await s.store.walletChains(identity.evm).catch(() => []) : [],
      );
      this.active = active;
      evm.sort(
        (a, b) =>
          Number(active.has(b.chainId)) - Number(active.has(a.chainId)) ||
          Number(b.routable) - Number(a.routable) ||
          (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) ||
          a.chainId.localeCompare(b.chainId),
      );
      ids.push(...evm.map((c) => c.chainId));
    }
    const sol = s.chains.find((c) => c.chainId === SOLANA);
    if (identity.solana && sol && this.scannable(s, sol)) ids.push(SOLANA);
    return ids;
  }
  async unscannable(identity: PortfolioIdentity): Promise<ChainCoverage[]> {
    const s = await this.load();
    const at = Date.now();
    return s.chains
      .filter(
        (c) =>
          c.mainnet &&
          !this.scannable(s, c) &&
          ((identity.evm && c.ecosystem === "EVM") ||
            (identity.solana && c.chainId === SOLANA)),
      )
      .map((c) => ({
        chainId: c.chainId,
        state: "CATALOG_ONLY",
        tier: "CATALOG_ONLY",
        native: "UNSUPPORTED",
        tokens: "NOT_CHECKED",
        historicalComplete: false,
        indexedFromBlock: null,
        indexedThroughBlock: null,
        headBlock: null,
        observedBlock: null,
        reason:
          s.status === "UNAVAILABLE"
            ? "DATA_PLANE_UNAVAILABLE"
            : "NO_VETTED_RPC",
        observedAt: at,
      }));
  }
  planScan(order: string[]) {
    const s = this.state;
    if (!s || !this.priceRead) return;
    const allow = new Set<string>();
    const now = Date.now();
    for (const id of order) {
      if (allow.size >= this.limits.priceChains) break;
      const c = s.chains.find((x) => x.chainId === id);
      if (!c || c.ecosystem !== "EVM" || !c.routable) continue;
      const cached = priceCache.get(id);
      if (cached && now - cached.at < 300000) continue;
      allow.add(id);
    }
    this.priceAllow = allow;
  }
  async scanEvidence(identity: PortfolioIdentity): Promise<ScanEvidence> {
    const s = await this.load();
    const routable = new Set(
      s.chains.filter((c) => c.mainnet && c.routable).map((c) => c.chainId),
    );
    return {
      indexed: identity.evm ? (this.active ?? new Set()) : new Set(),
      knownToken: new Set(
        [...this.extraTokens.entries()]
          .filter(([, list]) => list.some((t) => /^0x[0-9a-f]{40}$/.test(t)))
          .map(([id]) => id),
      ),
      highConfidence: new Set(
        [...routable].filter(
          (id) =>
            DEFI_CHAINS.has(id) ||
            positionsForChain(id).length > 0 ||
            curatedUniverse(id).length > 0,
        ),
      ),
      routable,
    };
  }
  operatorGroup(chainId: string) {
    const [primary] = [...(this.state?.endpoints.get(chainId) ?? [])].sort(
      (a, b) => a.priority - b.priority,
    );
    return primary?.operatorGroup ?? undefined;
  }
  describe(chainId: string): Network | undefined {
    const routed = this.routing.networks.find(
      (n) => n.id === chainId && n.mainnet,
    );
    if (routed) return routed;
    const c = this.state?.chains.find((x) => x.chainId === chainId);
    if (!c || (c.ecosystem !== "EVM" && c.ecosystem !== "SVM"))
      return undefined;
    return {
      id: c.chainId,
      key: `chain-${c.chainId}`,
      name: c.name,
      ecosystem: c.ecosystem,
      mainnet: true,
      nativeAsset: {
        chainId: c.chainId,
        address: c.ecosystem === "SVM" ? SOL_NATIVE : ZERO,
        symbol: c.native.symbol,
        name: c.native.name,
        decimals: c.ecosystem === "EVM" ? 18 : c.native.decimals,
      },
      provider: "otherbridge-data",
      theme: {
        logo: "/networks/neutral.svg",
        primary: "#90938d",
        accent: "#b7baaf",
        glow: "144 147 141",
        badgeDark: "#d0d1cc",
        badgeLight: "#43453f",
        logoSurface: "transparent",
        provenance: "Neutral geometry; reviewed asset unavailable",
      },
    };
  }
  async getBalances(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    return (await this.scanChain(network, identity, signal)).holdings;
  }
  async getNativeBalance(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    return (await this.scanChain(network, identity, signal)).holdings.filter(
      (h) => h.native,
    );
  }
  private async prices(
    chain: StoredChain,
    signal?: AbortSignal,
  ): Promise<Map<string, PriceEvidence>> {
    const cached = priceCache.get(chain.chainId);
    if (cached && Date.now() - cached.at < 300000) return cached.prices;
    if (
      !this.priceRead ||
      !chain.routable ||
      (this.priceAllow
        ? !this.priceAllow.has(chain.chainId)
        : this.priceChainsUsed >= this.limits.priceChains)
    )
      return new Map();
    this.priceChainsUsed++;
    let inflight = priceInflight.get(chain.chainId);
    if (!inflight) {
      inflight = fetchRoutingTokens(this.priceRead, [chain.chainId], signal)
        .then(
          (m) =>
            new Map(
              (m.get(chain.chainId) ?? []).map((t) => [t.address, t.price]),
            ),
        )
        .catch(() => new Map<string, PriceEvidence>())
        .finally(() => priceInflight.delete(chain.chainId));
      priceInflight.set(chain.chainId, inflight);
    }
    const prices = await inflight;
    if (prices.size) {
      priceCache.set(chain.chainId, { at: Date.now(), prices });
      if (priceCache.size > 200)
        priceCache.delete(priceCache.keys().next().value!);
    }
    return prices;
  }
  async scanChain(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
    hooks?: ChainScanHooks,
  ) {
    const s = await this.load();
    const chain = s.chains.find((c) => c.chainId === network.id);
    const pool = chain ? this.plane.pool(s, chain.chainId) : null;
    if (!chain || !pool) throw Error("NO_VETTED_RPC");
    const read = (readSignal?: AbortSignal, onNative?: (h: Holding) => void) =>
      chain.ecosystem === "SVM"
        ? this.scanSolana(s, chain, network, pool, identity, readSignal)
        : this.scanEvm(s, chain, network, pool, identity, readSignal, onNative);
    const address = chain.ecosystem === "SVM" ? identity.solana : identity.evm;
    if (!hooks || !address) return read(signal);
    // V1.14.2 single-flight + very short result cache, keyed by the wallet pseudonym (never the address), chain, the
    // exact read set (imported contracts, price eligibility) and the result epoch; failures are never cached.
    const cached = priceCache.get(chain.chainId);
    const priced =
      !!this.priceRead &&
      chain.routable &&
      ((!!cached && Date.now() - cached.at < 300000) ||
        (this.priceAllow?.has(chain.chainId) ?? false));
    const key = JSON.stringify([
      walletPseudonym(address),
      chain.chainId,
      [...(this.extraTokens.get(chain.chainId) ?? [])].sort(),
      priced,
      walletResultEpoch(),
    ]);
    return sharedChainScan(
      this.plane,
      key,
      (readSignal, shared) => read(readSignal, shared.onNative),
      {
        timeoutMs: hooks.timeoutMs ?? 8000,
        signal,
        hooks: { onNative: hooks.onNative },
        fresh: hooks.fresh,
      },
    );
  }
  private async scanEvm(
    s: PlaneState,
    chain: StoredChain,
    network: Network,
    pool: NonNullable<ReturnType<DataPlane["pool"]>>,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
    onNative?: (holding: Holding) => void,
  ) {
    const wallet = identity.evm;
    if (!wallet) throw Error("ADDRESS_MISSING");
    // Price evidence is requested before balances so it never post-dates the balance observation.
    const pricing = this.prices(chain, signal).catch(
      () => new Map<string, PriceEvidence>(),
    );
    let early: Map<string, PriceEvidence> | undefined;
    void pricing.then((m) => (early = m));
    const native = await readNative(pool, wallet, signal);
    // No native supply fits 2^128 base units; such values are RPC sentinels (e.g. gasless chains).
    const plausibleNative = native.balance < IMPLAUSIBLE;
    // V1.14.2 native fast path: the one native read of this chain, streamed as soon as it is a confirmed nonzero
    // balance (provisional: the chain's complete result replaces it). Priced only when price evidence is already in.
    if (onNative && plausibleNative && native.balance > 0n) {
      const price =
        early?.get(ZERO) ??
        early?.get(network.nativeAsset.address.toLowerCase());
      const fresh = freshPrice(price, Date.now());
      const usd = fresh === null ? null : usdValue(native.balance, 18, fresh);
      onNative({
        chainId: chain.chainId,
        address: network.nativeAsset.address,
        symbol: network.nativeAsset.symbol.slice(0, 32) || "?",
        name: network.nativeAsset.name.slice(0, 120),
        decimals: 18,
        balance: native.balance.toString(),
        native: true,
        spam: false,
        suspicious: false,
        usd: usd === null ? null : Number(usd),
        priceAt: usd === null ? null : (price?.observedAt ?? null),
        observedAt: native.observedAt,
        logo: "/networks/neutral.svg",
        lastActivity: null,
        observedBlock: native.block.toString(),
        discovery: "native",
        metadataVerified: true,
        ...(price ? { price } : {}),
      });
    }
    const endpoints = s.endpoints.get(chain.chainId) ?? [];
    const cp = s.checkpoints.get(chain.chainId);
    const indexStarted = !!cp && cp.indexedThroughBlock >= cp.indexedFromBlock;
    let tier = effectiveTier(chain, {
      healthyRpc: true,
      logs: endpoints.some((e) => e.supportsLogs),
      tokenUniverse: (s.tokenCounts.get(chain.chainId) ?? 0) > 0,
      indexStarted,
    });
    // V1.11: no index and no token universe, but curated registry contracts and a verified Multicall3 → an exact
    // balanceOf sweep of the curated set (CURATED_BALANCE_SCAN). Without a verified Multicall3 it stays native-only.
    const curated = curatedUniverse(chain.chainId);
    const receipts = positionsForChain(chain.chainId);
    const extra = (this.extraTokens.get(chain.chainId) ?? [])
      .filter((t) => /^0x[0-9a-f]{40}$/.test(t))
      .slice(0, MAX_EXTRA_TOKENS);
    let sweepMulticall: string | null = chain.multicall;
    if (tier === "NATIVE_ONLY" && (curated.length || extra.length)) {
      sweepMulticall = await verifiedMulticall(
        this.plane,
        pool,
        chain.chainId,
        signal,
      ).catch(() => null);
      if (sweepMulticall) tier = "CURATED_BALANCE_SCAN";
    }
    const lagLimit = BigInt(Math.max(64, chain.finality.depth * 2 + 16));
    // A paused (consensus-unresolved) index is never presented as current.
    const indexCurrent =
      indexStarted &&
      !!cp &&
      !cp.haltedReason &&
      native.block - cp.indexedThroughBlock <= lagLimit;
    const store = s.store;
    const discovered =
      tier === "FULL_INDEXED" && store
        ? await store.discoveredTokens(chain.chainId, wallet)
        : [];
    const storeUniverse =
      tier === "FULL_INDEXED" || tier === "ON_DEMAND_FUNGIBLE"
        ? store
          ? await store.tokenUniverse(
              chain.chainId,
              this.limits.tokenCandidates,
            )
          : []
        : [];
    // V1.11 additional discovery, deduplicated by chain + exact contract: the store/routing universe, the curated
    // registry and the user's imported contracts (for every fungible tier).
    const universe =
      tier === "NATIVE_ONLY" || tier === "CATALOG_ONLY"
        ? receipts.map((p) => p.address)
        : [
            ...new Set([
              ...receipts.map((p) => p.address),
              ...storeUniverse,
              ...curated.map((a) => a.address),
              ...extra,
            ]),
          ];
    // Routable tokens first; indexed-only (possibly hostile airdrop) tokens last in their own batches.
    const universeSet = new Set(universe);
    const indexedOnly = discovered
      .map((d) => d.token)
      .filter((t) => !universeSet.has(t) && t !== ZERO);
    const routedFirst = universe.filter((t) => t !== ZERO);
    const reservedForIndexed = Math.min(indexedOnly.length, 200);
    const bounded = [
      ...routedFirst.slice(0, this.limits.tokenCandidates - reservedForIndexed),
      ...indexedOnly.slice(0, reservedForIndexed),
    ];
    const candidates = [...routedFirst, ...indexedOnly];
    const { reads, unchecked } = bounded.length
      ? await readTokenBalances(
          pool,
          wallet,
          bounded,
          native.block,
          tier === "CURATED_BALANCE_SCAN" ? sweepMulticall : chain.multicall,
          signal,
        )
      : { reads: [], unchecked: [] as string[] };
    const failedReads = reads.filter((r) => r.balance === null).length;
    const overflow = candidates.length - bounded.length + unchecked.length;
    const tokenReadIncomplete = overflow > 0 || failedReads > 0;
    const tokenReadFailed =
      bounded.length > 0 && reads.every((r) => r.balance === null);
    const nonzero = reads.filter((r) => r.balance !== null && r.balance > 0n);
    const known = new Map<string, TokenRow>(
      (store
        ? await store.getTokens(chain.chainId, [
            ZERO,
            ...nonzero.map((r) => r.token),
          ])
        : []
      ).map((t) => [t.address, t]),
    );
    // Curated registry metadata (exact contract) fills what the store does not know; curated tokens are
    // route-supported by construction, so they count as routing-catalog tokens for the impersonation guard.
    const curatedByAddress = new Map(curated.map((a) => [a.address, a]));
    for (const p of receipts)
      if (nonzero.some((r) => r.token === p.address)) {
        known.set(p.address, {
          chainId: chain.chainId,
          address: p.address,
          symbol: p.symbol,
          name: `${p.protocol} · ${p.symbol}`,
          decimals: p.decimals,
          metadataStatus: "OK",
          sources: ["protocol-receipt"],
          suspicious: false,
          spam: false,
          price: known.get(p.address)?.price ?? null,
        });
      }
    for (const r of nonzero) {
      const c = curatedByAddress.get(r.token);
      if (!c || known.get(r.token)?.decimals != null) continue;
      known.set(r.token, {
        chainId: chain.chainId,
        address: r.token,
        symbol: c.symbol,
        name: c.name,
        decimals: c.decimals,
        metadataStatus: "OK",
        sources: [
          "otherbridge-curated",
          ...(c.level === "CURATED" || c.level === "CANONICAL"
            ? ["routing-catalog"]
            : []),
        ],
        suspicious: c.risk.length > 0,
        spam: false,
        price: null,
      });
    }
    const missing = nonzero
      .filter((r) => known.get(r.token)?.decimals == null)
      .map((r) => r.token);
    if (missing.length) {
      const meta = await readMetadata(
        pool,
        missing.slice(0, this.limits.metadataOnDemand),
        chain.multicall,
        signal,
      );
      for (const m of meta)
        known.set(m.token, {
          chainId: chain.chainId,
          address: m.token,
          symbol: m.symbol,
          name: m.name,
          decimals: m.decimals,
          metadataStatus: m.decimals !== null && m.symbol ? "OK" : "PARTIAL",
          sources: [...(known.get(m.token)?.sources ?? []), "indexed"],
          suspicious: m.suspicious,
          spam: false,
          price: known.get(m.token)?.price ?? null,
        });
      if (store)
        await store
          .upsertTokens(
            meta.map((m) => ({
              chainId: chain.chainId,
              address: m.token,
              symbol: m.symbol,
              name: m.name,
              decimals: m.decimals,
              suspicious: m.suspicious,
              metadataStatus:
                m.decimals !== null && m.symbol
                  ? "OK"
                  : m.decimals !== null
                    ? "PARTIAL"
                    : "FAILED",
              sources: [],
            })),
          )
          .catch(() => {});
    }
    const live = await pricing;
    const at = Date.now();
    const holding = (
      address: string,
      balance: bigint,
      decimals: number,
      symbol: string,
      name: string,
      extra: Partial<Holding>,
      price: PriceEvidence | undefined,
    ): Holding => {
      const fresh = freshPrice(price, at);
      const usd = fresh === null ? null : usdValue(balance, decimals, fresh);
      return {
        chainId: chain.chainId,
        address,
        symbol: symbol.slice(0, 32) || "?",
        name: name.slice(0, 120),
        decimals,
        balance: balance.toString(),
        native: false,
        spam: false,
        suspicious: false,
        usd: usd === null ? null : Number(usd),
        priceAt: usd === null ? null : (price?.observedAt ?? null),
        observedAt: native.observedAt,
        // Sanitized same-origin logo from the curated registry (exact contract), else the neutral mark.
        logo:
          curatedByAddress.get(address.toLowerCase())?.logo?.src ??
          receipts.find((p) => p.address === address.toLowerCase())?.logo ??
          "/networks/neutral.svg",
        lastActivity: null,
        observedBlock: native.block.toString(),
        ...(price ? { price } : {}),
        ...extra,
      };
    };
    const holdings: Holding[] = [];
    if (plausibleNative)
      holdings.push(
        holding(
          network.nativeAsset.address,
          native.balance,
          18,
          network.nativeAsset.symbol,
          network.nativeAsset.name,
          { native: true, discovery: "native", metadataVerified: true },
          live.get(ZERO) ??
            live.get(network.nativeAsset.address.toLowerCase()) ??
            known.get(ZERO)?.price ??
            undefined,
        ),
      );
    const indexedSet = new Set(discovered.map((d) => d.token));
    // Impersonation guard: an unrouted token reusing a routed (or the native) symbol is suspicious.
    const unroutedSymbols = nonzero
      .map((r) => known.get(r.token))
      .filter(
        (m): m is TokenRow =>
          !!m?.symbol && !m.sources.includes("routing-catalog"),
      )
      .map((m) => m.symbol!.toUpperCase());
    const collisions =
      store && unroutedSymbols.length
        ? await store
            .routedSymbols(chain.chainId, unroutedSymbols)
            .catch(() => new Set<string>())
        : new Set<string>();
    for (const r of nonzero) {
      const meta = known.get(r.token);
      // ERC20 mirror of the native asset (e.g. Metis/Celo) with the same balance is the same value.
      if (
        plausibleNative &&
        r.balance === native.balance &&
        meta?.symbol?.toUpperCase() === network.nativeAsset.symbol.toUpperCase()
      )
        continue;
      const routed = meta?.sources.includes("routing-catalog") ?? false;
      const impersonation =
        !routed &&
        !!meta?.symbol &&
        (collisions.has(meta.symbol.toUpperCase()) ||
          meta.symbol.toUpperCase() ===
            network.nativeAsset.symbol.toUpperCase());
      const suspicious =
        !!meta?.suspicious ||
        !meta?.symbol ||
        impersonation ||
        suspiciousText(meta?.symbol ?? "", meta?.name ?? "");
      holdings.push(
        holding(
          r.token,
          r.balance!,
          meta?.decimals ?? 0,
          meta?.symbol ?? "?",
          meta?.name ?? "",
          {
            discovery: indexedSet.has(r.token)
              ? "indexed"
              : curatedByAddress.has(r.token)
                ? "curated"
                : extra.includes(r.token)
                  ? "imported"
                  : "known-token",
            suspicious,
            spam: !!meta?.spam || (!routed && suspicious),
            metadataVerified: meta?.decimals != null,
            routable: routed,
          },
          live.get(r.token) ?? meta?.price ?? undefined,
        ),
      );
    }
    if (store && plausibleNative) {
      const pseudonym = walletPseudonym(wallet);
      void store
        .recordBalanceSnapshot(
          pseudonym,
          chain.chainId,
          null,
          native.balance,
          native.block,
          native.observedAt,
        )
        .catch(() => {});
    }
    const tierTokens: ChainCoverage["tokens"] =
      tier === "FULL_INDEXED"
        ? indexCurrent
          ? "INDEXED"
          : "KNOWN_TOKENS"
        : tier === "ON_DEMAND_FUNGIBLE"
          ? "KNOWN_TOKENS"
          : tier === "CURATED_BALANCE_SCAN"
            ? "CURATED"
            : "NOT_CHECKED";
    // A token phase whose reads all failed is FAILED, never "checked and empty".
    const tokens: ChainCoverage["tokens"] =
      tierTokens !== "NOT_CHECKED" && tokenReadFailed ? "FAILED" : tierTokens;
    const state: ChainCoverage["state"] =
      !plausibleNative && (tokens === "NOT_CHECKED" || tokens === "FAILED")
        ? "FAILED"
        : tier === "NATIVE_ONLY"
          ? "NATIVE_ONLY"
          : tier === "FULL_INDEXED" && !indexCurrent
            ? "INDEXING"
            : tier === "FULL_INDEXED" &&
                cp?.historicalComplete &&
                !tokenReadIncomplete
              ? "COMPLETE"
              : "PARTIAL";
    const coverage: ChainCoverage = {
      chainId: chain.chainId,
      state,
      tier,
      native: plausibleNative ? "CHECKED" : "UNSUPPORTED",
      tokens,
      historicalComplete:
        tier === "FULL_INDEXED" && !!cp?.historicalComplete && indexCurrent,
      indexedFromBlock: cp ? cp.indexedFromBlock.toString() : null,
      indexedThroughBlock:
        cp && indexStarted ? cp.indexedThroughBlock.toString() : null,
      headBlock: native.block.toString(),
      observedBlock: native.block.toString(),
      reason: !plausibleNative
        ? "IMPLAUSIBLE_BALANCE"
        : tokens !== "NOT_CHECKED" && tokenReadIncomplete
          ? "TOKEN_READ_INCOMPLETE"
          : tier === "FULL_INDEXED" && !indexCurrent
            ? indexStarted
              ? "INDEX_LAGGING"
              : "INDEX_NOT_STARTED"
            : "NONE",
      observedAt: at,
    };
    return {
      holdings,
      coverage,
      defiCoverage: receiptCoverage(
        chain.chainId,
        reads,
        native.observedAt,
        native.block.toString(),
      ),
    };
  }
  private async scanSolana(
    s: PlaneState,
    chain: StoredChain,
    network: Network,
    pool: NonNullable<ReturnType<DataPlane["pool"]>>,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    if (!identity.solana) throw Error("ADDRESS_MISSING");
    const result = await readSolana(pool, identity.solana, signal);
    const known = new Map<string, TokenRow>(
      (s.store
        ? await s.store.getTokens(
            chain.chainId,
            result.tokens.map((t) => t.mint),
          )
        : []
      ).map((t) => [t.address, t]),
    );
    const base = {
      chainId: chain.chainId,
      native: false,
      spam: false,
      usd: null,
      priceAt: null,
      observedAt: result.observedAt,
      logo: "/networks/neutral.svg" as const,
      lastActivity: null,
      observedBlock: result.slot.toString(),
    };
    const holdings: Holding[] = [
      {
        ...base,
        address: network.nativeAsset.address || SOL_NATIVE,
        symbol: network.nativeAsset.symbol || "SOL",
        name: network.nativeAsset.name || "",
        decimals: 9,
        balance: result.lamports.toString(),
        native: true,
        suspicious: false,
        discovery: "native",
        metadataVerified: true,
      },
      ...result.tokens
        .filter((t) => t.amount > 0n)
        .map((t) => {
          const meta = known.get(t.mint);
          const exact = knownAsset(chain.chainId, t.mint);
          const registered =
            exact &&
            (exact.level === "CURATED" || exact.level === "CANONICAL") &&
            exact.risk.length === 0 &&
            exact.decimals === t.decimals
              ? exact
              : null;
          return {
            ...base,
            address: t.mint,
            symbol: meta?.symbol ?? registered?.symbol ?? "?",
            name: meta?.name ?? registered?.name ?? "",
            logo: registered?.logo?.src ?? base.logo,
            decimals: t.decimals,
            balance: t.amount.toString(),
            suspicious: !meta && !registered,
            spam: false,
            discovery: "enumerated" as const,
            metadataVerified: !!meta || !!registered,
          };
        }),
    ];
    const coverage: ChainCoverage = {
      chainId: chain.chainId,
      state: "COMPLETE",
      tier: "ON_DEMAND_FUNGIBLE",
      native: "CHECKED",
      tokens: "ENUMERATED",
      historicalComplete: false,
      indexedFromBlock: null,
      indexedThroughBlock: null,
      headBlock: result.slot.toString(),
      observedBlock: result.slot.toString(),
      reason: "NONE",
      observedAt: Date.now(),
    };
    return { holdings, coverage };
  }
}
