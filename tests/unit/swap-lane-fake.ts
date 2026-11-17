// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): TEST-ONLY in-memory doubles for the swap lane engine — a programmable
// two-operator FAKE CHAIN (LaneChain) for ANY route of the route table (default: the reviewed Base route), an in-memory
// journal (of / append / batch / entries; a batch commits atomically, a throw inside it discards every buffered line)
// and a recording FAKE SIGNER. Not a test file itself (no *.test.ts).
// Every read the engine makes is checked against the lane's own read shape for the chain's route (laneReadProblem): a
// read the production transport would refuse is recorded in `violations` and fails on that operator, as laneRead would.
// SYNTHETIC_TEST_ONLY: the owner 0x3333…3333, its key, every hash, balance and fee are synthetic (the per-route pool
// prices are the evidence's slot0 values, so the spot math is checked against real numbers). Nothing here signs, sends
// or reaches a network.
import { createHash } from "node:crypto";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  stringToHex,
  type Hex,
} from "viem";
import {
  SWAP_LANE_APPROVAL_VERSION,
  SWAP_LANE_KEY_DOMAIN,
  swapLaneGateState,
  type OwnerSwapLaneApproval,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import {
  SWAP_LANE_ROUTE_PINS,
  pinnedContracts,
  type LaneRoutePins,
} from "../../src/swap/lane/pins";
import {
  SWAP_LANE_ROUTES,
  type SwapLaneRoute,
} from "../../src/swap/lane/scope";
import { laneReadProblem } from "../../src/swap/lane/reads";
import {
  SwapLaneEngine,
  type LaneChain,
  type LaneDeps,
  type LaneSigner,
} from "../../src/swap/lane/engine";
import type {
  LaneSignerResult,
  LaneTx,
} from "../../src/swap/lane/signer-adapter";
import type {
  CanaryDurableStore,
  StoreEntry,
} from "../../src/execution/server/canary/durable-store";
import {
  fakeStatus,
  fakeStatusBody,
  type FakeSignature,
} from "./lane-fake-signer-status";

/** The reviewed Base route: the default fixture of every lane test. */
export const BASE = "base-usdc-weth-univ3-max1";
export const BASE_ROUTE: Readonly<SwapLaneRoute> = SWAP_LANE_ROUTES[BASE];
export const BASE_PINS: Readonly<LaneRoutePins> = SWAP_LANE_ROUTE_PINS[BASE];
export const ENABLED_ROUTE_IDS = Object.values(SWAP_LANE_ROUTES)
  .filter((r) => r.status === "ENABLED")
  .map((r) => r.id);
export const BLOCKED_ROUTE_IDS = Object.values(SWAP_LANE_ROUTES)
  .filter((r) => r.status === "BLOCKED")
  .map((r) => r.id);
export const OWNER = "0x3333333333333333333333333333333333333333";
export const OTHER = "0x4444444444444444444444444444444444444444";
export const OWNER_KEY = "5e".repeat(32);
export const KEY_DIGEST = createHash("sha256")
  .update(`${SWAP_LANE_KEY_DOMAIN}:${OWNER_KEY}`, "utf8")
  .digest("hex");
export const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
export const HOUR = 3_600_000;
export const AMOUNT = 1_000_000n;
/** The owner's nonce when the synthetic record was armed (the lane journal is anchored to it). */
export const FIRST_NONCE = 7n;
/** A synthetic record of `routeId` (exactly the route's maximum, its full gas budget). */
export function recordFor(
  routeId: string,
  over: Partial<OwnerSwapLaneApproval> = {},
): Readonly<OwnerSwapLaneApproval> {
  const r = SWAP_LANE_ROUTES[routeId],
    p = SWAP_LANE_ROUTE_PINS[routeId];
  return Object.freeze({
    version: SWAP_LANE_APPROVAL_VERSION,
    approvalId: "0x" + "1a".repeat(32),
    route: r.id,
    scope: r.id,
    pinSet: p.set,
    account: OWNER,
    chainId: r.chainId,
    tokenIn: r.pay.address,
    tokenOut: r.receive.address,
    router: r.router,
    exactAmount: r.maxAmount.toString(),
    maxSlippageBps: 50,
    nativeGasBudgetWei: r.gasBudgetWei.toString(),
    firstNonce: FIRST_NONCE.toString(),
    notBefore: NOW - HOUR,
    notAfter: NOW + 6 * HOUR,
    singleUse: true,
    allowanceCleanup: "ZERO_REVOKE_ONLY",
    ...over,
  } as OwnerSwapLaneApproval);
}
export const RECORD: Readonly<OwnerSwapLaneApproval> = recordFor(BASE);
/** The fake runtime code of each pinned contract (the engine tests pin keccak256 of exactly these bytes). */
export const fakeCodeOf = (address: string) =>
  ("0x60806040" + address.slice(2).toLowerCase()) as Hex;
export const contractsOf = (routeId: string) =>
  pinnedContracts(SWAP_LANE_ROUTE_PINS[routeId]);
export const LANE_CONTRACTS = contractsOf(BASE);
/** sqrtPriceX96 of the Base USDC/WETH pool (token0 = WETH, token1 = USDC) at ~3 000 USDC per WETH. */
export const SQRT_P = 4_339_505_179_874_779_672_736_325n;
/** Per-route chain fixtures. The non-Base slot0 prices are the evidence's (BC-tokens-swap.json best pool), with the
 * evidence's own spot output for 1 USDC, so the engine's spot math is checked against an independent number. */
export interface RouteFixture {
  sqrtP: bigint;
  /** The evidence's spotOutFor1Usdc at sqrtP (null: none recorded). */
  evidenceSpotOut: bigint | null;
  baseFee: bigint;
  tip: bigint;
  /** OP-stack L1 data fee per transaction (wei). */
  l1Fee: bigint;
  /** Arbitrum: L1 component as extra gas units in eth_estimateGas (0 elsewhere). */
  l1Gas: { APPROVE: bigint; SWAP: bigint };
  eth: bigint;
}
export const FIXTURES: Record<string, RouteFixture> = {
  [BASE]: {
    sqrtP: SQRT_P,
    evidenceSpotOut: null,
    baseFee: 5_000_000n,
    tip: 1_000_000n,
    l1Fee: 5_000_000_000n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 1_000_000_000_000_000n,
  },
  "eth-usdc-weth-univ3-max1": {
    sqrtP: 1_852_099_936_216_560_349_623_962_360_988_415n,
    evidenceSpotOut: 546_474_203_914_121n,
    baseFee: 195_588_636n,
    tip: 50_000_000n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 1_000_000_000_000_000n,
  },
  "arb-usdc-weth-univ3-max1": {
    sqrtP: 3_389_632_294_661_681_148_739_001n,
    evidenceSpotOut: 546_328_667_688_179n,
    baseFee: 20_038_000n,
    tip: 0n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 900n, SWAP: 1_626n },
    eth: 1_000_000_000_000_000n,
  },
  "op-usdc-weth-univ3-max1": {
    sqrtP: 1_852_029_374_876_203_776_681_995_005_058_654n,
    evidenceSpotOut: 546_432_565_537_038n,
    baseFee: 536n,
    tip: 1_000_000n,
    l1Fee: 2_454_950_365n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 1_000_000_000_000_000n,
  },
  "pol-usdc-wpol-univ3-max1": {
    sqrtP: 22_563_631_162_006_140_786_087n,
    evidenceSpotOut: 12_329_378_457_575_580_865n,
    baseFee: 252_496_198_643n,
    tip: 30_000_000_000n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 10_000_000_000_000_000_000n,
  },
  "bnb-usdc-wbnb-univ3-max1": {
    sqrtP: 3_254_661_387_973_869_306_300_496_001n,
    evidenceSpotOut: 1_687_533_705_348_724n,
    baseFee: 0n,
    tip: 50_000_000n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 1_000_000_000_000_000n,
  },
  "avax-usdc-wavax-univ3-max1": {
    sqrtP: 214_098_838_313_312_304_709_116n,
    evidenceSpotOut: 136_940_070_082_131_708n,
    baseFee: 7_500_000_000n,
    tip: 150n,
    l1Fee: 0n,
    l1Gas: { APPROVE: 0n, SWAP: 0n },
    eth: 1_000_000_000_000_000_000n,
  },
};
/** The pool's spot output, computed here independently of src/swap/lane/calldata.ts spotOutFor. */
export const spotOutFor = (
  amountIn: bigint,
  sqrtP = SQRT_P,
  payIsToken0 = false,
) =>
  payIsToken0
    ? (amountIn * sqrtP * sqrtP) / 2n ** 192n
    : (amountIn * 2n ** 192n) / (sqrtP * sqrtP);
