// VEINED-FIN-LIVE-20261115-01: the swap lane's READ-ONLY capability. The two configured operators of the ROUTE's chain
// (./transport.ts SWAP_LANE_RPC_POOL), addressed by index — never a URL from a caller — through the lane's own transport
// (redirect "error", no-store, timeout, 1 MB cap, no raw upstream error). One frozen method list; every eth_call /
// eth_estimateGas / eth_getCode / eth_getStorageAt names a contract of THAT route's pin set; account reads only for the
// lane record's account; no state override; explicit block numbers; only a route of the route table that is ENABLED.
// VEINED-MC1 (bridge lane): the same capability for the bridge lane's two chains (source and destination of ONE
// ENABLED pair), with the bridge pin sets as the only contracts, plus eth_getLogs ONLY on that chain's pinned SpokePool
// with fixed topics [FilledRelay | FundsDeposited, chain word, depositId word] and an explicit range of <= 100 blocks,
// and the ONE LI.FI quote of the pair for the record's account (transport-built fixed query).
import { SwapError } from "../model";
import { laneReadContracts } from "./pins";
import {
  BRIDGE_LANE_TOPICS,
  bridgePinsOf,
  bridgeReadContracts,
} from "./bridge-pins";
import {
  BRIDGE_LANE_SCOPE,
  bridgeChainById,
  pairById,
  type BridgeLanePair,
} from "./bridge-scope";
import { routeById, type SwapLaneRoute } from "./scope";
import {
  laneGetLogs,
  laneJsonRpc,
  laneLifiQuote,
  lanePool,
  SWAP_LANE_RPC_POOL,
} from "./transport";

