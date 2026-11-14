import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";
import { readFileSync } from "node:fs";
import { abiFor, functionName, views, type ViewName } from "../../src/defi/abi";
import { deployments } from "../../src/defi/registry";
import type { DiscoveryStore } from "../../src/defi/store";
import type { PositionRef, ProtocolDeployment } from "../../src/defi/model";
import { multicall3Abi, SELECTORS } from "../../src/data/evm/erc20";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import {
  RpcError,
  type RpcEndpoint,
  type RpcTransport,
} from "../../src/data/rpc/transport";
import type { ApprovedEndpoint } from "../../src/data/rpc/pool";
import { prng } from "./prng";
// V1.14.1 deterministic DeFi chain simulator. SYNTHETIC_TEST_ONLY: never live evidence, never a real address owner.
// It answers exactly the reviewed view capabilities of the registry deployments at one pinned block: single eth_call,
// Multicall3 aggregate3 (real canonical runtime code, so the code-hash check passes), JSON-RPC batches, latency,
// per-endpoint rate limits and provider-side aggregate limits. Unknown selectors revert; unregistered addresses behave
// like accounts without code. Every HTTP request is recorded for the request census.
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000";
const UINT256_MAX = 2n ** 256n - 1n;
export const SIM_MC3_CODE = readFileSync(
  "tests/fixtures/multicall3-runtime.hex",
  "utf8",
).trim() as Hex;
const SELECTOR_NAMES = new Map<string, ViewName[]>();
for (const name of Object.keys(views) as ViewName[]) {
  const s = toFunctionSelector(views[name]);
  SELECTOR_NAMES.set(s, [...(SELECTOR_NAMES.get(s) ?? []), name]);
}
class SimRevert extends Error {}
export const simAddress = (salt: string) =>
  ("0x" + keccak256(toHex("sim:" + salt)).slice(26)) as Hex;
type Handler = (args: readonly unknown[]) => unknown;
export interface SimContract {
  code: Hex;
  views: Partial<Record<ViewName, Handler>>;
}
export interface SimRequestRecord {
  at: number;
  url: string;
  chainId: string;
  kind: "single" | "batch";
  methods: string[];
  aggregates: number;
  inner: number;
  status: "ok" | "rate-limited" | "timeout" | "error";
}
export interface SimBehavior {
  latencyMs: number;
  perItemMs: number;
  jitter: number;
  /** Sliding one-second window per endpoint URL; excess requests receive HTTP 429. */
  ratePerSecond?: number;
  /** Provider-side limit: aggregates with more inner calls fail like an out-of-gas eth_call. */
  maxAggregateInner?: number;
  /** Inner calls (target:name) that revert inside an aggregate and as single calls. */
  revert?: Set<string>;
  /** Next N requests fail with a transient HTTP error (then the endpoint recovers). */
  failNext?: number;
  /** Argument-level revert injection (e.g. one reserve of a data provider). */
  revertWhen?: (
    target: string,
    name: ViewName,
    args: readonly unknown[],
  ) => boolean;
}
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new RpcError("TIMEOUT"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => (clearTimeout(t), reject(new RpcError("TIMEOUT")));
    signal?.addEventListener("abort", stop, { once: true });
  });
