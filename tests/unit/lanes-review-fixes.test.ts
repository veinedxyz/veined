// VEINED-MC1 lanes review fixes (D:/vnd/hk1/mc1/evidence/R-review/LANES_REVIEW.md), end to end over the fakes of BOTH
// lanes (./swap-lane-fake.ts, ./bridge-lane-fake.ts; pins mocked only in their code hashes):
//   MAJOR-1  the signer's own status (sync + status, CONTRACT-v5.md) decides BEFORE a step is spent: not ready at review,
//            refused at dispatch WITHOUT spending (SIGNER_NOT_READY:<reason>, SIGNER_PREFLIGHT journaled);
//   MINOR-1  the nonce anchor is the signer's (firstNonce + signedCount): two lanes on one account and chain no longer
//            block each other; own dispatches can never exceed the signer's signatures; record firstNonce = lower bound;
//   MINOR-4  receipts are accepted exactly as strictly as the signer's receiptVerdict;
//   MINOR-5  the lane's own CLEANUP revoke: only after a final APPROVE and a dead EXECUTE, allowance > 0, single use,
//            gate-checked, preflighted, the CLEANUP step;
//   NIT-3 / NIT-4  the OP-stack L1 fee with the real nonce; eth_chainId on both operators.
// SYNTHETIC_TEST_ONLY. Nothing here signs, sends or reaches a network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { decodeFunctionData, parseAbi, parseTransaction, type Hex } from "viem";
import {
  BASE,
  ENABLED_ROUTE_IDS,
  BASE_ROUTE,
  FIRST_NONCE,
  KEY_DIGEST as SWAP_KEY_DIGEST,
  OWNER,
  OWNER_KEY as SWAP_KEY,
  RECORD,
  handApprove,
  lane,
  type Lane,
} from "./swap-lane-fake";
import {
  OWNER_KEY as BRIDGE_KEY,
  KEY_DIGEST as BRIDGE_KEY_DIGEST,
  ENABLED_PAIR_IDS,
  FIXTURES as BRIDGE_FIXTURES,
  bridgeLane,
  recordFor as bridgeRecordFor,
  settleSource as bridgeSettle,
  step as bridgeStep,
  type BridgeLane,
} from "./bridge-lane-fake";
import { swapLaneGateState } from "../../src/swap/lane/approval";
import { bridgeLaneGateState } from "../../src/swap/lane/bridge-approval";
import {
  parseSignerStatus,
  signerPreflightProblems,
} from "../../src/swap/lane/signer-adapter";
import { strictReceiptProblem } from "../../src/swap/lane/receipts";
import {
  BRIDGE_LANE_CHAINS,
  BRIDGE_LANE_PAIRS,
} from "../../src/swap/lane/bridge-scope";

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

const lc = (a: string) => a.toLowerCase();
const err = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as Error & { code: string; detail: readonly string[] };
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

// ---- the two lanes behind one interface ------------------------------------------------------------------------------
interface AnyLane {
  name: string;
  route: string;
  key: string;
  review: () => Promise<{
    ready: boolean;
    problems: string[];
    reviewId: string;
  }>;
  authorize: (id: string) => string;
  dispatch: (t: string) => Promise<{ outcome: string }>;
  store: { of(t: string): readonly { data: unknown }[]; types(): string[] };
  signer: {
    tamperStatus: ((raw: Record<string, unknown>) => unknown) | null;
    others: {
      key: string;
      outcome: "SENT" | "REFUSED" | "UNCERTAIN";
      hash: string | null;
    }[];
    calls: unknown[];
  };
}
const swapAny = (L: Lane): AnyLane => ({
  name: "swap",
  route: BASE,
  key: SWAP_KEY,
  review: () => L.engine.review(SWAP_KEY),
  authorize: (id) => L.engine.authorize(id, SWAP_KEY),
  dispatch: (t) => L.engine.dispatch(t, SWAP_KEY),
  store: L.store,
  signer: L.signer,
});
const bridgeAny = (L: BridgeLane): AnyLane => ({
  name: "bridge",
  route: L.pairId,
  key: BRIDGE_KEY,
  review: () => L.engine.review(BRIDGE_KEY),
  authorize: (id) => L.engine.authorize(id, BRIDGE_KEY),
  dispatch: (t) => L.engine.dispatch(t, BRIDGE_KEY),
  store: L.store,
  signer: L.signer,
});
const both = () =>
  [
    ["swap", () => swapAny(lane())],
    ["bridge", () => bridgeAny(bridgeLane())],
  ] as const;