const spotOf = (routeId: string, amountIn: bigint) =>
  spotOutFor(
    amountIn,
    FIXTURES[routeId].sqrtP,
    SWAP_LANE_ROUTES[routeId].payIsToken0,
  );
/** A quote `bps` below the pool's spot price (the engine's price impact of it is exactly `bps`). */
export const quoteAtImpact = (
  bps: number,
  amountIn = AMOUNT,
  routeId: string = BASE,
) => (spotOf(routeId, amountIn) * BigInt(10_000 - bps)) / 10_000n;
/** ceil(q * (10000 - s) / 10000), computed here independently. */
export const ceilMin = (q: bigint, s: number) => {
  const n = q * BigInt(10_000 - s);
  return n / 10_000n + (n % 10_000n === 0n ? 0n : 1n);
};

// ---- hand-built calldata (independent of src/swap/lane/calldata.ts) -------------------------------------------
export const w = (x: bigint | number | string) =>
  typeof x === "string"
    ? x.toLowerCase().replace(/^0x/, "").padStart(64, "0")
    : BigInt(x).toString(16).padStart(64, "0");
export const handApprove = (
  amount: bigint,
  spender: string = BASE_ROUTE.router,
) => "0x095ea7b3" + w(spender) + w(amount);
export const handSwap = (
  p: {
    owner: string;
    amountIn: bigint;
    minOut: bigint;
    deadline: bigint;
  },
  routeId: string = BASE,
) => {
  const r = SWAP_LANE_ROUTES[routeId];
  const inner =
    "04e45aaf" +
    w(r.pay.address) +
    w(r.receive.address) +
    w(r.poolFee) +
    w(p.owner) +
    w(p.amountIn) +
    w(p.minOut) +
    w(0);
  // 228 inner bytes -> padded to 256
  return (
    "0x5ae401dc" +
    w(p.deadline) +
    w(0x40) +
    w(1) +
    w(0x20) +
    w(inner.length / 2) +
    inner.padEnd(512, "0")
  );
};

