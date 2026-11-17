// VEINED-MC1 (BRIDGE LANE): the exact decoder and every binding of src/swap/lane/bridge-calldata.ts, pure, for every
// pair: canonical bytes only (planted bytes, relocated offsets, truncation, a dirty fee step are refused), every field
// bound to the pair and the record, the approve to the Diamond, and the LI.FI quote's own facts. When the read-only
// B-matrix evidence is present, the REAL LI.FI calldata of all 20 enabled pairs (E-bridge-sims.json, simulated on both
// operators) decodes and binds with its holder as the owner.
// SYNTHETIC_TEST_ONLY where values are synthetic. Pure: nothing is read from a chain or a network.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { getAddress, type Hex } from "viem";
import {
  bridgeApproveCalldata,
  bridgeApproveProblem,
  bridgeCallProblems,
  bridgeQuoteProblems,
  decodeBridgeCall,
} from "../../src/swap/lane/bridge-calldata";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
  pairById,
} from "../../src/swap/lane/bridge-scope";
import {
  AMOUNT,
  BRIDGED,
  ENABLED_PAIR_IDS,
  FEE,
  FEE_RECIPIENT,
  NOW_SEC,
  OTHER,
  OWNER,
  b32,
  effectiveOf,
  encodeBridge,
  feeCall,
  honestParts,
  quoteOf,
  w,
} from "./bridge-lane-fake";

const bind = (
  id: string,
  o: Partial<{
    owner: string;
    exactAmount: bigint;
    minimumOut: bigint;
    maxCostBps: number;
    nowSec: number;
  }> = {},
) => ({
  owner: OWNER,
  exactAmount: pairById(id)!.exactAmount,
  minimumOut: pairById(id)!.minimumOut,
  maxCostBps: 300,
  nowSec: NOW_SEC,
  ...o,
});
const problems = (id: string, data: unknown, o = {}) =>
  bridgeCallProblems(pairById(id)!, data, bind(id, o)).problems;

