import { randomUUID } from "node:crypto";
import type { DataPlane } from "../data/plane";
import { PostgresStore } from "../data/store/postgres";
import { fetchRoutingTokens } from "../data/registry/routing-tokens";
import { registry } from "../data/observability/metrics";
import { walletPseudonym } from "../data/core/privacy";
import { deployments } from "./registry";
import {
  addressSchema,
  scanSchema,
  type DefiScan,
  type DeploymentCoverage,
  type ProtocolDeployment,
} from "./model";
import { DefiReader, PinVerifier, pinChain, type BlockPin } from "./reader";
import { RpcError } from "../data/rpc/transport";
import {
  adapterFor,
  ADAPTER_VERSION,
  RECEIPT_FAMILIES,
  type AdapterContext,
} from "./adapters";
import { PostgresDefiStore, type DiscoveryStore } from "./store";
import { buildReverseIndex, ReverseIndex } from "./reverse-index";
import type { DefiPosition, PositionRef, ScanReceipt } from "./model";
import { economicAssets } from "./economic";
import type { CatalogIndex } from "./universe/store";
type Signal = NonNullable<DeploymentCoverage["signal"]>;
// V1.14 candidate-driven scanning: only reviewed deployments run, ordered by evidence that the wallet may hold a
// position (an exact held receipt/debt/vault token first). Nothing in the catalog is RPC-scanned by default.
const FAMILY_SIGNAL: Record<string, Signal> = {
  "lst-rate": "ACCOUNT_LOOKUP",
  eigenlayer: "ACCOUNT_LOOKUP",
  curve: "RECEIPT_TOKEN",
  "balancer-v2": "RECEIPT_TOKEN",
  "solidly-v2": "RECEIPT_TOKEN",
  "aave-v3": "ACCOUNT_LOOKUP",
  "compound-iii": "ACCOUNT_LOOKUP",
  lido: "ACCOUNT_LOOKUP",
  erc4626: "ACCOUNT_LOOKUP",
  "uniswap-v3": "POSITION_NFT",
  "morpho-blue": "INDEXED_ACTIVITY",
  "morpho-vault": "INDEXED_ACTIVITY",
  "uniswap-v2": "INDEXED_ACTIVITY",
};
// Families whose complete registry lanes are prefiltered with batched exact reads (larger, still bounded budget).
const REGISTRY_FAMILIES = new Set(["morpho-blue", "morpho-vault"]);
const POSITION_READ_CONCURRENCY = 4;
// V1.14.1 candidate confidence tiers: scheduling priority only (never position truth). Every candidate of the scope
// is still scheduled; higher-confidence evidence that the wallet holds a position runs first.
export const CANDIDATE_TIERS = [
  "EXACT_HELD_RECEIPT",
  "EXACT_POSITION_NFT",
  "EXACT_ACTIVE_INTERACTION",
  "EXACT_PROTOCOL_ACCOUNT",
  "HISTORICAL_INTERACTION",
  "BOUNDED_FALLBACK_PROBE",
] as const;
export type CandidateTier = (typeof CANDIDATE_TIERS)[number];
const ACCOUNT_FAMILIES = new Set([
  "aave-v3",
  "compound-iii",
  "lido",
  "lst-rate",
  "eigenlayer",
  "erc4626",
  "uniswap-v3",
]);
// The chain's native coin is never a contract (zero address / 0xeeee… convention): never a receipt candidate.
const NATIVE_IDS = /:0x(0{40}|e{40})$/;
let reverse: ReverseIndex | undefined;
export const reverseIndex = () =>
  (reverse ??= new ReverseIndex(buildReverseIndex(deployments)));