// ---- independent ABIs ------------------------------------------------------------------------------------------
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);
const FACTORY = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
const POOL = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function fee() view returns (uint24)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
]);
const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const ROUTER = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
const NODE_INTERFACE = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
const ORACLE = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);
const sel = (abi: readonly unknown[], name: string, args: readonly unknown[]) =>
  (
    encodeFunctionData as unknown as (p: {
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }) => string
  )({ abi, functionName: name, args }).slice(0, 10);
const Z = "0x0000000000000000000000000000000000000000";
const SEL = {
  balanceOf: sel(ERC20, "balanceOf", [Z]),
  allowance: sel(ERC20, "allowance", [Z, Z]),
  approve: sel(ERC20, "approve", [Z, 0n]),
  getPool: sel(FACTORY, "getPool", [Z, Z, 0]),
  token0: sel(POOL, "token0", []),
  token1: sel(POOL, "token1", []),
  fee: sel(POOL, "fee", []),
  slot0: sel(POOL, "slot0", []),
  quote: sel(QUOTER, "quoteExactInputSingle", [
    { tokenIn: Z, tokenOut: Z, amountIn: 0n, fee: 0, sqrtPriceLimitX96: 0n },
  ]),
  multicall: sel(ROUTER, "multicall", [0n, []]),
  getL1Fee: sel(ORACLE, "getL1Fee", ["0x"]),
  getOperatorFee: sel(ORACLE, "getOperatorFee", [0n]),
  l1Component: sel(NODE_INTERFACE, "gasEstimateL1Component", [Z, false, "0x"]),
};
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const lc = (a: string) => a.toLowerCase();

export interface FakeLog {
  address: string;
  topics: string[];
  data: string;
}
export interface FakeReceipt {
  transactionHash: string;
  status: "0x1" | "0x0";
  blockNumber: string;
  blockHash: string;
  gasUsed: string;
  effectiveGasPrice: string;
  /** OP-stack chains only (as on the real chains). */
  l1Fee?: string;
  logs: FakeLog[];
  from: string;
  to: string;
}
interface Balances {
  usdc: bigint;
  weth: bigint;
  allowance: bigint;
}
type Both<T> = {
  values: [T | null, T | null];
  agree: boolean;
  errors: string[];
};
/** Per-operator tamper: return undefined to keep the honest answer, any other value (null included) to replace it,
 * or throw to make that operator fail the read. */
export type Tamper = (
  op: 0 | 1,
  method: string,
  params: readonly unknown[],
  honest: unknown,
) => unknown;