describe.each(ENABLED_PAIR_IDS)("%s", (id) => {
  const p = pairById(id)!;
  const S = BRIDGE_LANE_CHAINS[p.source],
    D = BRIDGE_LANE_CHAINS[p.destination];
  it("the honest call decodes exactly and binds: no problem; the effective output is the facet's arithmetic", () => {
    const parts = honestParts(id, NOW_SEC);
    const data = encodeBridge(parts);
    const v = bridgeCallProblems(p, data, bind(id));
    expect(v.problems).toEqual([]);
    expect(v.effectiveOutput).toBe(effectiveOf(parts));
    expect(v.feeTotal).toBe(FEE);
    expect(v.call).toMatchObject({
      bridge: "across",
      receiver: OWNER,
      bridged: BRIDGED,
      destinationChainId: p.destination,
      hasSourceSwaps: true,
      hasDestinationCall: false,
    });
    expect(v.costBps).toBeLessThanOrEqual(300);
    // upper-case hex is not the canonical (lower-case) encoding: refused, never re-interpreted
    expect(problems(id, data.toUpperCase().replace("0X", "0x"))).toEqual([
      "BRIDGE_CALLDATA_NOT_CANONICAL",
    ]);
  });
  it("non-canonical bytes are refused: a planted word, a relocated offset, truncation, odd length, another selector", () => {
    const data = encodeBridge(honestParts(id, NOW_SEC));
    for (const bad of [
      data + "00".repeat(32),
      data.slice(0, -64),
      data.slice(0, -2),
      // the first head word (the offset of BridgeData) moved by one word
      data.slice(0, 10) +
        w(BigInt("0x" + data.slice(10, 74)) + 32n) +
        data.slice(74),
      "0xdeadbeef" + data.slice(10),
      "0x1794958f",
      "",
      null,
      42,
    ])
      expect(problems(id, bad)).toEqual(["BRIDGE_CALLDATA_NOT_CANONICAL"]);
    expect(decodeBridgeCall(data + "00".repeat(32))).toBeNull();
  });
  it("the fee step's own calldata must be exact too (a planted word inside it -> BRIDGE_FEE_CALL_NOT_CANONICAL)", () => {
    const parts = honestParts(id, NOW_SEC);
    parts.steps[0].callData = (parts.steps[0].callData +
      "00".repeat(32)) as Hex;
    expect(problems(id, encodeBridge(parts))).toContain(
      "BRIDGE_FEE_CALL_NOT_CANONICAL",
    );
    const parts2 = honestParts(id, NOW_SEC);
    parts2.steps[0].callData = ("0xa9059cbb" +
      parts2.steps[0].callData.slice(10)) as Hex;
    expect(problems(id, encodeBridge(parts2))).toContain(
      "BRIDGE_FEE_CALL_NOT_CANONICAL",
    );
  });
  it("record bindings: another owner, amount, minimum or cost cap", () => {
    const data = encodeBridge(honestParts(id, NOW_SEC));
    expect(problems(id, data, { owner: OTHER })).toEqual(
      expect.arrayContaining([
        "BRIDGE_RECEIVER_NOT_OWNER",
        "ACROSS_RECEIVER_NOT_OWNER",
        "ACROSS_REFUND_NOT_OWNER",
      ]),
    );
    expect(problems(id, data, { exactAmount: AMOUNT + 1n })).toEqual(
      expect.arrayContaining([
        "BRIDGE_INPUT_NOT_EXACT",
        "BRIDGE_FEE_ARITHMETIC",
      ]),
    );
    const eff = effectiveOf(honestParts(id, NOW_SEC));
    expect(problems(id, data, { minimumOut: eff + 1n })).toContain(
      "BRIDGE_OUTPUT_BELOW_MINIMUM",
    );
    expect(problems(id, data, { minimumOut: eff })).toEqual([]);
    expect(problems(id, data, { maxCostBps: 301 })).toContain(
      "BRIDGE_COST_ABOVE_CAP",
    );
    expect(problems(id, data, { maxCostBps: 1.5 })).toContain(
      "BRIDGE_COST_ABOVE_CAP",
    );
  });
  it("time bindings: the quote timestamp +/- 9 min (signer v5 10 min less a 60 s margin) and the fill window 30 min - 6 h, from the review time", () => {
    const at = (f: (x: ReturnType<typeof honestParts>) => void) => {
      const x = honestParts(id, NOW_SEC);
      f(x);
      return problems(id, encodeBridge(x));
    };
    expect(at((x) => void (x.across.quoteTimestamp = NOW_SEC - 540))).toEqual(
      [],
    );
    expect(at((x) => void (x.across.quoteTimestamp = NOW_SEC + 540))).toEqual(
      [],
    );
    expect(at((x) => void (x.across.quoteTimestamp = NOW_SEC - 541))).toContain(
      "BRIDGE_QUOTE_TIMESTAMP_SKEW",
    );
    expect(at((x) => void (x.across.fillDeadline = NOW_SEC + 1800))).toEqual(
      [],
    );
    expect(at((x) => void (x.across.fillDeadline = NOW_SEC + 21_600))).toEqual(
      [],
    );
    expect(at((x) => void (x.across.fillDeadline = NOW_SEC - 1))).toContain(
      "BRIDGE_FILL_DEADLINE_WINDOW",
    );
    expect(
      at((x) => {
        x.across.exclusivityParameter = 300;
        x.across.exclusiveRelayer = b32(OTHER);
      }),
    ).toEqual([]);
  });
  it("the approve: exactly approve(Diamond, amount) on canonical bytes", () => {
    const a = bridgeApproveCalldata(p.exactAmount);
    expect(a).toBe(
      "0x095ea7b3" +
        w("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE") +
        w(p.exactAmount),
    );
    expect(bridgeApproveProblem(a, p.exactAmount)).toBeNull();
    expect(bridgeApproveProblem(a, p.exactAmount + 1n)).toBe(
      "APPROVE_NOT_EXACT_AMOUNT",
    );
    expect(
      bridgeApproveProblem(
        "0x095ea7b3" + w(OTHER) + w(p.exactAmount),
        p.exactAmount,
      ),
    ).toBe("APPROVE_SPENDER_NOT_DIAMOND");
    // dirty upper bytes in the address word are not canonical
    expect(
      bridgeApproveProblem(
        "0x095ea7b3" +
          "ff" +
          w("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE").slice(2) +
          w(p.exactAmount),
        p.exactAmount,
      ),
    ).toBe("APPROVE_CALLDATA_NOT_CANONICAL");
    expect(bridgeApproveProblem(a + "00", p.exactAmount)).toBe(
      "APPROVE_CALLDATA_NOT_CANONICAL",
    );
  });
  it("the quote itself: the honest quote passes; every own fact is checked", () => {
    const q = quoteOf(id, honestParts(id, NOW_SEC));
    const v = bridgeQuoteProblems(p, q, OWNER);
    expect(v.problems).toEqual([]);
    expect(v.data).toBe(q.transactionRequest.data.toLowerCase());
    expect(v.gasLimit).toBe(0x47c8an);
    const bad = (f: (x: Record<string, Record<string, unknown>>) => void) => {
      const x = structuredClone(q) as unknown as Record<
        string,
        Record<string, unknown>
      >;
      f(x);
      return bridgeQuoteProblems(p, x, OWNER).problems;
    };
    expect(bad((x) => void (x.action.fromChainId = 999))).toContain(
      "QUOTE_ACTION_CHAINS",
    );
    expect(
      bad((x) => void (x.action.toToken = { address: S.usdc.address })),
    ).toContain("QUOTE_ACTION_TOKENS");
    expect(bad((x) => void (x.action.toAddress = OTHER))).toContain(
      "QUOTE_ACTION_ADDRESSES",
    );
    expect(bad((x) => void (x.estimate.fromAmount = "4999999"))).toContain(
      "QUOTE_AMOUNT_NOT_EXACT",
    );
    expect(bad((x) => void (x.estimate.toAmountMin = "1.5"))).toContain(
      "QUOTE_MINIMUM_UNREADABLE",
    );
    expect(
      bad((x) => void (x.transactionRequest.gasLimit = undefined)),
    ).toContain("QUOTE_GAS_LIMIT_UNBOUNDED");
    expect(bad((x) => void (x.transactionRequest.gasLimit = "0x0"))).toContain(
      "QUOTE_GAS_LIMIT_UNBOUNDED",
    );
    expect(
      bad((x) => void delete (x as Record<string, unknown>).transactionRequest),
    ).toEqual(["QUOTE_SHAPE"]);
    for (const junk of [
      null,
      [],
      "quote",
      1,
      Object.create({ tool: "across" }),
    ])
      expect(bridgeQuoteProblems(p, junk, OWNER).problems).toEqual([
        "QUOTE_SHAPE",
      ]);
    void D;
  });
});