describe("MAJOR-1: the signer's status decides before anything is spent", () => {
  it.each(both())(
    "%s: a clean status reviews ready; every refusing status is named at review",
    async (_n, make) => {
      expect((await make().review()).problems).toEqual([]);
      const cases: [string, (raw: Record<string, unknown>) => unknown][] = [
        ["IN_FLIGHT", (r) => ({ ...r, inFlight: 1 })],
        ["UNCERTAIN", (r) => ({ ...r, uncertain: 1 })],
        [
          "ADDRESS_MISMATCH",
          (r) => ({ ...r, address: "0x" + "44".repeat(20) }),
        ],
        [
          "ROUTE_NOT_ENABLED",
          (r) => ({ ...r, enabledRoutes: ["eth-usdc-weth-univ3-max1"] }),
        ],
        [
          "STEP_ALREADY_SIGNED",
          (r) => ({ ...r, signed: { [`${make().route}:APPROVE`]: true } }),
        ],
        // the fake's session ends 4 h after "now": move it to 1 minute after now (< the 2-minute margin)
        [
          "SESSION_ENDING",
          (r) => ({
            ...r,
            sessionNotAfter: new Date(
              Date.parse(String(r.sessionNotAfter)) - 4 * 3_600_000 + 60_000,
            ).toISOString(),
          }),
        ],
        ["CHAIN_NOT_IN_INSTANCE", (r) => ({ ...r, chains: {} })],
        ["STATUS_UNAVAILABLE", (r) => ({ ...r, extra: 1 })],
        [
          "STATUS_UNAVAILABLE",
          () => {
            throw new Error("unreachable");
          },
        ],
      ];
      for (const [reason, tamper] of cases) {
        const A = make();
        A.signer.tamperStatus = tamper;
        const r = await A.review();
        expect(r.ready, reason).toBe(false);
        expect(r.problems, `${A.name} ${reason}`).toContain(
          `SIGNER_NOT_READY:${reason}`,
        );
      }
    },
  );
  it.each(both())(
    "%s: a status that turns bad after the review refuses the dispatch WITHOUT spending; the token survives",
    async (_n, make) => {
      const A = make();
      const r = await A.review();
      expect(r.ready).toBe(true);
      const t = A.authorize(r.reviewId);
      // another lane of the same signer now has a signature in flight
      A.signer.others = [
        {
          key: "op-usdc-weth-univ3-max1:APPROVE",
          outcome: "SENT",
          hash: "0x" + "ee".repeat(32),
        },
      ];
      const e = await err(A.dispatch(t));
      expect(e.code).toBe("SIGNER_NOT_READY");
      expect(e.detail).toEqual(["SIGNER_NOT_READY:IN_FLIGHT"]);
      expect(A.store.of("NONCE")).toHaveLength(0);
      expect(A.store.of("USE")).toHaveLength(0);
      expect(A.store.of("PREPARED")).toHaveLength(0);
      expect(A.signer.calls).toHaveLength(0);
      expect(A.store.of("SIGNER_PREFLIGHT").map((x) => x.data)).toEqual([
        expect.objectContaining({
          ok: false,
          reasons: ["IN_FLIGHT"],
          inFlight: 1,
        }),
      ]);
      // once the other signature is decided the SAME token dispatches (nothing was spent)
      A.signer.others = [];
      expect((await A.dispatch(t)).outcome).toBe("SENT");
      expect(
        A.store
          .of("SIGNER_PREFLIGHT")
          .map((x) => (x.data as { ok: boolean }).ok),
      ).toEqual([false, true]);
    },
  );
  it("the preflight's rules, pure: totals, the route, the step key, the session margin of 2 minutes", () => {
    const raw = {
      address: OWNER,
      pinsSha256: "a".repeat(64),
      sessionNotAfter: new Date(1_000_000 + 120_000).toISOString(),
      enabledRoutes: [BASE],
      chains: {
        "8453": { firstNonce: "7", signedCount: 0, inFlight: 0, uncertain: 0 },
      },
      signed: {},
      inFlight: 0,
      uncertain: 0,
    };
    const s = parseSignerStatus(raw)!;
    const want = {
      account: OWNER,
      route: BASE,
      signerStep: "APPROVE",
      chainId: "8453",
      nowMs: 1_000_000,
    };
    expect(signerPreflightProblems(s, want)).toEqual([]);
    expect(signerPreflightProblems(s, { ...want, nowMs: 1_000_001 })).toEqual([
      "SESSION_ENDING",
    ]);
    expect(signerPreflightProblems(null, want)).toEqual(["STATUS_UNAVAILABLE"]);
    // the contract's exact shape: no extra key, decimal firstNonce, counts as integers
    for (const bad of [
      { ...raw, extra: true },
      {
        ...raw,
        chains: {
          "8453": { firstNonce: 7, signedCount: 0, inFlight: 0, uncertain: 0 },
        },
      },
      {
        ...raw,
        chains: {
          "8453": {
            firstNonce: "7",
            signedCount: -1,
            inFlight: 0,
            uncertain: 0,
          },
        },
      },
      { ...raw, signed: { [`${BASE}:APPROVE`]: false } },
      { ...raw, sessionNotAfter: "tomorrow" },
      { ...raw, inFlight: "0" },
    ])
      expect(parseSignerStatus(bad)).toBeNull();
  });
});

