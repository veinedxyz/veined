// VEINED-MC1 lanes review ROUND 2 (D:/vnd/hk1/mc1/evidence/R-review/LANES_REVIEW_R2.md), the concurrency findings,
// reproduced with the reviewer's own probes (temp/review-lanes-r2/probes/race.probe.ts, race2.probe.ts, slow.probe.ts)
// over the fakes of BOTH lanes, and shown closed:
//   NEW-1   ONE process-wide dispatch lock (src/swap/lane/dispatch-lock.ts) shared by both engines: a double dispatch of
//           one token, two tokens of one step, two revokes, a dispatch and a revoke of one record -> exactly ONE
//           hand-off, the second refused at once (DISPATCH_IN_PROGRESS) before the signer, the recorded outcome the
//           real one; a swap dispatch and a bridge dispatch at the same moment SERIALIZE, so the second one's
//           preflight sees the first one in flight and refuses WITHOUT spending (round-1 MAJOR-1 scenario 1).
//           Defence in depth: after the preflight await everything single use is re-checked (DISPATCH_DUPLICATE),
//           and a refusal never shadows a SENT / UNCERTAIN / mined step.
//   NEW-2   the review / token freshness is re-checked AFTER the preflight await: a slow preflight longer than the
//           20 s window spends nothing (TOKEN_EXPIRED / REVIEW_EXPIRED, detail AFTER_SIGNER_PREFLIGHT).
// SYNTHETIC_TEST_ONLY. Nothing here signs, sends or reaches a network (fetch is spied and must stay untouched).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BASE,
  BASE_ROUTE,
  OWNER,
  OWNER_KEY as SWAP_KEY,
  RECORD,
  lane,
  type Lane,
} from "./swap-lane-fake";
import {
  OWNER_KEY as BRIDGE_KEY,
  bridgeLane,
  recordFor as bridgeRecordFor,
  settleSource,
  step as bridgeStep,
  type BridgeLane,
} from "./bridge-lane-fake";
import type { LaneSignerResult } from "../../src/swap/lane/signer-adapter";
import { SWAP_LANE_SCOPE } from "../../src/swap/lane/scope";
import { BRIDGE_LANE_SCOPE } from "../../src/swap/lane/bridge-scope";
import {
  laneDispatchPending,
  withLaneDispatchLock,
} from "../../src/swap/lane/dispatch-lock";

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const codeOf = (x: PromiseSettledResult<unknown>) =>
  x.status === "fulfilled"
    ? `OK:${(x.value as { outcome: string }).outcome}`
    : `THROW:${(x.reason as { code?: string }).code}`;
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { code: string; detail: readonly string[] };
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
const datas = (
  store: { of(t: string): readonly { data: unknown }[] },
  t: string,
) => store.of(t).map((e) => e.data as Record<string, unknown>);
const dispatchesOf = (store: { of(t: string): readonly { data: unknown }[] }) =>
  datas(store, "DISPATCH").map((d) => `${d.step}:${d.outcome}`);
/** The parts of either engine and either fake signer a test drives through one interface. */
interface SomeEngine {
  review(k: string): Promise<{ reviewId: string; expiresAt: number }>;
  authorize(id: string, k: string): string;
  dispatch(t: string, k: string): Promise<{ outcome: string }>;
  revoke(k: string): Promise<unknown>;
}
interface SomeSigner {
  status(): Promise<unknown>;
  calls: { step: string }[];
}
const tokenId = (t: string) =>
  (JSON.parse(Buffer.from(t, "base64url").toString("utf8")) as { id: string })
    .id;

/**
 * The signer as v5 answers (CONTRACT-v5.md 1 and 3): one request at a time, in arrival order; a (route, step) signed
 * once is refused for ever; nothing is signed while an earlier signature is undecided. Exactly the reviewer's probe
 * signer (v5Like / race2), shared by both lanes when both lanes use it.
 */
