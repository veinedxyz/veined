// VEINED-MC1 lanes review ROUND 2, NEW-5 (the MINOR-4 residue, LANES_REVIEW_R2.md): the lanes accept a source receipt
// exactly where signer v5 receiptVerdict (D:/vnd/hk1/mc1/signer/policy-v5.mjs, read only) decides MINED — its quantity
// rule (no leading zeros) for every quantity and both heads, the operator-fee fields compared RAW across the operators
// (absent and null differ), the L1 fee a strict quantity, and the block hash compared raw. Each tampered receipt below
// was accepted as final by the round-2 lanes; now neither lane counts it, and the signer's own verdict on the very same
// answers is not MINED either. SYNTHETIC_TEST_ONLY: fakes only, no network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  BASE_ROUTE,
  OWNER,
  OWNER_KEY as SWAP_KEY,
  lane,
} from "./swap-lane-fake";
import {
  bridgeLane,
  settleSource,
  step as bridgeStep,
} from "./bridge-lane-fake";
import {
  SIGNER_QUANTITY,
  isQuantity,
  strictReceiptProblem,
} from "../../src/swap/lane/receipts";

vi.mock("../../src/swap/lane/pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/pins")>();
  const { fakeCodePinModule } = await import("./swap-lane-pin-mock");
  return fakeCodePinModule(real);
});
vi.mock("../../src/swap/lane/bridge-pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/bridge-pins")>();
  const { fakeBridgePinModule } = await import("./bridge-lane-pin-mock");
  return fakeBridgePinModule(real);
});

