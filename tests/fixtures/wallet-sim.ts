import { DataPlane, fallbackRegistry } from "../../src/data/plane";
import { MemoryStore } from "../../src/data/store/memory";
import { curatedUniverse } from "../../src/data/portfolio/provider";
import { positionsForChain } from "../../src/portfolio/positions";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { provenanceForUrl } from "../../src/data/registry/rpc-provenance";
import type { ApprovedEndpoint } from "../../src/data/rpc/pool";
import type { RpcTransport } from "../../src/data/rpc/transport";
import type { AdmissionResult } from "../../src/data/rpc/admission";
import type { Catalog } from "../../src/routing/model";
import {
  buildWorld,
  DefiSimChain,
  seedProfile,
  SIM_WALLETS,
  simAddress,
  simPriceRead,
  type SimWorld,
} from "./defi-sim";
// V1.14.2 deterministic multichain wallet-scan simulator. SYNTHETIC_TEST_ONLY: never live evidence, never a real
// address owner. Every scannable EVM chain of the committed registry (154 at V1.14.1) is simulated with the same
// endpoint count and batch capability as its committed endpoints, the canonical Multicall3 runtime code and the DeFi
// protocol state of defi-sim. A fixed, documented set of chains carries failure classes (slow, timeout, down, rate
// limit, wrong chain, malformed, no Multicall3, one endpoint down) so the census shows what dominates latency and the
// tests prove that a failure is never a zero.
const WAD = 10n ** 18n;
export const WALLET_FAILURES = {
  /** Every request answers after 1.2 s (a slow public RPC). */
  slow: ["25", "100", "81457", "295", "1313161554", "88888"],
  /** Every request exceeds the transport timeout. */
  timeout: ["4217", "61"],
  /** Every request fails with HTTP 503. */
  down: ["30", "250"],
  /** Every request is throttled (HTTP 429). */
  rateLimited: ["747474"],
  /** The endpoint serves another chain (eth_chainId mismatch). */
  wrongChain: ["80094"],
  /** eth_getBalance returns a malformed quantity. */
  malformed: ["2020"],
  /** No Multicall3 code on the chain (curated sweep impossible). */
  noMulticall: ["43114"],
  /** The first endpoint is down; the second answers (failover). */
  oneEndpointDown: ["42161"],
} as const;
export type FailureClass = keyof typeof WALLET_FAILURES;
export function failureOf(chainId: string): FailureClass | null {
  for (const [k, ids] of Object.entries(WALLET_FAILURES))
    if ((ids as readonly string[]).includes(chainId)) return k as FailureClass;
  return null;
}
export const WALLET_PROFILES = [
  "multichain",
  "indexed",
  "zero",
  "native-only",
  "obscure-erc20",
  "longtail",
] as const;
export type WalletProfile = (typeof WALLET_PROFILES)[number];
export const WALLET_SIM_WALLETS: Record<WalletProfile, string> = {
  multichain: SIM_WALLETS.production,
  indexed: "0x00000000000000000000000000000000001d3e01",
  zero: "0x0000000000000000000000000000000000002e70",
  "native-only": "0x0000000000000000000000000000000000000a71",
  "obscure-erc20": "0x00000000000000000000000000000000000b5c01",
  longtail: "0x000000000000000000000000000000000001a7a1",
};
class MalformedChain extends DefiSimChain {
  handle(
    method: string,
    params: unknown[],
    b: Parameters<DefiSimChain["handle"]>[2],
    stats: Parameters<DefiSimChain["handle"]>[3],
  ): unknown {
    if (method === "eth_getBalance") return "0xZZ";
    return super.handle(method, params, b, stats);
  }
}
export interface WalletWorld {
  world: SimWorld;
  /** Scannable EVM chains of the committed registry, accepted canonical order (routable, then TVL). */
  chains: string[];
  /** Simulated endpoint URL -> operator group of the committed endpoint it stands for (census only). */
  operatorOf: Map<string, string>;
  endpoints: ApprovedEndpoint[];
  catalog: Catalog;
  plane(transport: RpcTransport, store?: MemoryStore | null): DataPlane;
  priceRead: ReturnType<typeof simPriceRead>;
}
export interface WalletWorldOptions {
  latencyMs?: number;
  perItemMs?: number;
  jitter?: number;
  morphoMarkets?: number;
  morphoVaults?: number;
}
export function buildWalletWorld(o: WalletWorldOptions = {}): WalletWorld {
  const base = fallbackRegistry();
  const byChain = new Map<string, ApprovedEndpoint[]>();
  for (const e of base.endpoints)
    byChain.set(e.chainId, [...(byChain.get(e.chainId) ?? []), e]);
  const scannable = base.chains
    .filter(
      (c) =>
        c.ecosystem === "EVM" &&
        c.enabled &&
        c.mainnet &&
        (byChain.get(c.chainId)?.length ?? 0) > 0,
    )
    .sort(
      (a, b) =>
        Number(b.routable) - Number(a.routable) ||
        (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) ||
        a.chainId.localeCompare(b.chainId),
    )
    .map((c) => c.chainId);
  const world = buildWorld({
    chains: scannable,
    latencyMs: o.latencyMs ?? 90,
    perItemMs: o.perItemMs ?? 0.2,
    jitter: o.jitter ?? 0.1,
    morphoMarkets: o.morphoMarkets ?? 1814,
    morphoVaults: o.morphoVaults ?? 382,
  });
  // Curated registry contracts exist as ERC20s on every simulated chain (balances through world.balances).
  for (const chainId of scannable) {
    const chain = world.net.chains.get(chainId)!;
    for (const a of curatedUniverse(chainId)) {
      if (chain.contracts.has(a.address)) continue;
      world.tokenMeta.set(chainId + ":" + a.address, {
        symbol: a.symbol ?? "TKN",
        decimals: a.decimals ?? 18,
      });
      chain.token(
        a.address,
        a.symbol ?? "TKN",
        a.decimals ?? 18,
        world.balances(chainId, a.address),
      );
    }
    for (const p of positionsForChain(chainId))
      if (!chain.contracts.has(p.address))
        chain.token(
          p.address,
          p.symbol,
          p.decimals,
          world.balances(chainId, p.address),
        );
  }
  const operatorOf = new Map<string, string>();
  const endpoints: ApprovedEndpoint[] = scannable.flatMap((chainId) =>
    byChain.get(chainId)!.map((committed, i) => {
      const url = `https://rpc${i}.sim.test/${chainId}`;
      operatorOf.set(
        url,
        provenanceForUrl(committed.url).operatorGroup ?? "UNKNOWN",
      );
      return {
        id: `${chainId}:rpc${i}.sim.test`,
        chainId,
        url,
        priority: 10 + i,
        supportsLogs: false,
        maxLogRange: 0,
        supportsBatch: committed.supportsBatch,
        supportsFinalized: true,
        supportsSafe: true,
        archive: false,
      };
    }),
  );
  // Failure classes.
  const behavior = (url: string) => {
    const b = world.net.behavior.get(url) ?? {
      latencyMs: o.latencyMs ?? 90,
      perItemMs: o.perItemMs ?? 0.2,
      jitter: o.jitter ?? 0.1,
    };
    world.net.behavior.set(url, b);
    return b;
  };
  const urls = (chainId: string) =>
    endpoints.filter((e) => e.chainId === chainId).map((e) => e.url);
  for (const id of WALLET_FAILURES.slow)
    for (const u of urls(id)) behavior(u).latencyMs = 1200;
  for (const id of WALLET_FAILURES.timeout)
    for (const u of urls(id)) behavior(u).latencyMs = 9000;
  for (const id of WALLET_FAILURES.down)
    for (const u of urls(id)) behavior(u).failNext = Number.MAX_SAFE_INTEGER;
  for (const id of WALLET_FAILURES.rateLimited)
    for (const u of urls(id)) behavior(u).ratePerSecond = 0;
  for (const id of WALLET_FAILURES.oneEndpointDown)
    behavior(urls(id)[0]).failNext = Number.MAX_SAFE_INTEGER;
  for (const id of WALLET_FAILURES.wrongChain) {
    const other = new DefiSimChain(String(Number(id) + 1));
    world.net.chains.set(id, other);
  }
  for (const id of WALLET_FAILURES.malformed)
    world.net.chains.set(id, new MalformedChain(id));
  for (const id of WALLET_FAILURES.noMulticall)
    world.net.chains.get(id)!.contracts.delete(MULTICALL3);
  const catalog: Catalog = {
    networks: base.routing,
    tools: [],
    generation: "wallet-sim",
    observedAt: Date.now(),
    stale: false,
  };
  return {
    world,
    chains: scannable,
    operatorOf,
    endpoints,
    catalog,
    priceRead: simPriceRead(world),
    plane(transport, store = null) {
      return new DataPlane(store, transport, 60000, () => ({
        ...base,
        endpoints,
      }));
    },
  };
}
const curated = (chainId: string, symbol: string) => {
  const a = curatedUniverse(chainId).find((x) => x.symbol === symbol);
  if (!a) throw Error(`NO_CURATED_${chainId}_${symbol}`);
  return a.address;
};
export interface SeededProfile {
  profile: WalletProfile;
  wallet: string;
  /** User-imported exact contracts per chain (the client's localStorage imports). */
  extraTokens: Map<string, string[]>;
  /** The data-plane store carrying indexed activity (only the `indexed` profile). */
  store: MemoryStore | null;
  /** The chain the connected wallet is on (CURRENT_CHAIN evidence). */
  walletChain: string;
  /** Expected nonzero holdings (chainId:address) — the discovery oracle of the profile. */
  expected: string[];
}
const ZERO = "0x0000000000000000000000000000000000000000";
/** Seeds one wallet profile into the world (idempotent per profile; profiles use distinct synthetic wallets). */
export function seedWalletProfile(
  ww: WalletWorld,
  profile: WalletProfile,
): SeededProfile {
  const w = ww.world;
  const wallet = WALLET_SIM_WALLETS[profile];
  const native = (chainId: string, amount: bigint) =>
    w.net.chains.get(chainId)!.native.set(wallet, amount);
  const token = (
    chainId: string,
    address: string,
    amount: bigint,
    symbol?: string,
    decimals = 18,
    priced = false,
  ) => {
    const chain = w.net.chains.get(chainId)!;
    const a = address.toLowerCase();
    if (!chain.contracts.has(a) && symbol)
      chain.token(a, symbol, decimals, w.balances(chainId, a));
    if (priced && symbol)
      w.tokenMeta.set(chainId + ":" + a, { symbol, decimals });
    w.balances(chainId, a).set(wallet, amount);
    return a;
  };
  const extraTokens = new Map<string, string[]>();
  let store: MemoryStore | null = null;
  const expected: string[] = [];
  const has = (chainId: string, address: string) =>
    expected.push(`${chainId}:${address.toLowerCase()}`);
  switch (profile) {
    case "multichain": {
      seedProfile(w, "production", "1");
      has("1", ZERO);
      for (const [chainId, amount] of [
        ["8453", WAD / 4n],
        ["56", (8n * WAD) / 10n],
        ["42161", WAD / 10n],
        ["10", WAD / 20n],
        ["137", 120n * WAD],
        ["43114", 3n * WAD],
        ["100", 50n * WAD],
        ["31612", 2n * WAD],
        ["25", 1000n * WAD],
      ] as const) {
        native(chainId, amount);
        has(chainId, ZERO);
      }
      has("1", token("1", curated("1", "USDC"), 2500n * 10n ** 6n));
      has("56", token("56", curated("56", "USDT"), 1000n * WAD));
      // Imported exact contracts: an obscure token on a slow long-tail chain, a spam token, an unpriced token and a
      // zero-balance import.
      const obscure = token(
        "295",
        simAddress("wallet:obscure"),
        42n * WAD,
        "OBS",
      );
      const spam = token(
        "8453",
        simAddress("wallet:spam"),
        10n ** 24n,
        "CLAIM www.airdrop.test",
      );
      const unpriced = token(
        "56",
        simAddress("wallet:unpriced"),
        7n * WAD,
        "UNP",
      );
      const empty = token("1", simAddress("wallet:empty"), 0n, "EMP");
      extraTokens.set("295", [obscure]);
      extraTokens.set("8453", [spam]);
      extraTokens.set("56", [unpriced]);
      extraTokens.set("1", [empty]);
      has("295", obscure);
      has("8453", spam);
      has("56", unpriced);
      // The world's DeFi receipt tokens on chain 1 (Aave/Compound/Lido/...) are found by the curated / receipt sweep.
      break;
    }
    case "indexed": {
      native("42161", WAD / 3n);
      native("31612", 5n * WAD);
      native("8453", WAD / 50n);
      has("42161", ZERO);
      has("31612", ZERO);
      has("8453", ZERO);
      // A token the self-hosted index discovered for this wallet on a FULL_INDEXED chain (not in any universe).
      const idx = token("42161", simAddress("wallet:indexed"), 9n * WAD, "IDX");
      has("42161", idx);
      store = new MemoryStore();
      const now = Date.now();
      for (const e of ww.endpoints) {
        const admission: AdmissionResult = {
          chainId: e.chainId,
          url: e.url,
          host: new URL(e.url).host,
          provenance: "public-registry" as AdmissionResult["provenance"],
          status: "APPROVED",
          reason: null,
          latencyMs: 90,
          latestBlock: null,
          // The FULL_INDEXED chain's endpoints serve logs (index capability).
          supportsLogs: e.chainId === "42161",
          maxLogRange: e.chainId === "42161" ? 1000 : 0,
          supportsBatch: e.supportsBatch,
          supportsFinalized: true,
          supportsSafe: true,
          archive: false,
          logsPerBlock: null,
          checkedAt: now,
        };
        void store.upsertEndpoint(admission, e.priority);
      }
      store.checkpoints.set("42161", {
        chainId: "42161",
        indexedFromBlock: 20_980_000n,
        indexedThroughBlock: 20_999_990n,
        throughBlockHash: null,
        headBlock: 21_000_000n,
        safeBlock: 20_999_990n,
        historicalComplete: false,
        lastError: null,
        updatedAt: now,
      });
      // Routing-catalog token universe (ON_DEMAND_FUNGIBLE) on the mainstream curated chains.
      for (const chainId of ["1", "8453", "42161", "10", "137", "56"])
        void store.upsertTokens(
          curatedUniverse(chainId)
            .slice(0, 40)
            .map((a) => ({
              chainId,
              address: a.address,
              symbol: a.symbol,
              name: a.name,
              decimals: a.decimals,
              metadataStatus: "OK" as const,
              sources: ["routing-catalog"],
            })),
        );
      const discovery = (chainId: string, tokenAddress: string) =>
        store!.discovery.set(`${chainId}|${wallet}|${tokenAddress}`, {
          chainId,
          wallet,
          token: tokenAddress,
          firstBlock: 20_990_000n,
          lastBlock: 20_999_000n,
          transferCount: 3,
        });
      discovery("42161", idx);
      // Activity-only evidence: historical transfers on Linea and a long-tail chain (scheduling evidence only; the
      // Linea balance is zero today).
      discovery("59144", simAddress("wallet:linea-history"));
      discovery("31612", simAddress("wallet:mezo-history"));
      break;
    }
    case "zero":
      break;
    case "native-only":
      native("10", (7n * WAD) / 10n);
      has("10", ZERO);
      break;
    case "obscure-erc20": {
      const obscure = token(
        "31612",
        simAddress("wallet:obscure2"),
        77n * WAD,
        "OBX",
      );
      extraTokens.set("31612", [obscure]);
      has("31612", obscure);
      break;
    }
    case "longtail":
      native("1313161554", 4n * WAD);
      native("6880", 9n * WAD);
      has("1313161554", ZERO);
      has("6880", ZERO);
      break;
  }
  return {
    profile,
    wallet,
    extraTokens,
    store,
    walletChain: "8453",
    expected: [...new Set(expected)].sort(),
  };
}