/** The pool (read-only view for the gate; the transport itself is imported by this module alone). */
export { SWAP_LANE_RPC_POOL, lanePool };
export const SWAP_LANE_READ_METHODS: readonly string[] = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_simulateV1",
]);
/** The bridge lane's read methods: the swap lane's plus eth_getLogs (narrow shape below). */
export const BRIDGE_LANE_READ_METHODS: readonly string[] = Object.freeze([
  ...SWAP_LANE_READ_METHODS,
  "eth_getLogs",
]);
const BLOCK = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const WORD = /^0x[0-9a-f]{64}$/;
/** The route itself must be an entry of the frozen route table (not a look-alike object) and ENABLED. */
function routeProblem(route: unknown): string | null {
  const r = route as Readonly<SwapLaneRoute> | null;
  if (!r || typeof r !== "object" || routeById(r.id) !== r) return "ROUTE";
  return r.status === "ENABLED" ? null : "ROUTE_BLOCKED";
}
/** The shared read shape: `contracts` are the only contracts any read may name (lower case). */
function shapeProblem(
  methods: readonly string[],
  method: string,
  params: readonly unknown[],
  account: string | null,
  contracts: readonly string[],
): string | null {
  if (!methods.includes(method)) return "METHOD";
  if (!Array.isArray(params)) return "PARAMS";
  const contract = (a: unknown) =>
    typeof a === "string" && contracts.includes(a.toLowerCase());
  const own = (a: unknown) =>
    account !== null &&
    typeof a === "string" &&
    a.toLowerCase() === account.toLowerCase();
  const block = (b: unknown) => typeof b === "string" && BLOCK.test(b);
  switch (method) {
    case "eth_chainId":
    case "eth_blockNumber":
    case "eth_maxPriorityFeePerGas":
      return params.length === 0 ? null : "PARAMS";
    case "eth_getBlockByNumber":
      return params.length === 2 && block(params[0]) && params[1] === false
        ? null
        : "PARAMS";
    case "eth_getCode":
      return params.length === 2 && contract(params[0]) && block(params[1])
        ? null
        : "PARAMS";
    case "eth_getStorageAt":
      return params.length === 3 &&
        contract(params[0]) &&
        typeof params[1] === "string" &&
        HASH.test(params[1]) &&
        block(params[2])
        ? null
        : "PARAMS";
    case "eth_getBalance":
    case "eth_getTransactionCount":
      return params.length === 2 &&
        own(params[0]) &&
        (block(params[1]) || params[1] === "latest" || params[1] === "pending")
        ? null
        : "PARAMS";
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
      return params.length === 1 &&
        typeof params[0] === "string" &&
        HASH.test(params[0])
        ? null
        : "PARAMS";
    case "eth_simulateV1": {
      // One block of at most 8 plain calls from the record's account to pinned contracts; no state override, no
      // validation switch, no transfer tracing, explicit block.
      const o = params[0] as Record<string, unknown> | undefined;
      if (
        !o ||
        typeof o !== "object" ||
        params.length !== 2 ||
        !block(params[1])
      )
        return "PARAMS";
      if (
        Object.keys(o).sort().join(",") !==
          "blockStateCalls,traceTransfers,validation" ||
        o.validation !== false ||
        o.traceTransfers !== false
      )
        return "SIM_OPTIONS";
      const bsc = o.blockStateCalls as unknown[];
      if (!Array.isArray(bsc) || bsc.length !== 1) return "SIM_BLOCKS";
      const b0 = bsc[0] as Record<string, unknown>;
      if (!b0 || Object.keys(b0).join(",") !== "calls") return "SIM_OVERRIDE";
      const calls = b0.calls as Record<string, unknown>[];
      if (!Array.isArray(calls) || calls.length === 0 || calls.length > 8)
        return "SIM_CALLS";
      for (const k of calls) {
        if (
          !k ||
          typeof k !== "object" ||
          Object.keys(k).some((f) => !["from", "to", "data"].includes(f))
        )
          return "SIM_CALL_FIELD";
        if (
          !own(k.from) ||
          !contract(k.to) ||
          typeof k.data !== "string" ||
          k.data.length > 4096
        )
          return "SIM_CALL";
      }
      return null;
    }
    case "eth_call":
    case "eth_estimateGas": {
      const c = params[0] as Record<string, unknown> | undefined;
      if (
        !c ||
        typeof c !== "object" ||
        params.length !== 2 ||
        !block(params[1])
      )
        return "PARAMS";
      for (const k of Object.keys(c))
        if (!["from", "to", "data", "gas", "value"].includes(k))
          return "CALL_FIELD";
      if (!contract(c.to)) return "CONTRACT";
      if (c.from !== undefined && !own(c.from)) return "FROM";
      if (c.value !== undefined && c.value !== "0x0") return "VALUE";
      if (typeof c.data !== "string" || c.data.length > 4096) return "DATA";
      return null;
    }
  }
  return "METHOD";
}
/** Why one read is not inside the lane's narrow read shape for this route (null = allowed). */
export function laneReadProblem(
  method: string,
  params: readonly unknown[],
  account: string | null,
  route: Readonly<SwapLaneRoute>,
): string | null {
  const rp = routeProblem(route);
  if (rp) return rp;
  return shapeProblem(
    SWAP_LANE_READ_METHODS,
    method,
    params,
    account,
    laneReadContracts(route.id),
  );
}
/** The operator ids of the route's chain (display / evidence only). */
export function laneOperators(route: Readonly<SwapLaneRoute>): string[] {
  return (lanePool(route.chainId) ?? []).map((s) => s.operator);
}
export async function laneRead(
  route: Readonly<SwapLaneRoute>,
  operator: 0 | 1,
  method: string,
  params: readonly unknown[],
  account: string | null,
  signal: AbortSignal,
): Promise<unknown> {
  const problem = laneReadProblem(method, params, account, route);
  if (problem) throw new SwapError("REVIEW_REQUIRED");
  return laneJsonRpc(route.chainId, operator, method, params, signal);
}
type BothResult<T> = {
  values: [T | null, T | null];
  agree: boolean;
  errors: string[];
};
async function onBoth<T>(
  read: (op: 0 | 1) => Promise<unknown>,
  pick: (x: unknown) => unknown,
): Promise<BothResult<T>> {
  const r = await Promise.all(
    ([0, 1] as const).map((i) =>
      read(i).then(
        (v) => ({ v: v as T, e: null as string | null }),
        (e: unknown) => ({
          v: null,
          e: e instanceof SwapError ? e.code : "READ_FAILED",
        }),
      ),
    ),
  );
  const values: [T | null, T | null] = [r[0].v, r[1].v];
  const errors = r.map((x) => x.e).filter((e): e is string => e !== null);
  const agree =
    errors.length === 0 &&
    JSON.stringify(pick(values[0])) === JSON.stringify(pick(values[1]));
  return { values, agree, errors };
}
/** The same read on both operators. `agree` compares the JSON of `pick(result)`. */
export async function laneReadBoth<T = unknown>(
  route: Readonly<SwapLaneRoute>,
  method: string,
  params: readonly unknown[],
  account: string | null,
  signal: AbortSignal,
  pick: (x: unknown) => unknown = (x) => x,
): Promise<BothResult<T>> {
  return onBoth<T>(
    (i) => laneRead(route, i, method, params, account, signal),
    pick,
  );
}
export const isAddress = (a: unknown): a is string =>
  typeof a === "string" && ADDR.test(a);