export class FakeChain implements LaneChain {
  readonly route: Readonly<SwapLaneRoute>;
  readonly pins: Readonly<LaneRoutePins>;
  readonly A: {
    usdc: string;
    weth: string;
    router: string;
    quoter: string;
    factory: string;
    pool: string;
    oracle: string | null;
  };
  head = 57_814_300n;
  usdc: bigint;
  weth = 0n;
  eth: bigint;
  allowance = 0n;
  sqrtP: bigint;
  quoteOut: bigint;
  /** What the router actually pays out (null: the quote). */
  swapOut: bigint | null = null;
  baseFee: bigint;
  tip: bigint;
  l1Fee: bigint;
  /** OP-stack (Isthmus) operator fee per getOperatorFee(gas) call (0 on the evidence chains). */
  operatorFee = 0n;
  l1Gas: { APPROVE: bigint; SWAP: bigint };
  gas = { APPROVE: 46_000n, SWAP: 150_000n };
  /** Seconds the head block lags behind the clock. */
  lagSec = 1;
  code = new Map<string, string>();
  impl: string | null;
  /** Block number -> fork salt (a different salt = a different block hash at that height, i.e. a reorg). */
  forks = new Map<bigint, string>();
  receipts = new Map<string, FakeReceipt>();
  pending = new Map<string, LaneTx>();
  /** Every transaction ever handed in (pending or mined), by hash: what eth_getTransactionByHash answers. */
  sent = new Map<string, LaneTx>();
  /** The owner's nonce before any transaction this fake has seen (each mined owner tx, even a revert, adds one). */
  baseNonce = FIRST_NONCE;
  /** The next mined transaction reverts (receipt status 0x0, no state change). */
  failNext = false;
  tamper: Tamper | null = null;
  violations: string[] = [];
  log: { method: string; params: readonly unknown[] }[] = [];
  #n = 0;
  constructor(
    public readonly now: () => number,
    routeId: string = BASE,
  ) {
    this.route = SWAP_LANE_ROUTES[routeId];
    this.pins = SWAP_LANE_ROUTE_PINS[routeId];
    const f = FIXTURES[routeId];
    this.A = {
      usdc: lc(this.route.pay.address),
      weth: lc(this.route.receive.address),
      router: lc(this.route.router),
      quoter: lc(this.route.quoter),
      factory: lc(this.route.factory),
      pool: lc(this.route.pool),
      oracle: this.pins.gasPriceOracle ? lc(this.pins.gasPriceOracle) : null,
    };
    this.usdc = 5n * this.route.maxAmount;
    this.eth = f.eth;
    this.sqrtP = f.sqrtP;
    this.quoteOut = quoteAtImpact(10, this.route.maxAmount, routeId);
    this.baseFee = f.baseFee;
    this.tip = f.tip;
    this.l1Fee = f.l1Fee;
    this.l1Gas = { ...f.l1Gas };
    this.impl = this.pins.pay.implementation?.address ?? null;
    for (const p of pinnedContracts(this.pins))
      this.code.set(lc(p.address), fakeCodeOf(p.address));
  }
  get opStack() {
    return this.route.feeModel === "OP_STACK";
  }
  blockHash(n: bigint) {
    return keccak256(
      stringToHex(
        `fake-${this.route.id}-block:${n}:${this.forks.get(n) ?? ""}`,
      ),
    );
  }
  blockTimeSec(n: bigint) {
    return (
      Math.floor(this.now() / 1000) - this.lagSec - 2 * Number(this.head - n)
    );
  }
  quoteFor(amountIn: bigint) {
    return (this.quoteOut * amountIn) / this.route.maxAmount;
  }
  async both<T = unknown>(
    method: string,
    params: readonly unknown[],
    pick: (x: unknown) => unknown = (x) => x,
  ): Promise<Both<T>> {
    this.log.push({ method, params });
    const r = ([0, 1] as const).map((op) => {
      try {
        return {
          v: this.#answer(op, method, params) as T,
          e: null as string | null,
        };
      } catch (e) {
        return { v: null, e: e instanceof Error ? e.message : "READ_FAILED" };
      }
    });
    const values: [T | null, T | null] = [r[0].v, r[1].v];
    const errors = r.map((x) => x.e).filter((e): e is string => e !== null);
    const agree =
      errors.length === 0 &&
      JSON.stringify(pick(values[0])) === JSON.stringify(pick(values[1]));
    return { values, agree, errors };
  }
  #answer(op: 0 | 1, method: string, params: readonly unknown[]): unknown {
    const problem = laneReadProblem(method, params, OWNER, this.route);
    if (problem) {
      this.violations.push(`${method}:${problem}`);
      throw new Error("REVIEW_REQUIRED");
    }
    const honest = this.#honest(method, params);
    if (this.tamper) {
      const t = this.tamper(op, method, params, honest);
      if (t !== undefined) return t;
    }
    return honest;
  }
  #honest(method: string, p: readonly unknown[]): unknown {
    switch (method) {
      case "eth_chainId":
        return hex(BigInt(this.route.chainId));
      case "eth_blockNumber":
        return hex(this.head);
      case "eth_getBlockByNumber": {
        const n = BigInt(p[0] as string);
        if (n > this.head) return null;
        return {
          number: hex(n),
          hash: this.blockHash(n),
          timestamp: hex(this.blockTimeSec(n)),
          baseFeePerGas: hex(this.baseFee),
        };
      }
      case "eth_getCode":
        return this.code.get(lc(p[0] as string)) ?? "0x";
      case "eth_getStorageAt": {
        const impl = this.pins.pay.implementation;
        return impl &&
          this.impl &&
          lc(p[0] as string) === this.A.usdc &&
          lc(p[1] as string) === lc(impl.slot)
          ? "0x" + w(this.impl)
          : word(0n);
      }
      case "eth_call": {
        const c = p[0] as { to: string; data: string };
        return this.#call(c.to, c.data, this);
      }
      case "eth_estimateGas": {
        // The transaction alone on the current state, plus the chain's L1 component (Arbitrum) as gas units.
        const c = p[0] as { from: string; to: string; data: string };
        const s: Balances = {
          usdc: this.usdc,
          weth: this.weth,
          allowance: this.allowance,
        };
        const [res] = this.#simulateOn(s, [c]);
        if (res.status !== "0x1") throw new Error("SIMULATION_FAILED");
        const f = c.data.slice(0, 10).toLowerCase();
        return hex(
          BigInt(res.gasUsed) +
            (f === SEL.approve ? this.l1Gas.APPROVE : this.l1Gas.SWAP),
        );
      }
      case "eth_getBalance":
        return hex(this.eth);
      case "eth_getTransactionCount": {
        if (lc(p[0] as string) !== lc(OWNER)) return "0x0";
        return hex(
          p[1] === "pending"
            ? this.nonceAt(this.head) + this.ownerPending()
            : this.nonceAt(
                p[1] === "latest" ? this.head : BigInt(p[1] as string),
              ),
        );
      }
      case "eth_maxPriorityFeePerGas":
        return hex(this.tip);
      case "eth_simulateV1": {
        const o = p[0] as {
          blockStateCalls: {
            calls: { from: string; to: string; data: string }[];
          }[];
        };
        return [
          {
            number: hex(this.head + 1n),
            calls: this.#simulate(o.blockStateCalls[0].calls),
          },
        ];
      }
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(lc(p[0] as string));
        return r && BigInt(r.blockNumber) <= this.head
          ? structuredClone(r)
          : null;
      }
      case "eth_getTransactionByHash": {
        const h = lc(p[0] as string);
        const tx = this.sent.get(h);
        if (!tx) return null;
        const r = this.receipts.get(h);
        const mined = !!r && BigInt(r.blockNumber) <= this.head;
        return {
          hash: h,
          from: lc(tx.from),
          to: lc(tx.to),
          input: tx.data,
          value: tx.value,
          blockNumber: mined ? r.blockNumber : null,
          blockHash: mined ? r.blockHash : null,
        };
      }
    }
    throw new Error(`UNEXPECTED_METHOD:${method}`);
  }
  #call(to: string, data: string, s: Balances): string {
    const A = this.A,
      R = this.route;
    const t = lc(to),
      f = data.slice(0, 10).toLowerCase();
    const arg = (i: number) =>
      "0x" + data.slice(10 + 64 * i + 24, 10 + 64 * (i + 1));
    if (t === A.factory && f === SEL.getPool) {
      const a0 = lc(arg(0)),
        a1 = lc(arg(1));
      const ok =
        ((a0 === A.usdc && a1 === A.weth) ||
          (a0 === A.weth && a1 === A.usdc)) &&
        BigInt("0x" + data.slice(138, 202)) === BigInt(R.poolFee);
      return "0x" + w(ok ? A.pool : Z);
    }
    if (t === A.pool && f === SEL.token0)
      return "0x" + w(R.payIsToken0 ? A.usdc : A.weth);
    if (t === A.pool && f === SEL.token1)
      return "0x" + w(R.payIsToken0 ? A.weth : A.usdc);
    if (t === A.pool && f === SEL.fee) return word(BigInt(R.poolFee));
    if (t === A.pool && f === SEL.slot0)
      return encodeAbiParameters(
        [
          { type: "uint160" },
          { type: "int24" },
          { type: "uint16" },
          { type: "uint16" },
          { type: "uint16" },
          { type: "uint8" },
          { type: "bool" },
        ],
        [this.sqrtP, -196_000, 1, 2, 2, 0, true],
      );
    if (t === A.quoter && f === SEL.quote) {
      const d = decodeFunctionData({ abi: QUOTER, data: data as Hex });
      const q = d.args[0];
      if (
        lc(q.tokenIn) !== A.usdc ||
        lc(q.tokenOut) !== A.weth ||
        q.fee !== R.poolFee
      )
        throw new Error("QUOTE_SHAPE");
      return encodeFunctionResult({
        abi: QUOTER,
        functionName: "quoteExactInputSingle",
        result: [this.quoteFor(q.amountIn), this.sqrtP, 1, 80_000n],
      });
    }
    if (t === A.usdc && f === SEL.balanceOf)
      return word(lc(arg(0)) === lc(OWNER) ? s.usdc : 0n);
    if (t === A.usdc && f === SEL.allowance)
      return word(
        lc(arg(0)) === lc(OWNER) && lc(arg(1)) === A.router ? s.allowance : 0n,
      );
    if (t === A.weth && f === SEL.balanceOf)
      return word(lc(arg(0)) === lc(OWNER) ? s.weth : 0n);
    if (A.oracle && t === A.oracle && f === SEL.getL1Fee)
      return word(this.l1Fee);
    if (A.oracle && t === A.oracle && f === SEL.getOperatorFee)
      return word(this.operatorFee);
    if (
      t === "0x00000000000000000000000000000000000000c8" &&
      this.route.feeModel === "ARBITRUM" &&
      f === SEL.l1Component
    ) {
      const inner = decodeFunctionData({
        abi: NODE_INTERFACE,
        data: data as Hex,
      }).args[2] as string;
      return encodeAbiParameters(
        [{ type: "uint64" }, { type: "uint256" }, { type: "uint256" }],
        [
          inner.slice(0, 10).toLowerCase() === SEL.approve
            ? this.l1Gas.APPROVE
            : this.l1Gas.SWAP,
          this.baseFee,
          30_000_000_000n,
        ],
      );
    }
    throw new Error(`UNEXPECTED_CALL:${t}:${f}`);
  }
  /** Applies one router multicall to `s`; null = it reverts. */
  #swap(s: Balances, data: string, timestamp: number) {
    try {
      const m = decodeFunctionData({ abi: ROUTER, data: data as Hex });
      if (m.functionName !== "multicall") return null;
      const [deadline, calls] = m.args as readonly [bigint, readonly Hex[]];
      if (deadline < BigInt(timestamp) || calls.length !== 1) return null;
      const e = decodeFunctionData({ abi: ROUTER, data: calls[0] });
      if (e.functionName !== "exactInputSingle") return null;
      const p = (
        e.args as readonly [
          {
            tokenIn: string;
            tokenOut: string;
            fee: number;
            recipient: string;
            amountIn: bigint;
            amountOutMinimum: bigint;
          },
        ]
      )[0];
      if (
        lc(p.tokenIn) !== this.A.usdc ||
        lc(p.tokenOut) !== this.A.weth ||
        p.fee !== this.route.poolFee
      )
        return null;
      if (s.allowance < p.amountIn || s.usdc < p.amountIn) return null;
      const out = this.swapOut ?? this.quoteFor(p.amountIn);
      if (out < p.amountOutMinimum) return null;
      s.usdc -= p.amountIn;
      s.allowance -= p.amountIn;
      if (lc(p.recipient) === lc(OWNER)) s.weth += out;
      return { amountIn: p.amountIn, out, recipient: lc(p.recipient) };
    } catch {
      return null;
    }
  }
  #simulateOn(
    s: Balances,
    calls: { from: string; to: string; data: string }[],
  ) {
    const ts = this.blockTimeSec(this.head) + 2;
    return calls.map((c) => {
      const t = lc(c.to),
        f = c.data.slice(0, 10).toLowerCase();
      if (t === this.A.usdc && f === SEL.approve) {
        s.allowance = BigInt("0x" + c.data.slice(74, 138));
        return {
          status: "0x1",
          returnData: word(1n),
          gasUsed: hex(this.gas.APPROVE),
          logs: [],
        };
      }
      if (t === this.A.router && f === SEL.multicall) {
        const r = this.#swap(s, c.data, ts);
        return r
          ? {
              status: "0x1",
              returnData: "0x",
              gasUsed: hex(this.gas.SWAP),
              logs: [],
            }
          : {
              status: "0x0",
              returnData: "0x",
              gasUsed: hex(30_000n),
              logs: [],
            };
      }
      try {
        return {
          status: "0x1",
          returnData: this.#call(c.to, c.data, s),
          gasUsed: hex(26_000n),
          logs: [],
        };
      } catch {
        return {
          status: "0x0",
          returnData: "0x",
          gasUsed: hex(21_000n),
          logs: [],
        };
      }
    });
  }
  #simulate(calls: { from: string; to: string; data: string }[]) {
    return this.#simulateOn(
      { usdc: this.usdc, weth: this.weth, allowance: this.allowance },
      calls,
    );
  }
  // ---- the "network" side: a signer hands a transaction in, a block includes it ------------------------------
  submit(tx: LaneTx): string {
    const hash = keccak256(
      stringToHex(`fake-tx:${++this.#n}:${JSON.stringify(tx)}`),
    );
    this.pending.set(hash, { ...tx });
    this.sent.set(lc(hash), { ...tx });
    return hash;
  }
  /** The owner's nonce at a block: the base plus every mined owner transaction up to it. */
  nonceAt(block: bigint): bigint {
    let n = this.baseNonce;
    for (const r of this.receipts.values())
      if (lc(r.from) === lc(OWNER) && BigInt(r.blockNumber) <= block) n++;
    return n;
  }
  ownerPending(): bigint {
    return BigInt(
      [...this.pending.values()].filter((t) => lc(t.from) === lc(OWNER)).length,
    );
  }
  /** Includes every pending transaction in the next block; returns that block number. */
  mine(): bigint {
    const A = this.A;
    const n = this.head + 1n;
    this.head = n;
    const ts = this.blockTimeSec(n);
    for (const [hash, tx] of this.pending) {
      const fail = this.failNext;
      this.failNext = false;
      let status: "0x1" | "0x0" = "0x0";
      const logs: FakeLog[] = [];
      let gasUsed = 30_000n;
      const f = tx.data.slice(0, 10).toLowerCase();
      if (
        !fail &&
        lc(tx.from) === lc(OWNER) &&
        lc(tx.to) === A.usdc &&
        f === SEL.approve
      ) {
        const amount = BigInt("0x" + tx.data.slice(74, 138));
        this.allowance = amount;
        status = "0x1";
        gasUsed = this.gas.APPROVE;
        logs.push(this.erc20Log(A.usdc, "Approval", OWNER, A.router, amount));
      } else if (
        !fail &&
        lc(tx.from) === lc(OWNER) &&
        lc(tx.to) === A.router &&
        f === SEL.multicall
      ) {
        const r = this.#swap(this, tx.data, ts);
        if (r) {
          status = "0x1";
          gasUsed = this.gas.SWAP;
          logs.push(
            this.erc20Log(A.weth, "Transfer", A.pool, r.recipient, r.out),
          );
          logs.push(
            this.erc20Log(A.usdc, "Transfer", OWNER, A.pool, r.amountIn),
          );
        }
      }
      this.receipts.set(lc(hash), {
        transactionHash: hash,
        status,
        blockNumber: hex(n),
        blockHash: this.blockHash(n),
        gasUsed: hex(gasUsed),
        effectiveGasPrice: hex(this.baseFee + this.tip),
        ...(this.opStack ? { l1Fee: hex(this.l1Fee) } : {}),
        logs,
        from: lc(tx.from),
        to: lc(tx.to),
      });
      this.eth -=
        gasUsed * (this.baseFee + this.tip) + (this.opStack ? this.l1Fee : 0n);
    }
    this.pending.clear();
    return n;
  }
  advance(blocks: number) {
    this.head += BigInt(blocks);
  }
  erc20Log(
    token: string,
    name: "Transfer" | "Approval",
    a: string,
    b: string,
    value: bigint,
  ): FakeLog {
    const topics =
      name === "Transfer"
        ? encodeEventTopics({
            abi: ERC20,
            eventName: "Transfer",
            args: { from: a as Hex, to: b as Hex },
          })
        : encodeEventTopics({
            abi: ERC20,
            eventName: "Approval",
            args: { owner: a as Hex, spender: b as Hex },
          });
    return {
      address: token,
      topics: topics as string[],
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
    };
  }
}

