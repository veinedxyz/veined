// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's multi-chain ROUTE TABLE, route by route. The table is
// consistent with its pin sets and its RPC pool; every route builds and decodes its own exact calldata; a record and a
// step are checked against THEIR route (wrong chain id, another chain's router, a fee above the route's ceiling, a
// tip outside its policy close the gate); the spot math is right for both token orders (checked against the evidence's
// own spot outputs); each fee model (OP_STACK L1 fee required / ARBITRUM estimate / PLAIN neither) and the route's
// confirmations hold end to end over the fake chain; a BLOCKED route is refused everywhere.
// The pin set is mocked ONLY in its code hashes (./swap-lane-pin-mock.ts), as in swap-lane-engine.test.ts;
// swap-lane-adapter.test.ts runs the same routes against the UNMOCKED pins (every unverified pool hash is refused).
// SYNTHETIC_TEST_ONLY: owner, key, hashes, balances and fees are synthetic. Nothing here signs, sends or reaches a
// network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, parseAbi, parseTransaction, type Hex } from "viem";
import {
  BASE,
  BLOCKED_ROUTE_IDS,
  ENABLED_ROUTE_IDS,
  FIXTURES,
  KEY_DIGEST,
  MemStore,
  FakeChain,
  FakeSigner,
  NOW,
  OTHER,
  OWNER,
  OWNER_KEY,
  ceilMin,
  handApprove,
  handSwap,
  lane,
  quoteAtImpact,
  recordFor,
  spotOutFor as handSpot,
  w,
  type Lane,
} from "./swap-lane-fake";
import { SwapLaneEngine, type SwapLaneError } from "../../src/swap/lane/engine";
import {
  SWAP_LANE_ROUTES,
  SWAP_LANE_SCOPE,
  enabledRoutes,
  routeById,
  swapLaneRouteProblems,
} from "../../src/swap/lane/scope";
import {
  SWAP_LANE_ROUTE_PINS,
  laneReadContracts,
  pinsOf,
  routePinProblems,
} from "../../src/swap/lane/pins";
import {
  approveCalldata,
  approveProblem,
  decodeApprove,
  decodeSwap,
  quoteCalldata,
  spotOutFor,
  swapCalldata,
  swapProblem,
} from "../../src/swap/lane/calldata";
import {
  SWAP_LANE_APPROVAL_BOUNDS,
  swapLaneGateState,
  swapLaneRecordProblems,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import { SWAP_LANE_RPC_POOL, lanePool } from "../../src/swap/lane/reads";
import type { CanaryDurableStore } from "../../src/execution/server/canary/durable-store";
import { knownAsset } from "../../src/assets/registry";
import registryFile from "../../src/assets/registry.generated.json" with { type: "json" };
import reviewedWrapped from "../../src/assets/sources/evm-wrapped-native-reviewed.generated.json" with { type: "json" };

vi.mock("../../src/swap/lane/pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/pins")>();
  const { fakeCodePinModule } = await import("./swap-lane-pin-mock");
  return fakeCodePinModule(real);
});
import { PIN_TEST_OVERRIDES } from "./swap-lane-pin-mock";

const ROUTES = Object.values(SWAP_LANE_ROUTES);
const ALL_IDS = ROUTES.map((r) => r.id);
const R = (id: string) => SWAP_LANE_ROUTES[id];
const ETH = "eth-usdc-weth-univ3-max1",
  ARB = "arb-usdc-weth-univ3-max1",
  OP = "op-usdc-weth-univ3-max1",
  POL = "pol-usdc-wpol-univ3-max1",
  BNB = "bnb-usdc-wbnb-univ3-max1",
  AVAX = "avax-usdc-wavax-univ3-max1";
const DIGEST = "d".repeat(64);
const NOW_SEC = Math.floor(NOW / 1000);
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const lc = (a: string) => a.toLowerCase();
/** USD per native unit from the evidence (F-fees.json usdPerNative, QuoterV2 1 USDC quotes, 2026-11-15). */
const USD_PER_NATIVE: Record<string, number> = {
  "1": 1830.096,
  "8453": 1829.46,
  "42161": 1830.61,
  "10": 1830.972,
  "137": 0.08115,
  "56": 592.665,
  "43114": 7.306,
};
const err = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as SwapLaneError;
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("the route table", () => {
  it("seven chains, one route each; five ENABLED, BNB and Avalanche BLOCKED with their reasons", () => {
    expect(ROUTES.map((r) => r.chainId).sort()).toEqual(
      ["1", "8453", "42161", "10", "137", "56", "43114"].sort(),
    );
    expect(enabledRoutes().map((r) => r.id)).toEqual([BASE, ETH, ARB, OP, POL]);
    expect(ENABLED_ROUTE_IDS).toEqual([BASE, ETH, ARB, OP, POL]);
    expect(BLOCKED_ROUTE_IDS).toEqual([BNB, AVAX]);
    expect(R(BNB)).toMatchObject({
      status: "BLOCKED",
      blockReason: "NO_CIRCLE_USDC",
    });
    expect(R(AVAX)).toMatchObject({
      status: "BLOCKED",
      blockReason: "NO_SIMULATEV1_ON_PUBLIC_OPERATORS",
    });
    for (const r of enabledRoutes()) expect(r.blockReason).toBeNull();
  });
  it("the Base route keeps every value it was reviewed and live-tested with", () => {
    expect(R(BASE)).toEqual({
      id: BASE,
      chainId: "8453",
      chainHex: "0x2105",
      pay: {
        address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        symbol: "USDC",
        decimals: 6,
      },
      receive: {
        address: "0x4200000000000000000000000000000000000006",
        symbol: "WETH",
        decimals: 18,
      },
      provider: "uniswap-v3-swaprouter02",
      router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
      factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
      poolFee: 500,
      payIsToken0: false,
      feeModel: "OP_STACK",
      minAmount: 100_000n,
      maxAmount: 1_000_000n,
      maxGas: { APPROVE: 100_000n, SWAP: 350_000n },
      maxFeePerGasWei: 200_000_000n,
      minTipWei: 0n,
      maxTipWei: 10_000_000n,
      // signer v5 alignment: its Base swap budget (was 1e14) and its 300 confirmations (was 10)
      gasBudgetWei: 17_700_000_000_000n,
      confirmations: 300,
      maxReviewBlockAgeSec: 20,
      status: "ENABLED",
      blockReason: null,
    });
    expect(SWAP_LANE_ROUTE_PINS[BASE].set).toBe(
      "fl1-swap-lane-pins.2026-11-15.1",
    );
    expect(SWAP_LANE_SCOPE).toMatchObject({
      maxSlippageBps: 50,
      appliedSlippageBps: 25,
      maxPriceImpactBps: 30,
      deadlineSec: 300,
      reviewTtlSec: 20,
      gasMarginBps: 2_000n,
      minGas: 21_000n,
    });
  });
  it.each(ALL_IDS)(
    "%s: consistent, frozen, its own pin set, one unit max / a tenth min",
    (id) => {
      const r = R(id);
      expect(swapLaneRouteProblems(r)).toEqual([]);
      expect(routePinProblems(id)).toEqual([]);
      expect(Object.isFrozen(r)).toBe(true);
      expect(Object.isFrozen(r.pay)).toBe(true);
      expect(Object.isFrozen(r.maxGas)).toBe(true);
      expect(routeById(id)).toBe(r);
      expect(pinsOf(id)?.route).toBe(id);
      expect(r.maxAmount).toBe(10n ** BigInt(r.pay.decimals));
      expect(r.minAmount * 10n).toBe(r.maxAmount);
      expect(r.chainHex).toBe("0x" + BigInt(r.chainId).toString(16));
      expect(r.pay.symbol).toBe("USDC");
      expect(r.receive.decimals).toBe(18);
      // the OP-stack GasPriceOracle is a read contract of OP_STACK routes only
      const oracle = "0x420000000000000000000000000000000000000f";
      expect(laneReadContracts(id).includes(oracle)).toBe(
        r.feeModel === "OP_STACK",
      );
      expect(laneReadContracts(id)).toEqual(
        [
          r.pay.address,
          r.receive.address,
          r.router,
          r.quoter,
          r.factory,
          r.pool,
        ]
          .map(lc)
          .concat(r.feeModel === "OP_STACK" ? [oracle] : [])
          // VEINED-MC1 review MINOR-3: the Arbitrum NodeInterface (eth_call only), as signer v5 reads it
          .concat(
            r.feeModel === "ARBITRUM"
              ? ["0x00000000000000000000000000000000000000c8"]
              : [],
          ),
      );
      // pay decimals: Circle USDC has 6; only the BLOCKED Binance-Peg row has 18
      expect(r.pay.decimals).toBe(id === BNB ? 18 : 6);
    },
  );
  it("routeById never resolves an inherited key or a non-string", () => {
    for (const id of ["__proto__", "constructor", "toString", "", 8453, null])
      expect(routeById(id)).toBeNull();
    expect(pinsOf("__proto__")).toBeNull();
    expect(laneReadContracts("constructor")).toEqual([]);
  });
  it("fee models: Base and OP are OP_STACK, Arbitrum is ARBITRUM, the rest PLAIN; token order per pool", () => {
    expect(ROUTES.map((r) => [r.id, r.feeModel, r.payIsToken0])).toEqual([
      [BASE, "OP_STACK", false],
      [ETH, "PLAIN", true],
      [ARB, "ARBITRUM", false],
      [OP, "OP_STACK", true],
      [POL, "PLAIN", false],
      [BNB, "PLAIN", true],
      [AVAX, "PLAIN", false],
    ]);
    expect(ROUTES.map((r) => [r.id, r.poolFee, r.confirmations])).toEqual([
      [BASE, 500, 300],
      [ETH, 100, 10],
      [ARB, 100, 200],
      [OP, 500, 30],
      [POL, 500, 64],
      [BNB, 100, 140],
      [AVAX, 500, 60],
    ]);
  });
  it.each(ENABLED_ROUTE_IDS)(
    "%s: the gas budget is at most ~1 USD, and the worst case at the evidence fees fits it below the ceiling",
    (id) => {
      const r = R(id),
        f = FIXTURES[id];
      const usd = (Number(r.gasBudgetWei) / 1e18) * USD_PER_NATIVE[r.chainId];
      expect(usd, `${id} ${usd}`).toBeLessThanOrEqual(1.0);
      expect(usd).toBeGreaterThan(0);
      const tip =
        f.tip > r.maxTipWei
          ? r.maxTipWei
          : f.tip < r.minTipWei
            ? r.minTipWei
            : f.tip;
      const maxFee = 3n * f.baseFee + tip;
      expect(maxFee <= r.maxFeePerGasWei).toBe(true);
      // limits at the lane margin for the evidence-sized calls (approve ~55 k, swap ~140-180 k gas)
      const worst = (66_000n + 220_000n) * maxFee + f.l1Fee * 4n;
      expect(worst <= r.gasBudgetWei, `${id} ${worst}`).toBe(true);
    },
  );
});