const heldSchema = /^\d{1,20}:0x[0-9a-f]{40}$/;
export interface ScanOptions {
  chains?: string[];
  deploymentIds?: string[];
  clientScope?: string;
  signal?: AbortSignal;
  maxDeployments?: number;
  deadlineMs?: number;
  perAdapterMs?: number;
  store?: DiscoveryStore;
  priceRead?: Parameters<typeof fetchRoutingTokens>[0];
  readerFactory?: (
    d: ProtocolDeployment,
    wallet: string,
    pin: BlockPin,
    signal: AbortSignal,
  ) => AdapterContext;
  pinFactory?: (chainId: string, signal: AbortSignal) => Promise<BlockPin>;
  onProgress?: (coverage: DeploymentCoverage) => void;
  /** V1.14.1 progressive result: one deployment's coverage, positions and replaced wallet assets as soon as it ends. */
  onResult?: (part: {
    coverage: DeploymentCoverage;
    positions: DefiPosition[];
    replaced: string[];
  }) => void;
  /** Exact held asset ids (chainId:contract) used only to order/admit candidates; values are always read on-chain. */
  held?: string[];
  /** Accepted catalog for the funnel counts; null disables catalog counts (never fetched upstream). */
  catalog?: (() => Promise<CatalogIndex | null>) | null;
}
const inflight = new Map<string, Promise<DefiScan>>(),
  cache = new Map<string, { at: number; value: DefiScan }>(),
  circuits = new Map<string, { failures: number; until: number }>();
