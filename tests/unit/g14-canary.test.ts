// G14 Track A: the owner-signed canary pathway (Base USDC -> Arbitrum USDC, <= 5 USDC, owner = sender = recipient),
// hardened after independent review round 1 (evidence/review-a1/REVIEW.md: F1–F15; every reproduction is a test here).
// SYNTHETIC_TEST_ONLY: the account is 0x3333…3333; the real artefacts are a PUBLIC LI.FI quote's calldata for that
// synthetic account and its eth_simulateV1 result (tests/fixtures/g14-canary-across.json, evidence canary-probe-1).
// Nothing here signs, sends or reaches a network. Every adversarial case must FAIL or be UNKNOWN, never PASS.
import { describe, expect, it } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  pad,
  type Hex,
} from "viem";
import fx from "../fixtures/g14-canary-across.json" with { type: "json" };
import {
  ACROSS_V4_ABI,
  decodeAcrossCall,
} from "../../src/execution/canary/across-decoder";
import {
  CANARY_PINS,
  destinationPinProblems,
  pinProblems,
  type DestinationPinReads,
  type PinReads,
} from "../../src/execution/canary/pins";
import {
  CANARY_SCOPE,
  revocationTransaction,
  scopeProblem,
} from "../../src/execution/canary/scope";
import {
  verifyCanaryQuote,
  type ExecutableQuote,
} from "../../src/execution/canary/quote-verify";
import {
  canarySimulationRequest,
  interpretCanarySimulation,
  type SimulationRequest,
} from "../../src/execution/canary/simulation";
import {
  agree,
  balanceAndGasCheck,
  normalizeOrigin,
  operatorOf,
  type SourceRead,
} from "../../src/execution/canary/chain-reads";
import {
  SETTLEMENT_ABI,
  depositFromSourceLogs,
  destinationSettlement,
  reconcileCanary,
  type CanaryDeposit,
  type ChainLog,
} from "../../src/execution/canary/settlement";
import { canaryReadiness } from "../../src/execution/canary/readiness";
import {
  CanaryAuthorizationStore,
  MemoryNonceJournal,
  TokenError,
} from "../../src/execution/server/canary/authorization-store";
import { ReviewAttestor } from "../../src/execution/server/canary/attestation";
import {
  AuditAnchorLog,
  verifyAnchored,
} from "../../src/execution/server/canary/audit-anchor";
import {
  CanaryEngine,
  MemoryUseJournal,
  type CanaryReviewInput,
} from "../../src/execution/server/canary/engine";
import { executionGateState } from "../../src/execution/server/gate";
import {
  apply,
  newRecord,
  type ExecutionEvent,
} from "../../src/execution/lifecycle";
import { observeSource } from "../../src/execution/tracking";
import { CHECK_IDS, preflightDigest } from "../../src/execution/preflight";

const SYN = "0x3333333333333333333333333333333333333333";
const OTHER = "0x4444444444444444444444444444444444444444";
const QUOTED_AT = Date.parse(fx.at);
const NOW = QUOTED_AT + 1000;
const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const quote = (
  over: Partial<NonNullable<ExecutableQuote["transactionRequest"]>> = {},
  extra: Partial<ExecutableQuote> = {},
): ExecutableQuote => ({
  tool: fx.tool,
  quotedAt: QUOTED_AT,
  transactionRequest: { ...fx.transactionRequest, ...over },
  estimate: { ...fx.estimate },
  ...extra,
});
type Args = [
  Record<string, unknown>,
  Record<string, unknown>[],
  Record<string, unknown>,
];
/** Re-encodes the real call with one field changed (canonical calldata, so only the semantic check can catch it). */
function mutate(f: (args: Args) => void): string {
  const d = decodeFunctionData({
    abi: ACROSS_V4_ABI,
    data: fx.transactionRequest.data as Hex,
  });
  const args = structuredClone(d.args) as unknown as Args;
  f(args);
  return encodeFunctionData({
    abi: ACROSS_V4_ABI,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: args as never,
  });
}
const b32 = (a: string) => pad(a as Hex, { size: 32 });
const verify = (
  q: ExecutableQuote | null,
  over: Partial<Parameters<typeof verifyCanaryQuote>[0]> = {},
) =>
  verifyCanaryQuote({
    quote: q,
    owner: SYN,
    amountIn: "5000000",
    minimumOut: "4979689",
    now: NOW,
    ...over,
  });
const status = (r: { checks: { id: string; status: string }[] }, id: string) =>
  r.checks.find((c) => c.id === id)?.status;
const BLOCK = {
  number: "56376191",
  hash: "0x" + "a".repeat(64),
  timestamp: Math.floor(NOW / 1000),
};
const pinReads = (
  origin = "https://base-rpc.publicnode.com",
  over: Partial<PinReads> = {},
): PinReads => ({
  origin,
  chainId: "8453",
  block: BLOCK,
  selector: CANARY_PINS.selector,
  diamondCodehash: fx.pins.diamondCodehash,
  facetForSelector: fx.pins.facet,
  facetCodehash: fx.pins.facetCodehash,
  facetSpokePool: fx.pins.proxies["8453"].spokePool,
  feeCollectorCodehash: CANARY_PINS.feeCollector.codehash,
  sourceSpokePool: {
    codehash: fx.pins.proxies["8453"].spokePoolProxyCodehash,
    implementation: fx.pins.proxies["8453"].spokePoolImplementation,
    implementationCodehash:
      fx.pins.proxies["8453"].spokePoolImplementationCodehash,
  },
  sourceUsdc: {
    codehash: CANARY_PINS.usdc["8453"].codehash,
    implementation: fx.pins.proxies["8453"].usdcImplementation,
    implementationCodehash: fx.pins.proxies["8453"].usdcImplementationCodehash,
    decimals: 6,
    symbol: "USDC",
  },
  ...over,
});
const destPins = (
  over: Partial<DestinationPinReads> = {},
): DestinationPinReads => ({
  spokePool: {
    codehash: fx.pins.proxies["42161"].spokePoolProxyCodehash,
    implementation: fx.pins.proxies["42161"].spokePoolImplementation,
    implementationCodehash:
      fx.pins.proxies["42161"].spokePoolImplementationCodehash,
  },
  usdc: {
    codehash: CANARY_PINS.usdc["42161"].codehash,
    implementation: fx.pins.proxies["42161"].usdcImplementation,
    implementationCodehash: fx.pins.proxies["42161"].usdcImplementationCodehash,
    decimals: 6,
    symbol: "USDC",
  },
  ...over,
});

describe("G14 canary scope and pins", () => {
  it("scope: 1..5 USDC, a real owner address", () => {
    expect(scopeProblem("5000000", SYN)).toBeNull();
    expect(scopeProblem("5000001", SYN)).toBe("AMOUNT_ABOVE_CANARY_MAXIMUM");
    expect(scopeProblem("999999", SYN)).toBe("AMOUNT_BELOW_MINIMUM");
    expect(scopeProblem("5e6", SYN)).toBe("AMOUNT_INVALID");
    expect(
      scopeProblem("5000000", "0x0000000000000000000000000000000000000000"),
    ).toBe("OWNER_INVALID");
    expect(CANARY_SCOPE.maxAmount).toBe(5_000_000n);
  });
  it("live evidence reads match every pin; re-route, upgrade, code change or unreadable values fail closed", () => {
    expect(pinProblems(pinReads())).toEqual([]);
    expect(
      pinProblems(pinReads(undefined, { facetForSelector: OTHER })),
    ).toEqual(["FACET_REROUTED"]);
    expect(
      pinProblems(
        pinReads(undefined, { facetCodehash: "0x" + "1".repeat(64) }),
      ),
    ).toEqual(["FACET_CODE_CHANGED"]);
    expect(
      pinProblems(
        pinReads(undefined, { feeCollectorCodehash: "0x" + "1".repeat(64) }),
      ),
    ).toEqual(["FEE_COLLECTOR_CHANGED"]);
    expect(
      pinProblems(
        pinReads(undefined, {
          sourceUsdc: { ...pinReads().sourceUsdc, implementation: OTHER },
        }),
      ),
    ).toEqual(["USDC_UPGRADED"]);
    expect(
      pinProblems(
        pinReads(undefined, {
          sourceSpokePool: {
            ...pinReads().sourceSpokePool,
            implementationCodehash: "0x" + "2".repeat(64),
          },
        }),
      ),
    ).toEqual(["SPOKEPOOL_UPGRADED"]);
    expect(
      pinProblems(pinReads(undefined, { diamondCodehash: null })),
    ).toContain("PIN_UNREADABLE");
    expect(pinProblems(pinReads(undefined, { block: null }))).toContain(
      "PIN_UNREADABLE",
    );
    expect(pinProblems(pinReads(undefined, { chainId: "1" }))).toContain(
      "WRONG_CHAIN",
    );
    expect(pinProblems(null)).toEqual(["PIN_UNREADABLE"]);
    expect(
      pinProblems(
        pinReads(undefined, {
          sourceUsdc: { ...pinReads().sourceUsdc, decimals: 18 },
        }),
      ),
    ).toEqual(["USDC_CHANGED"]);
    // F1: reads made for any other selector (the out-of-scope "start" entry) are not the canary's pins.
    expect(
      pinProblems(pinReads(undefined, { selector: "0xa1f1ce43" })),
    ).toEqual(["SELECTOR_NOT_IN_SCOPE"]);
    expect(destinationPinProblems(destPins())).toEqual([]);
    expect(
      destinationPinProblems(
        destPins({ usdc: { ...destPins().usdc, implementation: OTHER } }),
      ),
    ).toEqual(["USDC_UPGRADED"]);
    expect(destinationPinProblems(null)).toEqual(["PIN_UNREADABLE"]);
  });
  it("F12 / G14 closure: the release matrix says implemented and wired, activation disabled, no owner record", () => {
    const r = canaryReadiness();
    expect(r.wired).toBe(true);
    expect(r.active).toBe(false);
    expect(r.implementation).toBe("PRESENT");
    expect(r.activation).toBe("DISABLED");
    expect(r.ownerRecord).toBe("ABSENT");
    expect(
      r.controls.every((c) => c.state !== ("IMPLEMENTED_TESTED" as never)),
    ).toBe(true);
    expect(
      r.controls.filter((c) => c.state === "OWNER_STEP").map((c) => c.id),
    ).toEqual(["OWNER_APPROVED_CANARY_RECORD"]);
    expect(r.liveNeeds).toEqual(
      expect.arrayContaining([
        "OWNER_RECORD",
        "OWNER_ACTIVATION_AND_G7_APPLICATION",
        "OWNER_KEEPS_ANCHOR_HEAD",
        "OWNER_RABBY_ACCEPTANCE",
        "OWNER_GOAL",
      ]),
    );
  });
});