/** An in-memory journal with the durable store's contract (JSON round trip; one atomic commit per batch). */
export class MemStore {
  readonly list: StoreEntry[] = [];
  #pending: StoreEntry[] | null = null;
  /** Appending this type throws (a failed journal write). */
  failOn: string | null = null;
  entries(): readonly StoreEntry[] {
    return this.list;
  }
  of(type: string): readonly StoreEntry[] {
    return this.list.filter((e) => e.type === type);
  }
  types() {
    return this.list.map((e) => e.type);
  }
  append(type: string, data: unknown): StoreEntry | null {
    if (this.failOn === type) throw new Error("STORE_WRITE_FAILED");
    const last = this.#pending?.at(-1) ?? this.list.at(-1);
    const body = {
      seq: (last?.seq ?? -1) + 1,
      type,
      data: JSON.parse(JSON.stringify(data ?? null)) as unknown,
      prev: last?.hash ?? "0".repeat(64),
    };
    const e: StoreEntry = Object.freeze({
      ...body,
      hash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    });
    if (this.#pending) {
      this.#pending.push(e);
      return null;
    }
    this.list.push(e);
    return e;
  }
  batch<T>(fn: () => T): T {
    if (this.#pending) return fn();
    this.#pending = [];
    try {
      const out = fn();
      this.list.push(...this.#pending);
      return out;
    } finally {
      this.#pending = null;
    }
  }
}

export type SignerAnswer = (
  step: "APPROVE" | "SWAP" | "REVOKE",
  tx: LaneTx,
) => LaneSignerResult | Promise<LaneSignerResult>;
/**
 * Records every hand-off; by default it "sends" (the fake chain receives the exact transaction). Its status() is the
 * signer v5 contract body derived from these hand-offs (./lane-fake-signer-status.ts), parsed by the REAL parser.
 */
export class FakeSigner implements LaneSigner {
  calls: {
    authority: unknown;
    tx: LaneTx;
    step: "APPROVE" | "SWAP" | "REVOKE";
  }[] = [];
  answer: SignerAnswer;
  signatures: FakeSignature[] = [];
  /** Signatures of OTHER lanes / records on this chain (the signer is shared). */
  others: FakeSignature[] = [];
  /** Rewrites the raw status body (undefined keeps it); a throw = the signer cannot be reached. */
  tamperStatus: ((raw: Record<string, unknown>) => unknown) | null = null;
  statusCalls = 0;
  constructor(readonly chain: FakeChain) {
    this.answer = (_step, tx) => ({
      outcome: "SENT",
      hash: chain.submit(tx),
      problems: [],
    });
  }
  async send(
    authority: unknown,
    tx: LaneTx,
    step: "APPROVE" | "SWAP" | "REVOKE",
  ) {
    this.calls.push({ authority, tx: { ...tx }, step });
    const r = await this.answer(step, tx);
    const signerStep = step === "SWAP" ? "EXECUTE" : step;
    this.signatures.push({
      key: `${this.chain.route.id}:${signerStep}`,
      outcome: r.outcome,
      hash: r.hash,
    });
    return r;
  }
  async status() {
    this.statusCalls++;
    const c = this.chain;
    const raw = fakeStatusBody({
      address: OWNER,
      routes: [c.route.id],
      chainId: c.route.chainId,
      firstNonce: FIRST_NONCE,
      signatures: this.signatures,
      others: this.others,
      decided: (h) => {
        const r = h ? c.receipts.get(h.toLowerCase()) : undefined;
        return (
          !!r &&
          c.head - BigInt(r.blockNumber) + 1n >= BigInt(c.route.confirmations)
        );
      },
      now: c.now(),
    });
    const t = this.tamperStatus ? this.tamperStatus(raw) : undefined;
    return fakeStatus(t === undefined ? raw : t);
  }
}

export interface Lane {
  clock: { t: number };
  chain: FakeChain;
  store: MemStore;
  signer: FakeSigner;
  engine: SwapLaneEngine;
  gateCalls: { facts: SwapLaneStepFacts; open: boolean; reasons: string[] }[];
}
/** One engine over the fakes. The default gate is the REAL lane gate with the synthetic record, digest and wiring. */
export function lane(
  over: Partial<LaneDeps> & {
    record?: Readonly<OwnerSwapLaneApproval>;
    /** The route of the fake chain and of the default record (default: Base). */
    route?: string;
    /** Run this engine over ANOTHER lane's chain and clock (with its own, fresh journal). */
    share?: Lane;
  } = {},
): Lane {
  const { share, route: routeId, ...deps } = over;
  const id = routeId ?? share?.chain.route.id ?? BASE;
  const clock = share?.clock ?? { t: NOW };
  const chain = share?.chain ?? new FakeChain(() => clock.t, id);
  const store = new MemStore();
  const signer = new FakeSigner(chain);
  const record = over.record ?? (id === BASE ? RECORD : recordFor(id));
  const gateCalls: Lane["gateCalls"] = [];
  const engine = new SwapLaneEngine({
    store: store as unknown as CanaryDurableStore,
    keyDigest: KEY_DIGEST,
    chain,
    signer,
    now: () => clock.t,
    gate: (facts) => {
      const g = swapLaneGateState(facts, record, KEY_DIGEST, true);
      if (facts)
        gateCalls.push({ facts, open: g.open, reasons: [...g.reasons] });
      return g;
    },
    ...deps,
    record,
  });
  return { clock, chain, store, signer, engine, gateCalls };
}