function signerV5() {
  const signed = new Set<string>();
  let undecided = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const handOffs: string[] = [];
  return {
    handOffs,
    decideAll() {
      undecided = 0;
    },
    answer(key: string, submit: () => string): Promise<LaneSignerResult> {
      handOffs.push(key);
      const run = queue.then(async (): Promise<LaneSignerResult> => {
        await sleep(5);
        if (signed.has(key))
          return {
            outcome: "REFUSED",
            hash: null,
            problems: ["STEP_ALREADY_SIGNED_ONCE"],
          };
        if (undecided > 0)
          return {
            outcome: "REFUSED",
            hash: null,
            problems: ["EARLIER_TX_UNDECIDED"],
          };
        signed.add(key);
        undecided++;
        return { outcome: "SENT", hash: submit(), problems: [] };
      });
      queue = run.then(() => undefined);
      return run;
    },
  };
}
const swapOnV5 = (L: Lane, v5 = signerV5()) => {
  L.signer.answer = (step, tx) =>
    v5.answer(`${BASE}:${step === "SWAP" ? "EXECUTE" : step}`, () =>
      L.chain.submit(tx),
    );
  return v5;
};
const bridgeOnV5 = (L: BridgeLane, v5 = signerV5()) => {
  L.signer.answer = (step, tx) =>
    v5.answer(`${L.pairId}:${step}`, () => L.src.submit(tx));
  return v5;
};
async function swapRefusedAfterApprove() {
  const L = lane();
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
  return L;
}
async function bridgeRefusedAfterApprove() {
  const L = bridgeLane();
  await bridgeStep(L);
  settleSource(L);
  await L.engine.track();
  L.signer.answer = () => ({
    outcome: "REFUSED",
    hash: null,
    problems: ["EARLIER_TX_UNDECIDED"],
  });
  await bridgeStep(L);
  return L;
}