// ---- VEINED-MC1: the bridge lane ------------------------------------------------------------------------------------
/** An ENABLED chain of the bridge table with its own pin set and a two-operator pool, else a problem code. */
function bridgeChainProblem(chainId: unknown): string | null {
  const c = bridgeChainById(chainId);
  if (!c || !bridgePinsOf(c.chainId) || !lanePool(c.chainId)) return "CHAIN";
  return c.status === "ENABLED" ? null : "CHAIN_BLOCKED";
}
/** eth_getLogs, bridge shape: the chain's pinned SpokePool, [topic0, word, word], an explicit range of <= 100 blocks. */
function logsProblem(
  chainId: string,
  params: readonly unknown[],
): string | null {
  const pins = bridgePinsOf(chainId);
  if (!pins || !Array.isArray(params) || params.length !== 1) return "PARAMS";
  const f = params[0] as Record<string, unknown> | null;
  if (
    !f ||
    typeof f !== "object" ||
    Array.isArray(f) ||
    Object.keys(f).sort().join(",") !== "address,fromBlock,toBlock,topics"
  )
    return "LOG_FILTER";
  if (
    typeof f.address !== "string" ||
    f.address.toLowerCase() !== pins.spokePool.address.toLowerCase()
  )
    return "LOG_ADDRESS";
  if (
    typeof f.fromBlock !== "string" ||
    typeof f.toBlock !== "string" ||
    !BLOCK.test(f.fromBlock) ||
    !BLOCK.test(f.toBlock)
  )
    return "LOG_RANGE";
  const from = BigInt(f.fromBlock),
    to = BigInt(f.toBlock);
  if (to < from || to - from + 1n > BigInt(BRIDGE_LANE_SCOPE.logWindowBlocks))
    return "LOG_RANGE";
  const t = f.topics as unknown[];
  if (
    !Array.isArray(t) ||
    t.length !== 3 ||
    (t[0] !== BRIDGE_LANE_TOPICS.filledRelay &&
      t[0] !== BRIDGE_LANE_TOPICS.fundsDeposited) ||
    !t.every((x) => typeof x === "string" && WORD.test(x))
  )
    return "LOG_TOPICS";
  return null;
}
/** Why one bridge-lane read on `chainId` is not inside the lane's narrow read shape (null = allowed). */
export function bridgeReadProblem(
  chainId: string,
  method: string,
  params: readonly unknown[],
  account: string | null,
): string | null {
  const cp = bridgeChainProblem(chainId);
  if (cp) return cp;
  if (method === "eth_getLogs") return logsProblem(chainId, params);
  return shapeProblem(
    BRIDGE_LANE_READ_METHODS,
    method,
    params,
    account,
    bridgeReadContracts(chainId),
  );
}
export async function bridgeRead(
  chainId: string,
  operator: 0 | 1,
  method: string,
  params: readonly unknown[],
  account: string | null,
  signal: AbortSignal,
): Promise<unknown> {
  const problem = bridgeReadProblem(chainId, method, params, account);
  if (problem) throw new SwapError("REVIEW_REQUIRED");
  return method === "eth_getLogs"
    ? laneGetLogs(chainId, operator, params[0], signal)
    : laneJsonRpc(chainId, operator, method, params, signal);
}
/** The same bridge read on both operators of `chainId`. `agree` compares the JSON of `pick(result)`. */
export async function bridgeReadBoth<T = unknown>(
  chainId: string,
  method: string,
  params: readonly unknown[],
  account: string | null,
  signal: AbortSignal,
  pick: (x: unknown) => unknown = (x) => x,
): Promise<BothResult<T>> {
  return onBoth<T>(
    (i) => bridgeRead(chainId, i, method, params, account, signal),
    pick,
  );
}
/** The ONE LI.FI quote of an ENABLED pair (a frozen table entry) for `account`: from = to = account, 5 USDC. */
export async function bridgeLifiQuote(
  pair: Readonly<BridgeLanePair>,
  account: string,
  signal: AbortSignal,
): Promise<unknown> {
  if (
    !pair ||
    typeof pair !== "object" ||
    pairById(pair.id) !== pair ||
    pair.status !== "ENABLED" ||
    bridgeChainProblem(pair.source) ||
    bridgeChainProblem(pair.destination) ||
    !isAddress(account)
  )
    throw new SwapError("REVIEW_REQUIRED");
  return laneLifiQuote(
    {
      fromChain: pair.source,
      toChain: pair.destination,
      fromToken: bridgeChainById(pair.source)!.usdc.address,
      toToken: bridgeChainById(pair.destination)!.usdc.address,
      fromAmount: pair.exactAmount.toString(),
      account,
    },
    signal,
  );
}
