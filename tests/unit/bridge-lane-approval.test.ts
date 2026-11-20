// VEINED-MC1 (BRIDGE LANE): the bridge lane's protected facts, its record and its gate (src/swap/lane/bridge-approval.ts)
// for every pair. In this build all four facts are closed and the gate is CLOSED; with a synthetic record, digest and
// wiring the gate opens only for the exact transaction of THAT pair (re-decoded and re-bound from its own bytes).
// SYNTHETIC_TEST_ONLY: the records, digests and transactions are synthetic. Pure: nothing reaches a chain or a network.
import { describe, expect, it } from "vitest";
import {
  BRIDGE_LANE_APPROVAL_BOUNDS,
  BRIDGE_LANE_LIVE_WIRING,
  OWNER_BRIDGE_LANE_APPROVAL,
  OWNER_BRIDGE_LANE_KEY_SHA256,
  OWNER_BRIDGE_LANE_SIGNER,
  bridgeLaneGateState,
  bridgeLaneRecordProblems,
  type BridgeLaneStepFacts,
} from "../../src/swap/lane/bridge-approval";
import { bridgeApproveCalldata } from "../../src/swap/lane/bridge-calldata";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
  pairById,
} from "../../src/swap/lane/bridge-scope";
import { OWNER_SWAP_LANE_APPROVAL } from "../../src/swap/lane/approval";
import {
  BLOCKED_PAIR_IDS,
  ENABLED_PAIR_IDS,
  NOW,
  OTHER,
  OWNER,
  encodeBridge,
  honestParts,
  recordFor,
} from "./bridge-lane-fake";

const DIGEST = "e".repeat(64);
const NOW_SEC = Math.floor(NOW / 1000);
const DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const txOf = (id: string, step: "APPROVE" | "EXECUTE") => {
  const p = pairById(id)!;
  const S = BRIDGE_LANE_CHAINS[p.source];
  return {
    chainId: S.chainHex,
    from: OWNER,
    to: step === "APPROVE" ? S.usdc.address.toLowerCase() : DIAMOND,
    value: "0x0",
    data:
      step === "APPROVE"
        ? bridgeApproveCalldata(p.exactAmount)
        : encodeBridge(honestParts(id, NOW_SEC)),
    gas: step === "APPROVE" ? "0x103dc" : "0x36030",
    maxFeePerGas: "0x" + (S.maxFeePerGasWei / 2n).toString(16),
    maxPriorityFeePerGas: "0x" + S.minTipWei.toString(16),
  };
};
const factsOf = (
  id: string,
  step: "APPROVE" | "EXECUTE",
  over: Partial<BridgeLaneStepFacts> = {},
): BridgeLaneStepFacts => ({
  route: id,
  step,
  exactAmount: pairById(id)!.exactAmount.toString(),
  tx: txOf(id, step),
  operatorsAgree: true,
  reviewAttested: true,
  guardianPassed: true,
  gasWorstCaseTotalWei: 1n,
  now: NOW,
  ...over,
});
const gate = (
  id: string,
  f: BridgeLaneStepFacts | undefined,
  rec = recordFor(id),
) => bridgeLaneGateState(f, rec, DIGEST, true);

describe("the protected facts are disarmed", () => {
  it("record null, key digest null, wiring false, signer null: the gate is CLOSED for every reason", () => {
    expect(OWNER_BRIDGE_LANE_APPROVAL).toBeNull();
    expect(OWNER_BRIDGE_LANE_KEY_SHA256).toBeNull();
    expect(BRIDGE_LANE_LIVE_WIRING).toBe(false);
    expect(OWNER_BRIDGE_LANE_SIGNER).toBeNull();
    const g = bridgeLaneGateState(factsOf("bridge-8453-42161", "APPROVE"));
    expect(g).toEqual({
      state: "CLOSED",
      open: false,
      reasons: [
        "NO_OWNER_APPROVED_BRIDGE_LANE",
        "NO_OWNER_BRIDGE_LANE_KEY",
        "BRIDGE_LANE_NOT_WIRED",
      ],
      scope: null,
      pinSet: null,
    });
    // it never borrows the swap lane's record
    expect(OWNER_SWAP_LANE_APPROVAL).toBeNull();
  });
  it("a synthetic record with no key or no wiring still closes", () => {
    const rec = recordFor("bridge-1-10");
    expect(
      bridgeLaneGateState(factsOf("bridge-1-10", "APPROVE"), rec, null, true)
        .reasons,
    ).toEqual(["NO_OWNER_BRIDGE_LANE_KEY"]);
    expect(
      bridgeLaneGateState(factsOf("bridge-1-10", "APPROVE"), rec, DIGEST, false)
        .reasons,
    ).toEqual(["BRIDGE_LANE_NOT_WIRED"]);
    expect(bridgeLaneGateState(undefined, rec, DIGEST, true).reasons).toEqual([
      "BRIDGE_LANE_FACTS_MISSING",
    ]);
  });
});