describe("blocked and unknown pairs", () => {
  it("a BNB pair still decodes (its table exists) but binds against 18-decimal USDC; the lane never reaches it", () => {
    const p = pairById("bridge-56-8453")!;
    expect(p.status).toBe("BLOCKED");
    expect(p.exactAmount).toBe(5n * 10n ** 18n);
    expect(BRIDGE_LANE_PAIRS["bridge-8453-56"].minimumOut).toBe(
      49n * 10n ** 17n,
    );
  });
  it("the fee recipient and FeeCollector are the pinned ones", () => {
    const parts = honestParts("bridge-1-10", NOW_SEC);
    parts.steps[0].callData = feeCall(BRIDGE_LANE_CHAINS["1"].usdc.address, [
      { recipient: getAddress(FEE_RECIPIENT), amount: FEE },
    ]);
    expect(problems("bridge-1-10", encodeBridge(parts))).toEqual([]);
  });
});

const EVIDENCE = "D:/vnd/hk1/mc1/evidence/B-matrix/E-bridge-sims.json";
describe.skipIf(!existsSync(EVIDENCE))(
  "the REAL LI.FI calldata of the evidence (E-bridge-sims.json)",
  () => {
    const ev = existsSync(EVIDENCE)
      ? (JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
          pairs: Record<
            string,
            {
              holder: string;
              tx: { data: string; to: string };
              verdict: string;
            }
          >;
        })
      : { pairs: {} };
    it.each(ENABLED_PAIR_IDS)(
      "%s: decodes exactly and binds with its holder as the owner",
      (id) => {
        const e = ev.pairs[id.slice(7)];
        expect(e.verdict).toBe("PASS");
        const call = decodeBridgeCall(e.tx.data)!;
        expect(call).not.toBeNull();
        const v = bridgeCallProblems(
          pairById(id)!,
          e.tx.data,
          bind(id, {
            owner: e.holder,
            nowSec: call.across.quoteTimestamp + 60,
          }),
        );
        expect(v.problems).toEqual([]);
        expect(v.feeTotal).toBe(12_500n);
        expect(v.call!.integrator).toBe("lifi-api");
        expect(e.tx.to.toLowerCase()).toBe(
          "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
        );
      },
    );
    it("the BNB evidence pairs bind against 18 decimals but stay BLOCKED in the lane", () => {
      for (const k of Object.keys(ev.pairs).filter((k) => k.includes("56"))) {
        expect(pairById(`bridge-${k}`)!.status).toBe("BLOCKED");
      }
    });
  },
);