describe("the RPC pool", () => {
  it("every ENABLED route's chain has exactly two operators of two organisations; Base keeps its pair", () => {
    for (const r of enabledRoutes()) {
      const p = lanePool(r.chainId)!;
      expect(p, r.id).toHaveLength(2);
      expect(p[0].operator).not.toBe(p[1].operator);
      expect(p[0].url).not.toBe(p[1].url);
      for (const s of p)
        expect(s.url).toMatch(/^https:\/\/[a-z0-9.-]+(\/rpc)?$/);
    }
    expect(lanePool("8453")).toEqual([
      {
        operator: "allnodes-publicnode",
        url: "https://base-rpc.publicnode.com",
      },
      { operator: "base-coinbase", url: "https://mainnet.base.org" },
    ]);
    expect(lanePool("1")?.map((s) => s.url)).toEqual([
      "https://rpc.mevblocker.io",
      "https://ethereum-rpc.publicnode.com",
    ]);
    expect(lanePool("42161")?.map((s) => s.url)).toEqual([
      "https://arb1.arbitrum.io/rpc",
      "https://arbitrum.drpc.org",
    ]);
    expect(lanePool("10")?.map((s) => s.url)).toEqual([
      "https://mainnet.optimism.io",
      "https://optimism.drpc.org",
    ]);
    expect(lanePool("137")?.map((s) => s.url)).toEqual([
      "https://polygon-bor-rpc.publicnode.com",
      "https://polygon.drpc.org",
    ]);
    // no verified eth_simulateV1 operator pair on Avalanche: no pool at all
    expect(lanePool("43114")).toBeNull();
    expect(lanePool("__proto__")).toBeNull();
    expect(Object.isFrozen(SWAP_LANE_RPC_POOL)).toBe(true);
  });
});

describe("calldata per route (hand-built bytes)", () => {
  const MIN = 330_000_000_000_000n;
  const DEADLINE = BigInt(NOW_SEC + 300);
  it.each(ALL_IDS)(
    "%s: approve / swap / quote build, decode and verify",
    (id) => {
      const r = R(id),
        amount = r.maxAmount;
      const a = approveCalldata(r, amount);
      expect(a).toBe(handApprove(amount, r.router));
      expect(decodeApprove(a)).toEqual({ spender: lc(r.router), amount });
      expect(approveProblem(r, a, amount)).toBeNull();
      const s = swapCalldata(r, {
        owner: OWNER,
        amountIn: amount,
        amountOutMinimum: MIN,
        deadline: DEADLINE,
      });
      expect(s).toBe(
        handSwap(
          { owner: OWNER, amountIn: amount, minOut: MIN, deadline: DEADLINE },
          id,
        ),
      );
      expect(decodeSwap(s)).toEqual({
        deadline: DEADLINE,
        tokenIn: lc(r.pay.address),
        tokenOut: lc(r.receive.address),
        fee: r.poolFee,
        recipient: OWNER,
        amountIn: amount,
        amountOutMinimum: MIN,
        sqrtPriceLimitX96: 0n,
      });
      const want = { owner: OWNER, amountIn: amount, amountOutMinimum: MIN };
      expect(swapProblem(r, s, want, NOW_SEC)).toBeNull();
      expect(quoteCalldata(r, amount)).toBe(
        "0xc6a5026a" +
          w(r.pay.address) +
          w(r.receive.address) +
          w(amount) +
          w(r.poolFee) +
          w(0),
      );
    },
  );
  it("Base bytes are unchanged (the reviewed reference words)", () => {
    expect(approveCalldata(R(BASE), 1_000_000n)).toBe(
      "0x095ea7b3" +
        "0000000000000000000000002626664c2603336e57b271c5c0b26f421741e481" +
        "00000000000000000000000000000000000000000000000000000000000f4240",
    );
  });
  it("one route's calldata is never another route's: tokens, spender and fee tier are route-bound", () => {
    const want = { owner: OWNER, amountIn: 1_000_000n, amountOutMinimum: MIN };
    const baseSwap = swapCalldata(R(BASE), { ...want, deadline: DEADLINE });
    for (const id of [ETH, ARB, OP, POL, AVAX]) {
      expect(swapProblem(R(id), baseSwap, want, NOW_SEC)).toBe("SWAP_TOKEN_IN");
      expect(
        approveProblem(R(id), approveCalldata(R(BASE), 1_000_000n), 1_000_000n),
      ).toBe(id === BASE ? null : "APPROVE_SPENDER_NOT_ROUTER");
    }
    // OP and Base share the WETH predeploy and fee 500, but not the pay token or the router
    expect(swapProblem(R(OP), baseSwap, want, NOW_SEC)).toBe("SWAP_TOKEN_IN");
    // Ethereum, Arbitrum, OP and Polygon share one SwapRouter02 address: the approve is the same bytes, the swap is not
    expect(approveCalldata(R(ETH), 1_000_000n)).toBe(
      approveCalldata(R(POL), 1_000_000n),
    );
    const ethSwap = swapCalldata(R(ETH), { ...want, deadline: DEADLINE });
    expect(swapProblem(R(POL), ethSwap, want, NOW_SEC)).toBe("SWAP_TOKEN_IN");
    // the same tokens with another route's fee tier
    const r = R(ETH);
    const wrongFee = handSwap(
      { owner: OWNER, amountIn: 1_000_000n, minOut: MIN, deadline: DEADLINE },
      ETH,
    ).replace(w(r.poolFee), w(500));
    expect(swapProblem(r, wrongFee, want, NOW_SEC)).toBe("SWAP_FEE_TIER");
  });
});