describe("G14 independent Across V4 decoder", () => {
  it("decodes the real call canonically and computes the facet's effective output", () => {
    const c = decodeAcrossCall(fx.transactionRequest.data)!;
    expect(c.selector).toBe(CANARY_PINS.selector);
    expect([c.receiver, c.across.receiver, c.across.refund]).toEqual([
      SYN,
      SYN,
      SYN,
    ]);
    expect(c.destinationChainId).toBe("42161");
    expect(c.bridgedAmount).toBe(4_987_500n);
    expect(c.steps[0].fees).toEqual([
      { recipient: CANARY_PINS.feeCollector.recipients[0], amount: 12_500n },
    ]);
    // AcrossFacetV4: minAmountAfterSwaps * outputAmountMultiplier / 1e18 = the quote's minimum exactly.
    expect(c.effectiveOutput).toBe(BigInt(fx.estimate.toAmountMin));
  });
  it("non-canonical, truncated, padded, unpinned or out-of-scope (start) calls are refused", () => {
    const d = fx.transactionRequest.data;
    expect(decodeAcrossCall(d + "00".repeat(32))).toBeNull();
    expect(decodeAcrossCall(d.slice(0, -64))).toBeNull();
    expect(decodeAcrossCall("0xdeadbeef" + d.slice(10))).toBeNull();
    expect(decodeAcrossCall(null)).toBeNull();
    const shifted =
      d.slice(0, 10) +
      (BigInt("0x" + d.slice(10, 74)) + 32n).toString(16).padStart(64, "0") +
      d.slice(74) +
      "00".repeat(32);
    expect(decodeAcrossCall(shifted)).toBeNull();
    const a = decodeFunctionData({ abi: ACROSS_V4_ABI, data: d as Hex })
      .args as unknown as Args;
    const start = encodeFunctionData({
      abi: ACROSS_V4_ABI,
      functionName: "startBridgeTokensViaAcrossV4",
      args: [a[0], a[2]] as never,
    });
    expect(decodeAcrossCall(start)).toBeNull();
  });
});

describe("G14 fresh executable quote verification", () => {
  it("the real quote passes every check for its own (synthetic) owner", () => {
    const v = verify(quote());
    expect(v.checks.filter((c) => c.status !== "PASS")).toEqual([]);
    expect(v.ready).toBe(true);
    expect(v.feeTotal).toBe(12_500n);
    expect(v.gasLimit).toBe(BigInt(fx.transactionRequest.gasLimit).toString());
  });
  it("adversarial quotes FAIL", () => {
    const cases: [string, ExecutableQuote, string][] = [
      [
        "other Across receiver",
        quote({ data: mutate((a) => (a[2].receiverAddress = b32(OTHER))) }),
        "RECIPIENT",
      ],
      [
        "other BridgeData receiver",
        quote({ data: mutate((a) => (a[0].receiver = OTHER)) }),
        "RECIPIENT",
      ],
      [
        "destination call",
        quote({
          data: mutate(
            (a) => (
              (a[0].hasDestinationCall = true),
              (a[2].message = "0x1234")
            ),
          ),
        }),
        "RECIPIENT",
      ],
      [
        "refund elsewhere",
        quote({ data: mutate((a) => (a[2].refundAddress = b32(OTHER))) }),
        "REFUND",
      ],
      [
        "other output token",
        quote({ data: mutate((a) => (a[2].receivingAssetId = b32(OTHER))) }),
        "ASSETS",
      ],
      [
        "other destination",
        quote({ data: mutate((a) => (a[0].destinationChainId = 10n)) }),
        "ASSETS",
      ],
      [
        "fee to an unknown recipient",
        quote({
          data: mutate(
            (a) =>
              (a[1][0].callData = (a[1][0].callData as string).replace(
                CANARY_PINS.feeCollector.recipients[0].slice(2),
                OTHER.slice(2),
              )),
          ),
        }),
        "FEES",
      ],
      [
        "bridged amount inflated",
        quote({ data: mutate((a) => (a[0].minAmount = 5_000_000n)) }),
        "FEES",
      ],
      [
        "F4 multiplier exactly 1:1 (no relayer fee)",
        quote({
          data: mutate((a) => (a[2].outputAmountMultiplier = 10n ** 18n)),
        }),
        "MIN_OUTPUT",
      ],
      [
        "multiplier above 1:1",
        quote({
          data: mutate(
            (a) => (a[2].outputAmountMultiplier = 1_100_000_000_000_000_000n),
          ),
        }),
        "MIN_OUTPUT",
      ],
      [
        "multiplier lowers the output",
        quote({
          data: mutate(
            (a) => (a[2].outputAmountMultiplier = 900_000_000_000_000_000n),
          ),
        }),
        "MIN_OUTPUT",
      ],
      [
        "referrer set",
        quote({ data: mutate((a) => (a[0].referrer = OTHER)) }),
        "CALLDATA",
      ],
      [
        "F4 non-EVM exclusive relayer",
        quote({
          data: mutate((a) => (a[2].exclusiveRelayer = "0x" + "f".repeat(64))),
        }),
        "CALLDATA",
      ],
      [
        "F4 exclusivity until the deadline",
        quote({
          data: mutate(
            (a) => (
              (a[2].exclusiveRelayer = b32(OTHER)),
              (a[2].exclusivityParameter = a[2].fillDeadline)
            ),
          ),
        }),
        "DEADLINES",
      ],
      [
        "exclusivity without a relayer",
        quote({ data: mutate((a) => (a[2].exclusivityParameter = 60)) }),
        "DEADLINES",
      ],
      ["another target", quote({ to: OTHER }), "TARGET"],
      ["native value attached", quote({ value: "0x1" }), "TARGET"],
      ["sent from another account", quote({ from: OTHER }), "TARGET"],
      ["another tool", quote({}, { tool: "lifiIntents" }), "TARGET"],
      ["stale", quote({}, { quotedAt: NOW - 31_000 }), "QUOTE_FRESH"],
      ["from the future", quote({}, { quotedAt: NOW + 5 }), "QUOTE_FRESH"],
      [
        "unpinned spender",
        { ...quote(), estimate: { ...fx.estimate, approvalAddress: OTHER } },
        "SPENDER",
      ],
      [
        "long fill window",
        quote({
          data: mutate(
            (a) => (a[2].fillDeadline = Number(a[2].quoteTimestamp) + 7 * 3600),
          ),
        }),
        "DEADLINES",
      ],
      ["F11 malformed gas limit", quote({ gasLimit: "zz" }), "GAS_LIMIT"],
      [
        "F11 unbounded gas limit",
        quote({ gasLimit: "0x" + (3_000_000).toString(16) }),
        "GAS_LIMIT",
      ],
    ];
    for (const [name, q, id] of cases) {
      const v = verify(q);
      expect(v.ready, name).toBe(false);
      expect(status(v, id), name).toBe("FAIL");
    }
    expect(status(verify(quote(), { amountIn: "6000000" }), "SCOPE")).toBe(
      "FAIL",
    );
    expect(
      status(verify(quote(), { minimumOut: "4979690" }), "MIN_OUTPUT"),
    ).toBe("FAIL");
    // F13: a hexadecimal minimum is refused at once (it never passes review to fail later).
    expect(verify(quote(), { minimumOut: "0x4bfbe9" }).checks).toEqual([
      { id: "SCOPE", status: "FAIL", code: "MINIMUM_INVALID" },
    ]);
    expect(status(verify(quote(), { owner: OTHER }), "TARGET")).toBe("FAIL");
    expect(status(verify(quote({ data: "0x1234" })), "CALLDATA")).toBe("FAIL");
  });
  it("no executable request (today: the protected normalizer drops it) -> every check UNKNOWN, never ready", () => {
    const v = verify({ ...quote(), transactionRequest: null });
    expect(v.ready).toBe(false);
    expect(
      v.checks
        .filter((c) => c.id !== "SCOPE")
        .every(
          (c) => c.status === "UNKNOWN" && c.code === "NO_EXECUTABLE_REQUEST",
        ),
    ).toBe(true);
  });
});

// The simulation in the canary layout: balanceOf, allowance(before) inserted, approve, the exact tx, balanceOf, allowance.
const simCalls = () => {
  const c = structuredClone(fx.simulationCalls);
  return [
    c[0],
    {
      status: "0x1",
      returnData: "0x" + "0".repeat(64),
      gasUsed: "0x5208",
      logs: [],
    },
    c[1],
    c[2],
    c[3],
    c[4],
  ];
};
const call = () => decodeAcrossCall(fx.transactionRequest.data)!;
const simulate = (
  calls = simCalls(),
  over: Partial<Parameters<typeof interpretCanarySimulation>[1]> = {},
) =>
  interpretCanarySimulation([{ calls }], {
    owner: SYN,
    amountIn: 5_000_000n,
    needsApproval: true,
    call: call(),
    feeTotal: 12_500n,
    ...over,
  });
const FEES = {
  baseFeePerGas: "5000000",
  maxFeePerGas: "10000000",
  maxPriorityFeePerGas: "1000000",
};