let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});
afterEach(() => {
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

const SIGNER = "D:/vnd/hk1/mc1/signer";
const haveSigner = existsSync(`${SIGNER}/policy-v5.mjs`);
type Verdict = { state: string };
const receiptVerdict = async (
  ...a: [string, unknown[], unknown[], unknown[], Record<string, string>]
) =>
  (
    (await import(pathToFileURL(`${SIGNER}/policy-v5.mjs`).href)) as {
      receiptVerdict: (...x: unknown[]) => Verdict;
    }
  ).receiptVerdict(...a);

type R = Record<string, unknown>;
type Tamper = (op: 0 | 1, method: string, honest: unknown) => unknown;
const zero = (q: unknown) => "0x0" + String(q).slice(2);
const upper = (h: unknown) => "0x" + String(h).slice(2).toUpperCase();
/** What each operator answered to the one receipt, the heads and the block read of the first step's track. */
function recorder(tamper: Tamper) {
  const seen = { r: [] as unknown[], h: [] as unknown[], at: [] as unknown[] };
  const hook = (
    op: 0 | 1,
    m: string,
    _p: readonly unknown[],
    honest: unknown,
  ) => {
    const v = tamper(op, m, honest);
    const out = v === undefined ? honest : v;
    if (m === "eth_getTransactionReceipt" && seen.r[op] === undefined)
      seen.r[op] = out;
    if (
      m === "eth_blockNumber" &&
      seen.r[op] !== undefined &&
      seen.h[op] === undefined
    )
      seen.h[op] = out;
    if (
      m === "eth_getBlockByNumber" &&
      seen.r[op] !== undefined &&
      seen.at[op] === undefined
    )
      seen.at[op] = out;
    return v;
  };
  return { seen, hook };
}
async function swapAfter(tamper: Tamper) {
  const S = lane();
  const out = await S.engine.dispatch(
    S.engine.authorize((await S.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
    SWAP_KEY,
  );
  S.chain.mine();
  S.chain.advance(BASE_ROUTE.confirmations);
  const { seen, hook } = recorder(tamper);
  S.chain.tamper = hook;
  const tr = await S.engine.track();
  return {
    state: (tr.steps.APPROVE as { state: string }).state,
    final: S.store.of("RECEIPT").length,
    seen,
    expect: {
      hash: out.hash!,
      from: OWNER,
      to: BASE_ROUTE.pay.address.toLowerCase(),
    },
  };
}
async function bridgeAfter(tamper: Tamper) {
  const B = bridgeLane();
  const { d } = await bridgeStep(B);
  settleSource(B);
  const { seen, hook } = recorder(tamper);
  B.src.tamper = hook;
  const tr = await B.engine.track();
  return {
    state: (tr.steps.APPROVE as { state: string }).state,
    final: B.store.of("RECEIPT").length,
    seen,
    expect: {
      hash: d.hash!,
      from: OWNER,
      to: B.src.chain.usdc.address.toLowerCase(),
    },
  };
}
const onReceipt =
  (op: 0 | 1 | "both", edit: (r: R) => R): Tamper =>
  (o, m, honest) =>
    m === "eth_getTransactionReceipt" && honest && (op === "both" || op === o)
      ? edit(honest as R)
      : undefined;

describe("NEW-5: the pure rules", () => {
  it("the signer's quantity rule: 0x, no leading zeros, at most 64 digits", () => {
    expect(SIGNER_QUANTITY.source).toBe("^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$");
    for (const q of ["0x0", "0x1", "0x5208", "0xAbC", "0x" + "f".repeat(64)])
      expect(isQuantity(q), q).toBe(true);
    for (const q of [
      "0x",
      "0x00",
      "0x01",
      "0x0001",
      "1",
      "0x" + "f".repeat(65),
      1,
      null,
    ])
      expect(isQuantity(q), String(q)).toBe(false);
  });
  it("leading zeros and malformed heads are RECEIPT_MALFORMED", () => {
    const ok = {
      transactionHash: "0xab",
      status: "0x1",
      blockNumber: "0x10",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
    };
    expect(
      strictReceiptProblem(ok, "0xab", false, ["0x20", "0x21"]),
    ).toBeNull();
    for (const k of ["blockNumber", "gasUsed", "effectiveGasPrice"])
      expect(
        strictReceiptProblem({ ...ok, [k]: zero((ok as R)[k]) }, "0xab", false),
        k,
      ).toBe("RECEIPT_MALFORMED");
    for (const h of [["0x020", "0x21"], ["0x20", null], ["0x20"]])
      expect(strictReceiptProblem(ok, "0xab", false, h), String(h)).toBe(
        "RECEIPT_MALFORMED",
      );
    expect(
      strictReceiptProblem({ ...ok, operatorFeeScalar: "0x00" }, "0xab", true),
    ).toBe("RECEIPT_OPERATOR_FEE_UNPROVEN");
  });
});

describe.each([
  ["swap (Base, OP-stack)", swapAfter],
  ["bridge (Base source, OP-stack)", bridgeAfter],
] as const)("NEW-5 end to end, %s", (_lane, after) => {
  it("control: the honest answers are final for the lane AND mined for the signer", async () => {
    const x = await after(() => undefined);
    expect(x.state).toBe("FINAL_SUCCESS");
    expect(x.final).toBe(1);
    if (haveSigner)
      expect(
        (await receiptVerdict("8453", x.seen.r, x.seen.h, x.seen.at, x.expect))
          .state,
      ).toBe("MINED");
  });
  it("control: operatorFeeConstant null on BOTH operators is accepted by both (null === null)", async () => {
    const x = await after(
      onReceipt("both", (r) => ({ ...r, operatorFeeConstant: null })),
    );
    expect(x.state).toBe("FINAL_SUCCESS");
    if (haveSigner)
      expect(
        (await receiptVerdict("8453", x.seen.r, x.seen.h, x.seen.at, x.expect))
          .state,
      ).toBe("MINED");
  });
  it.each([
    [
      "blockNumber with a leading zero (both operators)",
      onReceipt("both", (r) => ({ ...r, blockNumber: zero(r.blockNumber) })),
      "RECEIPT_MALFORMED",
      "RECEIPT_MALFORMED",
    ],
    [
      "gasUsed with a leading zero (both operators)",
      onReceipt("both", (r) => ({ ...r, gasUsed: zero(r.gasUsed) })),
      "RECEIPT_MALFORMED",
      "RECEIPT_MALFORMED",
    ],
    [
      "effectiveGasPrice with a leading zero (both operators)",
      onReceipt("both", (r) => ({
        ...r,
        effectiveGasPrice: zero(r.effectiveGasPrice),
      })),
      "RECEIPT_MALFORMED",
      "RECEIPT_MALFORMED",
    ],
    [
      "operatorFeeScalar absent on one operator and null on the other",
      onReceipt(1, (r) => ({ ...r, operatorFeeScalar: null })),
      "OPERATORS_DISAGREE",
      "OPERATORS_DISAGREE",
    ],
    [
      "operatorFeeConstant 0x00 on both (a zero, but not a signer quantity)",
      onReceipt("both", (r) => ({ ...r, operatorFeeConstant: "0x00" })),
      "RECEIPT_OPERATOR_FEE_UNPROVEN",
      "OPERATOR_FEE_UNPROVEN",
    ],
    [
      "l1Fee with a leading zero (both operators)",
      onReceipt("both", (r) => ({ ...r, l1Fee: zero(r.l1Fee) })),
      "RECEIPT_L1_FEE_UNPROVEN",
      "L1_FEE_UNPROVEN",
    ],
    [
      "one operator's head with a leading zero",
      ((o, m, honest) =>
        m === "eth_blockNumber" && o === 1
          ? zero(honest)
          : undefined) as Tamper,
      "RECEIPT_MALFORMED",
      "RECEIPT_MALFORMED",
    ],
    [
      "the block re-read with the receipt's hash in another letter case (both operators)",
      ((_o, m, honest) =>
        m === "eth_getBlockByNumber" && honest
          ? { ...(honest as R), hash: upper((honest as R).hash) }
          : undefined) as Tamper,
      "REORGED",
      "REORG_SUSPECTED",
    ],
  ] as const)(
    "%s -> lane %s, signer %s; nothing journaled as final",
    async (_name, tamper, laneState, signerState) => {
      const x = await after(tamper);
      expect(x.state).toBe(laneState);
      expect(x.final).toBe(0);
      if (haveSigner)
        expect(
          (
            await receiptVerdict(
              "8453",
              x.seen.r,
              x.seen.h,
              x.seen.at,
              x.expect,
            )
          ).state,
        ).toBe(signerState);
    },
  );
});