describe("NEW-1: one token or one step dispatched twice at the same moment (race.probe.ts)", () => {
  it("swap APPROVE, ONE token twice: one hand-off, the second DISPATCH_IN_PROGRESS; the mined approve is tracked as such", async () => {
    const L = lane();
    const v5 = swapOnV5(L);
    const r = await L.engine.review(SWAP_KEY);
    expect(r.ready, r.problems.join(",")).toBe(true);
    const t = L.engine.authorize(r.reviewId, SWAP_KEY);
    const res = await Promise.allSettled([
      L.engine.dispatch(t, SWAP_KEY),
      L.engine.dispatch(t, SWAP_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(L.signer.calls).toHaveLength(1);
    expect(v5.handOffs).toEqual([`${BASE}:APPROVE`]);
    expect(L.store.of("NONCE")).toHaveLength(1);
    expect(datas(L.store, "USE").map((u) => u.step)).toEqual(["APPROVE"]);
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT"]);
    expect(L.store.of("DISPATCH_DUPLICATE")).toHaveLength(0);
    // the same token once more, after the first finished: refused by the journal (nothing re-sent)
    expect((await err(L.engine.dispatch(t, SWAP_KEY))).code).toBe(
      "TOKEN_REPLAYED",
    );
    L.chain.mine();
    L.chain.advance(BASE_ROUTE.confirmations);
    const tr = await L.engine.track();
    expect((tr.steps.APPROVE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(tr.state).not.toMatch(/REFUSED/);
    // the round-2 probe ended at APPROVAL_NOT_FINAL for ever; now the lane moves on
    const next = await L.engine.review(SWAP_KEY);
    expect(next.step).toBe("SWAP");
    expect(next.problems).not.toContain("APPROVAL_NOT_FINAL");
    expect(next.ready, next.problems.join(",")).toBe(true);
    expect(
      laneDispatchPending(`SWAP:${BASE}:${OWNER}:${RECORD.approvalId}`),
    ).toBe(false);
  });
  it("swap APPROVE, TWO tokens of the same step at once: one hand-off, one USE", async () => {
    const L = lane();
    const v5 = swapOnV5(L);
    const r = await L.engine.review(SWAP_KEY);
    const t1 = L.engine.authorize(r.reviewId, SWAP_KEY);
    const t2 = L.engine.authorize(r.reviewId, SWAP_KEY);
    const res = await Promise.allSettled([
      L.engine.dispatch(t1, SWAP_KEY),
      L.engine.dispatch(t2, SWAP_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toHaveLength(1);
    expect(L.store.of("USE")).toHaveLength(1);
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT"]);
    // the spare token later: the step is spent (journal), never a second hand-off
    expect((await err(L.engine.dispatch(t2, SWAP_KEY))).code).toMatch(
      /^(REVIEW_STEP_STALE|STEP_ALREADY_USED)$/,
    );
    expect(L.signer.calls).toHaveLength(1);
  });
  it("bridge APPROVE, ONE token twice: one hand-off; the approve is tracked final, never APPROVE_REFUSED", async () => {
    const L = bridgeLane();
    const v5 = bridgeOnV5(L);
    const r = await L.engine.review(BRIDGE_KEY);
    expect(r.ready, r.problems.join(",")).toBe(true);
    const t = L.engine.authorize(r.reviewId, BRIDGE_KEY);
    const res = await Promise.allSettled([
      L.engine.dispatch(t, BRIDGE_KEY),
      L.engine.dispatch(t, BRIDGE_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toEqual([`${L.pairId}:APPROVE`]);
    expect(L.store.of("NONCE")).toHaveLength(1);
    expect(L.store.of("USE")).toHaveLength(1);
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT"]);
    settleSource(L);
    const tr = await L.engine.track();
    expect((tr.steps.APPROVE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(tr.state).not.toMatch(/REFUSED/);
  });
  it("bridge EXECUTE, ONE token twice after a clean APPROVE: one deposit hand-off, tracked as a deposit (never EXECUTE_REFUSED)", async () => {
    const L = bridgeLane();
    await bridgeStep(L);
    settleSource(L);
    await L.engine.track();
    const v5 = bridgeOnV5(L);
    const r = await L.engine.review(BRIDGE_KEY);
    expect(r.ready, r.problems.join(",")).toBe(true);
    const t = L.engine.authorize(r.reviewId, BRIDGE_KEY);
    const res = await Promise.allSettled([
      L.engine.dispatch(t, BRIDGE_KEY),
      L.engine.dispatch(t, BRIDGE_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toEqual([`${L.pairId}:EXECUTE`]);
    expect(L.signer.calls.map((c) => c.step)).toEqual(["APPROVE", "EXECUTE"]);
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT", "EXECUTE:SENT"]);
    settleSource(L);
    const tr = await L.engine.track();
    expect((tr.steps.EXECUTE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(tr.state).not.toMatch(/REFUSED/);
    expect(L.src.deposits).toHaveLength(1);
  });
  it("swap: TWO revokes at once after a refused SWAP: one CLEANUP hand-off, one USE REVOKE, the outcome SENT", async () => {
    const L = await swapRefusedAfterApprove();
    const v5 = swapOnV5(L);
    const res = await Promise.allSettled([
      L.engine.revoke(SWAP_KEY),
      L.engine.revoke(SWAP_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toEqual([`${BASE}:REVOKE`]);
    expect(L.signer.calls.filter((c) => c.step === "REVOKE")).toHaveLength(1);
    expect(datas(L.store, "USE").map((u) => u.step)).toEqual([
      "APPROVE",
      "SWAP",
      "REVOKE",
    ]);
    expect(dispatchesOf(L.store)).toEqual([
      "APPROVE:SENT",
      "SWAP:REFUSED",
      "REVOKE:SENT",
    ]);
    expect((await err(L.engine.revoke(SWAP_KEY))).code).toBe(
      "REVOKE_ALREADY_USED",
    );
    L.chain.mine();
    L.chain.advance(BASE_ROUTE.confirmations);
    const tr = await L.engine.track();
    expect((tr.steps.REVOKE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(tr.allowance).toEqual({ value: "0", agree: true });
  });
  it("bridge: TWO revokes at once after a refused EXECUTE: one CLEANUP hand-off", async () => {
    const L = await bridgeRefusedAfterApprove();
    const v5 = bridgeOnV5(L);
    const res = await Promise.allSettled([
      L.engine.revoke(BRIDGE_KEY),
      L.engine.revoke(BRIDGE_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toEqual([`${L.pairId}:REVOKE`]);
    expect(datas(L.store, "USE").map((u) => u.step)).toEqual([
      "APPROVE",
      "EXECUTE",
      "REVOKE",
    ]);
    expect(dispatchesOf(L.store)).toEqual([
      "APPROVE:SENT",
      "EXECUTE:REFUSED",
      "REVOKE:SENT",
    ]);
  });
  it("a dispatch and a revoke of ONE record at once: the second is refused before anything", async () => {
    const L = await swapRefusedAfterApprove();
    const v5 = swapOnV5(L);
    const res = await Promise.allSettled([
      L.engine.revoke(SWAP_KEY),
      L.engine.dispatch("not-a-token", SWAP_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:DISPATCH_IN_PROGRESS"]);
    expect(v5.handOffs).toHaveLength(1);
  });
});

describe("NEW-1: the swap lane and the bridge lane on ONE signer at the same moment (race2.probe.ts)", () => {
  async function twoLanes() {
    const S = lane();
    const B = bridgeLane();
    const rs = await S.engine.review(SWAP_KEY);
    const rb = await B.engine.review(BRIDGE_KEY);
    expect([rs.ready, rb.ready]).toEqual([true, true]);
    const ts = S.engine.authorize(rs.reviewId, SWAP_KEY);
    const tb = B.engine.authorize(rb.reviewId, BRIDGE_KEY);
    // one signer: each lane's status also sees the other lane's signatures (still undecided)
    S.signer.others = B.signer.signatures;
    B.signer.others = S.signer.signatures;
    const v5 = signerV5();
    swapOnV5(S, v5);
    bridgeOnV5(B, v5);
    return { S, B, ts, tb, v5 };
  }
  it("swap first: the swap is signed; the bridge waits, then its preflight sees the swap in flight and spends NOTHING", async () => {
    const { S, B, ts, tb, v5 } = await twoLanes();
    const res = await Promise.allSettled([
      S.engine.dispatch(ts, SWAP_KEY),
      B.engine.dispatch(tb, BRIDGE_KEY),
    ]);
    expect(codeOf(res[0])).toBe("OK:SENT");
    expect(codeOf(res[1])).toBe("THROW:SIGNER_NOT_READY");
    expect((res[1] as PromiseRejectedResult).reason.detail).toContain(
      "SIGNER_NOT_READY:IN_FLIGHT",
    );
    // the round-2 probe: both preflights [true], both lanes spent, one REFUSED EARLIER_TX_UNDECIDED. Now:
    expect(v5.handOffs).toEqual([`${BASE}:APPROVE`]);
    expect(datas(S.store, "SIGNER_PREFLIGHT").map((p) => p.ok)).toEqual([true]);
    expect(datas(B.store, "SIGNER_PREFLIGHT").map((p) => p.ok)).toEqual([
      false,
    ]);
    expect(S.store.of("USE")).toHaveLength(1);
    expect(B.store.of("USE")).toHaveLength(0);
    expect(B.store.of("NONCE")).toHaveLength(0);
    expect(B.store.of("PREPARED")).toHaveLength(0);
    expect(B.signer.calls).toHaveLength(0);
  });
  it("bridge first: the mirror image", async () => {
    const { S, B, ts, tb, v5 } = await twoLanes();
    const res = await Promise.allSettled([
      B.engine.dispatch(tb, BRIDGE_KEY),
      S.engine.dispatch(ts, SWAP_KEY),
    ]);
    expect(res.map(codeOf)).toEqual(["OK:SENT", "THROW:SIGNER_NOT_READY"]);
    expect(v5.handOffs).toEqual([`${B.pairId}:APPROVE`]);
    expect(S.store.of("USE")).toHaveLength(0);
    expect(S.signer.calls).toHaveLength(0);
  });
  it("the spans never overlap: the second lane's preflight starts only after the first lane's hand-off returned", async () => {
    const { S, B, ts, tb } = await twoLanes();
    const log: string[] = [];
    const wrap = (
      name: string,
      signer: Lane["signer"] | BridgeLane["signer"],
    ) => {
      const status = signer.status.bind(signer);
      const send = signer.send.bind(signer) as (
        a: unknown,
        tx: never,
        s: never,
      ) => Promise<LaneSignerResult>;
      signer.status = async () => {
        log.push(`${name}:status`);
        await sleep(20);
        return status();
      };
      (signer as { send: unknown }).send = async (
        a: unknown,
        tx: never,
        s: never,
      ) => {
        log.push(`${name}:send`);
        const r = await send(a, tx, s);
        log.push(`${name}:sent`);
        return r;
      };
    };
    wrap("swap", S.signer);
    wrap("bridge", B.signer);
    await Promise.allSettled([
      S.engine.dispatch(ts, SWAP_KEY),
      B.engine.dispatch(tb, BRIDGE_KEY),
    ]);
    expect(log).toEqual([
      "swap:status",
      "swap:send",
      "swap:sent",
      "bridge:status",
    ]);
  });
});

describe("NEW-2: the freshness window is re-checked after the preflight await (slow.probe.ts)", () => {
  const window = SWAP_LANE_SCOPE.reviewTtlSec * 1000;
  it.each([["swap"], ["bridge"]] as const)(
    "%s: a preflight slower than the 20 s window spends nothing and never hands off",
    async (name) => {
      const L = name === "swap" ? lane() : bridgeLane();
      const key = name === "swap" ? SWAP_KEY : BRIDGE_KEY;
      const engine = L.engine as unknown as SomeEngine;
      const signer = L.signer as unknown as SomeSigner;
      const r = await engine.review(key);
      const t = engine.authorize(r.reviewId, key);
      const status = signer.status.bind(signer);
      // the slow sync: real time passes AND the clock moves past the window
      signer.status = async () => {
        await sleep(30);
        L.clock.t += window + 5_000;
        return status();
      };
      const e = await err(engine.dispatch(t, key));
      expect(e.code).toMatch(/^(TOKEN_EXPIRED|REVIEW_EXPIRED)$/);
      expect(e.detail).toEqual(["AFTER_SIGNER_PREFLIGHT"]);
      expect(L.clock.t - r.expiresAt).toBeGreaterThan(0);
      // the preflight itself was clean (journaled); nothing single use was spent and nothing left the process
      expect(datas(L.store, "SIGNER_PREFLIGHT").map((p) => p.ok)).toEqual([
        true,
      ]);
      expect(L.store.of("NONCE")).toHaveLength(0);
      expect(L.store.of("USE")).toHaveLength(0);
      expect(L.store.of("PREPARED")).toHaveLength(0);
      expect(L.store.of("DISPATCH")).toHaveLength(0);
      expect(signer.calls).toHaveLength(0);
    },
  );
  it("a slow preflight INSIDE the window proceeds (the re-check is not a liveness loss)", async () => {
    const L = lane();
    const r = await L.engine.review(SWAP_KEY);
    const t = L.engine.authorize(r.reviewId, SWAP_KEY);
    const status = L.signer.status.bind(L.signer);
    L.signer.status = async () => {
      await sleep(10);
      L.clock.t += 5_000;
      return status();
    };
    expect((await L.engine.dispatch(t, SWAP_KEY)).outcome).toBe("SENT");
    expect(L.signer.calls).toHaveLength(1);
  });
  it.each([["swap"], ["bridge"]] as const)(
    "%s revoke: a revoke preflight slower than the window spends nothing (REVIEW_EXPIRED, REVOKE)",
    async (name) => {
      const L =
        name === "swap"
          ? await swapRefusedAfterApprove()
          : await bridgeRefusedAfterApprove();
      const key = name === "swap" ? SWAP_KEY : BRIDGE_KEY;
      const signer = L.signer as unknown as SomeSigner;
      const status = signer.status.bind(signer);
      let n = 0;
      // the revoke reads the status once with its other reads, then once more in the preflight: the second is slow
      signer.status = async () => {
        if (++n === 2) {
          await sleep(20);
          L.clock.t +=
            (name === "swap"
              ? SWAP_LANE_SCOPE.reviewTtlSec
              : BRIDGE_LANE_SCOPE.reviewTtlSec) *
              1000 +
            1_000;
        }
        return status();
      };
      const e = await err((L.engine as unknown as SomeEngine).revoke(key));
      expect(e.code).toBe("REVIEW_EXPIRED");
      expect(e.detail).toEqual(["REVOKE", "AFTER_SIGNER_PREFLIGHT"]);
      expect(datas(L.store, "USE").some((u) => u.step === "REVOKE")).toBe(
        false,
      );
      expect(signer.calls.some((c) => c.step === "REVOKE")).toBe(false);
    },
  );
});

describe("NEW-1 defence in depth: the re-check after the preflight await, and a refusal never shadows a sent step", () => {
  it.each([
    [
      "a USE of the same step journaled meanwhile (another writer)",
      (L: Lane) =>
        L.store.append("USE", {
          key: `${BASE}:${OWNER}:${RECORD.approvalId}:APPROVE`,
          step: "APPROVE",
        }),
      "STEP_ALREADY_USED",
    ],
    [
      "the token spent meanwhile",
      (L: Lane, t: string) => L.store.append("NONCE", { id: tokenId(t) }),
      "TOKEN_REPLAYED",
    ],
    [
      "another dispatch recorded meanwhile",
      (L: Lane) =>
        L.store.append("DISPATCH", {
          step: "REVOKE",
          outcome: "REFUSED",
          hash: null,
          problems: [],
        }),
      "OTHER_DISPATCH_RECORDED",
    ],
  ] as const)(
    "swap: %s -> DISPATCH_DUPLICATE before the signer",
    async (_name, meanwhile, detail) => {
      const L = lane();
      const r = await L.engine.review(SWAP_KEY);
      const t = L.engine.authorize(r.reviewId, SWAP_KEY);
      const status = L.signer.status.bind(L.signer);
      L.signer.status = async () => {
        meanwhile(L, t);
        return status();
      };
      const uses = L.store.of("USE").length;
      const e = await err(L.engine.dispatch(t, SWAP_KEY));
      expect(e.code).toBe("DISPATCH_DUPLICATE");
      expect(e.detail).toEqual([detail]);
      expect(L.signer.calls).toHaveLength(0);
      expect(L.store.of("PREPARED")).toHaveLength(0);
      // nothing of ours was added to what the other writer journaled
      expect(L.store.of("USE").length).toBeLessThanOrEqual(uses + 1);
    },
  );
  it("bridge: a USE of the same step journaled during the preflight -> DISPATCH_DUPLICATE, no hand-off", async () => {
    const L = bridgeLane();
    const record = bridgeRecordFor(L.pairId);
    const r = await L.engine.review(BRIDGE_KEY);
    const t = L.engine.authorize(r.reviewId, BRIDGE_KEY);
    const status = L.signer.status.bind(L.signer);
    L.signer.status = async () => {
      L.store.append("USE", {
        key: `${L.pairId}:${record.account.toLowerCase()}:${record.approvalId}:APPROVE`,
        step: "APPROVE",
      });
      return status();
    };
    const e = await err(L.engine.dispatch(t, BRIDGE_KEY));
    expect(e.code).toBe("DISPATCH_DUPLICATE");
    expect(e.detail).toEqual(["STEP_ALREADY_USED"]);
    expect(L.signer.calls).toHaveLength(0);
  });
  it("swap revoke: a REVOKE USE journaled during the preflight -> DISPATCH_DUPLICATE, no CLEANUP hand-off", async () => {
    const L = await swapRefusedAfterApprove();
    L.signer.answer = (_s, tx) => ({
      outcome: "SENT",
      hash: L.chain.submit(tx),
      problems: [],
    });
    const status = L.signer.status.bind(L.signer);
    let n = 0;
    L.signer.status = async () => {
      if (++n === 2)
        L.store.append("USE", {
          key: `${BASE}:${OWNER}:${RECORD.approvalId}:REVOKE`,
          step: "REVOKE",
        });
      return status();
    };
    const e = await err(L.engine.revoke(SWAP_KEY));
    expect(e.code).toBe("DISPATCH_DUPLICATE");
    expect(e.detail).toEqual(["REVOKE_ALREADY_USED"]);
    expect(L.signer.calls.some((c) => c.step === "REVOKE")).toBe(false);
  });
  it("swap: a signer refusal after another writer recorded the step SENT is kept apart; the SENT step is what the lane tracks", async () => {
    const L = lane();
    const r = await L.engine.review(SWAP_KEY);
    const t = L.engine.authorize(r.reviewId, SWAP_KEY);
    L.signer.answer = (_s, tx) => {
      // another writer of this journal recorded the same step as SENT (with its real hash) meanwhile
      L.store.append("DISPATCH", {
        step: "APPROVE",
        outcome: "SENT",
        hash: L.chain.submit(tx),
        problems: [],
      });
      return {
        outcome: "REFUSED",
        hash: null,
        problems: ["STEP_ALREADY_SIGNED_ONCE"],
      };
    };
    const out = await L.engine.dispatch(t, SWAP_KEY);
    expect(out.outcome).toBe("REFUSED");
    expect(out.problems).toContain("DUPLICATE_KEPT_APART");
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT"]);
    expect(
      datas(L.store, "DISPATCH_DUPLICATE").map((d) => `${d.step}:${d.outcome}`),
    ).toEqual(["APPROVE:REFUSED"]);
    L.chain.mine();
    L.chain.advance(BASE_ROUTE.confirmations);
    const tr = await L.engine.track();
    expect((tr.steps.APPROVE as { state: string }).state).toBe("FINAL_SUCCESS");
  });
  it("bridge: the same, for the deposit (EXECUTE)", async () => {
    const L = bridgeLane();
    await bridgeStep(L);
    settleSource(L);
    await L.engine.track();
    L.signer.answer = (_s, tx) => {
      L.store.append("DISPATCH", {
        step: "EXECUTE",
        outcome: "SENT",
        hash: L.src.submit(tx),
        problems: [],
      });
      return { outcome: "REFUSED", hash: null, problems: [] };
    };
    const { d } = await bridgeStep(L);
    expect(d.outcome).toBe("REFUSED");
    expect(d.problems).toContain("DUPLICATE_KEPT_APART");
    expect(dispatchesOf(L.store)).toEqual(["APPROVE:SENT", "EXECUTE:SENT"]);
    settleSource(L);
    const tr = await L.engine.track();
    expect((tr.steps.EXECUTE as { state: string }).state).toBe("FINAL_SUCCESS");
    expect(tr.state).not.toMatch(/REFUSED/);
  });
  it.each([["SENT"], ["UNCERTAIN"]] as const)(
    "a later REFUSED entry of a step never shadows its %s entry (reader side; revoke stays closed)",
    async (first) => {
      const L = lane();
      const r = await L.engine.review(SWAP_KEY);
      const t = L.engine.authorize(r.reviewId, SWAP_KEY);
      await L.engine.dispatch(t, SWAP_KEY);
      L.chain.mine();
      L.chain.advance(BASE_ROUTE.confirmations);
      await L.engine.track();
      const t2 = L.engine.authorize(
        (await L.engine.review(SWAP_KEY)).reviewId,
        SWAP_KEY,
      );
      L.signer.answer = (_s, tx) => ({
        outcome: first,
        hash: L.chain.submit(tx),
        problems: [],
      });
      await L.engine.dispatch(t2, SWAP_KEY);
      // a foreign REFUSED for the SAME step after it
      L.store.append("DISPATCH", {
        step: "SWAP",
        outcome: "REFUSED",
        hash: null,
        problems: ["STEP_ALREADY_SIGNED_ONCE"],
      });
      const tr = await L.engine.track();
      expect((tr.steps.SWAP as { state: string }).state).not.toBe("REFUSED");
      // the revoke treats the swap as live, never as refused
      const e = await err(L.engine.revoke(SWAP_KEY));
      expect(e.code).toBe("REVOKE_NOT_READY");
      expect(e.detail).toContain("REVOKE_NOT_ALLOWED:SWAP_NOT_DECIDED_FAILED");
    },
  );
});

describe("the lock itself (src/swap/lane/dispatch-lock.ts)", () => {
  const busy = () => Object.assign(new Error("BUSY"), { code: "BUSY" });
  it("spans of different records run one at a time, in arrival order", async () => {
    const log: string[] = [];
    let running = 0;
    let most = 0;
    const span = (name: string, ms: number) => async () => {
      running++;
      most = Math.max(most, running);
      log.push(`${name}>`);
      await sleep(ms);
      log.push(`<${name}`);
      running--;
      return name;
    };
    const out = await Promise.all([
      withLaneDispatchLock("t:a", busy, span("a", 15)),
      withLaneDispatchLock("t:b", busy, span("b", 1)),
      withLaneDispatchLock("t:c", busy, span("c", 5)),
    ]);
    expect(out).toEqual(["a", "b", "c"]);
    expect(most).toBe(1);
    expect(log).toEqual(["a>", "<a", "b>", "<b", "c>", "<c"]);
  });
  it("a second span of a running or queued record is refused at once and never runs", async () => {
    let ran = 0;
    let release: () => void = () => undefined;
    const first = withLaneDispatchLock("t:x", busy, async () => {
      ran++;
      await new Promise<void>((r) => {
        release = r;
      });
    });
    const queued = withLaneDispatchLock("t:y", busy, async () => {
      ran++;
    });
    expect(laneDispatchPending("t:x")).toBe(true);
    expect(laneDispatchPending("t:y")).toBe(true);
    await expect(
      withLaneDispatchLock("t:x", busy, async () => void ran++),
    ).rejects.toMatchObject({ code: "BUSY" });
    await expect(
      withLaneDispatchLock("t:y", busy, async () => void ran++),
    ).rejects.toMatchObject({ code: "BUSY" });
    await sleep(5);
    release();
    await first;
    await queued;
    expect(ran).toBe(2);
    expect(laneDispatchPending("t:x")).toBe(false);
    expect(laneDispatchPending("t:y")).toBe(false);
  });
  it("a span that throws releases the lock", async () => {
    await expect(
      withLaneDispatchLock("t:z", busy, async () => {
        throw new Error("SPAN_FAILED");
      }),
    ).rejects.toThrow("SPAN_FAILED");
    expect(laneDispatchPending("t:z")).toBe(false);
    expect(await withLaneDispatchLock("t:z", busy, async () => 7)).toBe(7);
  });
  it("is ONE lock per process: a second copy of the module (another route bundle) shares it", async () => {
    vi.resetModules();
    const copy = await import("../../src/swap/lane/dispatch-lock");
    expect(copy.withLaneDispatchLock).not.toBe(withLaneDispatchLock);
    let release: () => void = () => undefined;
    const held = withLaneDispatchLock("t:shared", busy, async () => {
      await new Promise<void>((r) => {
        release = r;
      });
    });
    expect(copy.laneDispatchPending("t:shared")).toBe(true);
    await expect(
      copy.withLaneDispatchLock("t:shared", busy, async () => 1),
    ).rejects.toMatchObject({ code: "BUSY" });
    const order: string[] = [];
    const after = copy
      .withLaneDispatchLock("t:other", busy, async () => {
        order.push("copy");
      })
      .then(() => order);
    await sleep(5);
    expect(order).toEqual([]);
    release();
    await held;
    expect(await after).toEqual(["copy"]);
  });
});