describe("G14 real transaction simulation (eth_simulateV1, no state overrides)", () => {
  it("builds the exact call list at the reviewed gas and real fees, without state overrides", () => {
    const r = canarySimulationRequest({
      owner: SYN,
      amountIn: 5_000_000n,
      needsApproval: true,
      tx: {
        to: fx.transactionRequest.to,
        data: fx.transactionRequest.data,
        value: "0",
        gas: "670622",
      },
      fees: FEES,
    });
    expect(r.blockStateCalls).toHaveLength(1);
    expect("stateOverrides" in r.blockStateCalls[0]).toBe(false);
    expect(r.blockStateCalls[0].blockOverrides).toEqual({
      baseFeePerGas: "0x4c4b40",
    });
    const calls = r.blockStateCalls[0].calls;
    expect(calls.map((c) => c.to.toLowerCase())).toEqual([
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
      CANARY_PINS.diamond.address.toLowerCase(),
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
    ]);
    expect(calls[2].data.startsWith("0x095ea7b3")).toBe(true);
    expect(calls[3]).toMatchObject({
      gas: "0xa3b9e",
      maxFeePerGas: "0x989680",
      maxPriorityFeePerGas: "0xf4240",
      value: "0x0",
    });
  });
  it("the real simulated logs account for every unit and the single deposit is the reviewed relay", () => {
    const s = simulate();
    expect(s.checks).toEqual([
      {
        id: "SIMULATION",
        status: "PASS",
        code: "EXACT_AMOUNT_SPENT_ALLOWANCE_ZERO",
      },
      { id: "SIMULATION_FLOWS", status: "PASS", code: "EVERY_UNIT_ACCOUNTED" },
      {
        id: "SIMULATION_DEPOSIT",
        status: "PASS",
        code: "ACROSS_DEPOSIT_TO_OWNER",
      },
    ]);
    expect(s.deposit?.outputAmount).toBe(4_979_689n);
    expect(s.gasUsed.every((g) => g > 0n)).toBe(true);
  });
  it("reverts, extra movements, wrong or duplicated deposits and leftover allowances FAIL", () => {
    const reverted = simCalls();
    reverted[3] = { ...reverted[3], status: "0x0" };
    expect(simulate(reverted).checks[0]).toMatchObject({
      status: "FAIL",
      code: "SIMULATED_CALL_REVERTED",
    });
    expect(
      simulate(simCalls(), { feeTotal: 10_000n }).checks.find(
        (c) => c.id === "SIMULATION_FLOWS",
      )?.status,
    ).toBe("FAIL");
    const leftover = simCalls();
    leftover[5] = { ...leftover[5], returnData: "0x" + "1".padStart(64, "0") };
    expect(simulate(leftover).checks[0].status).toBe("FAIL");
    const existing = simCalls();
    existing[1] = {
      ...existing[1],
      returnData: "0x" + (10n ** 12n).toString(16).padStart(64, "0"),
    };
    expect(simulate(existing).checks[0]).toMatchObject({
      status: "FAIL",
      code: "UNEXPECTED_EXISTING_ALLOWANCE",
    });
    expect(
      simulate(simCalls(), { owner: OTHER })
        .checks.filter((c) => c.id !== "SIMULATION")
        .map((c) => c.status),
    ).toEqual(["FAIL", "FAIL"]);
    expect(simulate(simCalls().slice(0, 4)).checks[0].code).toBe(
      "SIMULATION_SHAPE",
    );
    expect(
      interpretCanarySimulation(null, {
        owner: SYN,
        amountIn: 5_000_000n,
        needsApproval: true,
        call: call(),
        feeTotal: 12_500n,
      }).checks.every((c) => c.status === "FAIL"),
    ).toBe(true);
    // F7: two deposits (the last one no longer wins) and a deposit with other relay fields.
    const twice = simCalls();
    const dep = twice[3].logs.find(
      (l) => l.topics[0] === CANARY_PINS.topics.fundsDeposited,
    )!;
    twice[3] = { ...twice[3], logs: [...twice[3].logs, dep] };
    expect(
      simulate(twice).checks.find((c) => c.id === "SIMULATION_DEPOSIT"),
    ).toMatchObject({ status: "FAIL", code: "DEPOSITS:2" });
    const otherDeadline = {
      ...call(),
      across: {
        ...call().across,
        fillDeadline: call().across.fillDeadline + 1,
      },
    };
    expect(
      simulate(simCalls(), { call: otherDeadline }).checks.find(
        (c) => c.id === "SIMULATION_DEPOSIT",
      )?.status,
    ).toBe("FAIL");
  });
});

const src = (
  origin: string,
  values: Record<string, string | null>,
  block: SourceRead["block"] = { number: "100", hash: "0x" + "a".repeat(64) },
  chainId = "8453",
): SourceRead => ({ origin, chainId, block, values });
describe("G14 dual-RPC agreement and native gas", () => {
  const v = { usdc: "5000000", native: "1", allowance: "0" };
  it("two independent operators at one block on the expected chain must agree", () => {
    expect(
      agree(
        src("https://base-rpc.publicnode.com", v),
        src("https://mainnet.base.org", v),
        ["usdc", "native", "allowance"],
        "8453",
      ).status,
    ).toBe("AGREE");
    expect(
      agree(
        src("https://a.example", v),
        src("https://a.example", v),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("SINGLE");
    expect(
      agree(src("https://a.example", v), null, ["usdc"], "8453").status,
    ).toBe("SINGLE");
    expect(
      agree(
        src("https://a.example", v),
        src("https://b.example", { ...v, usdc: "4" }),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("DISAGREE");
    expect(
      agree(
        src("https://a.example", v),
        src("https://b.example", v, {
          number: "101",
          hash: "0x" + "b".repeat(64),
        }),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("UNKNOWN");
    expect(
      agree(
        src("https://a.example", v),
        src("https://b.example", { ...v, usdc: null }),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("UNKNOWN");
  });
  it("F6: the same operator behind another spelling, port or subdomain is ONE source; another chain concludes nothing", () => {
    for (const twin of [
      "https://base-rpc.publicnode.com/",
      "https://base-rpc.publicnode.com:443",
      "https://BASE-RPC.publicnode.com/x",
      "https://arbitrum-one-rpc.publicnode.com",
    ])
      expect(
        agree(
          src("https://base-rpc.publicnode.com", v),
          src(twin, v),
          ["usdc"],
          "8453",
        ).status,
        twin,
      ).toBe("SINGLE");
    expect(
      agree(
        src("https://a.example", v, undefined, "1"),
        src("https://b.example", v, undefined, "1"),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("UNKNOWN");
    expect(
      agree(
        src("http://a.example", v),
        src("https://b.example", v),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("UNKNOWN");
    expect(normalizeOrigin("https://u:p@a.example")).toBeNull();
    expect(operatorOf("https://base-rpc.publicnode.com:443/")).toBe(
      "publicnode.com",
    );
  });
  it("native gas with the policy margin plus the L1 data fee must be covered; unknowns stay UNKNOWN", () => {
    const ok = balanceAndGasCheck({
      usdcBalance: "5000000",
      amountIn: 5_000_000n,
      nativeBalance: "1000000000000",
      gasUsed: [50_000n, 170_000n],
      maxFeePerGas: "1000000",
      l1FeeWei: "1000",
    });
    expect(ok.map((c) => c.status)).toEqual(["PASS", "PASS"]);
    const l1 = balanceAndGasCheck({
      usdcBalance: "5000000",
      amountIn: 5_000_000n,
      nativeBalance: "264000000000",
      gasUsed: [50_000n, 170_000n],
      maxFeePerGas: "1000000",
      l1FeeWei: "1",
    });
    expect(l1.map((c) => c.status)).toEqual(["PASS", "FAIL"]);
    const poor = balanceAndGasCheck({
      usdcBalance: "4999999",
      amountIn: 5_000_000n,
      nativeBalance: "1",
      gasUsed: [50_000n],
      maxFeePerGas: "1000000",
      l1FeeWei: "0",
    });
    expect(poor.map((c) => c.status)).toEqual(["FAIL", "FAIL"]);
    expect(
      balanceAndGasCheck({
        usdcBalance: null,
        amountIn: 1n,
        nativeBalance: "1",
        gasUsed: [1n],
        maxFeePerGas: "1",
        l1FeeWei: null,
      }).map((c) => c.status),
    ).toEqual(["UNKNOWN", "UNKNOWN"]);
  });
});

// Settlement: the deposit comes from the (real, simulated) FundsDeposited log as if mined in tx 0xf…f at block 100.
const MAIN = "0x" + "c".repeat(64);
const sourceLogs = (): ChainLog[] =>
  fx.simulationCalls[2].logs.map((l) => ({
    ...l,
    transactionHash: MAIN,
    blockNumber: "100",
  }));
const deposit = (): CanaryDeposit =>
  depositFromSourceLogs(sourceLogs(), MAIN, SYN, "4979689")!;
const pool = CANARY_PINS.spokePools["42161"].address;
const fill = (
  d: CanaryDeposit,
  o: {
    recipient?: string;
    amount?: bigint;
    inputAmount?: bigint;
    depositId?: bigint;
    origin?: bigint;
    address?: string;
    hash?: string;
    updatedRecipient?: string;
  } = {},
): ChainLog => {
  const topics = encodeEventTopics({
    abi: SETTLEMENT_ABI,
    eventName: "FilledRelay",
    args: {
      originChainId: o.origin ?? 8453n,
      depositId: o.depositId ?? BigInt(d.depositId),
      relayer: b32(OTHER),
    },
  });
  const data = encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint256" },
      { type: "uint32" },
      { type: "uint32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      {
        type: "tuple",
        components: [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint8" },
        ],
      },
    ],
    [
      d.inputToken as Hex,
      d.outputToken as Hex,
      o.inputAmount ?? BigInt(d.inputAmount),
      o.amount ?? BigInt(d.outputAmount),
      8453n,
      d.fillDeadline,
      d.exclusivityDeadline,
      d.exclusiveRelayer as Hex,
      d.depositor as Hex,
      (o.recipient ? b32(o.recipient) : d.recipient) as Hex,
      d.messageHash as Hex,
      [
        (o.updatedRecipient ? b32(o.updatedRecipient) : d.recipient) as Hex,
        d.messageHash as Hex,
        o.amount ?? BigInt(d.outputAmount),
        0,
      ],
    ],
  );
  return {
    address: o.address ?? pool,
    topics: topics as string[],
    data,
    transactionHash: o.hash ?? "0x" + "f".repeat(64),
    blockNumber: "7",
  };
};
const transfer = (
  token: string,
  from: string,
  to: string,
  value: bigint,
  hash = "0x" + "f".repeat(64),
  blockNumber = "7",
  timestamp?: number,
): ChainLog => ({
  address: token,
  topics: encodeEventTopics({
    abi: SETTLEMENT_ABI,
    eventName: "Transfer",
    args: { from: from as Hex, to: to as Hex },
  }) as string[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
  transactionHash: hash,
  blockNumber,
  ...(timestamp ? { timestamp } : {}),
});
describe("G14 destination settlement, refund and reconciliation", () => {
  const usdcArb = CANARY_PINS.usdc["42161"].address;
  const at = (nowSec: number) => ({
    sourceRefundLogs: [] as ChainLog[],
    destinationPins: destPins(),
    nowSec,
  });
  it("the deposit is the pinned pool's single FundsDeposited of the mined transaction", () => {
    const d = deposit();
    expect(d).toMatchObject({
      inputAmount: "4987500",
      outputAmount: "4979689",
      sourceBlock: "100",
      owner: SYN,
    });
    expect(
      depositFromSourceLogs(sourceLogs(), "0x" + "d".repeat(64), SYN, "1"),
    ).toBeNull();
    expect(
      depositFromSourceLogs([...sourceLogs(), ...sourceLogs()], MAIN, SYN, "1"),
    ).toBeNull();
  });
  it("delivered only by the matching fill of the pinned pool, paid to the owner in that transaction", () => {
    const d = deposit();
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [fill(d), transfer(usdcArb, OTHER, SYN, 4_979_689n)],
        ...at(d.fillDeadline - 10),
      }),
    ).toMatchObject({ status: "DELIVERED", delivered: "4979689" });
  });
  it("F2: a third party's fake or altered fill neither delivers nor blocks; an unpaid matching fill is a discrepancy", () => {
    const d = deposit();
    const t = at(d.fillDeadline - 10);
    for (const fake of [
      fill(d, { inputAmount: 1n }),
      fill(d, { amount: 0n }),
      fill(d, { recipient: OTHER }),
      fill(d, { updatedRecipient: OTHER }),
      fill(d, { address: OTHER }),
      fill(d, { origin: 10n }),
      fill(d, { depositId: 1n }),
    ])
      expect(
        destinationSettlement({
          deposit: d,
          destinationLogs: [fake, transfer(usdcArb, OTHER, SYN, 1n)],
          ...t,
        }).status,
      ).toBe("PENDING");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [
          fill(d, { amount: 0n, hash: H(9) }),
          fill(d),
          transfer(usdcArb, OTHER, SYN, 4_979_689n),
        ],
        ...t,
      }).status,
    ).toBe("DELIVERED");
    expect(
      destinationSettlement({ deposit: d, destinationLogs: [fill(d)], ...t })
        .status,
    ).toBe("DISCREPANCY");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [fill(d), transfer(usdcArb, OTHER, SYN, 4_979_689n)],
        ...t,
        destinationPins: destPins({
          spokePool: { ...destPins().spokePool, implementation: OTHER },
        }),
      }).code,
    ).toBe("DESTINATION_PINS:SPOKEPOOL_UPGRADED");
  });
  it("F5: refunded only by the Base pool to the owner after the deposit block and the deadline", () => {
    const d = deposit();
    const basePool = CANARY_PINS.spokePools["8453"].address,
      usdcBase = CANARY_PINS.usdc["8453"].address;
    const late = d.fillDeadline + 2000;
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [],
        ...at(d.fillDeadline),
      }).status,
    ).toBe("PENDING");
    expect(
      destinationSettlement({ deposit: d, destinationLogs: [], ...at(late) })
        .status,
    ).toBe("REFUND_PENDING");
    const refund = (from: string, block: string, ts: number) =>
      transfer(usdcBase, from, SYN, 4_987_500n, H(5), block, ts);
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [],
        ...at(late),
        sourceRefundLogs: [refund(basePool, "200", d.fillDeadline + 100)],
      }),
    ).toMatchObject({ status: "REFUNDED", refunded: "4987500" });
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [],
        ...at(late),
        sourceRefundLogs: [refund(basePool, "50", d.fillDeadline + 100)],
      }).status,
    ).toBe("REFUND_PENDING");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [],
        ...at(late),
        sourceRefundLogs: [refund(basePool, "200", d.fillDeadline - 100)],
      }).status,
    ).toBe("REFUND_PENDING");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [],
        ...at(late),
        sourceRefundLogs: [refund(OTHER, "200", d.fillDeadline + 100)],
      }).status,
    ).toBe("REFUND_PENDING");
  });
  it("reconciliation: exact deltas; unrelated incoming activity is UNKNOWN; a refund reconciles too", () => {
    const ok = {
      amountIn: "5000000",
      delivered: "4979689",
      minimumOut: "4979689",
      base: { before: "5000000", after: "0" },
      arbitrum: { before: "1", after: "4979690" },
    };
    expect(reconcileCanary(ok)).toMatchObject({
      status: "PASS",
      code: "BOTH_CHAINS_RECONCILED",
    });
    expect(
      reconcileCanary({ ...ok, base: { before: "5000000", after: "1" } }).code,
    ).toBe("UNRELATED_ACTIVITY");
    expect(
      reconcileCanary({ ...ok, arbitrum: { before: "1", after: "4979691" } })
        .code,
    ).toBe("UNRELATED_ACTIVITY");
    expect(
      reconcileCanary({ ...ok, arbitrum: { before: "1", after: "4979689" } })
        .status,
    ).toBe("FAIL");
    expect(
      reconcileCanary({ ...ok, base: { before: "6000000", after: "0" } })
        .status,
    ).toBe("FAIL");
    expect(
      reconcileCanary({ ...ok, base: { before: null, after: "0" } }).status,
    ).toBe("UNKNOWN");
    expect(
      reconcileCanary({
        ...ok,
        delivered: null,
        refunded: "4987500",
        base: { before: "5000000", after: "4987500" },
        arbitrum: { before: "1", after: "1" },
      }),
    ).toMatchObject({ status: "PASS", code: "REFUND_RECONCILED" });
    expect(
      reconcileCanary({ ...ok, delivered: null, refunded: null }).code,
    ).toBe("NOT_SETTLED");
  });
});