describe("MINOR-1: the signer-authoritative nonce anchor", () => {
  it("swap: another lane's two mined signatures on the same account and chain no longer block it", async () => {
    const L = lane();
    for (const i of [1, 2]) {
      const h = L.chain.submit({
        chainId: "0x2105",
        from: OWNER,
        to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
        value: "0x0",
        data: "0x095ea7b3" + "0".repeat(127) + String(i),
        gas: "0x5208",
        maxFeePerGas: "0x1",
        maxPriorityFeePerGas: "0x1",
      });
      L.chain.mine();
      L.signer.others.push({
        key: `bridge-8453-${i === 1 ? "42161" : "10"}:APPROVE`,
        outcome: "SENT",
        hash: h,
      });
    }
    L.chain.advance(BASE_ROUTE.confirmations);
    expect(L.chain.nonceAt(L.chain.head)).toBe(FIRST_NONCE + 2n);
    const r = await L.engine.review(SWAP_KEY);
    expect(r.problems).toEqual([]);
    // the same chain activity WITHOUT the signer's knowledge (outside the signer) is never anchored
    L.signer.others = [];
    expect((await L.engine.review(SWAP_KEY)).problems).toEqual([
      "NONCE_NOT_ANCHORED_TO_JOURNAL",
    ]);
  });
  it("bridge: the same, and own SENT dispatches can never exceed the signer's signatures", async () => {
    const L = bridgeLane();
    expect((await L.engine.review(BRIDGE_KEY)).problems).toEqual([]);
    // a forged / foreign lane journal claiming a dispatch the signer never signed
    L.store.append("DISPATCH", {
      step: "APPROVE",
      outcome: "SENT",
      hash: "0x" + "ab".repeat(32),
    });
    expect((await L.engine.review(BRIDGE_KEY)).problems).toContain(
      "NONCE_NOT_ANCHORED_TO_JOURNAL",
    );
  });
  it("swap: a record armed above the chain nonce is refused (the record firstNonce is a lower bound)", async () => {
    const L = lane({
      record: { ...RECORD, firstNonce: (FIRST_NONCE + 1n).toString() },
    });
    expect((await L.engine.review(SWAP_KEY)).problems).toEqual([
      "NONCE_NOT_ANCHORED_TO_JOURNAL",
    ]);
  });
});