describe("spot price math (both token orders, raw units)", () => {
  it("both orders are exercised by the table", () => {
    expect(enabledRoutes().some((r) => r.payIsToken0)).toBe(true);
    expect(enabledRoutes().some((r) => !r.payIsToken0)).toBe(true);
  });
  it.each(ALL_IDS.filter((id) => FIXTURES[id].evidenceSpotOut !== null))(
    "%s: 1 unit at the evidence's slot0 gives exactly the evidence's spot output",
    (id) => {
      const r = R(id),
        f = FIXTURES[id];
      const out = spotOutFor(r, r.maxAmount, f.sqrtP);
      expect(out).toBe(f.evidenceSpotOut);
      expect(out).toBe(handSpot(r.maxAmount, f.sqrtP, r.payIsToken0));
      // the wrong order would be off by many orders of magnitude
      const flipped = spotOutFor(
        { ...r, payIsToken0: !r.payIsToken0 },
        r.maxAmount,
        f.sqrtP,
      );
      expect(flipped === out).toBe(false);
    },
  );
  it("Base keeps the reviewed formula (token0 = WETH): in * 2^192 / sqrtP^2", () => {
    const s = FIXTURES[BASE].sqrtP;
    expect(spotOutFor(R(BASE), 1_000_000n, s)).toBe(
      (1_000_000n << 192n) / (s * s),
    );
  });
  it("a zero price or amount gives 0 (never a division by zero)", () => {
    for (const id of ALL_IDS) {
      expect(spotOutFor(R(id), 1_000_000n, 0n)).toBe(0n);
      expect(spotOutFor(R(id), 0n, FIXTURES[id].sqrtP)).toBe(0n);
    }
  });
});

describe("record validation per route", () => {
  it.each(ALL_IDS)("%s: the route's own synthetic record", (id) => {
    const r = R(id);
    const rec = recordFor(id);
    expect(swapLaneRecordProblems(rec)).toEqual(
      r.status === "ENABLED" ? [] : ["ROUTE_BLOCKED"],
    );
    const B = SWAP_LANE_APPROVAL_BOUNDS[id];
    expect(B).toMatchObject({
      route: id,
      status: r.status,
      scope: id,
      pinSet: SWAP_LANE_ROUTE_PINS[id].set,
      chainId: r.chainId,
      minAmount: r.minAmount.toString(),
      maxAmount: r.maxAmount.toString(),
      maxGasBudgetWei: r.gasBudgetWei.toString(),
      maxSlippageBps: 50,
    });
    const extra = r.status === "ENABLED" ? [] : ["ROUTE_BLOCKED"];
    // amount bounds in the route's own decimals
    for (const ok of [r.minAmount, r.maxAmount])
      expect(
        swapLaneRecordProblems({ ...rec, exactAmount: ok.toString() }),
      ).toEqual(extra);
    for (const bad of [r.minAmount - 1n, r.maxAmount + 1n, 0n])
      expect(
        swapLaneRecordProblems({ ...rec, exactAmount: bad.toString() }),
      ).toEqual([...extra, "AMOUNT_BOUNDS"]);
    // the native gas budget may not exceed the route's
    expect(
      swapLaneRecordProblems({
        ...rec,
        nativeGasBudgetWei: (r.gasBudgetWei + 1n).toString(),
      }),
    ).toEqual([...extra, "GAS_BUDGET_BOUNDS"]);
  });
  it.each(ENABLED_ROUTE_IDS.filter((id) => id !== BASE))(
    "%s: any field of another route (Base) is refused",
    (id) => {
      const rec = recordFor(id),
        base = recordFor(BASE);
      const cases: [Record<string, unknown>, string][] = [
        [{ chainId: base.chainId }, "CHAIN"],
        [{ tokenIn: base.tokenIn }, "TOKENS"],
        [{ router: base.router }, "ROUTER"],
        [{ scope: base.scope }, "SCOPE"],
        [{ pinSet: base.pinSet }, "PIN_SET"],
      ];
      for (const [over, code] of cases)
        expect(swapLaneRecordProblems({ ...rec, ...over }), code).toEqual([
          code,
        ]);
      // a Base record relabelled as this route
      expect(swapLaneRecordProblems({ ...base, route: id })).toEqual(
        expect.arrayContaining(["SCOPE", "PIN_SET", "CHAIN", "TOKENS"]),
      );
    },
  );
});

/** A fully proven step of `id` (fees at the fixture's 3 x base + tip, inside the route's policy). */
function stepFacts(
  id: string,
  step: "APPROVE" | "SWAP",
  over: Partial<SwapLaneStepFacts> = {},
  tx: Partial<SwapLaneStepFacts["tx"]> = {},
): SwapLaneStepFacts {
  const r = R(id),
    f = FIXTURES[id];
  const tip =
    f.tip > r.maxTipWei
      ? r.maxTipWei
      : f.tip < r.minTipWei
        ? r.minTipWei
        : f.tip;
  const MIN = 330_000_000_000_000n;
  return {
    route: id,
    step,
    exactAmount: r.maxAmount.toString(),
    amountOutMinimum: step === "SWAP" ? MIN : undefined,
    tx: {
      chainId: r.chainHex,
      from: OWNER,
      to: lc(step === "APPROVE" ? r.pay.address : r.router),
      value: "0x0",
      data:
        step === "APPROVE"
          ? approveCalldata(r, r.maxAmount)
          : swapCalldata(r, {
              owner: OWNER,
              amountIn: r.maxAmount,
              amountOutMinimum: MIN,
              deadline: BigInt(NOW_SEC + 300),
            }),
      gas: hex(step === "APPROVE" ? 55_200 : 180_000),
      maxFeePerGas: hex(3n * f.baseFee + tip),
      maxPriorityFeePerGas: hex(tip),
      ...tx,
    },
    operatorsAgree: true,
    reviewAttested: true,
    guardianPassed: true,
    gasWorstCaseTotalWei: 1n,
    now: NOW,
    ...over,
  };
}
const gate = (id: string, facts?: SwapLaneStepFacts) =>
  swapLaneGateState(facts, recordFor(id), DIGEST, true);