describe("G14 server-backed single-use authorization (global nonce)", () => {
  const base = {
    action: "APPROVE" as const,
    review: "r".repeat(64),
    record: "canary-0001",
    account: SYN,
    chainId: "8453",
  };
  const issue = (s: CanaryAuthorizationStore, over = {}) =>
    s.issue({
      ...base,
      now: NOW,
      quoteExpiresAt: NOW + 25_000,
      trustedGesture: true,
      ...over,
    });
  const code = (f: () => unknown) => {
    try {
      f();
      return "NO_ERROR";
    } catch (e) {
      return (e as TokenError).code;
    }
  };
  it("issued by the server, consumed once, refused everywhere afterwards", () => {
    const s = new CanaryAuthorizationStore();
    const t = issue(s);
    expect(t.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(s.consume(t, { ...base, now: NOW + 1 }).nonce).toBe(t.nonce);
    expect(code(() => s.consume(t, { ...base, now: NOW + 2 }))).toBe(
      "NONCE_REUSED_GLOBAL",
    );
    expect(
      code(() =>
        s.consume(t, { ...base, record: "canary-0002", now: NOW + 2 }),
      ),
    ).toBe("NONCE_REUSED_GLOBAL");
  });
  it("hand-made, forged, foreign, superseded, mis-bound or expired tokens are refused", () => {
    const s = new CanaryAuthorizationStore();
    const t = issue(s);
    expect(
      code(() =>
        s.consume({ ...t, mac: "0".repeat(64) }, { ...base, now: NOW + 1 }),
      ),
    ).toBe("FORGED");
    expect(
      code(() =>
        s.consume(
          { ...t, expiresAt: t.expiresAt + 1 },
          { ...base, now: NOW + 1 },
        ),
      ),
    ).toBe("FORGED");
    const handMade: Record<string, unknown> = { ...t };
    delete handMade.mac;
    expect(code(() => s.consume(handMade, { ...base, now: NOW + 1 }))).toBe(
      "TOKEN_MALFORMED",
    );
    expect(
      code(() =>
        new CanaryAuthorizationStore().consume(t, { ...base, now: NOW + 1 }),
      ),
    ).toBe("FORGED");
    const newer = issue(s, { now: NOW + 1 });
    expect(code(() => s.consume(t, { ...base, now: NOW + 2 }))).toBe("REVOKED");
    expect(
      code(() => s.consume(newer, { ...base, chainId: "42161", now: NOW + 2 })),
    ).toBe("WRONG_CHAIN");
    expect(
      code(() =>
        s.consume(newer, { ...base, record: "canary-0009", now: NOW + 2 }),
      ),
    ).toBe("WRONG_RECORD");
    expect(
      code(() => s.consume(newer, { ...base, account: OTHER, now: NOW + 2 })),
    ).toBe("WRONG_ACCOUNT");
    expect(
      code(() => s.consume(newer, { ...base, action: "SEND", now: NOW + 2 })),
    ).toBe("WRONG_ACTION");
    expect(code(() => s.consume(newer, { ...base, now: NOW + 61_000 }))).toBe(
      "AUTHORIZATION_EXPIRED",
    );
    expect(code(() => issue(s, { trustedGesture: false }))).toBe(
      "UNTRUSTED_GESTURE",
    );
    expect(code(() => s.consume(newer, { ...base, now: NOW + 2 }))).toBe(
      "NO_ERROR",
    );
  });
  it("consumed nonces are journaled append-only and reloaded; expired outstanding tokens are dropped", () => {
    const j = new MemoryNonceJournal();
    const s = new CanaryAuthorizationStore(j);
    s.consume(issue(s), { ...base, now: NOW + 1 });
    expect(j.load()).toHaveLength(1);
    expect(new CanaryAuthorizationStore(j).usedCount()).toBe(1);
    const s2 = new CanaryAuthorizationStore();
    const old = issue(s2);
    issue(s2, {
      record: "canary-0002",
      now: NOW + 70_000,
      quoteExpiresAt: NOW + 95_000,
    });
    expect(code(() => s2.consume(old, { ...base, now: NOW + 1 }))).toBe(
      "REVOKED",
    );
  });
});

describe("G14 server-authenticated review artefacts", () => {
  it("only this process's attestation of exactly this payload verifies", () => {
    const a = new ReviewAttestor();
    const x = a.attest("PREFLIGHT", "rec-1", "p".repeat(64), { ok: 1 }, NOW);
    expect(a.verify(x, "PREFLIGHT", "rec-1", "p".repeat(64), { ok: 1 })).toBe(
      true,
    );
    expect(a.verify(x, "PREFLIGHT", "rec-1", "p".repeat(64), { ok: 2 })).toBe(
      false,
    );
    expect(a.verify(x, "GUARDIAN", "rec-1", "p".repeat(64), { ok: 1 })).toBe(
      false,
    );
    expect(a.verify(x, "PREFLIGHT", "rec-2", "p".repeat(64), { ok: 1 })).toBe(
      false,
    );
    expect(
      new ReviewAttestor().verify(x, "PREFLIGHT", "rec-1", "p".repeat(64), {
        ok: 1,
      }),
    ).toBe(false);
    expect(
      a.verify({ ...x, at: x.at + 1 }, "PREFLIGHT", "rec-1", "p".repeat(64), {
        ok: 1,
      }),
    ).toBe(false);
  });
});

const input = (over: Partial<CanaryReviewInput> = {}): CanaryReviewInput => {
  const v = { usdc: "5000000", native: "10000000000000000", allowance: "0" };
  return {
    record: "canary-test-0001",
    owner: SYN,
    amountIn: "5000000",
    minimumOut: "4979689",
    now: NOW,
    wallet: { account: SYN, chainId: "8453", proven: true },
    quote: quote(),
    pins: [
      pinReads("https://base-rpc.publicnode.com"),
      pinReads("https://mainnet.base.org"),
    ],
    balances: [
      src("https://base-rpc.publicnode.com", v, BLOCK),
      src("https://mainnet.base.org", v, BLOCK),
    ],
    fees: FEES,
    l1FeeWei: "1000",
    guardian: { level: "CLEAR", digest: "d".repeat(64) },
    ...over,
  };
};
const engine = (
  open: boolean,
  uses = new MemoryUseJournal(),
  sim: (r: SimulationRequest) => unknown = () => [{ calls: simCalls() }],
) => {
  const anchors = new AuditAnchorLog();
  const authorizations = new CanaryAuthorizationStore();
  const requests: SimulationRequest[] = [];
  const e = new CanaryEngine({
    gate: () =>
      open
        ? { open: true, reasons: [] }
        : executionGateState(CANARY_SCOPE.sourceChainId),
    authorizations,
    attestor: new ReviewAttestor(),
    anchors,
    uses,
    simulate: async (r) => {
      requests.push(r);
      return sim(r);
    },
  });
  return { e, anchors, authorizations, uses, requests };
};
describe("G14 canary engine (the smallest owner-signed pathway)", () => {
  it("a complete, consistent review is ready; the engine built the simulation; the real gate is CLOSED", async () => {
    const { e, anchors, requests } = engine(false);
    const r = await e.review(input());
    expect(r.checks.filter((c) => c.status !== "PASS")).toEqual([]);
    expect(r.ready).toBe(true);
    expect(r.report.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    expect(requests).toHaveLength(1);
    expect(requests[0].blockStateCalls[0].calls[3]).toMatchObject({
      data: fx.transactionRequest.data,
      gas: "0xa3b9e",
    });
    expect(r.simulation?.block).toBe(BLOCK.number);
    const rec = e.start("canary-test-0001", NOW + 10);
    expect(rec.state).toBe("REVIEWED");
    expect(verifyAnchored(rec, anchors.entries(), anchors.head())).toEqual({
      ok: true,
      extension: 0,
    });
    expect(() =>
      e.authorize("canary-test-0001", { now: NOW + 11, trustedGesture: true }),
    ).toThrow("GATE_CLOSED");
    expect(() => e.prepare("canary-test-0001", {}, NOW + 11)).toThrow(
      "GATE_CLOSED",
    );
    expect(executionGateState("8453").open).toBe(false);
  });
  it("any missing or inconsistent proof keeps the review not ready", async () => {
    const v = { usdc: "5000000", native: "10000000000000000", allowance: "0" };
    const cases: [
      string,
      Partial<CanaryReviewInput>,
      ((r: SimulationRequest) => unknown)?,
    ][] = [
      [
        "single balance source",
        { balances: [src("https://base-rpc.publicnode.com", v, BLOCK), null] },
      ],
      [
        "F6 same operator twice",
        {
          balances: [
            src("https://base-rpc.publicnode.com", v, BLOCK),
            src("https://base-rpc.publicnode.com/", v, BLOCK),
          ],
        },
      ],
      [
        "F6 pins from one operator twice",
        {
          pins: [
            pinReads("https://base-rpc.publicnode.com"),
            pinReads("https://base-rpc.publicnode.com:443"),
          ],
        },
      ],
      ["pins single source", { pins: [pinReads(), null] }],
      [
        "F1 pins read for another selector",
        {
          pins: [
            pinReads(undefined, { selector: "0xa1f1ce43" }),
            pinReads("https://mainnet.base.org", { selector: "0xa1f1ce43" }),
          ],
        },
      ],
      [
        "pins at different blocks",
        {
          pins: [
            pinReads(),
            pinReads("https://mainnet.base.org", {
              block: { number: "1", hash: H(1) },
            }),
          ],
        },
      ],
      [
        "N4 pins at a block other than the balances",
        {
          pins: [
            pinReads(undefined, { block: { number: "1", hash: H(1) } }),
            pinReads("https://mainnet.base.org", {
              block: { number: "1", hash: H(1) },
            }),
          ],
        },
      ],
      [
        "wallet not proven",
        { wallet: { account: SYN, chainId: "8453", proven: false } },
      ],
      [
        "wallet on Arbitrum",
        { wallet: { account: SYN, chainId: "42161", proven: true } },
      ],
      [
        "no executable request",
        { quote: { ...quote(), transactionRequest: null } },
      ],
      [
        "guardian hold",
        { guardian: { level: "HOLD", digest: "d".repeat(64) } },
      ],
      [
        "guardian digest not a digest",
        { guardian: { level: "CLEAR", digest: "not-a-digest" } },
      ],
      ["no fees", { fees: null }],
      ["no L1 fee", { l1FeeWei: null }],
      [
        "F11 gas limit below the simulated need",
        { quote: quote({ gasLimit: "1" }) },
      ],
      ["simulation failed", {}, () => null],
      [
        "simulation throws",
        {},
        () => {
          throw new Error("rpc");
        },
      ],
      [
        "facet re-routed",
        {
          pins: [
            pinReads(undefined, { facetForSelector: OTHER }),
            pinReads("https://mainnet.base.org", { facetForSelector: OTHER }),
          ],
        },
      ],
      [
        "large existing allowance",
        {
          balances: [
            src(
              "https://base-rpc.publicnode.com",
              { ...v, allowance: "1000000000" },
              BLOCK,
            ),
            src(
              "https://mainnet.base.org",
              { ...v, allowance: "1000000000" },
              BLOCK,
            ),
          ],
        },
      ],
    ];
    for (const [name, over, sim] of cases) {
      const { e } = engine(true, new MemoryUseJournal(), sim);
      const r = await e.review(input(over));
      expect(r.ready, name).toBe(false);
      expect(() => e.start("canary-test-0001", NOW + 10), name).toThrow();
      expect(e.record("canary-test-0001"), name).toBeNull();
    }
  });
  it("with an OPEN gate stub: one server token, the exact approval, no replay; review and settlement steps are server-only", async () => {
    const { e, authorizations, anchors, uses } = engine(true);
    await e.review(input());
    e.start("canary-test-0001", NOW + 10);
    const t = e.authorize("canary-test-0001", {
      now: NOW + 11,
      trustedGesture: true,
    });
    expect(t.action).toBe("APPROVE");
    const tx = e.prepare("canary-test-0001", t, NOW + 12);
    expect(tx.to.toLowerCase()).toBe(
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
    );
    expect(tx.data.toLowerCase()).toBe(
      encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "approve",
            inputs: [{ type: "address" }, { type: "uint256" }],
            outputs: [{ type: "bool" }],
            stateMutability: "nonpayable",
          },
        ],
        args: [CANARY_PINS.diamond.address as Hex, 5_000_000n],
      }).toLowerCase(),
    );
    expect(uses.load()).toEqual([
      `${CANARY_SCOPE.id}:${SYN}:canary-test-0001:APPROVE`,
    ]);
    expect(e.record("canary-test-0001")!.state).toBe(
      "AWAITING_APPROVAL_SIGNATURE",
    );
    expect(() => e.prepare("canary-test-0001", t, NOW + 13)).toThrow(
      "NOT_REVIEWED",
    );
    expect(() =>
      authorizations.consume(t, {
        action: "APPROVE",
        review: e.record("canary-test-0001")!.review!,
        record: "canary-test-0001",
        account: SYN,
        chainId: "8453",
        now: NOW + 13,
      }),
    ).toThrow("NONCE_REUSED_GLOBAL");
    expect(() =>
      e.observe("canary-test-0001", {
        type: "REVIEW_SHOWN",
        at: NOW + 14,
        review: "x",
      }),
    ).toThrow("REVIEW_STEPS_ARE_SERVER_ONLY");
    // F9: a destination or reconciliation conclusion cannot be injected.
    expect(() =>
      e.observe("canary-test-0001", {
        type: "DESTINATION",
        at: NOW + 14,
        status: "DELIVERED",
        hash: H(1),
        amount: "4979689",
      }),
    ).toThrow("SETTLEMENT_ONLY_FROM_SERVER_READS");
    expect(() =>
      e.observe("canary-test-0001", {
        type: "RECONCILED",
        at: NOW + 14,
        ok: true,
        detail: "x",
      }),
    ).toThrow("SETTLEMENT_ONLY_FROM_SERVER_READS");
    expect(() =>
      e.observe("canary-test-0001", { type: "OWNER_REJECTED", at: NOW + 14 }),
    ).not.toThrow();
    expect(e.record("canary-test-0001")!.state).toBe("OWNER_REJECTED");
    expect(
      verifyAnchored(
        e.record("canary-test-0001")!,
        anchors.entries(),
        anchors.head(),
      ),
    ).toEqual({ ok: true, extension: 0 });
  });
  it("F3: one canary per owner, ever — a second record is refused, also after a restart (journal)", async () => {
    const uses = new MemoryUseJournal();
    const a = engine(true, uses);
    await a.e.review(input());
    a.e.start("canary-test-0001", NOW + 10);
    // While the first is active, a second record for the same owner cannot start.
    await a.e.review(input({ record: "canary-test-0002" }));
    expect(() => a.e.start("canary-test-0002", NOW + 11)).toThrow(
      "ANOTHER_CANARY_ACTIVE",
    );
    a.e.prepare(
      "canary-test-0001",
      a.e.authorize("canary-test-0001", {
        now: NOW + 12,
        trustedGesture: true,
      }),
      NOW + 13,
    );
    // A restarted server (new engine, same journal) refuses another canary for this owner at review and at start.
    const b = engine(true, uses);
    const r = await b.e.review(input({ record: "canary-test-0003" }));
    expect(r.ready).toBe(false);
    expect(r.checks.find((c) => c.id === "SINGLE_USE")).toEqual({
      id: "SINGLE_USE",
      status: "FAIL",
      code: "APPROVAL_ALREADY_USED",
    });
    expect(() => b.e.start("canary-test-0003", NOW + 20)).toThrow();
    expect(b.e.usedBy(SYN)).toBe("canary-test-0001");
  });
  it("N1 + F9: one record goes approval -> re-review -> send -> settle -> reconcile with ONE journal, from server reads only", async () => {
    const noApproval = () => {
      const c = simCalls().filter((_, i) => i !== 2);
      c[1] = {
        ...c[1],
        returnData: "0x" + 5_000_000n.toString(16).padStart(64, "0"),
      };
      return c;
    };
    // The engine's own simulation request decides the layout (6 calls with the approval, 5 without).
    const { e, uses } = engine(true, new MemoryUseJournal(), (r) => [
      {
        calls:
          r.blockStateCalls[0].calls.length === 6 ? simCalls() : noApproval(),
      },
    ]);
    await e.review(input());
    e.start("canary-test-0001", NOW + 10);
    e.prepare(
      "canary-test-0001",
      e.authorize("canary-test-0001", { now: NOW + 11, trustedGesture: true }),
      NOW + 12,
    );
    const nonce = e.record("canary-test-0001")!.pending!.nonce;
    e.observe("canary-test-0001", {
      type: "TX_SUBMITTED",
      at: NOW + 13,
      role: "approval",
      hash: H(2),
      nonce,
    });
    e.observe("canary-test-0001", {
      type: "TX_CONFIRMED",
      at: NOW + 14,
      role: "approval",
      hash: H(2),
      block: "99",
      blockHash: H(3),
      confirmations: 12,
    });
    expect(e.record("canary-test-0001")!.state).toBe("APPROVAL_CONFIRMED");
    // Re-review of the SAME record: allowance now exactly the amount; the journal names this record, so it may go on.
    const v = {
      usdc: "5000000",
      native: "10000000000000000",
      allowance: "5000000",
    };
    const r2 = await e.review(
      input({
        now: NOW + 15,
        quote: quote({}, { quotedAt: NOW + 14 }),
        balances: [
          src("https://base-rpc.publicnode.com", v, BLOCK),
          src("https://mainnet.base.org", v, BLOCK),
        ],
      }),
    );
    expect(r2.checks.find((c) => c.id === "SINGLE_USE")).toEqual({
      id: "SINGLE_USE",
      status: "PASS",
      code: "APPROVAL_STANDING",
    });
    expect(r2.needsApproval).toBe(false);
    expect(r2.ready).toBe(true);
    expect(e.start("canary-test-0001", NOW + 20).state).toBe("REVIEWED");
    const send = e.authorize("canary-test-0001", {
      now: NOW + 21,
      trustedGesture: true,
    });
    expect(send.action).toBe("SEND");
    const tx = e.prepare("canary-test-0001", send, NOW + 22);
    expect(tx.to).toBe(CANARY_PINS.diamond.address);
    expect(uses.load().map((l) => l.split(":").at(-1))).toEqual([
      "APPROVE",
      "SEND",
    ]);
    e.observe("canary-test-0001", {
      type: "TX_SUBMITTED",
      at: NOW + 23,
      role: "main",
      hash: MAIN,
      nonce: e.record("canary-test-0001")!.pending!.nonce,
    });
    e.observe("canary-test-0001", {
      type: "TX_CONFIRMED",
      at: NOW + 24,
      role: "main",
      hash: MAIN,
      block: "100",
      blockHash: H(4),
      confirmations: 10,
    });
    expect(e.record("canary-test-0001")!.state).toBe("SOURCE_CONFIRMED");
    const d = deposit();
    // N2: a changed destination pin is reported and retried, never a terminal failure.
    const blocked = e.settle("canary-test-0001", {
      sourceLogs: sourceLogs(),
      destinationLogs: [
        fill(d),
        transfer(CANARY_PINS.usdc["42161"].address, OTHER, SYN, 4_979_689n),
      ],
      sourceRefundLogs: [],
      destinationPins: destPins({
        usdc: { ...destPins().usdc, implementation: OTHER },
      }),
      nowSec: d.fillDeadline - 100,
      at: NOW + 25,
    });
    expect(blocked.settlement.status).toBe("DISCREPANCY");
    expect(blocked.record.state).toBe("SOURCE_CONFIRMED");
    // A relayer paying one unit more still delivers (the extra is unrelated activity, not a failure).
    const settled = e.settle("canary-test-0001", {
      sourceLogs: sourceLogs(),
      destinationLogs: [
        fill(d),
        transfer(CANARY_PINS.usdc["42161"].address, OTHER, SYN, 4_979_690n),
      ],
      sourceRefundLogs: [],
      destinationPins: destPins(),
      nowSec: d.fillDeadline - 100,
      at: NOW + 26,
    });
    expect(settled.record.state).toBe("SETTLED");
    const two = (chain: string, usdc: string): [SourceRead, SourceRead] => [
      src("https://base-rpc.publicnode.com", { usdc }, BLOCK, chain),
      src("https://mainnet.base.org", { usdc }, BLOCK, chain),
    ];
    const one = e.reconcile("canary-test-0001", {
      baseBefore: two("8453", "5000000"),
      baseAfter: [
        src("https://base-rpc.publicnode.com", { usdc: "0" }, BLOCK),
        null,
      ],
      arbBefore: two("42161", "1"),
      arbAfter: two("42161", "4979690"),
      at: NOW + 27,
    });
    expect(one.check.status).toBe("UNKNOWN");
    expect(one.record.state).toBe("SETTLED");
    const done = e.reconcile("canary-test-0001", {
      baseBefore: two("8453", "5000000"),
      baseAfter: two("8453", "0"),
      arbBefore: two("42161", "1"),
      arbAfter: two("42161", "4979690"),
      at: NOW + 28,
    });
    expect(done.check.status).toBe("PASS");
    expect(done.record.state).toBe("RECONCILED");
  });
  it("N3: settlement needs the current main transaction (no stale deposit is kept)", async () => {
    const { e } = engine(true, new MemoryUseJournal(), () => [
      { calls: simCalls() },
    ]);
    await e.review(input());
    e.start("canary-test-0001", NOW + 10);
    expect(() =>
      e.settle("canary-test-0001", {
        sourceLogs: sourceLogs(),
        destinationLogs: [],
        sourceRefundLogs: [],
        destinationPins: destPins(),
        nowSec: 0,
        at: NOW + 11,
      }),
    ).toThrow("NO_MAIN_TRANSACTION");
  });
});

