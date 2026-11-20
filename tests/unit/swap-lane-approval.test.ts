// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane's protected facts, record validator and gate
// (src/swap/lane/approval.ts). The disarmed build keeps the gate CLOSED for any facts; with an explicit SYNTHETIC record,
// key digest and wiring the gate opens ONLY for the exact approve / exact swap, and every single deviation closes it.
// SYNTHETIC_TEST_ONLY: the record below is never a protected constant; nothing here signs or reaches a network.
import { describe, expect, it } from "vitest";
import { maxUint256, type Hex } from "viem";
import {
  OWNER_SWAP_LANE_APPROVAL,
  OWNER_SWAP_LANE_KEY_SHA256,
  OWNER_SWAP_LANE_SIGNER,
  SWAP_LANE_APPROVAL_BOUNDS,
  SWAP_LANE_APPROVAL_VERSION,
  SWAP_LANE_LIVE_WIRING,
  swapLaneGateState,
  swapLaneRecordProblems,
  type OwnerSwapLaneApproval,
  type SwapLaneStepFacts,
} from "../../src/swap/lane/approval";
import { approveCalldata, swapCalldata } from "../../src/swap/lane/calldata";
import { SWAP_LANE_ROUTE_PINS } from "../../src/swap/lane/pins";
import { SWAP_LANE_ROUTES, SWAP_LANE_SCOPE } from "../../src/swap/lane/scope";
import { swapLaneArmed } from "../../src/swap/lane/runtime";

const OWNER = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const HOUR = 3_600_000;
const DIGEST = "d".repeat(64);
const MIN_OUT = 330_000_000_000_000n;
/** The reviewed Base route: this file's fixture (every other route: swap-lane-routes.test.ts). */
const BASE = "base-usdc-weth-univ3-max1";
const BASE_ROUTE = SWAP_LANE_ROUTES[BASE];
const BASE_PINS = SWAP_LANE_ROUTE_PINS[BASE];
const RECORD: Readonly<OwnerSwapLaneApproval> = Object.freeze({
  version: SWAP_LANE_APPROVAL_VERSION,
  approvalId: "0x" + "1a".repeat(32),
  route: BASE,
  scope: BASE,
  pinSet: BASE_PINS.set,
  account: OWNER,
  chainId: "8453",
  tokenIn: BASE_PINS.pay.address,
  tokenOut: BASE_PINS.receive.address,
  router: BASE_PINS.router.address,
  exactAmount: "1000000",
  maxSlippageBps: 50,
  nativeGasBudgetWei: "17700000000000",
  firstNonce: "7",
  notBefore: NOW - HOUR,
  notAfter: NOW + 6 * HOUR,
  singleUse: true,
  allowanceCleanup: "ZERO_REVOKE_ONLY",
});
const hex = (n: bigint | number) => "0x" + BigInt(n).toString(16);
const deadline = (now = NOW) =>
  BigInt(Math.floor(now / 1000) + SWAP_LANE_SCOPE.deadlineSec);
const approveFacts = (
  over: Partial<SwapLaneStepFacts> = {},
  tx: Partial<SwapLaneStepFacts["tx"]> = {},
): SwapLaneStepFacts => ({
  route: BASE,
  step: "APPROVE",
  exactAmount: RECORD.exactAmount,
  tx: {
    chainId: "0x2105",
    from: OWNER,
    to: BASE_PINS.pay.address.toLowerCase(),
    value: "0x0",
    data: approveCalldata(BASE_ROUTE, 1_000_000n),
    gas: hex(55_200),
    maxFeePerGas: hex(11_000_000),
    maxPriorityFeePerGas: hex(1_000_000),
    ...tx,
  },
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 3_000_000_000_000n,
  now: NOW,
  ...over,
});
const swapData = (
  p: Partial<{
    owner: string;
    amountIn: bigint;
    amountOutMinimum: bigint;
    deadline: bigint;
  }> = {},
) =>
  swapCalldata(BASE_ROUTE, {
    owner: OWNER,
    amountIn: 1_000_000n,
    amountOutMinimum: MIN_OUT,
    deadline: deadline(),
    ...p,
  });