describe("the gate per route", () => {
  it.each(ENABLED_ROUTE_IDS)(
    "%s: OPEN for the exact approve and the exact swap",
    (id) => {
      for (const s of ["APPROVE", "SWAP"] as const) {
        const g = gate(id, stepFacts(id, s));
        expect(g.reasons, `${id} ${s}`).toEqual([]);
        expect(g).toMatchObject({
          state: "OPEN",
          scope: id,
          pinSet: SWAP_LANE_ROUTE_PINS[id].set,
        });
      }
    },
  );
  it.each(ENABLED_ROUTE_IDS)(
    "%s: another chain id closes it (STEP:CHAIN)",
    (id) => {
      for (const other of ROUTES.filter((r) => r.id !== id))
        expect(
          gate(id, stepFacts(id, "APPROVE", {}, { chainId: other.chainHex }))
            .reasons,
        ).toContain("STEP:CHAIN");
      expect(
        gate(id, stepFacts(id, "SWAP", {}, { chainId: R(id).chainId })).reasons,
      ).toContain("STEP:CHAIN");
    },
  );
  it.each(ENABLED_ROUTE_IDS)(
    "%s: another chain's router closes it (target and spender)",
    (id) => {
      const r = R(id);
      const foreign = ROUTES.map((x) => x.router).filter(
        (a) => lc(a) !== lc(r.router),
      );
      expect(foreign.length).toBeGreaterThan(0);
      for (const router of foreign) {
        expect(
          gate(id, stepFacts(id, "SWAP", {}, { to: lc(router) })).reasons,
        ).toContain("STEP:SWAP_TARGET_NOT_ROUTER");
        const approveForeign = handApprove(r.maxAmount, router);
        expect(
          gate(id, stepFacts(id, "APPROVE", {}, { data: approveForeign }))
            .reasons,
        ).toContain("STEP:APPROVE_SPENDER_NOT_ROUTER");
      }
      // the approve goes to this route's pay token only
      expect(
        gate(id, stepFacts(id, "APPROVE", {}, { to: lc(R(BASE).pay.address) }))
          .reasons,
      ).toEqual(id === BASE ? [] : ["STEP:APPROVE_TARGET_NOT_USDC"]);
    },
  );
  it.each(ENABLED_ROUTE_IDS)(
    "%s: the route's fee ceiling: at it OPEN, above it closed",
    (id) => {
      const r = R(id);
      expect(
        gate(
          id,
          stepFacts(id, "SWAP", {}, { maxFeePerGas: hex(r.maxFeePerGasWei) }),
        ).open,
      ).toBe(true);
      expect(
        gate(
          id,
          stepFacts(
            id,
            "SWAP",
            {},
            { maxFeePerGas: hex(r.maxFeePerGasWei + 1n) },
          ),
        ).reasons,
      ).toContain("STEP:FEE_CAP_ABOVE_SIGNER_POLICY");
    },
  );
  it.each(ENABLED_ROUTE_IDS)(
    "%s: the route's tip policy and gas caps",
    (id) => {
      const r = R(id);
      expect(
        gate(
          id,
          stepFacts(
            id,
            "APPROVE",
            {},
            { maxPriorityFeePerGas: hex(r.maxTipWei + 1n) },
          ),
        ).reasons,
      ).toContain("STEP:TIP_OUTSIDE_ROUTE_POLICY");
      if (r.minTipWei > 0n)
        expect(
          gate(
            id,
            stepFacts(
              id,
              "APPROVE",
              {},
              { maxPriorityFeePerGas: hex(r.minTipWei - 1n) },
            ),
          ).reasons,
        ).toContain("STEP:TIP_OUTSIDE_ROUTE_POLICY");
      expect(
        gate(id, stepFacts(id, "APPROVE", {}, { gas: hex(r.maxGas.APPROVE) }))
          .open,
      ).toBe(true);
      expect(
        gate(
          id,
          stepFacts(id, "APPROVE", {}, { gas: hex(r.maxGas.APPROVE + 1n) }),
        ).reasons,
      ).toContain("STEP:GAS_LIMIT");
      expect(
        gate(id, stepFacts(id, "SWAP", {}, { gas: hex(r.maxGas.SWAP + 1n) }))
          .reasons,
      ).toContain("STEP:GAS_LIMIT");
      expect(
        gate(
          id,
          stepFacts(id, "SWAP", { gasWorstCaseTotalWei: r.gasBudgetWei + 1n }),
        ).reasons,
      ).toContain("STEP:GAS_BUDGET");
    },
  );
  it.each(ENABLED_ROUTE_IDS)(
    "%s: facts of another route close it (STEP:ROUTE)",
    (id) => {
      const other = ENABLED_ROUTE_IDS.find((x) => x !== id)!;
      expect(
        gate(id, stepFacts(id, "APPROVE", { route: other })).reasons,
      ).toContain("STEP:ROUTE");
    },
  );
  it.each(BLOCKED_ROUTE_IDS)(
    "%s: a BLOCKED route never opens (record refused, no step check)",
    (id) => {
      const g = gate(id, stepFacts(id, "APPROVE"));
      expect(g.open).toBe(false);
      expect(g.reasons[0]).toBe("RECORD:ROUTE_BLOCKED");
      expect(g.reasons.filter((x) => x.startsWith("RECORD:"))).toEqual([
        "RECORD:ROUTE_BLOCKED",
      ]);
      expect(g.reasons.some((x) => x.startsWith("STEP:"))).toBe(false);
    },
  );
  it("the pool check uses the record's route's chain", () => {
    // Avalanche has no pool: its (BLOCKED) record reports the missing pool too once the record is otherwise valid
    const g = swapLaneGateState(
      stepFacts(AVAX, "APPROVE"),
      recordFor(AVAX),
      DIGEST,
      true,
    );
    expect(g.reasons).toEqual([
      "RECORD:ROUTE_BLOCKED",
      "SWAP_LANE_RPC_POOL_INCOMPLETE",
    ]);
  });
});

// ---- the engine per route over the fake chain (pins mocked only in their code hashes) -------------------------------
async function step(L: Lane) {
  const r = await L.engine.review(OWNER_KEY);
  expect(r.ready, `${L.chain.route.id}: ${r.problems.join(",")}`).toBe(true);
  const token = L.engine.authorize(r.reviewId, OWNER_KEY);
  const d = await L.engine.dispatch(token, OWNER_KEY);
  return { r, token, d };
}
/** Mines the pending transactions and buries them exactly deep enough for the route. */
const settle = (L: Lane) => {
  const n = L.chain.mine();
  L.chain.advance(L.chain.route.confirmations - 1);
  return n;
};
const ORACLE_ABI = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
]);
const OPERATOR_FEE_ABI = parseAbi([
  "function getOperatorFee(uint256) view returns (uint256)",
]);
/** eth_call reads of the OP-stack oracle; `selector` narrows them to getL1Fee (0x49948e0e) or getOperatorFee. */
const oracleCalls = (L: Lane, selector = "0x49948e0e") =>
  L.chain.log.filter(
    (x) =>
      x.method === "eth_call" &&
      lc((x.params[0] as { to: string }).to) ===
        "0x420000000000000000000000000000000000000f" &&
      (x.params[0] as { data: string }).data.slice(0, 10) === selector,
  );