describe("G14 externally anchored audit integrity", () => {
  it("cut-off, rewritten or re-anchored histories are detected; an older owner head still verifies honest appends", async () => {
    const { e, anchors } = engine(true);
    await e.review(input());
    const rec = e.start("canary-test-0001", NOW + 10);
    const ownerHead = anchors.head();
    expect(
      verifyAnchored(
        { ...rec, audit: rec.audit.slice(0, -1) },
        anchors.entries(),
        ownerHead,
      ),
    ).toEqual({ ok: false, code: "RECORD_NOT_ANCHORED" });
    let forged = newRecord("canary-test-0001");
    for (const a of rec.audit) {
      const ev = {
        ...(a.event as unknown as ExecutionEvent),
        at: a.at + 1,
      } as ExecutionEvent;
      forged = apply(
        forged,
        ev.type === "QUOTE_READ" ? { ...ev, plan: rec.plan! } : ev,
      );
    }
    expect(verifyAnchored(forged, anchors.entries(), ownerHead)).toEqual({
      ok: false,
      code: "RECORD_NOT_ANCHORED",
    });
    const fake = new AuditAnchorLog();
    for (let i = 1; i <= forged.audit.length; i++)
      fake.anchor(
        { id: forged.id, audit: forged.audit.slice(0, i) },
        forged.audit[i - 1].at,
      );
    expect(verifyAnchored(forged, fake.entries())).toEqual({
      ok: true,
      extension: 0,
    });
    expect(verifyAnchored(forged, fake.entries(), ownerHead)).toEqual({
      ok: false,
      code: "ANCHOR_LOG_NOT_OWNER_HEAD",
    });
    const broken = anchors
      .entries()
      .map((x, i) => (i === 1 ? { ...x, head: "0".repeat(64) } : x));
    expect(verifyAnchored(rec, broken, ownerHead)).toEqual({
      ok: false,
      code: "ANCHOR_CHAIN_BROKEN",
    });
    // F10: an honest append after the owner copied the head verifies, and the extension is reported.
    const later = e.observe("canary-test-0001", {
      type: "EXPIRED",
      at: NOW + 30_000,
    });
    expect(verifyAnchored(later, anchors.entries(), ownerHead)).toEqual({
      ok: true,
      extension: 1,
    });
  });
  it("F10: a step whose anchor would go back in time is refused before the record changes", async () => {
    const { e } = engine(true);
    await e.review(input());
    e.start("canary-test-0001", NOW + 1000);
    // The first record ends unused (its quote expired), so the same owner may review again ...
    expect(
      e.observe("canary-test-0001", { type: "EXPIRED", at: NOW + 40_000 })
        .state,
    ).toBe("EXPIRED");
    const r = await e.review(input({ record: "canary-test-0009" }));
    expect(r.ready).toBe(true);
    // ... but a start whose anchors would go back in time is refused before anything is stored.
    expect(() => e.start("canary-test-0009", NOW + 10)).toThrow(
      "ANCHOR_CLOCK_WENT_BACK",
    );
    expect(e.record("canary-test-0009")).toBeNull();
  });
});