export class DefiSimChain {
  contracts = new Map<string, SimContract>();
  native = new Map<string, bigint>();
  number = 21_000_000n;
  /** Every executed view as "target:name" (single calls and aggregate inner calls alike). */
  viewLog: string[] = [];
  /** The same executions with their decoded arguments (bigint-safe JSON). */
  callLog: { target: string; name: string; args: string }[] = [];
  constructor(readonly chainId: string) {
    this.contracts.set(MULTICALL3, { code: SIM_MC3_CODE, views: {} });
  }
  private baseTime = BigInt(Math.floor(Date.now() / 1000));
  /**
   * Block timestamp: fixed per simulated chain (state that depends on time, e.g. Morpho accrual, is deterministic),
   * re-based only when it would become older than the reader's 300 s staleness bound.
   */
  get timestamp() {
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (now - this.baseTime > 200n) this.baseTime = now;
    return this.baseTime;
  }
  get hash() {
    return keccak256(toHex(`sim-block:${this.chainId}:${this.number}`));
  }
  contract(address: string, views: SimContract["views"] = {}) {
    const a = address.toLowerCase();
    const c = this.contracts.get(a) ?? { code: "0x6080" as Hex, views: {} };
    Object.assign(c.views, views);
    this.contracts.set(a, c);
    return c;
  }
  /** ERC20 surface (balances keyed by holder). Merges with any protocol views already on the address. */
  token(
    address: string,
    symbol: string,
    decimals: number,
    balances = new Map<string, bigint>(),
  ) {
    const supply = () =>
      [...balances.values()].reduce((a, b) => a + b, 0n) + 10n ** 30n;
    this.contract(address, {
      balanceOf: ([w]) => balances.get(String(w).toLowerCase()) ?? 0n,
      decimals: () => decimals,
      symbol: () => symbol,
      totalSupply: supply,
    });
    return balances;
  }
  private view(to: string, data: Hex, b?: SimBehavior): Hex {
    const revert = b?.revert;
    const c = this.contracts.get(to.toLowerCase());
    if (!c) return "0x";
    const names = (SELECTOR_NAMES.get(data.slice(0, 10)) ?? []).filter(
      (n) => c.views[n],
    );
    if (!names.length) throw new SimRevert("NO_VIEW");
    const name = names[0];
    this.viewLog.push(to.toLowerCase() + ":" + name);
    if (revert?.has(to.toLowerCase() + ":" + name)) throw new SimRevert("REV");
    const abi = abiFor(name);
    const { args } = decodeFunctionData({ abi, data });
    this.callLog.push({
      target: to.toLowerCase(),
      name,
      args: JSON.stringify(args ?? [], (_k, v) =>
        typeof v === "bigint" ? v.toString() : v,
      ).toLowerCase(),
    });
    if (b?.revertWhen?.(to.toLowerCase(), name, args ?? []))
      throw new SimRevert("REV");
    const value = c.views[name]!(args ?? []);
    return encodeFunctionResult({
      abi,
      functionName: functionName(name),
      result: value as never,
    });
  }
  handle(
    method: string,
    params: unknown[],
    b: SimBehavior,
    stats: { aggregates: number; inner: number },
  ): unknown {
    switch (method) {
      case "eth_chainId":
        return toHex(BigInt(this.chainId));
      case "eth_blockNumber":
        return toHex(this.number);
      case "eth_getBlockByNumber": {
        const tag = String(params[0]);
        const n = /^0x/.test(tag) ? BigInt(tag) : this.number;
        if (n > this.number) return null;
        return {
          number: toHex(n),
          hash: keccak256(toHex(`sim-block:${this.chainId}:${n}`)),
          parentHash: keccak256(toHex(`sim-block:${this.chainId}:${n - 1n}`)),
          timestamp: toHex(this.timestamp),
        };
      }
      case "eth_getBalance":
        return toHex(this.native.get(String(params[0]).toLowerCase()) ?? 0n);
      case "eth_getTransactionCount":
        return "0x0";
      case "eth_getCode":
        return (
          this.contracts.get(String(params[0]).toLowerCase())?.code ?? "0x"
        );
      case "eth_getLogs":
        return [];
      case "eth_call": {
        const call = params[0] as { to: string; data: Hex };
        if (
          call.to.toLowerCase() === MULTICALL3 &&
          call.data.startsWith(SELECTORS.aggregate3)
        ) {
          const decoded = decodeFunctionData({
            abi: multicall3Abi,
            data: call.data,
          });
          const inner = decoded.args[0] as readonly {
            target: string;
            callData: Hex;
          }[];
          stats.aggregates++;
          stats.inner += inner.length;
          if (
            b.maxAggregateInner !== undefined &&
            inner.length > b.maxAggregateInner
          )
            throw { code: -32000, message: "out of gas" };
          return encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: inner.map((c) => {
              try {
                return {
                  success: true,
                  returnData: this.view(c.target, c.callData, b),
                };
              } catch {
                return { success: false, returnData: "0x" as Hex };
              }
            }),
          });
        }
        try {
          return this.view(call.to, call.data, b);
        } catch {
          throw { code: 3, message: "execution reverted" };
        }
      }
      default:
        throw { code: -32601, message: "method not found" };
    }
  }
}
export interface SimNetwork {
  chains: Map<string, DefiSimChain>;
  behavior: Map<string, SimBehavior>;
  log: SimRequestRecord[];
  transport: RpcTransport;
  endpoints(chainId: string, count?: number): ApprovedEndpoint[];
  reset(): void;
}
export function simNetwork(
  defaults: Partial<SimBehavior> = {},
  seed = 7,
): SimNetwork {
  const chains = new Map<string, DefiSimChain>();
  const behavior = new Map<string, SimBehavior>();
  const log: SimRequestRecord[] = [];
  const windows = new Map<string, number[]>();
  const rand = prng(seed);
  const get = (url: string): SimBehavior => {
    let b = behavior.get(url);
    if (!b) {
      b = { latencyMs: 0, perItemMs: 0, jitter: 0, ...defaults };
      behavior.set(url, b);
    }
    return b;
  };
  const transport: RpcTransport = async (
    endpoint: RpcEndpoint,
    body: unknown,
    options,
  ) => {
    const b = get(endpoint.url);
    const chain = chains.get(endpoint.chainId);
    const batch = Array.isArray(body);
    const reqs = (batch ? body : [body]) as {
      id: number;
      method: string;
      params: unknown[];
    }[];
    const rec: SimRequestRecord = {
      at: Date.now(),
      url: endpoint.url,
      chainId: endpoint.chainId,
      kind: batch ? "batch" : "single",
      methods: reqs.map((r) => r.method),
      aggregates: 0,
      inner: 0,
      status: "ok",
    };
    log.push(rec);
    if (b.ratePerSecond !== undefined) {
      const now = Date.now(),
        w = (windows.get(endpoint.url) ?? []).filter((t) => now - t < 1000);
      if (w.length >= b.ratePerSecond) {
        windows.set(endpoint.url, w);
        rec.status = "rate-limited";
        await sleep(Math.min(20, b.latencyMs), options.signal).catch(() => {});
        throw new RpcError("RATE_LIMITED", "429");
      }
      w.push(now);
      windows.set(endpoint.url, w);
    }
    if (b.failNext && b.failNext > 0) {
      b.failNext--;
      rec.status = "error";
      throw new RpcError("HTTP_ERROR", "503");
    }
    if (!chain) throw new RpcError("HTTP_ERROR", "NO_CHAIN");
    const stats = { aggregates: 0, inner: 0 };
    const out = reqs.map((r) => {
      try {
        return {
          jsonrpc: "2.0",
          id: r.id,
          result: chain.handle(r.method, r.params, b, stats),
        };
      } catch (error) {
        return { jsonrpc: "2.0", id: r.id, error };
      }
    });
    rec.aggregates = stats.aggregates;
    rec.inner = stats.inner;
    const latency =
      (b.latencyMs + b.perItemMs * (reqs.length + stats.inner)) *
      (1 + (rand.next() * 2 - 1) * b.jitter);
    const limit = options.timeoutMs ?? 6000;
    try {
      if (latency > limit) {
        await sleep(limit, options.signal);
        throw new RpcError("TIMEOUT");
      }
      if (latency > 0) await sleep(latency, options.signal);
    } catch (e) {
      rec.status = "timeout";
      throw e;
    }
    return batch ? out : out[0];
  };
  return {
    chains,
    behavior,
    log,
    transport,
    endpoints(chainId, count = 1) {
      return Array.from({ length: count }, (_, i) => ({
        id: `${chainId}:rpc${i}.sim.test`,
        chainId,
        url: `https://rpc${i}.sim.test/${chainId}`,
        priority: 10 + i,
        supportsLogs: false,
        maxLogRange: 0,
        supportsBatch: true,
        supportsFinalized: true,
        supportsSafe: true,
        archive: false,
      }));
    },
    reset() {
      log.length = 0;
      windows.clear();
    },
  };
}
/** Request census of a slice of the simulator log (HTTP requests, JSON-RPC items, aggregates, inner calls). */
export function census(records: SimRequestRecord[]) {
  const byMethod: Record<string, number> = {};
  for (const r of records)
    for (const m of r.methods) byMethod[m] = (byMethod[m] ?? 0) + 1;
  return {
    httpRequests: records.length,
    rpcItems: records.reduce((a, r) => a + r.methods.length, 0),
    jsonRpcBatches: records.filter((r) => r.kind === "batch").length,
    multicallBatches: records.reduce((a, r) => a + r.aggregates, 0),
    innerCalls: records.reduce((a, r) => a + r.inner, 0),
    rateLimited: records.filter((r) => r.status === "rate-limited").length,
    timeouts: records.filter((r) => r.status === "timeout").length,
    errors: records.filter((r) => r.status === "error").length,
    byMethod,
  };
}
// ---------------------------------------------------------------------------------------------------------------
// Protocol state builders (synthetic values only; addresses are the reviewed registry literals or synthetic tokens).
const usdPrice = (symbol: string) =>
  /BTC/i.test(symbol)
    ? 60000n
    : /ETH|ezETH|weETH|rsETH/i.test(symbol)
      ? 2000n
      : /AAVE|LINK|UNI|CRV|LDO|COMP|MKR|SNX|BAL/i.test(symbol)
        ? 20n
        : 1n;