// Bound even an uncooperative transport; late results cannot publish into a scan. V1.14.1: the work promise is always
// observed, so a read that fails after the deadline can never become an unhandled rejection.
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  work.catch(() => {});
  return new Promise((resolve, reject) => {
    const abort = () => reject(Error("SCAN_TIMEOUT"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function clearScanStateForTests() {
  inflight.clear();
  cache.clear();
  circuits.clear();
}
export function scanDefi(
  walletRaw: string,
  plane: DataPlane,
  options: ScanOptions = {},
): Promise<DefiScan> {
  const wallet = addressSchema.parse(walletRaw.toLowerCase());
  if (options.chains?.length === 0 || options.deploymentIds?.length === 0)
    throw Error("EMPTY_SCOPE");
  const key = walletPseudonym(
    JSON.stringify([
      options.clientScope ?? "app",
      wallet,
      [...(options.chains ?? [])].sort(),
      [...(options.deploymentIds ?? [])].sort(),
      options.maxDeployments ?? 6,
      [...(options.held ?? [])].sort(),
    ]),
  );
  const cached = cache.get(key);
  if (!options.readerFactory && cached && Date.now() - cached.at < 30000)
    return Promise.resolve(cached.value);
  const existing = inflight.get(key);
  if (existing) return existing;
  const work = run(wallet, plane, options)
    .then((value) => {
      if (
        !options.readerFactory &&
        !value.coverage.some(
          (c) => c.state === "FAILED" || c.state === "PENDING",
        )
      ) {
        cache.set(key, { at: Date.now(), value });
        if (cache.size > 128) cache.delete(cache.keys().next().value!);
      }
      return value;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, work);
  return work;
}
async function run(
  wallet: string,
  plane: DataPlane,
  o: ScanOptions,
): Promise<DefiScan> {
  const started = Date.now(),
    state = await plane.state();
  const signal = AbortSignal.any([
    AbortSignal.timeout(o.deadlineMs ?? 15000),
    ...(o.signal ? [o.signal] : []),
  ]);
  const wanted = o.deploymentIds ? new Set(o.deploymentIds) : undefined;
  if (wanted && [...wanted].some((id) => !deployments.some((d) => d.id === id)))
    throw Error("UNSUPPORTED_DEPLOYMENT");
  if (
    o.chains?.some(
      (id) =>
        !state.chains.some(
          (c) => c.chainId === id && c.mainnet && c.ecosystem === "EVM",
        ),
    )
  )
    throw Error("UNSUPPORTED_CHAIN");
  // Exact held ids, deduplicated, native coin excluded (it is a balance, never a receipt candidate).
  const held = [
    ...new Set(
      (o.held ?? []).filter((h) => heldSchema.test(h) && !NATIVE_IDS.test(h)),
    ),
  ].slice(0, 2000);
  const nftHits = reverseIndex().receiptHits(held, ["position-manager"]);
  const hits = reverseIndex().receiptHits(held);
  // Held contracts not already resolved by the reverse index are receipt candidates for LP/vault families, whose
  // identity is then proven on-chain against the reviewed factory/registry (never by symbol).
  const heldByChain = new Map<string, string[]>();
  for (const h of held) {
    const [chain, contract] = h.split(":");
    if (reverseIndex().lookup(chain, contract).length) continue;
    heldByChain.set(chain, [...(heldByChain.get(chain) ?? []), contract]);
  }
  const receiptCandidates = (d: ProtocolDeployment) =>
    (heldByChain.get(d.chainId)?.length ?? 0) > 0;
  const signals = new Map<string, Signal>();
  const tiers = new Map<string, CandidateTier>();
  const scoped = deployments.filter(
    (d) =>
      (!wanted || wanted.has(d.id)) &&
      (!o.chains || o.chains.includes(d.chainId)),
  );
  const noSignal = scoped.filter(
    (d) => RECEIPT_FAMILIES.has(d.adapter) && !receiptCandidates(d),
  );
  const candidates = scoped
    .filter((d) => !noSignal.includes(d))
    .map((d, i) => {
      signals.set(
        d.id,
        hits.has(d.id) ||
          ((RECEIPT_FAMILIES.has(d.adapter) || d.adapter === "uniswap-v2") &&
            receiptCandidates(d))
          ? "RECEIPT_TOKEN"
          : (FAMILY_SIGNAL[d.adapter] ?? "EXPLICIT"),
      );
      tiers.set(
        d.id,
        hits.has(d.id)
          ? "EXACT_HELD_RECEIPT"
          : nftHits.has(d.id)
            ? "EXACT_POSITION_NFT"
            : ACCOUNT_FAMILIES.has(d.adapter)
              ? "EXACT_PROTOCOL_ACCOUNT"
              : RECEIPT_FAMILIES.has(d.adapter) ||
                  (d.adapter === "uniswap-v2" && receiptCandidates(d))
                ? d.adapter === "uniswap-v2"
                  ? "HISTORICAL_INTERACTION"
                  : "BOUNDED_FALLBACK_PROBE"
                : "HISTORICAL_INTERACTION",
      );
      return { d, i };
    })
    .sort(
      (a, b) =>
        CANDIDATE_TIERS.indexOf(tiers.get(a.d.id)!) -
          CANDIDATE_TIERS.indexOf(tiers.get(b.d.id)!) || a.i - b.i,
    )
    .map((x) => x.d);
  const selected = candidates.slice(0, Math.min(o.maxDeployments ?? 6, 32)),
    pending = candidates.slice(selected.length);
  const result: DefiScan = {
    version: 2,
    wallet,
    scanId: randomUUID(),
    observedAt: started,
    positions: [],
    coverage: [],
    replacedWalletAssets: [],
    replacementOwners: {},
    continuation: pending.map((d) => d.id),
    nonEvm: "NOT_CHECKED",
    elapsedMs: 0,
    peakConcurrency: 0,
  };
  const store =
    o.store ??
    (plane.store instanceof PostgresStore
      ? new PostgresDefiStore(plane.store.sql)
      : undefined);
  const pins = new Map<string, Promise<BlockPin>>();
  const verifiers = new Map<string, PinVerifier>();
  const extraVerifiers: PinVerifier[] = [];
  // One read memo per chain pin of this round (wallet-scoped by construction: one scan = one wallet).
  const memos = new Map<string, Map<string, Promise<unknown>>>();
  const memoFor = (pin: BlockPin) => {
    const k = pin.endpointId + "@" + pin.hash;
    let m = memos.get(k);
    if (!m) memos.set(k, (m = new Map()));
    return m;
  };
  let failoverPins = 0;
  let firstResultAt: number | null = null;
  const pricePromise = o.priceRead
    ? fetchRoutingTokens(
        o.priceRead,
        [...new Set(selected.map((d) => d.chainId))],
        signal,
      ).catch(() => new Map())
    : Promise.resolve(new Map());
  const prices = await pricePromise;
  let index = 0,
    active = 0;
  const blank = (d: ProtocolDeployment): DeploymentCoverage => ({
    deploymentId: d.id,
    protocolId: d.protocolId,
    protocolName: d.name,
    chainId: d.chainId,
    adapterVersion: ADAPTER_VERSION[d.adapter],
    state: "NOT_CHECKED",
    result: "UNKNOWN",
    reason: "NOT_SCHEDULED",
    observedAt: started,
    sourceBlock: null,
    sourceBlockHash: null,
    calls: 0,
    batches: 0,
    fallbacks: 0,
    errors: 0,
    durationMs: 0,
    signal: signals.get(d.id),
    tier: tiers.get(d.id),
  });
  for (const d of noSignal) {
    const c = blank(d);
    c.reason = "NO_RECEIPT_CANDIDATE";
    result.coverage.push(c);
  }
  async function worker() {
    next: while (index < selected.length && !signal.aborted) {
      const d = selected[index++],
        at = Date.now(),
        coverage = blank(d);
      let ctx: AdapterContext | undefined;
      // Counters of an abandoned first attempt (bounded failover) are kept in the census.
      const prior = {
        calls: 0,
        errors: 0,
        batches: 0,
        fallbacks: 0,
        http: 0,
        rpcItems: 0,
        multicallBatches: 0,
        retries: 0,
        cooldownSkips: 0,
        cacheHits: 0,
      };
      const carry = (c: AdapterContext) => {
        prior.calls += c.calls;
        prior.errors += c.errors;
        prior.batches += c.batches;
        prior.fallbacks += c.fallbacks;
        prior.cacheHits += c.cacheHits ?? 0;
        if (c instanceof DefiReader) {
          prior.http += c.http;
          prior.rpcItems += c.rpcItems;
          prior.multicallBatches += c.multicallBatches;
          prior.retries += c.retries + 1;
          prior.cooldownSkips += c.cooldownSkips;
        }
      };
      active++;
      result.peakConcurrency = Math.max(result.peakConcurrency, active);
      try {
        const circuit = circuits.get(d.id);
        if (!o.readerFactory && circuit && circuit.until > Date.now()) {
          coverage.reason = "CIRCUIT_COOLDOWN";
          continue;
        }
        const chain = state.chains.find(
          (c) =>
            c.chainId === d.chainId &&
            c.mainnet &&
            c.enabled &&
            c.ecosystem === "EVM",
        );
        const pool = plane.pool(state, d.chainId);
        if (!chain || !pool) {
          coverage.reason = "NO_HEALTHY_RPC";
          continue;
        }
        // Every admitted endpoint of the chain is in cooldown (rate limit / failures): skipped, truthfully unchecked.
        if (pool.available() === 0) {
          coverage.reason = "RPC_COOLDOWN";
          coverage.cooldownSkips = 1;
          continue;
        }
        const taskSignal = AbortSignal.any([
          signal,
          AbortSignal.timeout(
            (o.perAdapterMs ?? 10000) *
              (REGISTRY_FAMILIES.has(d.adapter) ? 2 : 1),
          ),
        ]);
        // V1.14.1 bounded failover: when the pinned endpoint throttles or enters cooldown during this adapter and another
        // admitted endpoint is healthy, the adapter restarts ONCE on a fresh pin from that endpoint (all of its reads are
        // repeated at the new block; nothing is mixed across block contexts). Otherwise it fails truthfully.
        let excluded: string | undefined;
        let refs: PositionRef[] = [];
        let adapter = adapterFor(d);
        const slots: (DefiPosition | null | undefined)[] = [];
        let failed = 0;
        for (let attempt = 0; ; attempt++) {
          let pinned: BlockPin, verifier: PinVerifier;
          if (!excluded) {
            let pin = pins.get(d.chainId);
            if (!pin) {
              pin = o.pinFactory
                ? o.pinFactory(d.chainId, taskSignal)
                : pinChain(pool, taskSignal);
              pins.set(d.chainId, pin);
            }
            pinned = await bounded(pin, taskSignal);
            let shared = verifiers.get(d.chainId);
            if (!shared) {
              shared = new PinVerifier(pool, pinned);
              verifiers.set(d.chainId, shared);
            }
            verifier = shared;
          } else {
            const skip = excluded;
            pinned = await bounded(
              pinChain(pool, taskSignal, (e) => e.id !== skip),
              taskSignal,
            );
            verifier = new PinVerifier(pool, pinned);
            extraVerifiers.push(verifier);
            failoverPins++;
          }
          if (ctx) carry(ctx);
          try {
            ctx = o.readerFactory
              ? o.readerFactory(d, wallet, pinned, taskSignal)
              : new DefiReader(
                  d,
                  wallet,
                  pinned,
                  taskSignal,
                  pool,
                  new Map(
                    (prices.get(d.chainId) ?? []).map(
                      (t: {
                        address: string;
                        price: import("../data/core/price").PriceEvidence;
                      }) => [t.address, t.price],
                    ),
                  ),
                  REGISTRY_FAMILIES.has(d.adapter) ? 4608 : 256,
                  verifier,
                  memoFor(pinned),
                );
            coverage.sourceBlock = pinned.number.toString();
            coverage.sourceBlockHash = pinned.hash;
            coverage.observedAt = pinned.observedAt;
            // Unpriced held tokens first: plain routable tokens are rarely LP/vault receipts. Bounded per deployment.
            const priced = new Set(
              (prices.get(d.chainId) ?? []).map(
                (t: { address: string }) => t.address,
              ),
            );
            ctx.held = [...(heldByChain.get(d.chainId) ?? [])].sort(
              (a, b) => Number(priced.has(a)) - Number(priced.has(b)),
            );
            ctx.curatedVaults ??= new Set(
              deployments
                .filter(
                  (v) => v.chainId === d.chainId && v.adapter === "erc4626",
                )
                .map((v) => v.contracts.vault),
            );
            // V1.14.1: code proofs of every reviewed contract in one request (LONG-cached per chain + address).
            if (ctx instanceof DefiReader)
              await bounded(
                ctx.codeMany([...new Set(Object.values(d.contracts))]),
                taskSignal,
              );
            if (
              ["morpho-blue", "morpho-vault", "uniswap-v2"].includes(d.adapter)
            ) {
              const local = store
                ? await bounded(
                    store.refs(
                      d.id,
                      wallet,
                      REGISTRY_FAMILIES.has(d.adapter) ? 4096 : 64,
                    ),
                    taskSignal,
                  ).catch(() => ({ refs: [], complete: false }))
                : { refs: [], complete: false };
              ctx.refs = local.refs;
              ctx.discoveryComplete = local.complete;
              if (
                !local.refs.length &&
                !local.complete &&
                !(d.adapter === "uniswap-v2" && ctx.held?.length)
              ) {
                coverage.state = "NOT_CHECKED";
                coverage.reason = "LOCAL_DISCOVERY_INDEX_REQUIRED";
                continue next;
              }
            }
            adapter = adapterFor(d);
            refs = await bounded(adapter.discover(ctx), taskSignal);
            // Bounded concurrency (same pin, same call budget); results keep the deterministic ref order.
            slots.length = 0;
            failed = 0;
            let nextRef = 0;
            await Promise.all(
              Array.from(
                { length: Math.min(POSITION_READ_CONCURRENCY, refs.length) },
                async () => {
                  while (nextRef < refs.length && !taskSignal.aborted) {
                    const i = nextRef++;
                    try {
                      slots[i] = await bounded(
                        adapter.readPosition(refs[i], ctx!),
                        taskSignal,
                      );
                    } catch {
                      failed++;
                    }
                  }
                },
              ),
            );
            if (ctx instanceof DefiReader)
              await bounded(ctx.verifyPin(), taskSignal);
            if (taskSignal.aborted) throw Error("SCAN_TIMEOUT");
            // Position reads lost to an endpoint cooldown: restart on the other endpoint when one is healthy, else the
            // partial result stands (POSITION_READ_INCOMPLETE, never a zero).
            if (
              failed > 0 &&
              attempt === 0 &&
              ctx instanceof DefiReader &&
              ctx.cooldownSkips > 0 &&
              !o.readerFactory &&
              pool.available((x) => x.id !== pinned.endpointId) > 0
            ) {
              excluded = pinned.endpointId;
              continue;
            }
            break;
          } catch (e) {
            const throttled =
              e instanceof RpcError &&
              (e.code === "RATE_LIMITED" || e.detail === "NO_HEALTHY_ENDPOINT");
            if (
              attempt === 0 &&
              !o.readerFactory &&
              !taskSignal.aborted &&
              throttled &&
              pool.available((x) => x.id !== pinned.endpointId) > 0
            ) {
              excluded = pinned.endpointId;
              continue;
            }
            throw e;
          }
        }
        const positions = slots.filter((p): p is DefiPosition => !!p);
        if (failed === refs.length && failed > 0)
          throw Error("POSITION_READ_FAILED");
        const native = adapter.getCoverage(ctx);
        coverage.state =
          failed || positions.some((p) => p.coverage !== "FULL_POSITION")
            ? "PARTIAL_POSITION"
            : native.state;
        coverage.reason = failed ? "POSITION_READ_INCOMPLETE" : native.reason;
        coverage.result = positions.length
          ? "NONZERO"
          : coverage.state === "FULL_POSITION" ||
              (d.adapter === "uniswap-v3" && refs.length === 0 && !failed)
            ? "ZERO"
            : "UNKNOWN";
        result.positions.push(...positions);
        const replacementStart = result.replacedWalletAssets.length;
        result.replacedWalletAssets.push(
          ...positions.flatMap((p) => p.representations),
        );
        if (coverage.state === "FULL_POSITION") {
          if (d.adapter === "aave-v3")
            result.replacedWalletAssets.push(
              ...(d.assets ?? []).flatMap((a) => [
                d.chainId + ":" + a.receipt,
                d.chainId + ":" + a.debt,
              ]),
            );
          if (d.adapter === "compound-iii")
            result.replacedWalletAssets.push(
              d.chainId + ":" + d.contracts.comet,
            );
        }
        result.replacementOwners[d.id] =
          result.replacedWalletAssets.slice(replacementStart);
        circuits.delete(d.id);
      } catch (e) {
        coverage.state = "FAILED";
        coverage.reason =
          e instanceof RpcError && e.detail === "NO_HEALTHY_ENDPOINT"
            ? "RPC_COOLDOWN"
            : e instanceof Error && /^[A-Z0-9_]{1,100}$/.test(e.message)
              ? e.message
              : "ADAPTER_READ_FAILED";
        coverage.result = "UNKNOWN";
        // An endpoint that throttles or cools down is a provider condition, not a protocol failure: it never trips the
        // deployment's circuit (the endpoint health model already backs off), so a protocol is never suppressed for it.
        if (
          !o.readerFactory &&
          coverage.reason !== "RPC_COOLDOWN" &&
          coverage.reason !== "RATE_LIMITED"
        ) {
          const failures = (circuits.get(d.id)?.failures ?? 0) + 1;
          circuits.set(d.id, {
            failures,
            until: failures >= 3 ? Date.now() + 60000 : 0,
          });
        }
      } finally {
        coverage.calls = (ctx?.calls ?? 0) + prior.calls;
        coverage.errors = (ctx?.errors ?? 0) + prior.errors;
        coverage.batches = (ctx?.batches ?? 0) + prior.batches;
        coverage.fallbacks = (ctx?.fallbacks ?? 0) + prior.fallbacks;
        if (ctx instanceof DefiReader) {
          coverage.http = ctx.http + prior.http;
          coverage.rpcItems = ctx.rpcItems + prior.rpcItems;
          coverage.multicallBatches =
            ctx.multicallBatches + prior.multicallBatches;
          coverage.retries = ctx.retries + prior.retries;
          coverage.cooldownSkips =
            (coverage.cooldownSkips ?? 0) +
            ctx.cooldownSkips +
            prior.cooldownSkips;
        }
        const hits =
          (ctx?.cacheHits ?? 0) +
          prior.cacheHits +
          (ctx instanceof DefiReader ? ctx.memoHits : 0);
        if (hits) coverage.cacheHits = hits;
        coverage.durationMs = Date.now() - at;
        active--;
        returnCoverage();
      }
      function returnCoverage() {
        // The outcome is final when the deployment ends (a streamed row is the row of the round).
        coverage.scanResult = outcome(coverage);
        result.coverage.push(coverage);
        if (firstResultAt === null && coverage.calls > 0)
          firstResultAt = Date.now();
        o.onProgress?.(coverage);
        if (o.onResult) {
          const own = result.positions.filter((p) => p.deploymentId === d.id);
          o.onResult({
            coverage,
            positions: own,
            replaced: result.replacementOwners[d.id] ?? [],
          });
        }
        const labels = {
          protocol: d.protocolId,
          chain: d.chainId,
          state: coverage.state,
        };
        registry().inc("defi_adapter_scans_total", labels);
        registry().observe(
          "defi_adapter_duration_ms",
          { protocol: d.protocolId, chain: d.chainId },
          Date.now() - at,
        );
        registry().inc(
          "defi_rpc_calls_total",
          { protocol: d.protocolId, chain: d.chainId },
          ctx?.calls ?? 0,
        );
        if (coverage.state === "FAILED")
          registry().inc("defi_adapter_errors_total", {
            protocol: d.protocolId,
            chain: d.chainId,
          });
      }
    }
  }
  await Promise.all(Array.from({ length: 3 }, worker));
  for (const d of selected.slice(index)) {
    const c = blank(d);
    c.state = "PENDING";
    c.reason = "SCAN_DEADLINE";
    result.coverage.push(c);
    result.continuation.push(d.id);
  }
  result.replacedWalletAssets = [...new Set(result.replacedWalletAssets)];
  result.elapsedMs = Date.now() - started;
  for (const c of result.coverage) c.scanResult = outcome(c);
  result.receipt = await scanReceipt(result, candidates, signals, o, {
    tiers,
    firstResultAt,
    started,
    pins: pins.size + failoverPins,
    verifies: [...verifiers.values(), ...extraVerifiers].reduce(
      (a, v) => a + v.requests,
      0,
    ),
  });
  registry().observe("defi_position_count", {}, result.positions.length);
  for (const coverage of result.coverage)
    registry().inc("defi_coverage_total", { state: coverage.state });
  if (result.coverage.some((c) => c.state !== "FULL_POSITION"))
    registry().inc("defi_partial_scans_total");
  const parsed = scanSchema.parse(result);
  if (store)
    await store
      .record(
        parsed,
        o.clientScope ?? "app",
        Number(process.env.OTHERBRIDGE_DEFI_RETENTION_MS ?? 0),
      )
      .catch(() => {});
  return parsed;
}

// V1.14 scan outcome vocabulary: a checked zero is never "not checked" and never "failed".
function outcome(
  c: DeploymentCoverage,
): NonNullable<DeploymentCoverage["scanResult"]> {
  return c.state === "FAILED"
    ? "FAILED"
    : c.result === "NONZERO"
      ? "NONZERO"
      : c.result === "ZERO"
        ? "CHECKED_ZERO"
        : "NOT_CHECKED";
}
async function scanReceipt(
  result: DefiScan,
  candidates: ProtocolDeployment[],
  signals: Map<string, Signal>,
  o: ScanOptions,
  run: {
    tiers: Map<string, CandidateTier>;
    firstResultAt: number | null;
    started: number;
    pins: number;
    verifies: number;
  },
): Promise<ScanReceipt> {
  const catalog =
    o.catalog === null
      ? null
      : await (
          o.catalog ??
          (async () => (await import("./universe/store")).loadCatalog())
        )().catch(() => null);
  const scanned = new Set(o.chains ?? candidates.map((d) => d.chainId));
  const chainOfKey = new Map(
    catalog ? [...catalog.chains.values()].map((c) => [c.key, c.chainId]) : [],
  );
  const slowest = result.coverage.reduce<DeploymentCoverage | undefined>(
    (a, c) => (!a || c.durationMs > a.durationMs ? c : a),
    undefined,
  );
  const signalCounts: Record<string, number> = {};
  for (const d of candidates) {
    const s = signals.get(d.id) ?? "EXPLICIT";
    signalCounts[s] = (signalCounts[s] ?? 0) + 1;
  }
  const economic = result.positions.flatMap(economicAssets);
  const tierCounts: Record<string, number> = {};
  for (const d of candidates) {
    const t = run.tiers.get(d.id) ?? "HISTORICAL_INTERACTION";
    tierCounts[t] = (tierCounts[t] ?? 0) + 1;
  }
  const sum = (
    k:
      | "http"
      | "rpcItems"
      | "multicallBatches"
      | "retries"
      | "cooldownSkips"
      | "cacheHits",
  ) => result.coverage.reduce((a, c) => a + (c[k] ?? 0), 0);
  return {
    catalogVersion: catalog?.universe.syncId ?? null,
    chainsConsidered: scanned.size,
    chainsChecked: new Set(
      result.coverage
        .filter((c) => c.sourceBlock !== null)
        .map((c) => c.chainId),
    ).size,
    funnel: {
      universeRows: catalog ? catalog.coverage.length : null,
      chainRelevantRows: catalog
        ? catalog.coverage.filter((r) =>
            scanned.has(chainOfKey.get(r.chainKey) ?? ""),
          ).length
        : null,
      candidateDeployments: candidates.length,
      adaptersRun: result.coverage.filter((c) => c.calls > 0).length,
    },
    signals: signalCounts,
    candidateProtocols: [...new Set(candidates.map((d) => d.protocolId))].slice(
      0,
      500,
    ),
    skipped: result.coverage
      .filter((c) => c.state === "NOT_CHECKED" || c.state === "PENDING")
      .map((c) => ({ deploymentId: c.deploymentId, reason: c.reason }))
      .slice(0, 1000),
    failed: result.coverage.filter((c) => c.state === "FAILED").length,
    checkedZero: result.coverage.filter((c) => c.scanResult === "CHECKED_ZERO")
      .length,
    nonzero: result.coverage.filter((c) => c.scanResult === "NONZERO").length,
    positions: result.positions.length,
    unpriced: economic.filter(
      (a) => a.valueUsd === null && BigInt(a.rawAmount) > 0n,
    ).length,
    unpricedDebt: result.positions
      .flatMap((p) => p.borrowed)
      .filter((a) => a.valueUsd === null && BigInt(a.rawAmount) > 0n).length,
    durationMs: result.elapsedMs,
    rpcCalls: result.coverage.reduce((a, c) => a + c.calls, 0),
    slowest: slowest
      ? { deploymentId: slowest.deploymentId, durationMs: slowest.durationMs }
      : null,
    // V1.14.1 machine-readable request census and timing of this round (pins / reorg checks are shared per chain).
    tiers: tierCounts,
    requests: {
      http: sum("http") + run.pins + run.verifies,
      rpcItems: sum("rpcItems") + run.pins * 2 + run.verifies,
      multicallBatches: sum("multicallBatches"),
      retries: sum("retries"),
      cooldownSkips: sum("cooldownSkips"),
      cacheHits: sum("cacheHits"),
      pins: run.pins,
      pinVerifications: run.verifies,
    },
    timing: {
      firstResultMs:
        run.firstResultAt === null ? null : run.firstResultAt - run.started,
      roundMs: result.elapsedMs,
    },
  };
}