describe("G14 lifecycle corrections (review N5, round 7 V1 / V2)", () => {
  const quoted = async () => {
    const { e } = engine(true);
    const r = await e.review(input());
    return {
      rec: apply(newRecord("canary-test-0002"), {
        type: "QUOTE_READ",
        at: NOW,
        plan: r.plan!,
      }),
      hash: r.planHash!,
    };
  };
  const report = (fail = false) => ({
    checks: CHECK_IDS.map((id, i) => ({
      id,
      status: fail && i === 4 ? ("FAIL" as const) : ("PASS" as const),
      code: "T",
    })),
    now: NOW,
  });
  const ev = (
    hash: string,
    rep: ReturnType<typeof report>,
    over: Partial<Extract<ExecutionEvent, { type: "PREFLIGHT" }>> = {},
  ): ExecutionEvent => ({
    type: "PREFLIGHT",
    at: NOW,
    plan: hash,
    ready: true,
    failed: [],
    digest: preflightDigest(hash, rep.checks, rep.now),
    report: rep,
    ...over,
  });
  it("N5: a ready claim must be what the attached report says, with the recomputed digest", async () => {
    const { rec, hash } = await quoted();
    expect(apply(rec, ev(hash, report())).state).toBe("PREFLIGHT_PASSED");
    expect(() => apply(rec, ev(hash, report(true)))).toThrow(
      "PREFLIGHT_CLAIM_MISMATCH",
    );
    expect(() =>
      apply(rec, ev(hash, report(), { digest: "a".repeat(64) })),
    ).toThrow("PREFLIGHT_CLAIM_MISMATCH");
    expect(() =>
      apply(rec, ev(hash, { checks: report().checks.slice(1), now: NOW })),
    ).toThrow("PREFLIGHT_REPORT_INVALID");
    const r2 = report(true);
    expect(
      apply(
        rec,
        ev(hash, r2, {
          ready: false,
          failed: ["BALANCE"],
          digest: preflightDigest(hash, r2.checks, NOW),
        }),
      ).state,
    ).toBe("BLOCKED");
    const noReport: Record<string, unknown> = { ...ev(hash, report()) };
    delete noReport.report;
    expect(() => apply(rec, noReport as unknown as ExecutionEvent)).toThrow(
      "INVALID_OBSERVATION",
    );
  });
  it("V1: `since: null` still lets a reorg be seen; V2: a non-string authorization field is refused with a code", async () => {
    const o = {
      role: "main" as const,
      hash: H(1),
      receipt: null,
      canonicalHashAtBlock: null,
      head: "100",
      transactionKnown: false,
      accountNonce: "5",
      txNonce: "5",
      replacement: null,
      submittedAt: NOW,
      confirmedBlockHash: H(2),
      now: NOW + 1,
      since: null,
    };
    expect(observeSource(o)?.type).toBe("REORG");
    const { e } = engine(true);
    await e.review(input());
    const rec = e.start("canary-test-0001", NOW + 10);
    expect(() =>
      apply(rec, {
        type: "OWNER_AUTHORIZED",
        at: NOW + 11,
        authorization: {
          action: "APPROVE",
          review: rec.review!,
          record: rec.id,
          account: 123 as unknown as string,
          issuedAt: NOW + 11,
          expiresAt: NOW + 20,
          nonce: "a".repeat(32),
        },
      }),
    ).toThrow("INVALID_OBSERVATION");
  });
});