describe("the record", () => {
  it("bounds per pair are derived from the pair table (exact amount, minimum, spender, budget)", () => {
    expect(Object.keys(BRIDGE_LANE_APPROVAL_BOUNDS).sort()).toEqual(
      Object.keys(BRIDGE_LANE_PAIRS).sort(),
    );
    for (const id of ENABLED_PAIR_IDS)
      expect(BRIDGE_LANE_APPROVAL_BOUNDS[id]).toMatchObject({
        exactAmount: "5000000",
        minimumOut: "4900000",
        maxCostBps: 300,
        spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
      });
  });
  it.each(ENABLED_PAIR_IDS)("%s: the synthetic record is well formed", (id) => {
    expect(bridgeLaneRecordProblems(recordFor(id))).toEqual([]);
  });
  it.each(BLOCKED_PAIR_IDS)(
    "%s: a record of a BLOCKED pair is refused (ROUTE_BLOCKED)",
    (id) => {
      expect(bridgeLaneRecordProblems(recordFor(id))).toContain(
        "ROUTE_BLOCKED",
      );
    },
  );
  it("every field is checked", () => {
    const id = "bridge-42161-137";
    const bad = (over: Record<string, unknown>) =>
      bridgeLaneRecordProblems({ ...recordFor(id), ...over });
    expect(bad({ extra: 1 })).toContain("UNKNOWN_FIELD:extra");
    expect(bad({ version: "veined.bridge-lane.approval.v0" })).toContain(
      "VERSION",
    );
    expect(bad({ approvalId: "0x12" })).toContain("APPROVAL_ID");
    expect(bad({ route: "bridge-42161-43114" })).toContain("ROUTE");
    expect(bad({ route: "__proto__" })).toContain("ROUTE");
    expect(bad({ scope: "bridge-42161-10" })).toContain("SCOPE");
    expect(bad({ pinSet: "other" })).toContain("PIN_SET");
    expect(bad({ account: "0x" + "0".repeat(40) })).toContain("ACCOUNT");
    expect(bad({ sourceChainId: "10" })).toContain("CHAINS");
    expect(bad({ destinationToken: OTHER })).toContain("TOKENS");
    expect(bad({ spender: OTHER })).toContain("SPENDER");
    expect(bad({ exactAmount: "5000001" })).toContain("AMOUNT_NOT_PAIR_AMOUNT");
    expect(bad({ exactAmount: "05000000" })).toContain("AMOUNT");
    expect(bad({ minimumOut: "4899999" })).toContain("MINIMUM_BOUNDS");
    expect(bad({ minimumOut: "5000001" })).toContain("MINIMUM_BOUNDS");
    expect(bad({ minimumOut: "4950000" })).toEqual([]);
    expect(bad({ maxCostBps: 301 })).toContain("COST_BOUNDS");
    expect(bad({ maxCostBps: 0 })).toContain("COST_BOUNDS");
    expect(
      bad({ nativeGasBudgetWei: (pairById(id)!.gasBudgetWei + 1n).toString() }),
    ).toContain("GAS_BUDGET_BOUNDS");
    expect(bad({ firstNonce: "-1" })).toContain("FIRST_NONCE");
    expect(bad({ notAfter: NOW - 3_600_000 - 1 })).toContain("WINDOW_BOUNDS");
    expect(bad({ notAfter: NOW + 25 * 3_600_000 })).toContain("WINDOW_BOUNDS");
    expect(bad({ singleUse: false })).toContain("SINGLE_USE");
    expect(bad({ allowanceCleanup: "NONE" })).toContain("CLEANUP_POLICY");
    expect(bridgeLaneRecordProblems(null)).toEqual(["NO_RECORD"]);
  });
});