describe("MINOR-4: receipts exactly as strict as the signer's receiptVerdict", () => {
  it("the pure rules", () => {
    const ok = {
      transactionHash: "0xab",
      status: "0x1",
      blockNumber: "0x10",
      gasUsed: "0x5208",
      effectiveGasPrice: "0x1",
    };
    expect(strictReceiptProblem(ok, "0xAB", false)).toBeNull();
    expect(
      strictReceiptProblem({ ...ok, transactionHash: "0xcd" }, "0xab", false),
    ).toBe("RECEIPT_TX_HASH_MISMATCH");
    expect(strictReceiptProblem({ ...ok, status: "0x2" }, "0xab", false)).toBe(
      "RECEIPT_MALFORMED",
    );
    expect(
      strictReceiptProblem(
        { ...ok, effectiveGasPrice: undefined },
        "0xab",
        false,
      ),
    ).toBe("RECEIPT_MALFORMED");
    expect(
      strictReceiptProblem({ ...ok, operatorFeeScalar: "0x1" }, "0xab", true),
    ).toBe("RECEIPT_OPERATOR_FEE_UNPROVEN");
    expect(
      strictReceiptProblem({ ...ok, operatorFeeConstant: "0x5" }, "0xab", true),
    ).toBe("RECEIPT_OPERATOR_FEE_UNPROVEN");
    expect(
      strictReceiptProblem(
        { ...ok, operatorFeeScalar: "0x0", operatorFeeConstant: null },
        "0xab",
        true,
      ),
    ).toBeNull();
    // not OP-stack: the operator fee fields are ignored (as the signer ignores them)
    expect(
      strictReceiptProblem({ ...ok, operatorFeeScalar: "0x1" }, "0xab", false),
    ).toBeNull();
  });
  it.each([
    [
      "effectiveGasPrice differs between the operators",
      (o: 0 | 1, r: Record<string, unknown>) =>
        o === 1 ? { ...r, effectiveGasPrice: "0x7" } : undefined,
      "OPERATORS_DISAGREE",
    ],
    [
      "blockNumber differs between the operators",
      (o: 0 | 1, r: Record<string, unknown>) =>
        o === 1 ? { ...r, blockNumber: "0x1" } : undefined,
      "OPERATORS_DISAGREE",
    ],
    [
      "another transaction hash on both",
      (_o: 0 | 1, r: Record<string, unknown>) => ({
        ...r,
        transactionHash: "0x" + "12".repeat(32),
      }),
      "RECEIPT_TX_HASH_MISMATCH",
    ],
    [
      "a non-zero Isthmus operator fee scalar on both",
      (_o: 0 | 1, r: Record<string, unknown>) => ({
        ...r,
        operatorFeeScalar: "0x1",
      }),
      "RECEIPT_OPERATOR_FEE_UNPROVEN",
    ],
    [
      "a receipt to another target",
      (_o: 0 | 1, r: Record<string, unknown>) => ({
        ...r,
        to: "0x" + "45".repeat(20),
      }),
      "DISCREPANCY_TX",
    ],
  ] as const)(
    "swap (Base, OP-stack) and bridge: %s -> %s, nothing journaled as final",
    async (_name, tamper, state) => {
      const S = lane();
      await S.engine.dispatch(
        S.engine.authorize(
          (await S.engine.review(SWAP_KEY)).reviewId,
          SWAP_KEY,
        ),
        SWAP_KEY,
      );
      S.chain.mine();
      S.chain.advance(BASE_ROUTE.confirmations);
      S.chain.tamper = (o, m, _p, honest) =>
        m === "eth_getTransactionReceipt" && honest
          ? tamper(o, honest as Record<string, unknown>)
          : undefined;
      expect(
        ((await S.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe(state);
      expect(S.store.of("RECEIPT")).toHaveLength(0);
      const B = bridgeLane();
      await bridgeStep(B);
      bridgeSettle(B);
      B.src.tamper = (o, m, _p, honest) =>
        m === "eth_getTransactionReceipt" && honest
          ? tamper(o, honest as Record<string, unknown>)
          : undefined;
      expect(
        ((await B.engine.track()).steps.APPROVE as { state: string }).state,
      ).toBe(state);
      expect(B.store.of("RECEIPT")).toHaveLength(0);
    },
  );
});

describe("MINOR-5: the lane's own CLEANUP revoke", () => {
  async function swapRefusedAfterApprove(
    over: Parameters<typeof lane>[0] = {},
  ) {
    const L = lane(over);
    await L.engine.dispatch(
      L.engine.authorize((await L.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
      SWAP_KEY,
    );
    L.chain.mine();
    L.chain.advance(BASE_ROUTE.confirmations);
    await L.engine.track();
    L.signer.answer = () => ({
      outcome: "REFUSED",
      hash: null,
      problems: ["EARLIER_TX_UNDECIDED"],
    });
    await L.engine.dispatch(
      L.engine.authorize((await L.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
      SWAP_KEY,
    );
    L.signer.answer = (_s, tx) => ({
      outcome: "SENT",
      hash: L.chain.submit(tx),
      problems: [],
    });
    return L;
  }
  it("swap: after a refused SWAP, ONE approve(router, 0) with the CLEANUP step; single use; tracked", async () => {
    const L = await swapRefusedAfterApprove();
    expect(L.chain.allowance).toBe(1_000_000n);
    const out = await L.engine.revoke(SWAP_KEY);
    expect(out).toMatchObject({ step: "REVOKE", outcome: "SENT" });
    const c = L.signer.calls.at(-1)!;
    expect(c.step).toBe("REVOKE");
    expect(c.tx).toMatchObject({
      chainId: "0x2105",
      from: OWNER,
      to: lc(BASE_ROUTE.pay.address),
      value: "0x0",
      data: handApprove(0n),
    });
    expect(BigInt(c.tx.gas)).toBeLessThanOrEqual(BASE_ROUTE.maxGas.APPROVE);
    expect(
      L.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE", "SWAP", "REVOKE"]);
    expect(L.gateCalls.at(-1)).toMatchObject({
      open: true,
      facts: { step: "REVOKE" },
    });
    expect((await err(L.engine.revoke(SWAP_KEY))).code).toBe(
      "REVOKE_ALREADY_USED",
    );
    L.chain.mine();
    L.chain.advance(BASE_ROUTE.confirmations);
    const t = await L.engine.track();
    expect((t.steps.REVOKE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(t.allowance).toEqual({ value: "0", agree: true });
    expect(L.signer.calls).toHaveLength(3);
  });
  it("swap: refused without spending unless the SWAP is dead and an allowance is left", async () => {
    // no final APPROVE
    const A = lane();
    let e = await err(A.engine.revoke(SWAP_KEY));
    expect(e.code).toBe("REVOKE_NOT_READY");
    expect(e.detail).toEqual(
      expect.arrayContaining([
        "REVOKE_NOT_ALLOWED:APPROVE_NOT_FINAL",
        "REVOKE_NOT_ALLOWED:SWAP_NOT_DECIDED_FAILED",
      ]),
    );
    expect(A.store.of("USE")).toHaveLength(0);
    // APPROVE final, SWAP never dispatched, the record window still open -> not yet
    const B = lane();
    await B.engine.dispatch(
      B.engine.authorize((await B.engine.review(SWAP_KEY)).reviewId, SWAP_KEY),
      SWAP_KEY,
    );
    B.chain.mine();
    B.chain.advance(BASE_ROUTE.confirmations);
    await B.engine.track();
    e = await err(B.engine.revoke(SWAP_KEY));
    expect(e.detail).toEqual(["REVOKE_NOT_ALLOWED:SWAP_NOT_DECIDED_FAILED"]);
    expect(
      B.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE"]);
    // ... after the record window it is allowed (the SWAP was never dispatched within the window)
    B.clock.t = RECORD.notAfter + 1;
    expect(await B.engine.revoke(SWAP_KEY)).toMatchObject({
      step: "REVOKE",
      outcome: "SENT",
    });
    // the allowance already gone -> REVOKE_NOT_NEEDED
    const C = await swapRefusedAfterApprove();
    C.chain.allowance = 0n;
    e = await err(C.engine.revoke(SWAP_KEY));
    expect(e.detail).toContain("REVOKE_NOT_NEEDED");
    // a closed gate spends nothing
    const G = await swapRefusedAfterApprove({
      gate: (f) =>
        swapLaneGateState(f, RECORD, SWAP_KEY_DIGEST, f?.step !== "REVOKE"),
    });
    e = await err(G.engine.revoke(SWAP_KEY));
    expect(e.code).toBe("SWAP_LANE_GATE_CLOSED");
    expect(
      G.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE", "SWAP"]);
    // a refusing signer status spends nothing
    const D = await swapRefusedAfterApprove();
    D.signer.tamperStatus = (r) => ({ ...r, uncertain: 1 });
    e = await err(D.engine.revoke(SWAP_KEY));
    expect(e.detail).toContain("SIGNER_NOT_READY:UNCERTAIN");
    expect(
      D.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE", "SWAP"]);
  });
  it("bridge: after a refused EXECUTE, ONE approve(Diamond, 0); refused while another pair of this chain still needs the allowance", async () => {
    const L = bridgeLane();
    await bridgeStep(L);
    bridgeSettle(L);
    await L.engine.track();
    L.signer.answer = () => ({
      outcome: "REFUSED",
      hash: null,
      problems: ["EARLIER_TX_UNDECIDED"],
    });
    await bridgeStep(L);
    L.signer.answer = (_s, tx) => ({
      outcome: "SENT",
      hash: L.src.submit(tx),
      problems: [],
    });
    // another pair from Base approved and neither executed nor revoked: the shared Diamond allowance is not ours to clear
    L.signer.tamperStatus = (r) => ({
      ...r,
      signed: { ...(r.signed as object), "bridge-8453-10:APPROVE": true },
    });
    const e = await err(L.engine.revoke(BRIDGE_KEY));
    expect(e.code).toBe("REVOKE_NOT_READY");
    expect(e.detail).toContain(
      "SIGNER_NOT_READY:REVOKE_WOULD_CLEAR_OTHER_ROUTE",
    );
    expect(
      L.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE", "EXECUTE"]);
    L.signer.tamperStatus = null;
    const out = await L.engine.revoke(BRIDGE_KEY);
    expect(out).toMatchObject({ step: "REVOKE", outcome: "SENT" });
    expect(L.signer.calls.at(-1)).toMatchObject({
      step: "REVOKE",
      tx: {
        to: lc(L.src.chain.usdc.address),
        data:
          "0x095ea7b3" +
          "0".repeat(24) +
          "1231deb6f5749ef6ce6943a275a1d3e7486f4eae" +
          "0".repeat(64),
      },
    });
    expect((await err(L.engine.revoke(BRIDGE_KEY))).code).toBe(
      "REVOKE_ALREADY_USED",
    );
  });
  it("bridge: refused before a final APPROVE; a closed gate refuses the revoke without spending", async () => {
    const A = bridgeLane();
    const e0 = await err(A.engine.revoke(BRIDGE_KEY));
    expect(e0.code).toBe("REVOKE_NOT_READY");
    expect(e0.detail).toEqual(
      expect.arrayContaining([
        "REVOKE_NOT_ALLOWED:APPROVE_NOT_FINAL",
        "REVOKE_NOT_ALLOWED:EXECUTE_NOT_DECIDED_FAILED",
      ]),
    );
    expect(A.store.of("USE")).toHaveLength(0);
    const record = bridgeRecordFor("bridge-8453-42161");
    const L = bridgeLane({
      gate: (f) =>
        bridgeLaneGateState(f, record, BRIDGE_KEY_DIGEST, f?.step !== "REVOKE"),
    });
    await bridgeStep(L);
    bridgeSettle(L);
    await L.engine.track();
    L.signer.answer = () => ({
      outcome: "REFUSED",
      hash: null,
      problems: ["EARLIER_TX_UNDECIDED"],
    });
    await bridgeStep(L);
    const e = await err(L.engine.revoke(BRIDGE_KEY));
    expect(e.code).toBe("BRIDGE_LANE_GATE_CLOSED");
    expect(
      L.store.of("USE").map((x) => (x.data as { step: string }).step),
    ).toEqual(["APPROVE", "EXECUTE"]);
    expect(L.signer.calls.map((c) => c.step)).toEqual(["APPROVE", "EXECUTE"]);
  });
});

describe("NIT-3 / NIT-4", () => {
  it("swap and bridge: an operator on another chain -> OPERATOR_CHAIN_ID_MISMATCH (bridge: either side)", async () => {
    const S = lane();
    S.chain.tamper = (o, m) =>
      o === 1 && m === "eth_chainId" ? "0x1" : undefined;
    expect((await S.engine.review(SWAP_KEY)).problems).toContain(
      "OPERATOR_CHAIN_ID_MISMATCH",
    );
    const B = bridgeLane();
    B.src.tamper = (o, m) =>
      o === 0 && m === "eth_chainId" ? "0xa" : undefined;
    expect((await B.engine.review(BRIDGE_KEY)).problems).toContain(
      "OPERATOR_CHAIN_ID_MISMATCH",
    );
    const D = bridgeLane();
    D.dst.tamper = (o, m) =>
      o === 1 && m === "eth_chainId" ? "0x2105" : undefined;
    expect((await D.engine.review(BRIDGE_KEY)).problems).toContain(
      "DESTINATION_OPERATOR_CHAIN_ID_MISMATCH",
    );
  });
  it("swap and bridge: the OP-stack L1 fee is read for the transaction serialized with the REAL (anchored) nonce", async () => {
    const ORACLE = parseAbi([
      "function getL1Fee(bytes) view returns (uint256)",
    ]);
    const nonces = (log: { method: string; params: readonly unknown[] }[]) =>
      log
        .filter(
          (x) =>
            x.method === "eth_call" &&
            (x.params[0] as { data: string }).data.startsWith("0x49948e0e"),
        )
        .map(
          (x) =>
            parseTransaction(
              decodeFunctionData({
                abi: ORACLE,
                data: (x.params[0] as { data: Hex }).data,
              }).args[0],
            ).nonce,
        );
    const S = lane();
    await S.engine.review(SWAP_KEY);
    expect([...new Set(nonces(S.chain.log))]).toEqual([Number(FIRST_NONCE)]);
    const B = bridgeLane();
    await B.engine.review(BRIDGE_KEY);
    // APPROVE then EXECUTE: two consecutive nonces
    expect([...new Set(nonces(B.src.log))].sort()).toEqual([11, 12]);
  });
});

// ---- MINOR-5 against the signer itself: the lanes' REAL revoke bytes + the adapter's CLEANUP declaration ---------------
// judged by signer v5's own pure policy (D:/vnd/hk1/mc1/signer/policy-v5.mjs check(), its offline fixtures, injected
// reads; no key, no network). Skipped when the read-only signer tree is not on this machine.
const SIGNER = "D:/vnd/hk1/mc1/signer";
const haveSigner =
  existsSync(`${SIGNER}/policy-v5.mjs`) &&
  existsSync(`${SIGNER}/fixtures-v5.mjs`);
interface SignerFixtures {
  P: {
    ROUTES: Record<
      string,
      { id: string; chainId: number; exactAmount?: bigint; maxAmount?: bigint }
    >;
    validateInstance: (raw: unknown) => {
      ok: boolean;
      problems: string[];
      instance: unknown;
    };
    check: (
      tx: unknown,
      ctx: unknown,
    ) => { ok: boolean; problems: string[]; lane?: string; step?: string };
  };
  instanceRaw: (o: { routes: string[] }) => Record<string, unknown>;
  FIRST_NONCE: Record<number, number>;
  reads: (
    route: unknown,
    o: Record<string, unknown>,
  ) => Record<string, unknown>;
  afterApprove: (route: unknown) => unknown;
  pair: (v: unknown) => [string, string];
  honestNonces: (inst: unknown, j: unknown) => unknown;
}
const loadSigner = async () =>
  (await import(
    pathToFileURL(`${SIGNER}/fixtures-v5.mjs`).href
  )) as SignerFixtures;
describe.skipIf(!haveSigner)(
  "MINOR-5: signer v5 accepts exactly the lanes' CLEANUP revoke",
  () => {
    const judge = async (
      id: string,
      tx: unknown,
      declared: Record<string, string>,
      o: {
        amount: bigint;
        gas: bigint;
        baseFee: bigint;
        l1?: bigint;
        headSkew?: number;
      },
    ) => {
      const F = await loadSigner();
      const route = F.P.ROUTES[id];
      const v = F.P.validateInstance({
        ...F.instanceRaw({ routes: [id] }),
        burner: OWNER,
      });
      expect(v.problems).toEqual([]);
      const j = F.afterApprove(route);
      return F.P.check(tx, {
        now: Date.UTC(2026, 10, 16, 12, 0, 0),
        instance: v.instance,
        journal: j,
        chainNonces: F.honestNonces(v.instance, j),
        declared,
        reads: F.reads(route, {
          nonce: F.FIRST_NONCE[route.chainId] + 1,
          allow: o.amount,
          baseFee: o.baseFee,
          blockAgeSec: 2,
          headSkew: o.headSkew ?? 1,
          l1: o.l1,
          estimate: F.pair(o.gas),
          arbL1: F.pair(o.gas / 4n),
        }),
      });
    };
    it.each(ENABLED_ROUTE_IDS)(
      "swap %s: approve(router, 0) declared {lane: CLEANUP, route, step: REVOKE} passes",
      async (id) => {
        const L = lane({ route: id });
        await L.engine.dispatch(
          L.engine.authorize(
            (await L.engine.review(SWAP_KEY)).reviewId,
            SWAP_KEY,
          ),
          SWAP_KEY,
        );
        L.chain.mine();
        L.chain.advance(L.chain.route.confirmations);
        await L.engine.track();
        L.signer.answer = () => ({
          outcome: "REFUSED",
          hash: null,
          problems: ["EARLIER_TX_UNDECIDED"],
        });
        await L.engine.dispatch(
          L.engine.authorize(
            (await L.engine.review(SWAP_KEY)).reviewId,
            SWAP_KEY,
          ),
          SWAP_KEY,
        );
        L.signer.answer = (_s, tx) => ({
          outcome: "SENT",
          hash: L.chain.submit(tx),
          problems: [],
        });
        expect(await L.engine.revoke(SWAP_KEY)).toMatchObject({
          outcome: "SENT",
        });
        const c = L.signer.calls.at(-1)!;
        expect(c.step).toBe("REVOKE");
        const o = {
          amount: L.chain.route.maxAmount,
          gas: L.chain.gas.APPROVE + L.chain.l1Gas.APPROVE,
          baseFee: L.chain.baseFee,
          l1: L.chain.route.feeModel === "OP_STACK" ? L.chain.l1Fee : undefined,
        };
        const ok = await judge(
          id,
          c.tx,
          { lane: "CLEANUP", route: id, step: "REVOKE" },
          o,
        );
        expect(ok.problems, id).toEqual([]);
        expect(ok).toMatchObject({ ok: true, lane: "CLEANUP", step: "REVOKE" });
        // the same bytes under the lane's own declaration are refused (the signer classifies a zero approve as CLEANUP)
        expect(
          (
            await judge(
              id,
              c.tx,
              { lane: "SWAP", route: id, step: "APPROVE" },
              o,
            )
          ).problems,
        ).toContain("DECLARED_STEP_MISMATCH");
      },
    );
    it.each(ENABLED_PAIR_IDS)(
      "bridge %s: approve(Diamond, 0) declared {lane: CLEANUP, route, step: REVOKE} passes",
      async (id) => {
        const L = bridgeLane({ pair: id });
        await bridgeStep(L);
        bridgeSettle(L);
        await L.engine.track();
        L.signer.answer = () => ({
          outcome: "REFUSED",
          hash: null,
          problems: ["EARLIER_TX_UNDECIDED"],
        });
        await bridgeStep(L);
        L.signer.answer = (_s, tx) => ({
          outcome: "SENT",
          hash: L.src.submit(tx),
          problems: [],
        });
        expect(await L.engine.revoke(BRIDGE_KEY)).toMatchObject({
          outcome: "SENT",
        });
        const c = L.signer.calls.at(-1)!;
        expect(c.step).toBe("REVOKE");
        const src = BRIDGE_LANE_PAIRS[id].source;
        const S = BRIDGE_LANE_CHAINS[src];
        const f = BRIDGE_FIXTURES[src];
        const o = {
          amount: BRIDGE_LANE_PAIRS[id].exactAmount,
          gas: L.src.gas.APPROVE + L.src.l1Gas.APPROVE,
          baseFee: f.baseFee,
          l1: S.feeModel === "OP_STACK" ? f.l1Fee : undefined,
          headSkew: S.maxHeadSkewBlocks,
        };
        const ok = await judge(
          id,
          c.tx,
          { lane: "CLEANUP", route: id, step: "REVOKE" },
          o,
        );
        expect(ok.problems, id).toEqual([]);
        expect(ok).toMatchObject({ ok: true, lane: "CLEANUP", step: "REVOKE" });
        expect(
          (
            await judge(
              id,
              c.tx,
              { lane: "BRIDGE", route: id, step: "REVOKE" },
              o,
            )
          ).problems,
        ).toContain("DECLARED_STEP_MISMATCH");
      },
    );
  },
);