describe("G14 round-2 corrections (N5, N6)", () => {
  it("N5: a trailing-dot host is the same operator", () => {
    expect(operatorOf("https://mainnet.base.org.")).toBe(
      operatorOf("https://mainnet.base.org"),
    );
    expect(
      agree(
        src("https://mainnet.base.org", { usdc: "1" }),
        src("https://mainnet.base.org.", { usdc: "1" }),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("SINGLE");
  });
  it("N6: a slow fill (fillType 2) delivers when it pays at least the reviewed minimum to the owner", () => {
    const d = deposit();
    const slow = (amount: bigint): ChainLog => {
      const f = fill(d);
      // fillType 2 with the slow-fill amount in relayExecutionInfo; the relay fields stay the deposit's own.
      const data = encodeAbiParameters(
        [
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint256" },
          { type: "uint32" },
          { type: "uint32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          { type: "bytes32" },
          {
            type: "tuple",
            components: [
              { type: "bytes32" },
              { type: "bytes32" },
              { type: "uint256" },
              { type: "uint8" },
            ],
          },
        ],
        [
          d.inputToken as Hex,
          d.outputToken as Hex,
          BigInt(d.inputAmount),
          BigInt(d.outputAmount),
          8453n,
          d.fillDeadline,
          d.exclusivityDeadline,
          d.exclusiveRelayer as Hex,
          d.depositor as Hex,
          d.recipient as Hex,
          d.messageHash as Hex,
          [d.recipient as Hex, d.messageHash as Hex, amount, 2],
        ],
      );
      return { ...f, data };
    };
    const t = {
      sourceRefundLogs: [] as ChainLog[],
      destinationPins: destPins(),
      nowSec: d.fillDeadline - 10,
    };
    const usdcArb = CANARY_PINS.usdc["42161"].address,
      arbPool = CANARY_PINS.spokePools["42161"].address;
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [
          slow(4_985_000n),
          transfer(usdcArb, arbPool, SYN, 4_985_000n),
        ],
        ...t,
      }),
    ).toMatchObject({ status: "DELIVERED", delivered: "4985000" });
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [
          slow(4_000_000n),
          transfer(usdcArb, arbPool, SYN, 4_000_000n),
        ],
        ...t,
      }).status,
    ).toBe("PENDING");
  });
});

describe("G14 round-3 corrections (M1, M2, R1)", () => {
  const noApproval = () => {
    const c = simCalls().filter((_, i) => i !== 2);
    c[1] = {
      ...c[1],
      returnData: "0x" + 5_000_000n.toString(16).padStart(64, "0"),
    };
    return c;
  };
  const standing = {
    usdc: "5000000",
    native: "10000000000000000",
    allowance: "5000000",
  };
  const withAllowance = (over: Partial<CanaryReviewInput> = {}) =>
    input({
      balances: [
        src("https://base-rpc.publicnode.com", standing, BLOCK),
        src("https://mainnet.base.org", standing, BLOCK),
      ],
      ...over,
    });
  const layout = (r: SimulationRequest) => [
    {
      calls:
        r.blockStateCalls[0].calls.length === 6 ? simCalls() : noApproval(),
    },
  ];
  it("M1: after a restart the SAME record id cannot send again (the journal holds the phases, not the records)", async () => {
    const uses = new MemoryUseJournal();
    const a = engine(true, uses, layout);
    await a.e.review(withAllowance());
    a.e.start("canary-test-0001", NOW + 10);
    a.e.prepare(
      "canary-test-0001",
      a.e.authorize("canary-test-0001", {
        now: NOW + 11,
        trustedGesture: true,
      }),
      NOW + 12,
    );
    expect(a.e.phases(SYN)).toEqual({
      approve: null,
      send: "canary-test-0001",
    });
    const b = engine(true, uses, layout);
    const r = await b.e.review(withAllowance());
    expect(r.checks.find((c) => c.id === "SINGLE_USE")).toEqual({
      id: "SINGLE_USE",
      status: "FAIL",
      code: "CANARY_ALREADY_SENT",
    });
    expect(r.ready).toBe(false);
    expect(() => b.e.start("canary-test-0001", NOW + 20)).toThrow();
    expect(b.e.record("canary-test-0001")).toBeNull();
  });
  it("M1/M2: a standing exact approval survives a restart or an expired record, and is used by exactly one later send", async () => {
    const uses = new MemoryUseJournal();
    const a = engine(true, uses, layout);
    await a.e.review(input());
    a.e.start("canary-test-0001", NOW + 10);
    a.e.prepare(
      "canary-test-0001",
      a.e.authorize("canary-test-0001", {
        now: NOW + 11,
        trustedGesture: true,
      }),
      NOW + 12,
    );
    // A second approval is never possible (restart, other record id, allowance read as 0 again).
    const b = engine(true, uses, layout);
    const again = await b.e.review(input({ record: "canary-test-0002" }));
    expect(again.checks.find((c) => c.id === "SINGLE_USE")?.code).toBe(
      "APPROVAL_ALREADY_USED",
    );
    // The approval is mined and the old record is gone (restart): a NEW record sends with the standing allowance.
    const r = await b.e.review(withAllowance({ record: "canary-test-0003" }));
    expect(r.checks.find((c) => c.id === "SINGLE_USE")).toEqual({
      id: "SINGLE_USE",
      status: "PASS",
      code: "APPROVAL_STANDING",
    });
    expect(r.ready).toBe(true);
    b.e.start("canary-test-0003", NOW + 20);
    const t = b.e.authorize("canary-test-0003", {
      now: NOW + 21,
      trustedGesture: true,
    });
    expect(t.action).toBe("SEND");
    b.e.prepare("canary-test-0003", t, NOW + 22);
    expect(b.e.phases(SYN)).toEqual({
      approve: "canary-test-0001",
      send: "canary-test-0003",
    });
    // ... and nothing after that.
    const c = engine(true, uses, layout);
    expect(
      (
        await c.e.review(withAllowance({ record: "canary-test-0004" }))
      ).checks.find((x) => x.id === "SINGLE_USE")?.code,
    ).toBe("CANARY_ALREADY_SENT");
  });
  it("M2: the exact revocation of a standing approval is approve(Diamond, 0) from the owner on Base USDC", () => {
    const tx = revocationTransaction(SYN);
    expect(tx).toMatchObject({
      chainId: "8453",
      from: SYN,
      to: CANARY_PINS.usdc["8453"].address,
      value: "0",
    });
    expect(tx.data.toLowerCase()).toBe(
      encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "approve",
            inputs: [{ type: "address" }, { type: "uint256" }],
            outputs: [{ type: "bool" }],
            stateMutability: "nonpayable",
          },
        ],
        args: [CANARY_PINS.diamond.address as Hex, 0n],
      }).toLowerCase(),
    );
    expect(() =>
      revocationTransaction("0x0000000000000000000000000000000000000000"),
    ).toThrow("OWNER_INVALID");
  });
  it("R1: an unread fill payment is retried (never terminal); removed (reorganised) logs never count", () => {
    const d = deposit();
    const t = {
      sourceRefundLogs: [] as ChainLog[],
      destinationPins: destPins(),
      nowSec: d.fillDeadline - 10,
    };
    expect(
      destinationSettlement({ deposit: d, destinationLogs: [fill(d)], ...t })
        .code,
    ).toBe("FILL_PAYMENT_NOT_READ");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [
          { ...fill(d), removed: true },
          transfer(CANARY_PINS.usdc["42161"].address, OTHER, SYN, 4_979_689n),
        ],
        ...t,
      }).status,
    ).toBe("PENDING");
    expect(
      destinationSettlement({
        deposit: d,
        destinationLogs: [
          fill(d),
          transfer(CANARY_PINS.usdc["42161"].address, OTHER, SYN, 4_000_000n),
        ],
        ...t,
      }).code,
    ).toBe("FILL_UNDERPAID_TO_OWNER");
  });
  it("R1 through the engine: an unread payment leaves the record pending; settling twice is refused", async () => {
    const { e } = engine(true, new MemoryUseJournal(), layout);
    await e.review(withAllowance());
    e.start("canary-test-0001", NOW + 10);
    e.prepare(
      "canary-test-0001",
      e.authorize("canary-test-0001", { now: NOW + 11, trustedGesture: true }),
      NOW + 12,
    );
    e.observe("canary-test-0001", {
      type: "TX_SUBMITTED",
      at: NOW + 13,
      role: "main",
      hash: MAIN,
      nonce: e.record("canary-test-0001")!.pending!.nonce,
    });
    e.observe("canary-test-0001", {
      type: "TX_CONFIRMED",
      at: NOW + 14,
      role: "main",
      hash: MAIN,
      block: "100",
      blockHash: H(4),
      confirmations: 10,
    });
    const d = deposit();
    const base = {
      sourceLogs: sourceLogs(),
      sourceRefundLogs: [] as ChainLog[],
      destinationPins: destPins(),
      nowSec: d.fillDeadline - 100,
    };
    const unread = e.settle("canary-test-0001", {
      ...base,
      destinationLogs: [fill(d)],
      at: NOW + 15,
    });
    expect(unread.settlement.code).toBe("FILL_PAYMENT_NOT_READ");
    expect(unread.record.state).toBe("SOURCE_CONFIRMED");
    expect(
      e.settle("canary-test-0001", {
        ...base,
        destinationLogs: [
          fill(d),
          transfer(CANARY_PINS.usdc["42161"].address, OTHER, SYN, 4_979_689n),
        ],
        at: NOW + 16,
      }).record.state,
    ).toBe("SETTLED");
    expect(() =>
      e.settle("canary-test-0001", {
        ...base,
        destinationLogs: [],
        at: NOW + 17,
      }),
    ).toThrow("ALREADY_SETTLED");
  });
});