describe.each(ENABLED_PAIR_IDS)("the gate on %s", (id) => {
  const p = pairById(id)!;
  const S = BRIDGE_LANE_CHAINS[p.source];
  it("opens for the exact APPROVE and EXECUTE of the pair (record, digest, wiring synthetic)", () => {
    for (const step of ["APPROVE", "EXECUTE"] as const) {
      const g = gate(id, factsOf(id, step));
      expect(g.reasons, step).toEqual([]);
      expect(g).toMatchObject({ open: true, state: "OPEN", scope: id });
    }
  });
  it("closes on every byte and fact that is not the pair's (each reason named)", () => {
    const reasons = (
      step: "APPROVE" | "EXECUTE",
      over: Partial<BridgeLaneStepFacts> = {},
      tx: Record<string, string> = {},
    ) =>
      gate(id, factsOf(id, step, { ...over, tx: { ...txOf(id, step), ...tx } }))
        .reasons;
    expect(
      reasons("APPROVE", {}, { chainId: S.chainHex === "0x1" ? "0xa" : "0x1" }),
    ).toContain("STEP:CHAIN");
    expect(reasons("APPROVE", {}, { from: OTHER })).toContain(
      "STEP:FROM_NOT_OWNER",
    );
    expect(reasons("APPROVE", {}, { value: "0x1" })).toContain(
      "STEP:NATIVE_VALUE",
    );
    expect(reasons("APPROVE", {}, { to: OTHER })).toContain(
      "STEP:APPROVE_TARGET_NOT_USDC",
    );
    expect(
      reasons(
        "APPROVE",
        {},
        { data: bridgeApproveCalldata(p.exactAmount + 1n) },
      ),
    ).toContain("STEP:APPROVE_NOT_EXACT_AMOUNT");
    expect(reasons("EXECUTE", {}, { to: OTHER })).toContain(
      "STEP:EXECUTE_TARGET_NOT_DIAMOND",
    );
    const wrong = honestParts(id, NOW_SEC);
    wrong.receiver = OTHER;
    expect(reasons("EXECUTE", {}, { data: encodeBridge(wrong) })).toContain(
      "STEP:BRIDGE_RECEIVER_NOT_OWNER",
    );
    // the bytes are re-bound at the gate's own time: a quote that went stale since the review closes it
    expect(reasons("EXECUTE", { now: NOW + 11 * 60_000 })).toContain(
      "STEP:BRIDGE_QUOTE_TIMESTAMP_SKEW",
    );
    expect(
      reasons(
        "EXECUTE",
        {},
        { gas: "0x" + (S.maxGas.EXECUTE + 1n).toString(16) },
      ),
    ).toContain("STEP:GAS_LIMIT");
    expect(
      reasons(
        "APPROVE",
        {},
        { gas: "0x" + (S.maxGas.APPROVE + 1n).toString(16) },
      ),
    ).toContain("STEP:GAS_LIMIT");
    expect(reasons("APPROVE", {}, { gas: "0x5207" })).toContain(
      "STEP:GAS_LIMIT_BELOW_FLOOR",
    );
    expect(
      reasons(
        "APPROVE",
        {},
        { maxFeePerGas: "0x" + (S.maxFeePerGasWei + 1n).toString(16) },
      ),
    ).toContain("STEP:FEE_CAP_ABOVE_SIGNER_POLICY");
    expect(
      reasons(
        "APPROVE",
        {},
        { maxPriorityFeePerGas: "0x" + (S.maxTipWei + 1n).toString(16) },
      ),
    ).toContain("STEP:TIP_OUTSIDE_CHAIN_POLICY");
    if (S.minTipWei > 0n)
      expect(
        reasons(
          "APPROVE",
          {},
          { maxPriorityFeePerGas: "0x" + (S.minTipWei - 1n).toString(16) },
        ),
      ).toContain("STEP:TIP_OUTSIDE_CHAIN_POLICY");
    expect(
      reasons("APPROVE", { gasWorstCaseTotalWei: p.gasBudgetWei + 1n }),
    ).toContain("STEP:GAS_BUDGET");
    expect(reasons("APPROVE", { operatorsAgree: false })).toContain(
      "STEP:OPERATORS_NOT_PROVEN",
    );
    expect(reasons("APPROVE", { reviewAttested: false })).toContain(
      "STEP:REVIEW_NOT_ATTESTED",
    );
    expect(reasons("APPROVE", { guardianPassed: false })).toContain(
      "STEP:GUARDIAN_NOT_PASSED",
    );
    expect(
      reasons("APPROVE", {
        route: "bridge-1-137" === id ? "bridge-1-10" : "bridge-1-137",
      }),
    ).toContain("STEP:ROUTE");
    expect(reasons("APPROVE", { exactAmount: "1" })).toContain(
      "STEP:AMOUNT_NOT_RECORD_AMOUNT",
    );
    expect(reasons("APPROVE", { now: NOW + 13 * 3_600_000 })).toContain(
      "STEP:APPROVAL_EXPIRED",
    );
    expect(reasons("APPROVE", { now: NOW - 2 * 3_600_000 })).toContain(
      "STEP:NOT_YET_VALID",
    );
    expect(reasons("APPROVE", { step: "CLEANUP" as never })).toContain(
      "STEP:UNKNOWN_STEP",
    );
  });
  it("a record of another pair never opens this pair's step", () => {
    const other = ENABLED_PAIR_IDS.find((x) => x !== id)!;
    expect(
      gate(id, factsOf(id, "APPROVE"), recordFor(other)).reasons,
    ).toContain("STEP:ROUTE");
  });
});