const swapFacts = (
  over: Partial<SwapLaneStepFacts> = {},
  tx: Partial<SwapLaneStepFacts["tx"]> = {},
): SwapLaneStepFacts => ({
  route: BASE,
  step: "SWAP",
  exactAmount: RECORD.exactAmount,
  amountOutMinimum: MIN_OUT,
  tx: {
    chainId: "0x2105",
    from: OWNER,
    to: BASE_PINS.router.address.toLowerCase(),
    value: "0x0",
    data: swapData(),
    gas: hex(180_000),
    maxFeePerGas: hex(11_000_000),
    maxPriorityFeePerGas: hex(1_000_000),
    ...tx,
  },
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 3_000_000_000_000n,
  now: NOW,
  ...over,
});
/** The gate with the SYNTHETIC record, a well-formed digest and wiring on (never the protected constants). */
const armedGate = (facts?: SwapLaneStepFacts, record = RECORD) =>
  swapLaneGateState(facts, record, DIGEST, true);
const closedWith = (facts: SwapLaneStepFacts, ...reasons: string[]) => {
  const g = armedGate(facts);
  expect(g.state).toBe("CLOSED");
  expect(g.open).toBe(false);
  for (const r of reasons) expect(g.reasons).toContain(r);
  return g;
};

describe("the disarmed build", () => {
  it("all four protected facts are closed", () => {
    expect(OWNER_SWAP_LANE_APPROVAL).toBeNull();
    expect(OWNER_SWAP_LANE_KEY_SHA256).toBeNull();
    expect(SWAP_LANE_LIVE_WIRING).toBe(false);
    expect(OWNER_SWAP_LANE_SIGNER).toBeNull();
  });
  it("swapLaneGateState() is CLOSED with exactly the three missing-fact reasons", () => {
    const g = swapLaneGateState();
    expect(g).toEqual({
      state: "CLOSED",
      open: false,
      reasons: [
        "NO_OWNER_APPROVED_SWAP_LANE",
        "NO_OWNER_SWAP_LANE_KEY",
        "SWAP_LANE_NOT_WIRED",
      ],
      // no record: no route, so no scope and no pin set
      scope: null,
      pinSet: null,
    });
  });
  it("exact, fully proven facts cannot open the disarmed gate", () => {
    for (const f of [approveFacts(), swapFacts()]) {
      const g = swapLaneGateState(f);
      expect(g.open).toBe(false);
      expect(g.reasons).toEqual([
        "NO_OWNER_APPROVED_SWAP_LANE",
        "NO_OWNER_SWAP_LANE_KEY",
        "SWAP_LANE_NOT_WIRED",
      ]);
    }
  });
  it("a valid record alone (no key, no wiring) does not open it either", () => {
    expect(swapLaneGateState(approveFacts(), RECORD).reasons).toEqual([
      "NO_OWNER_SWAP_LANE_KEY",
      "SWAP_LANE_NOT_WIRED",
    ]);
    expect(swapLaneGateState(approveFacts(), RECORD, DIGEST).reasons).toEqual([
      "SWAP_LANE_NOT_WIRED",
    ]);
    expect(
      swapLaneGateState(approveFacts(), RECORD, DIGEST, "true" as never)
        .reasons,
    ).toEqual(["SWAP_LANE_NOT_WIRED"]);
    expect(
      swapLaneGateState(approveFacts(), RECORD, DIGEST, 1 as never).reasons,
    ).toEqual(["SWAP_LANE_NOT_WIRED"]);
  });
  it("a malformed key digest is no key", () => {
    for (const d of [
      "D".repeat(64),
      "d".repeat(63),
      "d".repeat(65),
      "",
      "0x" + "d".repeat(64),
    ])
      expect(
        swapLaneGateState(approveFacts(), RECORD, d, true).reasons,
      ).toEqual(["NO_OWNER_SWAP_LANE_KEY"]);
  });
  it("swapLaneArmed() reports not armed with every missing fact (signer included)", () => {
    expect(swapLaneArmed()).toEqual({
      armed: false,
      reasons: [
        "NO_OWNER_APPROVED_SWAP_LANE",
        "NO_OWNER_SWAP_LANE_KEY",
        "NO_LOCAL_SIGNER",
        "SWAP_LANE_NOT_WIRED",
      ],
    });
  });
});