const anyOracleCalls = (L: Lane) =>
  L.chain.log.filter(
    (x) =>
      x.method === "eth_call" &&
      lc((x.params[0] as { to: string }).to) ===
        "0x420000000000000000000000000000000000000f",
  );

describe("the engine per route", () => {
  it.each(ENABLED_ROUTE_IDS)(
    "%s: APPROVE then SWAP to SETTLED_VERIFIED with the route's own bytes, chain id and confirmations",
    async (id) => {
      const L = lane({ route: id });
      const r = R(id),
        amount = r.maxAmount;
      expect(L.engine.route).toBe(r);
      const quote = L.chain.quoteOut;
      const a = await step(L);
      expect(a.r).toMatchObject({
        route: id,
        chainId: r.chainId,
        step: "APPROVE",
        amountIn: amount.toString(),
        quoteOut: quote.toString(),
        spotOut: handSpot(amount, FIXTURES[id].sqrtP, r.payIsToken0).toString(),
        priceImpactBps: 10,
        slippageBps: 25,
        amountOutMinimum: ceilMin(quote, 25).toString(),
        pins: { set: SWAP_LANE_ROUTE_PINS[id].set, problems: [] },
      });
      if (FIXTURES[id].evidenceSpotOut !== null)
        expect(a.r.spotOut).toBe(FIXTURES[id].evidenceSpotOut!.toString());
      expect(a.r.guardian?.level).toBe("CLEAR");
      expect(L.signer.calls[0].tx).toMatchObject({
        chainId: r.chainHex,
        from: OWNER,
        to: lc(r.pay.address),
        value: "0x0",
        data: handApprove(amount, r.router),
      });
      expect(L.store.of("USE")[0].data).toMatchObject({
        key: `${id}:${OWNER}:${"0x" + "1a".repeat(32)}:APPROVE`,
      });
      // confirmations: one short of the route's depth is still CONFIRMING
      L.chain.mine();
      L.chain.advance(r.confirmations - 2);
      expect(
        ((await L.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe("CONFIRMING");
      L.chain.advance(1);
      expect(
        ((await L.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe("FINAL_SUCCESS");
      const s = await step(L);
      expect(L.signer.calls[1].tx).toMatchObject({
        chainId: r.chainHex,
        to: lc(r.router),
        data: handSwap(
          {
            owner: OWNER,
            amountIn: amount,
            minOut: BigInt(s.r.amountOutMinimum),
            deadline: BigInt(s.r.deadline),
          },
          id,
        ),
      });
      settle(L);
      const t = await L.engine.track();
      expect(t.state).toBe("SETTLED_VERIFIED");
      expect(t.settlement).toEqual({
        usdcOut: amount.toString(),
        wethIn: quote.toString(),
        minOut: s.r.amountOutMinimum,
        allowanceAfter: "0",
        problems: [],
      });
      expect(L.chain.violations).toEqual([]);
      expect(L.signer.calls).toHaveLength(2);
    },
  );
  it.each(BLOCKED_ROUTE_IDS)(
    "%s: the engine refuses a BLOCKED route at construction",
    async (id) => {
      const chain = new FakeChain(() => NOW, id);
      const make = () =>
        new SwapLaneEngine({
          store: new MemStore() as unknown as CanaryDurableStore,
          record: recordFor(id),
          keyDigest: KEY_DIGEST,
          chain,
          signer: new FakeSigner(chain),
          now: () => NOW,
        });
      expect((await err(make)).code).toBe("ROUTE_NOT_ENABLED");
      expect(chain.log).toHaveLength(0);
    },
  );
  it("an unknown route is refused at construction too", async () => {
    for (const route of ["base-usdc-weth-univ3-max5", "__proto__", ""]) {
      const chain = new FakeChain(() => NOW);
      const e = await err(
        () =>
          new SwapLaneEngine({
            store: new MemStore() as unknown as CanaryDurableStore,
            record: { ...recordFor(BASE), route },
            keyDigest: KEY_DIGEST,
            chain,
            signer: new FakeSigner(chain),
          }),
      );
      expect(e.code).toBe("ROUTE_NOT_ENABLED");
    }
  });
});

describe("fee models end to end", () => {
  it.each([BASE, OP])(
    "%s (OP_STACK): the L1 fee is read from the oracle for a tx serialized with the route's chain id, and required",
    async (id) => {
      const L = lane({ route: id });
      const r = await L.engine.review(OWNER_KEY);
      expect(r.ready, r.problems.join()).toBe(true);
      const calls = oracleCalls(L);
      expect(calls).toHaveLength(1);
      const arg = decodeFunctionData({
        abi: ORACLE_ABI,
        data: (calls[0].params[0] as { data: Hex }).data,
      }).args[0];
      const tx = parseTransaction(arg);
      expect(tx.chainId).toBe(Number(R(id).chainId));
      expect(lc(tx.to!)).toBe(lc(R(id).pay.address));
      expect(r.gas.l1FeeWei).toBe((FIXTURES[id].l1Fee * 2n * 2n).toString());
      // signer v5 (Isthmus): the operator fee is read once, for the largest gas of the review, and must be 0
      const op = oracleCalls(L, "0x275aedd2");
      expect(op).toHaveLength(1);
      expect(
        decodeFunctionData({
          abi: OPERATOR_FEE_ABI,
          data: (op[0].params[0] as { data: Hex }).data,
        }).args[0],
      ).toBe(R(id).maxGas.SWAP);
      expect(anyOracleCalls(L)).toHaveLength(2);
      // unread on one operator -> L1_FEE_UNPROVEN (never 0) and the operator fee is unproven too (dry-review item 8:
      // named as a failed read, not as a non-zero fee)
      const L2 = lane({ route: id });
      L2.chain.tamper = (op, method, params) =>
        op === 1 &&
        method === "eth_call" &&
        lc((params[0] as { to: string }).to) ===
          "0x420000000000000000000000000000000000000f"
          ? null
          : undefined;
      expect((await L2.engine.review(OWNER_KEY)).problems).toEqual([
        "L1_FEE_UNPROVEN",
        "OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE",
      ]);
      // a non-zero operator fee (on one operator only, or on both) is refused: the signer would refuse it
      for (const both of [false, true]) {
        const L3 = lane({ route: id });
        L3.chain.tamper = (o, method, params) =>
          (both || o === 0) &&
          method === "eth_call" &&
          (params[0] as { data: string }).data.slice(0, 10) === "0x275aedd2"
            ? "0x" + "0".repeat(63) + "1"
            : undefined;
        expect((await L3.engine.review(OWNER_KEY)).problems).toEqual([
          "OP_STACK_OPERATOR_FEE_NONZERO",
        ]);
      }
      // a revert (pre-Isthmus oracle: no getOperatorFee) is never read as 0 (dry-review item 8: an RPC error is a
      // FAILED read, named as such — the transport cannot tell a revert from a rate limit — and still not ready)
      const L4 = lane({ route: id });
      L4.chain.tamper = (_o, method, params) => {
        if (
          method === "eth_call" &&
          (params[0] as { data: string }).data.slice(0, 10) === "0x275aedd2"
        )
          throw new Error("SIMULATION_FAILED");
        return undefined;
      };
      const r4 = await L4.engine.review(OWNER_KEY);
      expect(r4.ready).toBe(false);
      expect(r4.problems).toEqual([
        "OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE",
      ]);
    },
  );
  it("every enabled route: operator heads further apart than the signer v5 chain limit -> OPERATOR_HEADS_TOO_FAR_APART", async () => {
    const LIMITS: Record<string, number> = {
      "1": 2,
      "8453": 5,
      "42161": 10,
      "10": 3,
      "137": 4,
    };
    for (const id of ENABLED_ROUTE_IDS) {
      const limit = LIMITS[R(id).chainId];
      for (const [skew, refused] of [
        [limit, false],
        [limit + 1, true],
      ] as const) {
        const L = lane({ route: id });
        L.chain.tamper = (o, method) =>
          o === 1 && method === "eth_blockNumber"
            ? "0x" + (L.chain.head + BigInt(skew)).toString(16)
            : undefined;
        const r = await L.engine.review(OWNER_KEY);
        expect(r.problems.includes("OPERATOR_HEADS_TOO_FAR_APART"), id).toBe(
          refused,
        );
        expect(r.ready, `${id} ${r.problems.join()}`).toBe(!refused);
      }
    }
  });
  it("non-OP_STACK routes never read the operator fee", async () => {
    for (const id of [ETH, ARB, POL]) {
      const L = lane({ route: id });
      await L.engine.review(OWNER_KEY);
      expect(anyOracleCalls(L)).toHaveLength(0);
    }
  });
  it.each([BASE, OP])(
    "%s (OP_STACK): a receipt without l1Fee never counts (RECEIPT_L1_FEE_UNPROVEN, nothing journaled)",
    async (id) => {
      const L = lane({ route: id });
      await step(L);
      settle(L);
      L.chain.tamper = (_op, method, _p, honest) => {
        if (method !== "eth_getTransactionReceipt" || !honest) return undefined;
        const { l1Fee: _f, ...rest } = honest as Record<string, unknown>;
        void _f;
        return rest;
      };
      const t = await L.engine.track();
      expect((t.steps.APPROVE as { state: string }).state).toBe(
        "RECEIPT_L1_FEE_UNPROVEN",
      );
      expect(L.store.of("RECEIPT")).toHaveLength(0);
      // the operators must agree on it, too
      L.chain.tamper = (op, method, _p, honest) =>
        op === 1 && method === "eth_getTransactionReceipt" && honest
          ? { ...(honest as object), l1Fee: "0x1" }
          : undefined;
      expect(
        ((await L.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe("OPERATORS_DISAGREE");
      L.chain.tamper = null;
      expect(
        ((await L.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe("FINAL_SUCCESS");
      expect(L.store.of("RECEIPT")[0].data).toMatchObject({
        l1Fee: FIXTURES[id].l1Fee.toString(),
      });
    },
  );
  it.each([ETH, ARB, POL])(
    "%s (not OP_STACK): no oracle read, no L1 fee, receipts without l1Fee count",
    async (id) => {
      const L = lane({ route: id });
      const r = await L.engine.review(OWNER_KEY);
      expect(r.ready, r.problems.join()).toBe(true);
      expect(anyOracleCalls(L)).toHaveLength(0);
      expect(r.gas.l1FeeWei).toBe("0");
      const t = L.engine.authorize(r.reviewId, OWNER_KEY);
      await L.engine.dispatch(t, OWNER_KEY);
      settle(L);
      expect(
        ((await L.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe("FINAL_SUCCESS");
      expect(L.store.of("RECEIPT")[0].data).toMatchObject({ l1Fee: "0" });
    },
  );
  it("PLAIN routes never call eth_estimateGas", async () => {
    for (const id of [ETH, POL]) {
      const L = lane({ route: id });
      await L.engine.review(OWNER_KEY);
      expect(L.chain.log.some((x) => x.method === "eth_estimateGas")).toBe(
        false,
      );
    }
  });
  it("ARBITRUM: the step is estimated on both operators; the limit is the larger of sim x 1.2 and estimate x 1.1", async () => {
    const L = lane({ route: ARB });
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready, r.problems.join()).toBe(true);
    const est = L.chain.log.filter((x) => x.method === "eth_estimateGas");
    expect(est).toHaveLength(1);
    expect(est[0].params[0]).toMatchObject({
      from: OWNER,
      to: R(ARB).pay.address,
    });
    // small L1 component: the simulated margin dominates
    expect(r.gas.limits).toEqual({ APPROVE: "55200", SWAP: "180000" });
    // a large L1 component (gas units): the estimate dominates for the step under review
    const L2 = lane({ route: ARB });
    L2.chain.l1Gas.APPROVE = 40_000n;
    const r2 = await L2.engine.review(OWNER_KEY);
    expect(r2.ready, r2.problems.join()).toBe(true);
    expect(r2.gas.limits.APPROVE).toBe(
      (((46_000n + 40_000n) * 11n) / 10n).toString(),
    );
    // ... and above the route's cap it is refused
    const L3 = lane({ route: ARB });
    L3.chain.l1Gas.APPROVE = 60_000n;
    expect((await L3.engine.review(OWNER_KEY)).problems).toEqual([
      "GAS_ABOVE_CAP:APPROVE",
    ]);
    // an estimate missing on one operator -> GAS_ESTIMATE_UNPROVEN
    const L4 = lane({ route: ARB });
    L4.chain.tamper = (op, method) => {
      if (op === 0 && method === "eth_estimateGas")
        throw new Error("SIMULATION_FAILED");
      return undefined;
    };
    expect((await L4.engine.review(OWNER_KEY)).problems).toEqual([
      "GAS_ESTIMATE_UNPROVEN:APPROVE",
      "ARBITRUM_SIGNER_READS_UNAVAILABLE",
    ]);
    // VEINED-MC1 review MINOR-3: the NodeInterface L1 component missing on one operator -> not ready (the signer
    // would refuse ARB_L1_COMPONENT_UNKNOWN), and an estimate that excludes it -> not ready
    const L5 = lane({ route: ARB });
    L5.chain.tamper = (op, method, params) =>
      op === 1 &&
      method === "eth_call" &&
      lc((params[0] as { to: string }).to) ===
        "0x00000000000000000000000000000000000000c8"
        ? null
        : undefined;
    expect((await L5.engine.review(OWNER_KEY)).problems).toEqual([
      "ARBITRUM_SIGNER_READS_UNAVAILABLE",
    ]);
    const L6 = lane({ route: ARB });
    L6.chain.tamper = (_op, method, params) =>
      method === "eth_call" &&
      lc((params[0] as { to: string }).to) ===
        "0x00000000000000000000000000000000000000c8"
        ? "0x" + 10_000_000n.toString(16).padStart(64, "0") + "0".repeat(128)
        : undefined;
    expect((await L6.engine.review(OWNER_KEY)).problems).toEqual(
      expect.arrayContaining([
        "ARBITRUM_GAS_BELOW_L1_COMPONENT:APPROVE",
        "ARBITRUM_ESTIMATE_EXCLUDES_L1:APPROVE",
      ]),
    );
  });
  it("ARBITRUM: the SWAP review estimates the swap (the allowance exists then)", async () => {
    const L = lane({ route: ARB });
    await step(L);
    settle(L);
    await L.engine.track();
    L.chain.l1Gas.SWAP = 60_000n;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("SWAP");
    expect(r.ready, r.problems.join()).toBe(true);
    expect(r.gas.limits.SWAP).toBe(
      (((150_000n + 60_000n) * 11n) / 10n).toString(),
    );
    const est = L.chain.log
      .filter((x) => x.method === "eth_estimateGas")
      .at(-1)!;
    expect(lc((est.params[0] as { to: string }).to)).toBe(lc(R(ARB).router));
  });
});

describe("fees: tip clamp and ceiling per route", () => {
  it("Polygon: an operator tip below the Bor floor is raised to minTipWei, above maxTipWei it is capped", async () => {
    const r = R(POL);
    const L = lane({ route: POL });
    L.chain.tip = 1_000_000_000n;
    const a = await L.engine.review(OWNER_KEY);
    expect(a.gas.maxPriorityFeePerGas).toBe(r.minTipWei.toString());
    expect(a.gas.maxFeePerGas).toBe(
      (3n * L.chain.baseFee + r.minTipWei).toString(),
    );
    expect(a.ready, a.problems.join()).toBe(true);
    const L2 = lane({ route: POL });
    L2.chain.tamper = (op, method) =>
      op === 1 && method === "eth_maxPriorityFeePerGas"
        ? hex(10n ** 13n)
        : undefined;
    const b = await L2.engine.review(OWNER_KEY);
    expect(b.gas.maxPriorityFeePerGas).toBe(r.maxTipWei.toString());
    expect(b.ready, b.problems.join()).toBe(true);
  });
  it("Polygon: 3 x base + tip above the 2 000 gwei ceiling -> FEE_CAP_ABOVE_SIGNER_POLICY", async () => {
    const L = lane({ route: POL });
    L.chain.baseFee = 700_000_000_000n;
    const r = await L.engine.review(OWNER_KEY);
    expect(BigInt(r.gas.maxFeePerGas) > R(POL).maxFeePerGasWei).toBe(true);
    expect(r.problems).toContain("FEE_CAP_ABOVE_SIGNER_POLICY");
    expect(r.ready).toBe(false);
  });
  it("Arbitrum: tips are ignored (maxTipWei 0): any suggested tip becomes 0", async () => {
    const L = lane({ route: ARB });
    L.chain.tip = 5_000_000n;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.gas.maxPriorityFeePerGas).toBe("0");
    expect(r.gas.maxFeePerGas).toBe((3n * L.chain.baseFee).toString());
  });
  it("Ethereum: a fee above its 5 gwei ceiling (signer v5) is refused; the gas budget binds first at ~2 gwei", async () => {
    const L = lane({ route: ETH });
    L.chain.baseFee = 1_000_000_000n; // 3 gwei + tip: under the ceiling, over the ~0.92 USD budget
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toEqual(["GAS_BUDGET"]);
    const L2 = lane({ route: ETH });
    L2.chain.baseFee = 4_000_000_000n;
    expect((await L2.engine.review(OWNER_KEY)).problems).toEqual(
      expect.arrayContaining(["FEE_CAP_ABOVE_SIGNER_POLICY", "GAS_BUDGET"]),
    );
  });
});

describe("pool shape and block age per route", () => {
  it.each(ENABLED_ROUTE_IDS)(
    "%s: the pool's token order must be the route's",
    async (id) => {
      const L = lane({ route: id });
      const r = R(id);
      L.chain.tamper = (_op, method, params) => {
        if (method !== "eth_call") return undefined;
        const c = params[0] as { to: string; data: string };
        if (lc(c.to) !== lc(r.pool)) return undefined;
        // swap token0 and token1
        if (c.data === "0x0dfe1681")
          return "0x" + w(r.payIsToken0 ? r.receive.address : r.pay.address);
        if (c.data === "0xd21220a7")
          return "0x" + w(r.payIsToken0 ? r.pay.address : r.receive.address);
        return undefined;
      };
      expect((await L.engine.review(OWNER_KEY)).problems).toContain(
        "POOL_SHAPE_MISMATCH",
      );
    },
  );
  it("the read block's age limit is the route's (Arbitrum 10 s, Ethereum 45 s = signer v5)", async () => {
    const A = lane({ route: ARB });
    A.chain.lagSec = 11;
    expect((await A.engine.review(OWNER_KEY)).problems).toContain(
      "REVIEW_BLOCK_TOO_OLD",
    );
    const A2 = lane({ route: ARB });
    A2.chain.lagSec = 5;
    expect((await A2.engine.review(OWNER_KEY)).ready).toBe(true);
    const E = lane({ route: ETH });
    E.chain.lagSec = 43; // read block 45 s old: exactly at the limit
    expect((await E.engine.review(OWNER_KEY)).ready).toBe(true);
    const E2 = lane({ route: ETH });
    E2.chain.lagSec = 44; // 46 s
    expect((await E2.engine.review(OWNER_KEY)).problems).toContain(
      "REVIEW_BLOCK_TOO_OLD",
    );
  });
  it("a quote at exactly the spot price on a payIsToken0 route has zero impact", async () => {
    const L = lane({ route: ETH });
    L.chain.quoteOut = quoteAtImpact(0, R(ETH).maxAmount, ETH);
    const r = await L.engine.review(OWNER_KEY);
    expect(r.priceImpactBps).toBe(0);
    expect(r.quoteOut).toBe(r.spotOut);
  });
  it("another account's reads never leave the route's shape (no violations on any route)", async () => {
    for (const id of ENABLED_ROUTE_IDS) {
      const L = lane({ route: id });
      await L.engine.review(OWNER_KEY);
      expect(L.chain.violations, id).toEqual([]);
      expect(
        L.chain.log.every(
          (x) => !JSON.stringify(x.params).toLowerCase().includes(lc(OTHER)),
        ),
      ).toBe(true);
    }
  });
});

describe("the asset registry knows every ENABLED route's tokens (Guardian asset evidence)", () => {
  it.each(ENABLED_ROUTE_IDS)(
    "%s: pay and receive tokens are CURATED, no risk, exact decimals",
    (id) => {
      const r = R(id);
      for (const [t, d] of [
        [r.pay, 6],
        [r.receive, 18],
      ] as const) {
        const a = knownAsset(r.chainId, t.address, false);
        expect(a, `${id} ${t.symbol}`).not.toBeNull();
        expect(a).toMatchObject({ level: "CURATED", risk: [], decimals: d });
      }
    },
  );
  it("the Base WETH row is exactly the reviewed source's row (a rebuild keeps it)", () => {
    expect(reviewedWrapped.assets).toHaveLength(1);
    const row = reviewedWrapped.assets[0];
    expect(row).toEqual({
      chainId: "8453",
      address: "0x4200000000000000000000000000000000000006",
      native: false,
      symbol: "WETH",
      name: "Wrapped Ether",
      decimals: 18,
      level: "CURATED",
      sources: ["otherbridge-curated", "routing", "coingecko"],
      logo: null,
      coingeckoId: "l2-standard-bridged-weth-base",
      risk: [],
      routable: true,
    });
    expect(registryFile.assets).toContainEqual(row);
    expect(
      registryFile.assets.filter(
        (a) => a.chainId === "8453" && a.symbol.toUpperCase() === "WETH",
      ),
    ).toHaveLength(1);
  });
});

/**
 * A pinned copy of the multi-chain restricted signer v5's values (D:/vnd/hk1/mc1/signer/policy-v5.mjs, CHAINS and the
 * swap routes, read 2026-11-16 after its Base pool / route-id alignment): the lane may never be looser than the signer
 * it hands transactions to. BNB and Avalanche are BLOCKED in both.
 */
const SIGNER_V5: Record<
  string,
  {
    maxFeePerGasWei: bigint;
    minPriorityFeePerGasWei: bigint;
    minConfirmations: number;
    maxReadBlockAgeSec: number;
    swapGasBudgetWei: bigint;
  }
> = {
  "1": {
    maxFeePerGasWei: 5_000_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 10,
    maxReadBlockAgeSec: 45,
    swapGasBudgetWei: 546_000_000_000_000n,
  },
  "8453": {
    maxFeePerGasWei: 200_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 300,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 17_700_000_000_000n,
  },
  "42161": {
    maxFeePerGasWei: 400_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 200,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 58_700_000_000_000n,
  },
  "10": {
    maxFeePerGasWei: 20_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 30,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 2_990_000_000_000n,
  },
  "137": {
    maxFeePerGasWei: 2_000_000_000_000n,
    minPriorityFeePerGasWei: 30_000_000_000n,
    minConfirmations: 64,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 1_370_000_000_000_000_000n,
  },
  "56": {
    maxFeePerGasWei: 3_000_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 140,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 145_000_000_000_000n,
  },
  "43114": {
    maxFeePerGasWei: 100_000_000_000n,
    minPriorityFeePerGasWei: 0n,
    minConfirmations: 60,
    maxReadBlockAgeSec: 30,
    swapGasBudgetWei: 32_600_000_000_000_000n,
  },
};
const SIGNER_V5_SWAP_GAS_CAP = { APPROVE: 120_000n, EXECUTE: 400_000n };

describe("never looser than the multi-chain signer v5", () => {
  it("every route has signer values", () => {
    expect(
      ROUTES.filter((r) => !SIGNER_V5[r.chainId]).map((r) => r.id),
    ).toEqual([]);
  });
  it.each(ALL_IDS)(
    "%s: fee ceiling, budget, confirmations, block age, tips and gas caps inside the signer's",
    (id) => {
      const r = R(id),
        s = SIGNER_V5[r.chainId];
      // ENABLED routes use EXACTLY the signer's ceiling; nothing may exceed it
      if (r.status === "ENABLED")
        expect(r.maxFeePerGasWei).toBe(s.maxFeePerGasWei);
      expect(r.maxFeePerGasWei <= s.maxFeePerGasWei).toBe(true);
      expect(r.gasBudgetWei <= s.swapGasBudgetWei).toBe(true);
      expect(r.confirmations).toBeGreaterThanOrEqual(s.minConfirmations);
      expect(r.maxReviewBlockAgeSec).toBeLessThanOrEqual(s.maxReadBlockAgeSec);
      expect(r.minTipWei >= s.minPriorityFeePerGasWei).toBe(true);
      expect(r.maxTipWei <= s.maxFeePerGasWei).toBe(true);
      expect(r.maxGas.APPROVE <= SIGNER_V5_SWAP_GAS_CAP.APPROVE).toBe(true);
      expect(r.maxGas.SWAP <= SIGNER_V5_SWAP_GAS_CAP.EXECUTE).toBe(true);
    },
  );
  it("the budgets are min(lane value, signer swap budget): Base and OP take the signer's", () => {
    expect(R(BASE).gasBudgetWei).toBe(SIGNER_V5["8453"].swapGasBudgetWei);
    expect(R(OP).gasBudgetWei).toBe(SIGNER_V5["10"].swapGasBudgetWei);
    expect(R(ETH).gasBudgetWei).toBe(500_000_000_000_000n);
    expect(R(ARB).gasBudgetWei).toBe(50_000_000_000_000n);
    expect(R(POL).gasBudgetWei).toBe(1_100_000_000_000_000_000n);
  });
});

describe("pool pins: verified on both lane operators, and an unverified pin is still refused", () => {
  it("no pin of any route is null; the pool hashes are the B-matrix pool-codehashes.json values", async () => {
    const real = await vi.importActual<
      typeof import("../../src/swap/lane/pins")
    >("../../src/swap/lane/pins");
    for (const id of ALL_IDS)
      for (const p of [
        real.SWAP_LANE_ROUTE_PINS[id].pay,
        real.SWAP_LANE_ROUTE_PINS[id].receive,
        real.SWAP_LANE_ROUTE_PINS[id].router,
        real.SWAP_LANE_ROUTE_PINS[id].quoter,
        real.SWAP_LANE_ROUTE_PINS[id].factory,
        real.SWAP_LANE_ROUTE_PINS[id].pool,
      ])
        expect(p.codehash, `${id} ${p.address}`).toMatch(/^0x[0-9a-f]{64}$/);
    expect(
      Object.fromEntries(
        ALL_IDS.map((id) => [id, real.SWAP_LANE_ROUTE_PINS[id].pool.codehash]),
      ),
    ).toEqual({
      [BASE]:
        "0xcd06f61c6db6a1d8317548aaaa0aa83254624aec741534c51815810e977587ae",
      [ETH]:
        "0x65154c5c5a7a171a3d89df22d2a11319ddcb60bdf00ff9a4e3bd7312cb6badce",
      [ARB]:
        "0x2a97cecfded007e8ef2bb083121cd8331ae4984c84abef1516776f57a887fd9b",
      [OP]: "0xd20e8366dace090b2b758dd366810eae25224ad5d9d562a683fbbe78f566e4d4",
      [POL]:
        "0x01852aa83592c7f15c79f75d316e5af8ac007bb693136bae1068e1160992dd8a",
      [BNB]:
        "0x62f53d9a50eae0140d6d3724e022a1abff21be88269b6f4065b10ccf15a05238",
      [AVAX]:
        "0x5f749fa34b67231847e5343ec7f72968e26ca17198cc0876b785292067902932",
    });
  });
  it.each(ENABLED_ROUTE_IDS)(
    "%s: a pin set served with a null pool hash is refused (PIN_UNVERIFIED), the code is never read as a match",
    async (id) => {
      PIN_TEST_OVERRIDES.nullPoolOf = id;
      try {
        const L = lane({ route: id });
        const pool = R(id).pool;
        const r = await L.engine.review(OWNER_KEY);
        expect(r.ready).toBe(false);
        expect(r.pins.problems).toEqual([`PIN_UNVERIFIED:${pool}`]);
        expect(r.problems).toContain(`PIN_UNVERIFIED:${pool}`);
        expect(
          L.chain.log.some(
            (x) =>
              x.method === "eth_getCode" &&
              lc(String(x.params[0])) === lc(pool),
          ),
        ).toBe(false);
        expect(
          await err(() => L.engine.authorize(r.reviewId, OWNER_KEY)),
        ).toMatchObject({
          code: "REVIEW_NOT_READY",
        });
      } finally {
        PIN_TEST_OVERRIDES.nullPoolOf = null;
      }
      // without the override the same route is ready again
      expect((await lane({ route: id }).engine.review(OWNER_KEY)).ready).toBe(
        true,
      );
    },
  );
});