export interface AaveUser {
  supply: bigint;
  stableDebt?: bigint;
  variableDebt?: bigint;
  collateral?: boolean;
}
export interface SimWorld {
  net: SimNetwork;
  store: DiscoveryStore;
  /** wallet -> deployment -> per-reserve user state (Aave/Spark). */
  aave: Map<string, Map<string, Map<string, AaveUser>>>;
  aaveRewards: Map<string, Map<string, { token: string; amount: bigint }[]>>;
  compound: Map<
    string,
    Map<string, { supply: bigint; borrow: bigint; collateral: bigint[] }>
  >;
  comets: Map<string, { base: string; assets: string[]; decimals: number[] }>;
  balances: (chainId: string, token: string) => Map<string, bigint>;
  tokenMeta: Map<string, { symbol: string; decimals: number }>;
  morphoMarkets: Map<
    string,
    { params: readonly [string, string, string, string, bigint] }
  >;
  morphoPositions: Map<string, Map<string, [bigint, bigint, bigint]>>;
  morphoVaults: string[];
  v3Positions: Map<
    string,
    { tokenId: bigint; owner: string; deployment: string }
  >;
  pairs: string[];
  /** chainId -> synthetic Curve LP / Balancer BPT address. */
  curveLp: Map<string, string>;
  bpt: Map<string, string>;
  solidlyPools: Map<string, string>;
  /** Exact held ids (chainId:contract) for a wallet: its nonzero token balances on the simulated chains. */
  held(wallet: string): string[];
}
export interface WorldOptions {
  chains: string[];
  latencyMs?: number;
  perItemMs?: number;
  jitter?: number;
  morphoMarkets?: number;
  morphoVaults?: number;
  endpointsPerChain?: number;
}
export function buildWorld(o: WorldOptions): SimWorld {
  const net = simNetwork({
    latencyMs: o.latencyMs ?? 0,
    perItemMs: o.perItemMs ?? 0,
    jitter: o.jitter ?? 0,
  });
  const tokenMeta = new Map<string, { symbol: string; decimals: number }>();
  const bal = new Map<string, Map<string, bigint>>();
  const world: SimWorld = {
    net,
    store: undefined as unknown as DiscoveryStore,
    aave: new Map(),
    aaveRewards: new Map(),
    compound: new Map(),
    comets: new Map(),
    balances: (chainId, token) => {
      const k = chainId + ":" + token.toLowerCase();
      let m = bal.get(k);
      if (!m) {
        m = new Map();
        bal.set(k, m);
      }
      return m;
    },
    tokenMeta,
    morphoMarkets: new Map(),
    morphoPositions: new Map(),
    morphoVaults: [],
    v3Positions: new Map(),
    pairs: [],
    curveLp: new Map(),
    bpt: new Map(),
    solidlyPools: new Map(),
    held(wallet) {
      const w = wallet.toLowerCase(),
        out: string[] = [];
      for (const [k, m] of bal) if ((m.get(w) ?? 0n) > 0n) out.push(k);
      return out.sort();
    },
  };
  const tok = (
    chain: DefiSimChain,
    address: string,
    symbol: string,
    decimals: number,
  ) => {
    const a = address.toLowerCase();
    tokenMeta.set(chain.chainId + ":" + a, { symbol, decimals });
    chain.token(a, symbol, decimals, world.balances(chain.chainId, a));
    return a;
  };
  for (const chainId of o.chains) {
    const chain = new DefiSimChain(chainId);
    net.chains.set(chainId, chain);
    const r = prng(Number(chainId) + 11);
    for (const d of deployments.filter((x) => x.chainId === chainId)) {
      for (const a of new Set(Object.values(d.contracts))) chain.contract(a);
      buildDeployment(world, chain, d, tok, r, o);
    }
  }
  world.store = {
    async refs(deploymentId: string, _wallet: string, limit: number) {
      const d = deployments.find((x) => x.id === deploymentId);
      if (d?.adapter === "morpho-blue" && d.chainId === o.chains[0]) {
        const refs: PositionRef[] = [...world.morphoMarkets.keys()].map(
          (id) => ({
            key: id,
            marketId: id,
            discovery: "registry",
          }),
        );
        return refs.length <= limit
          ? { refs, complete: true }
          : { refs: refs.slice(0, limit), complete: false };
      }
      if (d?.adapter === "morpho-vault" && d.chainId === o.chains[0]) {
        const refs: PositionRef[] = world.morphoVaults.map((v) => ({
          key: v,
          contract: v,
          discovery: "registry",
        }));
        return refs.length <= limit
          ? { refs, complete: true }
          : { refs: refs.slice(0, limit), complete: false };
      }
      return { refs: [], complete: false };
    },
    async record() {},
  };
  return world;
}
function buildDeployment(
  world: SimWorld,
  chain: DefiSimChain,
  d: ProtocolDeployment,
  tok: (
    chain: DefiSimChain,
    address: string,
    symbol: string,
    decimals: number,
  ) => string,
  r: ReturnType<typeof prng>,
  o: WorldOptions,
) {
  const c = d.contracts;
  const users = <T>(m: Map<string, Map<string, T>>, w: unknown) =>
    m.get(String(w).toLowerCase())?.get(d.id);
  switch (d.adapter) {
    case "aave-v3": {
      const assets = d.assets ?? [];
      for (const a of assets) {
        tok(chain, a.underlying, a.symbol, a.decimals);
        tok(chain, a.receipt, "a" + a.symbol, a.decimals);
        tok(chain, a.debt, "variableDebt" + a.symbol, a.decimals);
      }
      const reward = tok(chain, simAddress(d.id + ":reward"), "AAVE", 18);
      void reward;
      const user = (w: unknown, asset: string) =>
        world.aave.get(String(w).toLowerCase())?.get(d.id)?.get(asset);
      chain.contract(c.addressesProvider, {
        getPool: () => c.pool,
        getPoolDataProvider: () => c.provider,
      });
      chain.contract(c.pool, {
        getUserAccountData: ([w]) => {
          let coll = 0n,
            debt = 0n;
          for (const a of assets) {
            const u = user(w, a.underlying);
            if (!u) continue;
            const px = usdPrice(a.symbol) * 10n ** 8n;
            if (u.collateral !== false)
              coll += (u.supply * px) / 10n ** BigInt(a.decimals);
            debt +=
              (((u.stableDebt ?? 0n) + (u.variableDebt ?? 0n)) * px) /
              10n ** BigInt(a.decimals);
          }
          const hf = debt ? (coll * 8000n * WAD) / 10000n / debt : UINT256_MAX;
          return [
            coll,
            debt,
            (coll * 75n) / 100n - debt > 0n ? (coll * 75n) / 100n - debt : 0n,
            8000n,
            7500n,
            hf,
          ];
        },
      });
      chain.contract(c.provider, {
        getAllReservesTokens: () =>
          assets.map((a) => ({ symbol: a.symbol, tokenAddress: a.underlying })),
        getUserReserveData: ([asset, w]) => {
          const u = user(w, String(asset).toLowerCase());
          return [
            u?.supply ?? 0n,
            u?.stableDebt ?? 0n,
            u?.variableDebt ?? 0n,
            0n,
            0n,
            0n,
            0n,
            0,
            (u?.supply ?? 0n) > 0n && u?.collateral !== false,
          ];
        },
        getReserveTokensAddresses: ([asset]) => {
          const a = assets.find(
            (x) => x.underlying === String(asset).toLowerCase(),
          );
          if (!a) throw Error("NO_RESERVE");
          return [a.receipt, simAddress(d.id + ":stable:" + a.symbol), a.debt];
        },
        getReserveConfigurationData: ([asset]) => {
          const a = assets.find(
            (x) => x.underlying === String(asset).toLowerCase(),
          );
          if (!a) throw Error("NO_RESERVE");
          return [
            BigInt(a.decimals),
            7500n,
            8000n,
            10500n,
            1000n,
            true,
            true,
            false,
            true,
            false,
          ];
        },
      });
      chain.contract(c.incentives, {
        getAllUserRewards: ([, w]) => {
          const list =
            world.aaveRewards.get(String(w).toLowerCase())?.get(d.id) ?? [];
          return [list.map((x) => x.token), list.map((x) => x.amount)];
        },
      });
      break;
    }
    case "compound-iii": {
      const sym = d.id.split("-").pop()!.toUpperCase();
      const dec = /USD/.test(sym) ? 6 : /BTC/.test(sym) ? 8 : 18;
      const base = tok(chain, simAddress(d.id + ":base"), sym, dec);
      const n = 4 + r.int(6);
      const assets = Array.from({ length: n }, (_, i) =>
        tok(
          chain,
          simAddress(d.id + ":coll:" + i),
          "COLL" + i,
          i % 3 === 0 ? 8 : 18,
        ),
      );
      const decimals = assets.map((_, i) => (i % 3 === 0 ? 8 : 18));
      world.comets.set(d.id, { base, assets, decimals });
      const comet = c.comet;
      const u = (w: unknown) => users(world.compound, w);
      tok(chain, comet, "c" + sym + "v3", dec);
      chain.contract(comet, {
        baseToken: () => base,
        balanceOf: ([w]) => u(w)?.supply ?? 0n,
        borrowBalanceOf: ([w]) => u(w)?.borrow ?? 0n,
        numAssets: () => n,
        getAssetInfo: ([i]) => ({
          offset: Number(i),
          asset: assets[Number(i)],
          priceFeed: simAddress(d.id + ":feed:" + i),
          scale: 10n ** BigInt(decimals[Number(i)]),
          borrowCollateralFactor: (8n * WAD) / 10n,
          liquidateCollateralFactor: (85n * WAD) / 100n,
          liquidationFactor: (9n * WAD) / 10n,
          supplyCap: 10n ** 30n,
        }),
        collateralBalanceOf: ([w, asset]) =>
          u(w)?.collateral[assets.indexOf(String(asset).toLowerCase())] ?? 0n,
        isBorrowCollateralized: () => true,
        isLiquidatable: () => false,
      });
      break;
    }
    case "erc4626": {
      const vault = c.vault;
      const under = tok(
        chain,
        simAddress(d.id + ":asset"),
        d.id.includes("sdai") ? "DAI" : "frxETH",
        18,
      );
      const shares = world.balances(chain.chainId, vault);
      tok(chain, vault, d.id.includes("sdai") ? "sDAI" : "sVAULT", 18);
      chain.contract(vault, {
        asset: () => under,
        convertToAssets: ([x]) => ((x as bigint) * 105n) / 100n,
      });
      void shares;
      break;
    }
    case "lido": {
      tok(chain, c.steth, "stETH", 18);
      tok(chain, c.wsteth, "wstETH", 18);
      chain.contract(c.wsteth, {
        getStETHByWstETH: ([x]) => ((x as bigint) * 118n) / 100n,
      });
      if (c.withdrawalQueue)
        chain.contract(c.withdrawalQueue, {
          getWithdrawalRequests: () => [],
          getWithdrawalStatus: () => [],
          getLastCheckpointIndex: () => 1n,
          findCheckpointHints: ([ids]) => (ids as bigint[]).map(() => 1n),
          getClaimableEther: ([ids]) => (ids as bigint[]).map(() => 0n),
        });
      break;
    }
    case "lst-rate": {
      const cfg = d.config!;
      tok(chain, c.token, d.id.split("-")[1] ?? "LST", 18);
      if (cfg.underlying === "token" && c.underlying)
        tok(chain, c.underlying, "eETH", 18);
      const rate = (105n * WAD) / 100n;
      chain.contract(c.converter, {
        [cfg.call]:
          cfg.mode === "convert"
            ? ([x]: readonly unknown[]) => ((x as bigint) * rate) / WAD
            : () => rate,
      } as SimContract["views"]);
      break;
    }
    case "eigenlayer": {
      for (const s of d.strategies ?? []) {
        tok(chain, s.underlying, s.symbol, 18);
        chain.contract(s.strategy, {
          underlyingToken: () => s.underlying,
          sharesToUnderlyingView: ([x]) => x as bigint,
        });
      }
      chain.contract(c.strategyManager, { getDeposits: () => [[], []] });
      chain.contract(c.delegationManager, {
        getWithdrawableShares: ([, list]) => [
          (list as string[]).map(() => 0n),
          (list as string[]).map(() => 0n),
        ],
        getQueuedWithdrawalRoots: () => [],
      });
      chain.contract(c.eigenPodManager, { podOwnerDepositShares: () => 0n });
      break;
    }
    case "uniswap-v3": {
      const pancake = d.variant === "pancake";
      const t0 = tok(chain, simAddress(d.id + ":t0"), "WETH", 18),
        t1 = tok(chain, simAddress(d.id + ":t1"), "USDC", 6);
      const [a0, a1] = t0 < t1 ? [t0, t1] : [t1, t0];
      const fee = 3000;
      const pool = simAddress(d.id + ":pool");
      chain.contract(pool);
      chain.contract(c.factory, {
        poolFor: ([x, y, f]) =>
          String(x).toLowerCase() === a0 &&
          String(y).toLowerCase() === a1 &&
          Number(f) === fee
            ? pool
            : ZERO,
      });
      const g = 10n ** 30n;
      chain.contract(pool, {
        factory: () => c.factory,
        token0: () => a0,
        token1: () => a1,
        fee: () => fee,
        [pancake ? "slot0Pancake" : "slot0"]: () => [
          2n ** 96n,
          0,
          0,
          1,
          1,
          0,
          true,
        ],
        tickSpacing: () => 60,
        feeGrowthGlobal0X128: () => g,
        feeGrowthGlobal1X128: () => g * 2n,
        ticks: () => [0n, 0n, g / 4n, g / 2n, 0n, 0n, 0, true],
      } as SimContract["views"]);
      const owned = () =>
        [...world.v3Positions.values()].filter((p) => p.deployment === d.id);
      chain.contract(c.manager, {
        balanceOf: ([w]) =>
          BigInt(
            owned().filter((p) => p.owner === String(w).toLowerCase()).length,
          ),
        tokenOfOwnerByIndex: ([w, i]) =>
          owned().filter((p) => p.owner === String(w).toLowerCase())[Number(i)]
            ?.tokenId ?? 0n,
        ownerOf: ([id]) => owned().find((p) => p.tokenId === id)?.owner ?? ZERO,
        factory: () => c.factory,
        ...(pancake ? { deployer: () => c.deployer } : {}),
        positions: () => [
          0n,
          ZERO,
          a0,
          a1,
          fee,
          -600,
          600,
          10n ** 15n,
          g / 8n,
          g / 4n,
          7n,
          9n,
        ],
      });
      break;
    }
    case "uniswap-v2": {
      const a = tok(chain, simAddress("v2:t0:" + chain.chainId), "WETH", 18),
        b = tok(chain, simAddress("v2:t1:" + chain.chainId), "USDC", 6);
      const [t0, t1] = a < b ? [a, b] : [b, a];
      const pair = simAddress(d.id + ":pair");
      tok(chain, pair, "UNI-V2", 18);
      world.pairs.push(chain.chainId + ":" + pair);
      chain.contract(d.contracts.factory, {
        getPair: ([x, y]) =>
          String(x).toLowerCase() === t0 && String(y).toLowerCase() === t1
            ? pair
            : ZERO,
        feeTo: () => ZERO,
      });
      world.balances(chain.chainId, t0).set(pair, 1000n * WAD);
      world.balances(chain.chainId, t1).set(pair, 2_000_000n * 10n ** 6n);
      chain.contract(pair, {
        factory: () => d.contracts.factory,
        token0: () => t0,
        token1: () => t1,
        totalSupply: () => 1000n * WAD,
        getReserves: () => [1000n * WAD, 2_000_000n * 10n ** 6n, 1],
        kLast: () => 0n,
      });
      break;
    }
    case "morpho-blue": {
      const loanTokens = ["USDC", "WETH", "USDT", "DAI"].map((s, i) =>
        tok(
          chain,
          simAddress("morpho:loan:" + i),
          s,
          s === "USDC" || s === "USDT" ? 6 : 18,
        ),
      );
      const collTokens = ["wstETH", "WBTC", "weETH", "sUSDe"].map((s, i) =>
        tok(chain, simAddress("morpho:coll:" + i), s, s === "WBTC" ? 8 : 18),
      );
      const reviewed = simAddress("morpho:oracle:reviewed"),
        other = simAddress("morpho:oracle:other");
      chain.contract(reviewed, {
        price: () => (10n ** 36n * 2000n) / 10n ** 12n,
      });
      chain.contract(other, { price: () => 10n ** 36n });
      // Registry lanes exist for the first simulated chain only (as for the accepted V1.14 Ethereum backfill).
      const count = chain.chainId === o.chains[0] ? (o.morphoMarkets ?? 0) : 0;
      for (let i = 0; i < count; i++) {
        const params = [
          loanTokens[i % 4],
          collTokens[(i >> 2) % 4],
          i % 3 === 0 ? reviewed : other,
          c.irm,
          // A unique wei offset keeps every synthetic market id distinct (ids are the hash of the parameters).
          ([86n, 77n, 91n, 94n][i % 4] * WAD) / 100n + BigInt(i),
        ] as const;
        const id = keccak256(
          encodeAbiParameters(
            [
              { type: "address" },
              { type: "address" },
              { type: "address" },
              { type: "address" },
              { type: "uint256" },
            ],
            params as unknown as readonly [Hex, Hex, Hex, Hex, bigint],
          ),
        );
        world.morphoMarkets.set(id, { params });
      }
      const ts = () => chain.timestamp - 100n;
      chain.contract(c.blue, {
        idToMarketParams: ([id]) =>
          world.morphoMarkets.get(String(id))?.params ?? [
            ZERO,
            ZERO,
            ZERO,
            ZERO,
            0n,
          ],
        position: ([id, w]) =>
          world.morphoPositions
            .get(String(w).toLowerCase())
            ?.get(String(id)) ?? [0n, 0n, 0n],
        market: () => [
          10n ** 24n,
          10n ** 30n,
          5n * 10n ** 23n,
          5n * 10n ** 29n,
          ts(),
          0n,
        ],
        feeRecipient: () => simAddress("morpho:fee"),
      });
      chain.contract(c.irm, { borrowRateView: () => 1585489599n });
      if (c.oracleFactory)
        chain.contract(c.oracleFactory, {
          isMorphoChainlinkOracleV2: ([x]) =>
            String(x).toLowerCase() === reviewed,
        });
      break;
    }
    case "morpho-vault": {
      const count = chain.chainId === o.chains[0] ? (o.morphoVaults ?? 0) : 0;
      const under = tok(chain, simAddress("morpho:vault:asset"), "USDC", 6);
      const set = new Set<string>();
      for (let i = 0; i < count; i++) {
        const v = simAddress(d.id + ":vault:" + i);
        set.add(v);
        world.morphoVaults.push(v);
        tok(chain, v, "mmUSDC" + i, 18);
        chain.contract(v, {
          asset: () => under,
          convertToAssets: ([x]) => (x as bigint) / 10n ** 12n,
        });
      }
      chain.contract(c.factory, {
        isMetaMorpho: ([v]) => set.has(String(v).toLowerCase()),
      });
      break;
    }
    case "curve": {
      const lp = simAddress(d.id + ":lp"),
        pool = simAddress(d.id + ":pool");
      const coins = ["DAI", "USDC", "USDT"].map((s, i) =>
        tok(chain, simAddress(d.id + ":coin:" + i), s, s === "DAI" ? 18 : 6),
      );
      tok(chain, lp, "3Crv", 18);
      world.curveLp.set(chain.chainId, lp);
      if (d.contracts.addressProvider)
        chain.contract(d.contracts.addressProvider, {
          get_address: ([i]) => (i === 7n ? d.contracts.metaRegistry : ZERO),
        });
      chain.contract(pool);
      const pad8 = <T>(xs: T[], z: T) => [
        ...xs,
        ...Array(8 - xs.length).fill(z),
      ];
      chain.contract(d.contracts.metaRegistry, {
        get_pool_from_lp_token: ([t]) =>
          String(t).toLowerCase() === lp ? pool : ZERO,
        get_gauge: () => ZERO,
        get_n_coins: () => 3n,
        get_coins: () => pad8(coins, ZERO),
        get_balances: () => pad8([10n ** 26n, 10n ** 14n, 10n ** 14n], 0n),
      });
      break;
    }
    case "balancer-v2": {
      const bpt = simAddress(d.id + ":bpt");
      const poolId = (bpt + "0002" + "0".repeat(20)) as Hex;
      const toks = ["WETH", "BAL"].map((s, i) =>
        tok(chain, simAddress(d.id + ":t:" + i), s, 18),
      );
      tok(chain, bpt, "B-80BAL-20WETH", 18);
      world.bpt.set(chain.chainId, bpt);
      chain.contract(bpt, {
        getPoolId: () => poolId,
        getActualSupply: () => 10n ** 24n,
      });
      chain.contract(d.contracts.weightedPoolFactory, {
        isPoolFromFactory: ([x]) => String(x).toLowerCase() === bpt,
      });
      chain.contract(d.contracts.vault, {
        getVaultPool: () => [bpt, 2],
        getPoolTokens: () => [toks, [10n ** 23n, 4n * 10n ** 23n], 1n],
      });
      break;
    }
    case "solidly-v2": {
      const pool = simAddress(d.id + ":pool");
      const t = ["WETH", "USDC"].map((s, i) =>
        tok(chain, simAddress(d.id + ":t:" + i), s, s === "USDC" ? 6 : 18),
      );
      tok(chain, pool, "vAMM-WETH/USDC", 18);
      world.solidlyPools.set(d.id, chain.chainId + ":" + pool);
      world.balances(chain.chainId, t[0]).set(pool, 100n * WAD);
      world.balances(chain.chainId, t[1]).set(pool, 200_000n * 10n ** 6n);
      chain.contract(d.contracts.poolFactory, {
        isPool: ([x]) => String(x).toLowerCase() === pool,
      });
      chain.contract(d.contracts.voter, { gauges: () => ZERO });
      chain.contract(pool, {
        token0: () => t[0],
        token1: () => t[1],
        stable: () => false,
      });
      break;
    }
  }
}
// ---------------------------------------------------------------------------------------------------------------
// Wallet profiles (synthetic wallets; never a real person's address).
export const SIM_WALLETS = {
  production: "0x00000000000000000000000000000000000a11ce",
  whale: "0x0000000000000000000000000000000000c011ec",
  zero: "0x0000000000000000000000000000000000000e70",
} as const;
export type SimProfile = keyof typeof SIM_WALLETS;
const setAave = (
  w: SimWorld,
  wallet: string,
  deploymentId: string,
  asset: string,
  u: AaveUser,
) => {
  const byDep = w.aave.get(wallet) ?? new Map();
  w.aave.set(wallet, byDep);
  const m = byDep.get(deploymentId) ?? new Map();
  byDep.set(deploymentId, m);
  m.set(asset, u);
  const d = deployments.find((x) => x.id === deploymentId)!;
  const a = d.assets!.find((x) => x.underlying === asset)!;
  // The wallet scan sees the receipt/debt tokens the protocol mints (the DeFi scan replaces them with the position).
  if (u.supply) w.balances(d.chainId, a.receipt).set(wallet, u.supply);
  const debt = (u.stableDebt ?? 0n) + (u.variableDebt ?? 0n);
  if (debt) w.balances(d.chainId, a.debt).set(wallet, debt);
};
/** Seeds a deterministic profile on chain 1 (and the receipt-family chains present in the world). */
export function seedProfile(w: SimWorld, profile: SimProfile, chainId = "1") {
  const wallet = SIM_WALLETS[profile];
  const chain = w.net.chains.get(chainId)!;
  chain.native.set(wallet, 3n * WAD);
  if (profile === "zero") return wallet;
  const aave = deployments.find((d) => d.id === `aave-v3-${chainId}`);
  if (profile === "whale" && aave) {
    // Treasury-like: supplied in most reviewed reserves, no debt, a claimable reward.
    for (const [i, a] of aave.assets!.entries())
      if (i % 4 !== 3)
        setAave(w, wallet, aave.id, a.underlying, {
          supply: 10n ** BigInt(a.decimals) * BigInt(100 + i),
          collateral: i % 2 === 0,
        });
    const reward = simAddress(aave.id + ":reward");
    w.aaveRewards.set(
      wallet,
      new Map([[aave.id, [{ token: reward, amount: 5n * WAD }]]]),
    );
    return wallet;
  }
  if (aave) {
    const by = (s: string) => aave.assets!.find((a) => a.symbol === s)!;
    setAave(w, wallet, aave.id, by("WETH").underlying, {
      supply: 10n * WAD,
      collateral: true,
    });
    setAave(w, wallet, aave.id, by("USDC").underlying, {
      supply: 25_000n * 10n ** 6n,
      collateral: true,
    });
    setAave(w, wallet, aave.id, by("USDT").underlying, {
      supply: 0n,
      variableDebt: 8_000n * 10n ** 6n,
    });
  }
  const comet = deployments.find((d) => d.id === `compound-${chainId}-usdc`);
  if (comet) {
    const info = w.comets.get(comet.id)!;
    w.compound.set(
      wallet,
      new Map([
        [
          comet.id,
          {
            supply: 5_000n * 10n ** 6n,
            borrow: 0n,
            collateral: info.assets.map(() => 0n),
          },
        ],
      ]),
    );
    w.balances(chainId, comet.contracts.comet).set(wallet, 5_000n * 10n ** 6n);
  }
  const lido = deployments.find((d) => d.id === `lido-${chainId}`);
  if (lido) w.balances(chainId, lido.contracts.wsteth).set(wallet, 3n * WAD);
  const reth = deployments.find((d) => d.id === `lst-reth-${chainId}`);
  if (reth) w.balances(chainId, reth.contracts.token).set(wallet, 2n * WAD);
  const sdai = deployments.find((d) => d.id === `erc4626-sdai-${chainId}`);
  if (sdai) w.balances(chainId, sdai.contracts.vault).set(wallet, 1_000n * WAD);
  const v3 = deployments.find((d) => d.id === `uniswap-v3-${chainId}`);
  if (v3)
    w.v3Positions.set("1", { tokenId: 777n, owner: wallet, deployment: v3.id });
  const pair = w.pairs.find((p) => p.startsWith(chainId + ":"));
  if (pair) w.balances(chainId, pair.split(":")[1]).set(wallet, 5n * WAD);
  const lp = w.curveLp.get(chainId);
  if (lp) w.balances(chainId, lp).set(wallet, 1_000n * WAD);
  const bpt = w.bpt.get(chainId);
  if (bpt) w.balances(chainId, bpt).set(wallet, 1_000n * WAD);
  // Receipt-family LP positions on the other simulated chains (Aerodrome / Velodrome basic pools).
  for (const pool of w.solidlyPools.values()) {
    const [c, a] = pool.split(":");
    w.balances(c, a).set(wallet, 3n * WAD);
  }
  const markets = [...w.morphoMarkets.keys()];
  if (markets.length) {
    // One supply position and one borrow against collateral in a market with a reviewed oracle.
    w.morphoPositions.set(
      wallet,
      new Map([
        [markets[markets.length >> 1], [10n ** 12n * 10n ** 6n, 0n, 0n]],
        [markets[0], [0n, 10n ** 29n / 10n ** 6n, 10n * WAD]],
      ]),
    );
  }
  if (w.morphoVaults.length)
    w.balances(chainId, w.morphoVaults[w.morphoVaults.length - 7]).set(
      wallet,
      2_500n * WAD,
    );
  return wallet;
}
/** Deterministic routing-price list for the simulated tokens (exact decimals; synthetic prices). */
export function simPriceRead(w: SimWorld) {
  return async (_path: string, params: Record<string, string>) => {
    const tokens: Record<string, unknown[]> = {};
    for (const chainId of params.chains.split(",")) {
      tokens[chainId] = [
        { address: ZERO, symbol: "ETH", decimals: 18, priceUSD: "2000" },
        ...[...w.tokenMeta.entries()]
          .filter(([k]) => k.startsWith(chainId + ":"))
          .filter(
            ([, m]) =>
              !/^(a|variableDebt|c)[A-Z]/.test(m.symbol) &&
              !/^mm|UNI-V2|3Crv|B-80|vAMM|sDAI/.test(m.symbol),
          )
          .map(([k, m]) => ({
            address: k.split(":")[1],
            symbol: m.symbol,
            decimals: m.decimals,
            priceUSD: String(usdPrice(m.symbol)),
          })),
      ];
    }
    return { tokens };
  };
}