describe("the record validator", () => {
  it("the synthetic record is well formed and inside the bounds", () => {
    expect(swapLaneRecordProblems(RECORD)).toEqual([]);
    expect(SWAP_LANE_APPROVAL_BOUNDS[BASE].maxAmount).toBe("1000000");
    expect(SWAP_LANE_APPROVAL_BOUNDS[BASE].maxSlippageBps).toBe(50);
    expect(SWAP_LANE_APPROVAL_BOUNDS[BASE].maxGasBudgetWei).toBe(
      "17700000000000",
    );
    expect(SWAP_LANE_APPROVAL_BOUNDS[BASE].maxWindowMs).toBe(24 * HOUR);
  });
  it("inclusive bounds are accepted (0.1 USDC, 1 USDC, 1 bps, 50 bps, 1 wei .. the 1.77e13 wei route budget, a 24 h window)", () => {
    for (const over of [
      { exactAmount: "100000" },
      { exactAmount: "1000000" },
      { maxSlippageBps: 1 },
      { maxSlippageBps: 50 },
      { nativeGasBudgetWei: "1" },
      { firstNonce: "0" },
      { firstNonce: "18446744073709551615" },
      { nativeGasBudgetWei: "17700000000000" },
      { notBefore: NOW, notAfter: NOW + 24 * HOUR },
      { account: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
      { router: BASE_PINS.router.address.toLowerCase() },
      { tokenIn: BASE_PINS.pay.address.toLowerCase() },
    ])
      expect(
        swapLaneRecordProblems({ ...RECORD, ...over }),
        JSON.stringify(over),
      ).toEqual([]);
  });
  const cases: [string, Record<string, unknown>, string][] = [
    ["amount above 1 USDC", { exactAmount: "1000001" }, "AMOUNT_BOUNDS"],
    ["amount of 2 USDC", { exactAmount: "2000000" }, "AMOUNT_BOUNDS"],
    ["amount below 0.1 USDC", { exactAmount: "99999" }, "AMOUNT_BOUNDS"],
    ["amount zero", { exactAmount: "0" }, "AMOUNT_BOUNDS"],
    ["amount as a number", { exactAmount: 1_000_000 }, "AMOUNT"],
    ["amount with a leading zero", { exactAmount: "01000000" }, "AMOUNT"],
    ["amount in exponent form", { exactAmount: "1e6" }, "AMOUNT"],
    ["amount negative", { exactAmount: "-1" }, "AMOUNT"],
    ["amount hex", { exactAmount: "0xf4240" }, "AMOUNT"],
    ["slippage above 50 bps", { maxSlippageBps: 51 }, "SLIPPAGE_BOUNDS"],
    ["slippage of 100 bps", { maxSlippageBps: 100 }, "SLIPPAGE_BOUNDS"],
    ["slippage zero", { maxSlippageBps: 0 }, "SLIPPAGE_BOUNDS"],
    ["slippage fractional", { maxSlippageBps: 30.5 }, "SLIPPAGE_BOUNDS"],
    ["slippage as a string", { maxSlippageBps: "30" }, "SLIPPAGE_BOUNDS"],
    [
      "gas budget above the Base route budget (1.77e13)",
      { nativeGasBudgetWei: "17700000000001" },
      "GAS_BUDGET_BOUNDS",
    ],
    [
      "gas budget of 1 ETH",
      { nativeGasBudgetWei: "1000000000000000000" },
      "GAS_BUDGET_BOUNDS",
    ],
    ["gas budget zero", { nativeGasBudgetWei: "0" }, "GAS_BUDGET_BOUNDS"],
    ["gas budget hex", { nativeGasBudgetWei: "0x10" }, "GAS_BUDGET"],
    ["gas budget number", { nativeGasBudgetWei: 1e14 }, "GAS_BUDGET"],
    ["firstNonce missing", { firstNonce: undefined }, "FIRST_NONCE"],
    ["firstNonce as a number", { firstNonce: 7 }, "FIRST_NONCE"],
    ["firstNonce with a leading zero", { firstNonce: "07" }, "FIRST_NONCE"],
    ["firstNonce hex", { firstNonce: "0x7" }, "FIRST_NONCE"],
    ["firstNonce negative", { firstNonce: "-1" }, "FIRST_NONCE"],
    ["firstNonce empty", { firstNonce: "" }, "FIRST_NONCE"],
    ["firstNonce fractional", { firstNonce: "7.0" }, "FIRST_NONCE"],
    [
      "window above 24 h",
      { notBefore: NOW, notAfter: NOW + 24 * HOUR + 1 },
      "WINDOW_BOUNDS",
    ],
    [
      "window of a week",
      { notBefore: NOW, notAfter: NOW + 7 * 24 * HOUR },
      "WINDOW_BOUNDS",
    ],
    ["window empty", { notBefore: NOW, notAfter: NOW }, "WINDOW_BOUNDS"],
    ["window inverted", { notBefore: NOW, notAfter: NOW - 1 }, "WINDOW_BOUNDS"],
    ["window fractional", { notAfter: NOW + 0.5 }, "WINDOW"],
    ["window as strings", { notBefore: String(NOW) }, "WINDOW"],
    ["window unsafe integer", { notAfter: 2 ** 60 }, "WINDOW"],
    [
      "wrong router",
      { router: "0xE592427A0AEce92De3Edee1F18E0157C05861564" },
      "ROUTER",
    ],
    ["router = the pool", { router: BASE_PINS.pool.address }, "ROUTER"],
    [
      "router = Permit2",
      { router: "0x000000000022D473030F116dDEE9F6B43aC78BA3" },
      "ROUTER",
    ],
    ["wrong tokenIn", { tokenIn: OTHER }, "TOKENS"],
    ["wrong tokenOut", { tokenOut: OTHER }, "TOKENS"],
    [
      "tokens swapped",
      {
        tokenIn: BASE_PINS.receive.address,
        tokenOut: BASE_PINS.pay.address,
      },
      "TOKENS",
    ],
    [
      "bad approvalId (upper case)",
      { approvalId: "0x" + "1A".repeat(32) },
      "APPROVAL_ID",
    ],
    [
      "bad approvalId (short)",
      { approvalId: "0x" + "1a".repeat(31) },
      "APPROVAL_ID",
    ],
    ["bad approvalId (no 0x)", { approvalId: "1a".repeat(32) }, "APPROVAL_ID"],
    ["bad approvalId (number)", { approvalId: 1 }, "APPROVAL_ID"],
    ["wrong version", { version: "veined.canary.approval.v1" }, "VERSION"],
    [
      "a single-route (v1) record",
      { version: "veined.swap-lane.approval.v1" },
      "VERSION",
    ],
    ["no route", { route: undefined }, "ROUTE"],
    ["an unknown route", { route: "base-usdc-weth-univ3-max5" }, "ROUTE"],
    ["an inherited key as the route", { route: "__proto__" }, "ROUTE"],
    ["a route as a number", { route: 8453 }, "ROUTE"],
    [
      "another route with the Base values",
      { route: "eth-usdc-weth-univ3-max1" },
      "CHAIN",
    ],
    ["a BLOCKED route", { route: "bnb-usdc-wbnb-univ3-max1" }, "ROUTE_BLOCKED"],
    ["wrong scope", { scope: "base-usdc-weth-univ3-max5" }, "SCOPE"],
    ["wrong pin set", { pinSet: "fl1-swap-lane-pins.2026-11-14.1" }, "PIN_SET"],
    [
      "zero account",
      { account: "0x0000000000000000000000000000000000000000" },
      "ACCOUNT",
    ],
    ["short account", { account: "0x3333" }, "ACCOUNT"],
    ["non-hex account", { account: "0x" + "g".repeat(40) }, "ACCOUNT"],
    ["chain as a number", { chainId: 8453 }, "CHAIN"],
    ["another chain", { chainId: "42161" }, "CHAIN"],
    ["hex chain id", { chainId: "0x2105" }, "CHAIN"],
    ["not single use", { singleUse: false }, "SINGLE_USE"],
    ["single use as a string", { singleUse: "true" }, "SINGLE_USE"],
    ["another cleanup policy", { allowanceCleanup: "NONE" }, "CLEANUP_POLICY"],
    ["extra field (spender)", { spender: OTHER }, "UNKNOWN_FIELD:spender"],
    [
      "extra field (recipient)",
      { recipient: OTHER },
      "UNKNOWN_FIELD:recipient",
    ],
    ["extra field (unlimited)", { unlimited: true }, "UNKNOWN_FIELD:unlimited"],
  ];
  it.each(cases)("%s is refused", (_, over, code) => {
    const p = swapLaneRecordProblems({ ...RECORD, ...over });
    expect(p).toContain(code);
    expect(
      swapLaneGateState(
        approveFacts(),
        { ...RECORD, ...over } as never,
        DIGEST,
        true,
      ).reasons,
    ).toContain(`RECORD:${code}`);
  });
  it("a missing field is refused", () => {
    for (const k of Object.keys(RECORD)) {
      const r: Record<string, unknown> = { ...RECORD };
      delete r[k];
      expect(swapLaneRecordProblems(r).length, k).toBeGreaterThan(0);
    }
  });
  it("an own __proto__ key (JSON) is an unknown field", () => {
    const r = JSON.parse(
      JSON.stringify(RECORD).replace(/^\{/, '{"__proto__":{"singleUse":true},'),
    ) as unknown;
    expect(swapLaneRecordProblems(r)).toContain("UNKNOWN_FIELD:__proto__");
  });
  it("no record / not an object", () => {
    for (const r of [null, undefined, 0, "", "record", true])
      expect(swapLaneRecordProblems(r)).toEqual(["NO_RECORD"]);
    expect(swapLaneRecordProblems([]).length).toBeGreaterThan(5);
    expect(swapLaneRecordProblems({}).length).toBeGreaterThan(5);
  });
  it("a record with problems is never evaluated against facts (record reasons only, no STEP reasons)", () => {
    const g = swapLaneGateState(
      approveFacts(),
      { ...RECORD, exactAmount: "2000000" },
      DIGEST,
      true,
    );
    expect(g.reasons).toEqual(["RECORD:AMOUNT_BOUNDS"]);
  });
});

describe("the gate with an explicit synthetic record, key digest and wiring", () => {
  it("OPEN for the exact approve", () => {
    expect(armedGate(approveFacts())).toEqual({
      state: "OPEN",
      open: true,
      reasons: [],
      scope: BASE,
      pinSet: BASE_PINS.set,
    });
  });
  it("OPEN for the exact swap", () => {
    expect(armedGate(swapFacts()).state).toBe("OPEN");
    expect(armedGate(swapFacts()).reasons).toEqual([]);
  });
  it("OPEN at the exact gas caps and at the exact gas budget", () => {
    expect(armedGate(approveFacts({}, { gas: hex(100_000) })).open).toBe(true);
    expect(armedGate(swapFacts({}, { gas: hex(350_000) })).open).toBe(true);
    expect(
      armedGate(approveFacts({ gasWorstCaseTotalWei: 17_700_000_000_000n }))
        .open,
    ).toBe(true);
  });
  it("no facts -> SWAP_LANE_FACTS_MISSING", () => {
    expect(armedGate().reasons).toEqual(["SWAP_LANE_FACTS_MISSING"]);
    expect(
      armedGate({ ...approveFacts(), tx: undefined } as never).reasons,
    ).toEqual(["SWAP_LANE_FACTS_MISSING"]);
  });
  it("malicious spender (any non-router spender)", () => {
    for (const spender of [
      OTHER,
      BASE_PINS.pool.address,
      "0x000000000022D473030F116dDEE9F6B43aC78BA3",
    ]) {
      const data = ("0x095ea7b3" +
        spender.slice(2).toLowerCase().padStart(64, "0") +
        (1_000_000).toString(16).padStart(64, "0")) as Hex;
      closedWith(approveFacts({}, { data }), "STEP:APPROVE_SPENDER_NOT_ROUTER");
    }
  });
  it("unlimited or wrong-amount approve", () => {
    closedWith(
      approveFacts({}, { data: approveCalldata(BASE_ROUTE, maxUint256) }),
      "STEP:APPROVE_NOT_EXACT_AMOUNT",
    );
    closedWith(
      approveFacts({}, { data: approveCalldata(BASE_ROUTE, 999_999n) }),
      "STEP:APPROVE_NOT_EXACT_AMOUNT",
    );
  });
  it("approve sent to a contract other than USDC", () => {
    closedWith(
      approveFacts({}, { to: BASE_PINS.receive.address }),
      "STEP:APPROVE_TARGET_NOT_USDC",
    );
    closedWith(
      approveFacts({}, { to: BASE_PINS.router.address }),
      "STEP:APPROVE_TARGET_NOT_USDC",
    );
  });
  it("approve step carrying swap calldata (and the reverse)", () => {
    closedWith(
      approveFacts({}, { data: swapData() }),
      "STEP:APPROVE_CALLDATA_NOT_CANONICAL",
    );
    closedWith(
      swapFacts({}, { data: approveCalldata(BASE_ROUTE, 1_000_000n) }),
      "STEP:SWAP_CALLDATA_NOT_CANONICAL",
    );
  });
  it("malicious recipient", () => {
    closedWith(
      swapFacts({}, { data: swapData({ owner: OTHER }) }),
      "STEP:SWAP_RECIPIENT_NOT_OWNER",
    );
    closedWith(
      swapFacts({}, { data: swapData({ owner: BASE_PINS.router.address }) }),
      "STEP:SWAP_RECIPIENT_NOT_OWNER",
    );
  });
  it("swap sent to a contract other than the router", () => {
    closedWith(swapFacts({}, { to: OTHER }), "STEP:SWAP_TARGET_NOT_ROUTER");
    closedWith(
      swapFacts({}, { to: BASE_PINS.pay.address }),
      "STEP:SWAP_TARGET_NOT_ROUTER",
    );
  });
  it("swap without a reviewed minimum, or with another minimum than the reviewed one", () => {
    closedWith(
      swapFacts({ amountOutMinimum: undefined }),
      "STEP:NO_REVIEWED_MINIMUM",
    );
    closedWith(
      swapFacts({ amountOutMinimum: MIN_OUT + 1n }),
      "STEP:SWAP_MIN_OUT_NOT_REVIEWED",
    );
    closedWith(
      swapFacts({}, { data: swapData({ amountOutMinimum: 1n }) }),
      "STEP:SWAP_MIN_OUT_NOT_REVIEWED",
    );
  });
  it("swap amount other than the record's", () => {
    closedWith(
      swapFacts({}, { data: swapData({ amountIn: 999_999n }) }),
      "STEP:SWAP_AMOUNT_NOT_EXACT",
    );
  });
  it("swap deadline passed or too far, against the facts' clock", () => {
    closedWith(swapFacts({ now: NOW + 301_000 }), "STEP:SWAP_DEADLINE_PASSED");
    closedWith(
      swapFacts({}, { data: swapData({ deadline: deadline() + 31n }) }),
      "STEP:SWAP_DEADLINE_TOO_FAR",
    );
  });
  it("expired record (at notAfter and after)", () => {
    closedWith(approveFacts({ now: RECORD.notAfter }), "STEP:APPROVAL_EXPIRED");
    closedWith(
      approveFacts({ now: RECORD.notAfter + 1 }),
      "STEP:APPROVAL_EXPIRED",
    );
    expect(armedGate(approveFacts({ now: RECORD.notAfter - 1 })).open).toBe(
      true,
    );
  });
  it("not-yet-valid record", () => {
    closedWith(
      approveFacts({ now: RECORD.notBefore - 1 }),
      "STEP:NOT_YET_VALID",
    );
    expect(armedGate(approveFacts({ now: RECORD.notBefore })).open).toBe(true);
  });
  it("gas budget exceeded", () => {
    closedWith(
      approveFacts({ gasWorstCaseTotalWei: 17_700_000_000_001n }),
      "STEP:GAS_BUDGET",
    );
    const small = { ...RECORD, nativeGasBudgetWei: "1000" };
    expect(
      swapLaneGateState(approveFacts(), small, DIGEST, true).reasons,
    ).toEqual(["STEP:GAS_BUDGET"]);
  });
  it("firstNonce is REQUIRED: a record without it is refused (and never opens the gate)", () => {
    const { firstNonce: _f, ...without } = RECORD;
    void _f;
    expect(swapLaneRecordProblems(without)).toEqual(["FIRST_NONCE"]);
    expect(
      swapLaneGateState(approveFacts(), without as never, DIGEST, true).reasons,
    ).toEqual(["RECORD:FIRST_NONCE"]);
  });
  it("a fee cap above the signer's ceiling (0.2 gwei), zero or unparsable -> FEE_CAP_ABOVE_SIGNER_POLICY", () => {
    const cap = BASE_ROUTE.maxFeePerGasWei;
    expect(cap).toBe(200_000_000n);
    expect(armedGate(approveFacts({}, { maxFeePerGas: hex(cap) })).open).toBe(
      true,
    );
    expect(armedGate(swapFacts({}, { maxFeePerGas: hex(cap) })).open).toBe(
      true,
    );
    for (const maxFeePerGas of [
      hex(cap + 1n),
      hex(10n ** 12n),
      "0x0",
      "",
      "x",
      "-1",
    ])
      closedWith(
        approveFacts({}, { maxFeePerGas }),
        "STEP:FEE_CAP_ABOVE_SIGNER_POLICY",
      );
    closedWith(
      swapFacts({}, { maxFeePerGas: hex(cap + 1n) }),
      "STEP:FEE_CAP_ABOVE_SIGNER_POLICY",
    );
  });
  it("a gas limit below 21 000 -> GAS_LIMIT_BELOW_FLOOR (21 000 itself is accepted)", () => {
    expect(SWAP_LANE_SCOPE.minGas).toBe(21_000n);
    expect(armedGate(approveFacts({}, { gas: hex(21_000) })).open).toBe(true);
    const g = closedWith(
      approveFacts({}, { gas: hex(20_999) }),
      "STEP:GAS_LIMIT_BELOW_FLOOR",
    );
    expect(g.reasons).toEqual(["STEP:GAS_LIMIT_BELOW_FLOOR"]);
    closedWith(swapFacts({}, { gas: hex(1) }), "STEP:GAS_LIMIT_BELOW_FLOOR");
    for (const gas of ["0x0", "garbage"])
      closedWith(
        approveFacts({}, { gas }),
        "STEP:GAS_LIMIT",
        "STEP:GAS_LIMIT_BELOW_FLOOR",
      );
  });
  it("gas limit above the step's cap, zero, negative or unparsable", () => {
    closedWith(approveFacts({}, { gas: hex(100_001) }), "STEP:GAS_LIMIT");
    closedWith(swapFacts({}, { gas: hex(350_001) }), "STEP:GAS_LIMIT");
    // the swap cap does not apply to an approve
    closedWith(approveFacts({}, { gas: hex(300_000) }), "STEP:GAS_LIMIT");
    for (const gas of ["0x0", "0", "-1", "garbage", "", "0x"])
      closedWith(approveFacts({}, { gas }), "STEP:GAS_LIMIT");
  });
  it("not attested / Guardian not passed / operators not proven (only literal true counts)", () => {
    closedWith(
      approveFacts({ reviewAttested: false }),
      "STEP:REVIEW_NOT_ATTESTED",
    );
    closedWith(
      approveFacts({ guardianPassed: false }),
      "STEP:GUARDIAN_NOT_PASSED",
    );
    closedWith(
      approveFacts({ operatorsAgree: false }),
      "STEP:OPERATORS_NOT_PROVEN",
    );
    closedWith(
      approveFacts({
        reviewAttested: "true" as never,
        guardianPassed: 1 as never,
        operatorsAgree: {} as never,
      }),
      "STEP:REVIEW_NOT_ATTESTED",
      "STEP:GUARDIAN_NOT_PASSED",
      "STEP:OPERATORS_NOT_PROVEN",
    );
  });
  it("native value", () => {
    for (const value of ["0x1", "0x00", "0", "0xde0b6b3a7640000"])
      closedWith(approveFacts({}, { value }), "STEP:NATIVE_VALUE");
    closedWith(swapFacts({}, { value: "0x1" }), "STEP:NATIVE_VALUE");
  });
  it("facts of another route than the record's", () => {
    for (const route of ["eth-usdc-weth-univ3-max1", "", "x"])
      closedWith(approveFacts({ route }), "STEP:ROUTE");
    expect(armedGate(approveFacts({ route: BASE })).open).toBe(true);
  });
  it("a priority fee outside the route's [minTipWei, maxTipWei] or above the fee cap", () => {
    expect(BASE_ROUTE.minTipWei).toBe(0n);
    expect(BASE_ROUTE.maxTipWei).toBe(10_000_000n);
    for (const t of [0n, 10_000_000n])
      expect(
        armedGate(approveFacts({}, { maxPriorityFeePerGas: hex(t) })).open,
      ).toBe(true);
    for (const maxPriorityFeePerGas of [hex(10_000_001n), "-1", "", "x"])
      closedWith(
        approveFacts({}, { maxPriorityFeePerGas }),
        "STEP:TIP_OUTSIDE_ROUTE_POLICY",
      );
    closedWith(
      swapFacts(
        {},
        {
          maxFeePerGas: hex(5_000_000n),
          maxPriorityFeePerGas: hex(6_000_000n),
        },
      ),
      "STEP:TIP_OUTSIDE_ROUTE_POLICY",
    );
  });
  it("the gate's scope and pin set are the record's route's", () => {
    const g = armedGate(approveFacts());
    expect(g.scope).toBe(BASE);
    expect(g.pinSet).toBe("fl1-swap-lane-pins.2026-11-15.1");
    // a record naming a BLOCKED route never reaches the step checks
    const blocked = swapLaneGateState(
      approveFacts(),
      { ...RECORD, route: "bnb-usdc-wbnb-univ3-max1" },
      DIGEST,
      true,
    );
    expect(blocked.open).toBe(false);
    expect(blocked.reasons).toContain("RECORD:ROUTE_BLOCKED");
    expect(blocked.reasons.some((r) => r.startsWith("STEP:"))).toBe(false);
  });
  it("wrong chain", () => {
    for (const chainId of ["0x1", "8453", "0xa4b1", "0x02105"])
      closedWith(approveFacts({}, { chainId }), "STEP:CHAIN");
  });
  it("wrong from", () => {
    closedWith(approveFacts({}, { from: OTHER }), "STEP:FROM_NOT_OWNER");
    closedWith(
      swapFacts({}, { from: BASE_PINS.router.address }),
      "STEP:FROM_NOT_OWNER",
    );
  });
  it("exactAmount other than the record's (even with a matching approve)", () => {
    closedWith(
      approveFacts({ exactAmount: "1000001" }),
      "STEP:AMOUNT_NOT_RECORD_AMOUNT",
    );
    const g = closedWith(
      approveFacts(
        { exactAmount: "500000" },
        { data: approveCalldata(BASE_ROUTE, 500_000n) },
      ),
      "STEP:AMOUNT_NOT_RECORD_AMOUNT",
      "STEP:APPROVE_NOT_EXACT_AMOUNT",
    );
    expect(g.reasons.length).toBe(2);
  });
  it("an unknown step", () => {
    closedWith(approveFacts({ step: "CLEANUP" as never }), "STEP:UNKNOWN_STEP");
  });
  it("VEINED-MC1 review MINOR-5: REVOKE opens only for approve(router, 0) on the route's USDC; an approval of the amount is not a revoke", () => {
    const revoke = approveFacts(
      { step: "REVOKE" },
      { data: approveCalldata(BASE_ROUTE, 0n) },
    );
    expect(armedGate(revoke).reasons).toEqual([]);
    // after the record window and without a Guardian verdict it still opens (it only lowers an allowance to 0)
    expect(
      armedGate({ ...revoke, now: RECORD.notAfter + 1, guardianPassed: false })
        .reasons,
    ).toEqual([]);
    closedWith(approveFacts({ step: "REVOKE" }), "STEP:REVOKE_NOT_ZERO");
    closedWith(
      approveFacts(
        { step: "REVOKE" },
        { data: approveCalldata(BASE_ROUTE, 0n), to: OTHER },
      ),
      "STEP:REVOKE_TARGET_NOT_USDC",
    );
  });
  it("every reason is reported at once (no early exit hides a second deviation)", () => {
    const g = armedGate(
      swapFacts(
        { operatorsAgree: false, now: RECORD.notAfter },
        { from: OTHER, value: "0x1", chainId: "0x1" },
      ),
    );
    expect(g.reasons).toEqual(
      expect.arrayContaining([
        "STEP:APPROVAL_EXPIRED",
        "STEP:CHAIN",
        "STEP:FROM_NOT_OWNER",
        "STEP:NATIVE_VALUE",
        "STEP:OPERATORS_NOT_PROVEN",
      ]),
    );
  });
});