describe("G14 round-4 corrections (P1, P2, block age, R1-NIT)", () => {
  const standing = {
    usdc: "5000000",
    native: "10000000000000000",
    allowance: "5000000",
  };
  const noApproval = () => {
    const c = simCalls().filter((_, i) => i !== 2);
    c[1] = {
      ...c[1],
      returnData: "0x" + 5_000_000n.toString(16).padStart(64, "0"),
    };
    return c;
  };
  const layout = (r: SimulationRequest) => [
    {
      calls:
        r.blockStateCalls[0].calls.length === 6 ? simCalls() : noApproval(),
    },
  ];
  it("P1: a step that would be refused spends neither the token nor the canary", async () => {
    const { e, uses } = engine(true, new MemoryUseJournal(), layout);
    await e.review(input());
    e.start("canary-test-0001", NOW + 10);
    const t = e.authorize("canary-test-0001", {
      now: NOW + 11,
      trustedGesture: true,
    });
    // The token itself ends 10 s before the quote (the lifecycle would refuse after that point anyway).
    expect(t.expiresAt).toBe(QUOTED_AT + 30_000 - 10_000);
    expect(() =>
      e.prepare("canary-test-0001", t, QUOTED_AT + 30_000 - 9_000),
    ).toThrow("QUOTE_TOO_CLOSE_TO_EXPIRY");
    expect(uses.load()).toEqual([]);
    expect(e.record("canary-test-0001")!.state).toBe("REVIEWED");
    // Still inside the window: the same token works once.
    expect(e.prepare("canary-test-0001", t, NOW + 12).to.toLowerCase()).toBe(
      CANARY_PINS.usdc["8453"].address.toLowerCase(),
    );
    expect(uses.load()).toHaveLength(1);
  });
  it("P2: an unrecognised journal line for the owner fails closed (read as a send)", async () => {
    const uses = new MemoryUseJournal();
    uses.append(`${CANARY_SCOPE.id}:${SYN}:canary-old-format`);
    const { e } = engine(true, uses, layout);
    expect(e.phases(SYN).send).toBe("canary-old-format");
    const r = await e.review(
      input({
        balances: [
          src("https://base-rpc.publicnode.com", standing, BLOCK),
          src("https://mainnet.base.org", standing, BLOCK),
        ],
      }),
    );
    expect(r.checks.find((c) => c.id === "SINGLE_USE")?.code).toBe(
      "CANARY_ALREADY_SENT",
    );
    // Other owners are not affected.
    expect(e.phases(OTHER)).toEqual({ approve: null, send: null });
  });
  it("NIT: an old review block (or one without a time) is not ready", async () => {
    const { e } = engine(true, new MemoryUseJournal(), layout);
    const old = { ...BLOCK, timestamp: Math.floor(NOW / 1000) - 120 };
    const v = { usdc: "5000000", native: "10000000000000000", allowance: "0" };
    const r = await e.review(
      input({
        balances: [
          src("https://base-rpc.publicnode.com", v, old),
          src("https://mainnet.base.org", v, old),
        ],
        pins: [
          pinReads(undefined, { block: old }),
          pinReads("https://mainnet.base.org", { block: old }),
        ],
      }),
    );
    expect(r.checks.find((c) => c.id === "REVIEW_BLOCK_FRESH")).toMatchObject({
      status: "UNKNOWN",
      code: "BLOCK_TOO_OLD:120",
    });
    expect(r.ready).toBe(false);
    const noTime = { number: BLOCK.number, hash: BLOCK.hash };
    const r2 = await e.review(
      input({
        balances: [
          src("https://base-rpc.publicnode.com", v, noTime),
          src("https://mainnet.base.org", v, noTime),
        ],
      }),
    );
    expect(r2.checks.find((c) => c.id === "REVIEW_BLOCK_FRESH")?.code).toBe(
      "BLOCK_TIME_NOT_READ",
    );
  });
  it("R1-NIT: an apparent underpayment of the matching fill is retried by the engine, never terminal", async () => {
    const { e } = engine(true, new MemoryUseJournal(), layout);
    await e.review(
      input({
        balances: [
          src("https://base-rpc.publicnode.com", standing, BLOCK),
          src("https://mainnet.base.org", standing, BLOCK),
        ],
      }),
    );
    e.start("canary-test-0001", NOW + 10);
    e.prepare(
      "canary-test-0001",
      e.authorize("canary-test-0001", { now: NOW + 11, trustedGesture: true }),
      NOW + 12,
    );
    e.observe("canary-test-0001", {
      type: "TX_SUBMITTED",
      at: NOW + 13,
      role: "main",
      hash: MAIN,
      nonce: e.record("canary-test-0001")!.pending!.nonce,
    });
    e.observe("canary-test-0001", {
      type: "TX_CONFIRMED",
      at: NOW + 14,
      role: "main",
      hash: MAIN,
      block: "100",
      blockHash: H(4),
      confirmations: 10,
    });
    const d = deposit();
    const partial = e.settle("canary-test-0001", {
      sourceLogs: sourceLogs(),
      destinationLogs: [
        fill(d),
        transfer(CANARY_PINS.usdc["42161"].address, OTHER, OTHER, 1n),
      ],
      sourceRefundLogs: [],
      destinationPins: destPins(),
      nowSec: d.fillDeadline - 100,
      at: NOW + 15,
    });
    expect(partial.settlement.code).toBe("FILL_UNDERPAID_TO_OWNER");
    expect(partial.record.state).toBe("SOURCE_CONFIRMED");
  });
});

describe("G14 round-5 NITs (W1, W2, W4)", () => {
  const standing = {
    usdc: "5000000",
    native: "10000000000000000",
    allowance: "5000000",
  };
  const noApproval = () => {
    const c = simCalls().filter((_, i) => i !== 2);
    c[1] = {
      ...c[1],
      returnData: "0x" + 5_000_000n.toString(16).padStart(64, "0"),
    };
    return c;
  };
  const layout = (r: SimulationRequest) => [
    {
      calls:
        r.blockStateCalls[0].calls.length === 6 ? simCalls() : noApproval(),
    },
  ];
  it("W1: authorization is possible while the plan has 10 s left; the token itself ends 10 s before the quote", async () => {
    const { e } = engine(true, new MemoryUseJournal(), layout);
    await e.review(input());
    e.start("canary-test-0001", NOW + 10);
    const t = e.authorize("canary-test-0001", {
      now: QUOTED_AT + 12_000,
      trustedGesture: true,
    });
    expect(t.expiresAt).toBe(QUOTED_AT + 20_000);
    expect(() =>
      e.authorize("canary-test-0001", {
        now: QUOTED_AT + 21_000,
        trustedGesture: true,
      }),
    ).toThrow("QUOTE_TOO_CLOSE_TO_EXPIRY");
  });
  it("W2: a journal line written with CRLF keeps its phase", async () => {
    const uses = new MemoryUseJournal();
    uses.append(`${CANARY_SCOPE.id}:${SYN}:canary-old:APPROVE\r`);
    const { e } = engine(true, uses, layout);
    expect(e.phases(SYN)).toEqual({ approve: "canary-old", send: null });
    const r = await e.review(
      input({
        balances: [
          src("https://base-rpc.publicnode.com", standing, BLOCK),
          src("https://mainnet.base.org", standing, BLOCK),
        ],
      }),
    );
    expect(r.checks.find((c) => c.id === "SINGLE_USE")?.code).toBe(
      "APPROVAL_STANDING",
    );
  });
  it("W4: two operators reporting different block times do not agree", () => {
    const v = { usdc: "1" };
    expect(
      agree(
        src("https://a.example", v, BLOCK),
        src("https://b.example", v, {
          ...BLOCK,
          timestamp: BLOCK.timestamp + 1,
        }),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("UNKNOWN");
    expect(
      agree(
        src("https://a.example", v, BLOCK),
        src("https://b.example", v, BLOCK),
        ["usdc"],
        "8453",
      ).status,
    ).toBe("AGREE");
  });
});
