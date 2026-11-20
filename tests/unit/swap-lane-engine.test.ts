// VEINED-FIN-LIVE-20261115-01 (SWAP-LIVE-01): the swap lane ENGINE (src/swap/lane/engine.ts) end to end over an
// in-memory FAKE CHAIN (two programmable operators), an in-memory journal and a recording fake signer, on a fixed
// clock. The pin set is mocked ONLY in its code hashes (keccak256 of the fake chain's bytes; every address, selector
// and slot is the real pin), because a real runtime-code preimage cannot be produced. swap-lane-adapter.test.ts runs
// the same fake chain against the UNMOCKED pins and proves every code hash is then refused.
// SYNTHETIC_TEST_ONLY: owner, key, hashes and amounts are synthetic. Nothing here signs, sends or reaches a network.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AMOUNT,
  BASE,
  BASE_PINS,
  BASE_ROUTE,
  FIRST_NONCE,
  NOW,
  OTHER,
  OWNER,
  OWNER_KEY,
  RECORD,
  ceilMin,
  fakeCodeOf,
  handApprove,
  handSwap,
  lane,
  quoteAtImpact,
  spotOutFor,
  type Lane,
} from "./swap-lane-fake";
import { keccak256 } from "viem";
import type { SwapLaneError } from "../../src/swap/lane/engine";
import {
  SWAP_LANE_ROUTE_PINS,
  SWAP_LANE_SELECTORS,
  pinsOf,
} from "../../src/swap/lane/pins";
import { sendLaneTransaction } from "../../src/swap/lane/signer-adapter";

vi.mock("../../src/swap/lane/pins", async (importOriginal) => {
  const real =
    await importOriginal<typeof import("../../src/swap/lane/pins")>();
  // Must equal fakeCodeOf in ./swap-lane-fake.ts (asserted below).
  const { fakeCodePinModule } = await import("./swap-lane-pin-mock");
  return fakeCodePinModule(real);
});

const U = BASE_PINS.pay.address.toLowerCase();
const R = BASE_PINS.router.address.toLowerCase();
const W = BASE_PINS.receive.address.toLowerCase();
const err = async (p: Promise<unknown> | (() => unknown)) => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    return e as SwapLaneError;
  }
  throw new Error("EXPECTED_A_REFUSAL");
};
const code = async (p: Promise<unknown> | (() => unknown)) =>
  (await err(p)).code;
/** review -> authorize -> dispatch of the next step (the review must be ready). */
async function step(L: Lane) {
  const r = await L.engine.review(OWNER_KEY);
  expect(r.ready, r.problems.join(",")).toBe(true);
  const token = L.engine.authorize(r.reviewId, OWNER_KEY);
  const d = await L.engine.dispatch(token, OWNER_KEY);
  return { r, token, d };
}
/** Includes the pending transactions and buries them under the route's depth (confirmations + 1, signer v5: 300). */
const settle = (L: Lane) => {
  const n = L.chain.mine();
  L.chain.advance(BASE_ROUTE.confirmations);
  return n;
};
async function approved(L: Lane) {
  const a = await step(L);
  expect(a.d.outcome).toBe("SENT");
  settle(L);
  const t = await L.engine.track();
  expect((t.steps.APPROVE as { state: string }).state).toBe("FINAL_SUCCESS");
  return a;
}
type Steps = Record<string, { state: string; hash?: string | null }>;
const stepsOf = (t: { steps: Record<string, unknown> }) => t.steps as Steps;

afterEach(() => vi.restoreAllMocks());

describe("test set-up", () => {
  it("the mocked pins differ from the real ones only in the code hashes, and match the fake chain's bytes", async () => {
    const real = await vi.importActual<
      typeof import("../../src/swap/lane/pins")
    >("../../src/swap/lane/pins");
    expect(Object.keys(SWAP_LANE_ROUTE_PINS)).toEqual(
      Object.keys(real.SWAP_LANE_ROUTE_PINS),
    );
    for (const id of Object.keys(real.SWAP_LANE_ROUTE_PINS)) {
      const mocked = SWAP_LANE_ROUTE_PINS[id],
        actual = real.SWAP_LANE_ROUTE_PINS[id];
      expect(pinsOf(id)).toBe(mocked);
      expect(mocked.set).toBe(actual.set);
      expect(mocked.route).toBe(actual.route);
      expect(mocked.gasPriceOracle).toBe(actual.gasPriceOracle);
      for (const k of [
        "pay",
        "receive",
        "router",
        "quoter",
        "factory",
        "pool",
      ] as const) {
        expect(mocked[k].address).toBe(actual[k].address);
        expect(mocked[k].codehash).toBe(
          keccak256(fakeCodeOf(mocked[k].address)),
        );
        expect(mocked[k].codehash).not.toBe(actual[k].codehash);
      }
      expect(mocked.pay.implementation).toEqual(actual.pay.implementation);
    }
    expect(BASE_PINS).toBe(SWAP_LANE_ROUTE_PINS[BASE]);
    expect(SWAP_LANE_SELECTORS).toEqual(real.SWAP_LANE_SELECTORS);
    // the real Base pin set is the reviewed one
    expect(real.SWAP_LANE_ROUTE_PINS[BASE].set).toBe(
      "fl1-swap-lane-pins.2026-11-15.1",
    );
    expect(BASE_ROUTE.id).toBe(BASE);
  });
});

describe("happy path: APPROVE then SWAP to SETTLED_VERIFIED", () => {
  it("reviews, authorizes, dispatches the exact bytes twice, tracks and settles", async () => {
    const L = lane();
    const quote = L.chain.quoteOut;
    // ---- APPROVE ----
    const r1 = await L.engine.review(OWNER_KEY);
    expect(r1.problems).toEqual([]);
    expect(r1).toMatchObject({
      ready: true,
      step: "APPROVE",
      amountIn: "1000000",
      quoteOut: quote.toString(),
      spotOut: spotOutFor(AMOUNT).toString(),
      priceImpactBps: 10,
      slippageBps: 25,
      amountOutMinimum: ceilMin(quote, 25).toString(),
      deadline: String(Math.floor(NOW / 1000) + 300),
      expiresAt: NOW + 20_000,
      balances: {
        usdc: "5000000",
        weth: "0",
        eth: "1000000000000000",
        allowance: "0",
      },
      simulation: {
        usdcDelta: "-1000000",
        wethDelta: quote.toString(),
        allowanceAfter: "0",
        gasUsed: { APPROVE: "46000", SWAP: "150000" },
      },
      gas: {
        maxFeePerGas: "16000000",
        maxPriorityFeePerGas: "1000000",
        limits: { APPROVE: "55200", SWAP: "180000" },
        budgetWei: "17700000000000",
      },
      pins: { set: BASE_PINS.set, problems: [] },
    });
    expect(r1.guardian?.level).not.toMatch(/BLOCK|HOLD/);
    // the Base WETH registry row (reviewed source) removed the former asset CAUTION: a clean review is CLEAR
    expect(r1.guardian?.level).toBe("CLEAR");
    expect(r1).toMatchObject({ route: BASE, chainId: "8453" });
    // the nonce is read at the review block AND pending, on both operators (journal anchored on chain)
    const B1 = "0x" + (L.chain.head - 1n).toString(16);
    expect(L.chain.log).toEqual(
      expect.arrayContaining([
        { method: "eth_getTransactionCount", params: [OWNER, B1] },
        { method: "eth_getTransactionCount", params: [OWNER, "pending"] },
      ]),
    );
    expect(r1.attestation).toBeTruthy();
    const t1 = L.engine.authorize(r1.reviewId, OWNER_KEY);
    expect(L.signer.calls).toHaveLength(0);
    const d1 = await L.engine.dispatch(t1, OWNER_KEY);
    expect(d1).toMatchObject({
      step: "APPROVE",
      outcome: "SENT",
      problems: [],
    });
    expect(L.signer.calls).toHaveLength(1);
    expect(L.signer.calls[0].step).toBe("APPROVE");
    expect(L.signer.calls[0].tx).toEqual({
      chainId: "0x2105",
      from: OWNER,
      to: U,
      value: "0x0",
      data:
        "0x095ea7b3" +
        "0000000000000000000000002626664c2603336e57b271c5c0b26f421741e481" +
        "00000000000000000000000000000000000000000000000000000000000f4240",
      gas: "0xd7a0",
      maxFeePerGas: "0xf42400",
      maxPriorityFeePerGas: "0xf4240",
    });
    expect(L.signer.calls[0].tx.data).toBe(handApprove(AMOUNT));
    // the journal: review, token, then ONE batch of NONCE + USE + PREPARED before the hand-off, then the outcome
    expect(L.store.types()).toEqual([
      "REVIEW",
      "AUTH",
      "SIGNER_PREFLIGHT",
      "NONCE",
      "USE",
      "PREPARED",
      "DISPATCH",
    ]);
    expect(L.store.of("USE")[0].data).toMatchObject({
      key: `${BASE}:${OWNER}:${RECORD.approvalId}:APPROVE`,
      step: "APPROVE",
    });
    // the gate ran on the transaction's own bytes and was OPEN
    expect(L.gateCalls).toHaveLength(1);
    expect(L.gateCalls[0].open).toBe(true);
    expect(L.gateCalls[0].facts.tx).toEqual(L.signer.calls[0].tx);
    // tracking: pending, then confirming, then final
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe("PENDING");
    L.chain.mine();
    expect(stepsOf(await L.engine.track()).APPROVE).toMatchObject({
      state: "CONFIRMING",
    });
    // one block short of the route's depth is still CONFIRMING, the depth itself is final
    L.chain.advance(BASE_ROUTE.confirmations - 2);
    expect(stepsOf(await L.engine.track()).APPROVE).toMatchObject({
      state: "CONFIRMING",
      confirmations: String(BASE_ROUTE.confirmations - 1),
    });
    L.chain.advance(1);
    const tr1 = await L.engine.track();
    expect(stepsOf(tr1).APPROVE).toMatchObject({
      state: "FINAL_SUCCESS",
      confirmations: String(BASE_ROUTE.confirmations),
    });
    expect(BASE_ROUTE.confirmations).toBe(300);
    expect(stepsOf(tr1).SWAP.state).toBe("NOT_DISPATCHED");
    expect(tr1.state).toBe("SWAP_NOT_DISPATCHED");
    expect(tr1.allowance).toEqual({ value: "1000000", agree: true });
    expect(L.store.of("RECEIPT")).toHaveLength(1);
    // ---- SWAP ----
    const r2 = await L.engine.review(OWNER_KEY);
    expect(r2.problems).toEqual([]);
    expect(r2).toMatchObject({
      ready: true,
      step: "SWAP",
      balances: { usdc: "5000000", allowance: "1000000" },
      simulation: {
        usdcDelta: "-1000000",
        allowanceAfter: "0",
        gasUsed: { SWAP: "150000" },
      },
      gas: { limits: { SWAP: "180000" } },
    });
    expect(BigInt(r2.gas.spentWei)).toBe(46_000n * 6_000_000n + 5_000_000_000n);
    const t2 = L.engine.authorize(r2.reviewId, OWNER_KEY);
    const d2 = await L.engine.dispatch(t2, OWNER_KEY);
    expect(d2).toMatchObject({ step: "SWAP", outcome: "SENT" });
    expect(L.signer.calls).toHaveLength(2);
    const minOut = ceilMin(quote, 25);
    expect(r2.amountOutMinimum).toBe(minOut.toString());
    expect(L.signer.calls[1]).toMatchObject({ step: "SWAP" });
    expect(L.signer.calls[1].tx).toEqual({
      chainId: "0x2105",
      from: OWNER,
      to: R,
      value: "0x0",
      data: handSwap({
        owner: OWNER,
        amountIn: AMOUNT,
        minOut,
        deadline: BigInt(r2.deadline),
      }),
      gas: "0x2bf20",
      maxFeePerGas: "0xf42400",
      maxPriorityFeePerGas: "0xf4240",
    });
    settle(L);
    const tr2 = await L.engine.track();
    expect(tr2.state).toBe("SETTLED_VERIFIED");
    expect(tr2.settlement).toEqual({
      usdcOut: "1000000",
      wethIn: quote.toString(),
      minOut: minOut.toString(),
      allowanceAfter: "0",
      problems: [],
    });
    expect(stepsOf(tr2).SWAP.state).toBe("FINAL_SUCCESS");
    expect(tr2.allowance).toEqual({ value: "0", agree: true });
    expect(L.store.of("SETTLED")).toHaveLength(1);
    // a second track neither re-journals nor re-sends
    expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
    expect(L.store.of("SETTLED")).toHaveLength(1);
    expect(L.store.of("RECEIPT")).toHaveLength(2);
    // the lane is spent
    expect(L.signer.calls).toHaveLength(2);
    expect(L.engine.nextStep()).toBeNull();
    const r3 = await L.engine.review(OWNER_KEY);
    expect(r3.ready).toBe(false);
    expect(r3.problems).toContain("LANE_ALREADY_USED");
    expect(await code(() => L.engine.authorize(r3.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    // every read the engine made is inside the lane's read shape
    expect(L.chain.violations).toEqual([]);
    expect(L.signer.calls).toHaveLength(2);
  });
});

describe("owner key", () => {
  it("a wrong key is refused before anything is read or journaled", async () => {
    const L = lane();
    expect(await code(L.engine.review("00".repeat(32)))).toBe(
      "OWNER_KEY_MISMATCH",
    );
    expect(await code(L.engine.review("5E".repeat(32)))).toBe(
      "OWNER_KEY_INVALID",
    );
    expect(await code(L.engine.review("5e".repeat(31)))).toBe(
      "OWNER_KEY_INVALID",
    );
    expect(await code(L.engine.review(undefined))).toBe("OWNER_KEY_INVALID");
    expect(await code(L.engine.review(RECORD.approvalId))).toBe(
      "OWNER_KEY_INVALID",
    );
    expect(L.chain.log).toHaveLength(0);
    expect(L.store.list).toHaveLength(0);
  });
  it("authorize and dispatch need the key too (and a wrong key spends nothing)", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    expect(
      await code(() => L.engine.authorize(r.reviewId, "01".repeat(32))),
    ).toBe("OWNER_KEY_MISMATCH");
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    expect(await code(L.engine.dispatch(t, "01".repeat(32)))).toBe(
      "OWNER_KEY_MISMATCH",
    );
    expect(L.store.of("NONCE")).toHaveLength(0);
    expect(L.signer.calls).toHaveLength(0);
    expect((await L.engine.dispatch(t, OWNER_KEY)).outcome).toBe("SENT");
  });
  it("an engine whose digest is of another key refuses the owner key", async () => {
    const L = lane({ keyDigest: "0".repeat(64) });
    expect(await code(L.engine.review(OWNER_KEY))).toBe("OWNER_KEY_MISMATCH");
  });
});

describe("single use", () => {
  it("token replay: the same token twice -> TOKEN_REPLAYED, the signer is not called again", async () => {
    const L = lane();
    const { token, d } = await step(L);
    expect(d.outcome).toBe("SENT");
    expect(await code(L.engine.dispatch(token, OWNER_KEY))).toBe(
      "TOKEN_REPLAYED",
    );
    expect(L.signer.calls).toHaveLength(1);
    expect(L.store.of("NONCE")).toHaveLength(1);
  });
  it("forged / altered / foreign tokens are TOKEN_INVALID", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const body = JSON.parse(
      Buffer.from(t, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    const enc = (x: unknown) =>
      Buffer.from(JSON.stringify(x)).toString("base64url");
    for (const bad of [
      enc({ ...body, step: "SWAP" }),
      enc({ ...body, notAfter: (body.notAfter as number) + 3_600_000 }),
      enc({ ...body, id: "00".repeat(16) }),
      enc({ ...body, mac: "0".repeat(64) }),
      enc({ ...body, mac: "Z" }),
      enc(null),
      enc(1),
      "not-a-token",
      "",
      null,
    ])
      expect(await code(L.engine.dispatch(bad, OWNER_KEY))).toBe(
        "TOKEN_INVALID",
      );
    // a token minted by another engine instance (another process key) is not this engine's
    const other = lane();
    const r2 = await other.engine.review(OWNER_KEY);
    const foreign = other.engine.authorize(r2.reviewId, OWNER_KEY);
    expect(await code(L.engine.dispatch(foreign, OWNER_KEY))).toBe(
      "TOKEN_INVALID",
    );
    expect(L.signer.calls).toHaveLength(0);
    expect(L.store.of("NONCE")).toHaveLength(0);
  });
  it("step replay: a second token of the same APPROVE review -> REVIEW_STEP_STALE, never a second send", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    const t1 = L.engine.authorize(r.reviewId, OWNER_KEY);
    const t2 = L.engine.authorize(r.reviewId, OWNER_KEY);
    expect((await L.engine.dispatch(t1, OWNER_KEY)).outcome).toBe("SENT");
    expect(L.store.of("USE")).toHaveLength(1);
    expect(await code(L.engine.dispatch(t2, OWNER_KEY))).toMatch(
      /^(STEP_ALREADY_USED|REVIEW_STEP_STALE)$/,
    );
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toMatch(
      /^(STEP_ALREADY_USED|REVIEW_STEP_STALE)$/,
    );
    expect(L.signer.calls).toHaveLength(1);
    expect(L.store.of("USE")).toHaveLength(1);
    expect(L.engine.nextStep()).toBe("SWAP");
  });
  it("a USE written by another writer of the same journal makes an earlier review stale", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    L.store.append("USE", {
      key: `${BASE}:${OWNER}:${RECORD.approvalId}:APPROVE`,
      step: "APPROVE",
    });
    expect(await code(L.engine.dispatch(t, OWNER_KEY))).toMatch(
      /^(STEP_ALREADY_USED|REVIEW_STEP_STALE)$/,
    );
    expect(L.signer.calls).toHaveLength(0);
  });
  it("a failed journal write inside the dispatch batch commits nothing and sends nothing", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    L.store.failOn = "PREPARED";
    await err(L.engine.dispatch(t, OWNER_KEY));
    expect(L.store.of("NONCE")).toHaveLength(0);
    expect(L.store.of("USE")).toHaveLength(0);
    expect(L.store.of("PREPARED")).toHaveLength(0);
    expect(L.signer.calls).toHaveLength(0);
  });
});

describe("freshness and validity", () => {
  it("stale review: past the 20 s TTL -> REVIEW_EXPIRED; a token past it -> TOKEN_EXPIRED", async () => {
    const L = lane();
    const r = await L.engine.review(OWNER_KEY);
    L.clock.t = NOW + 19_999;
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    L.clock.t = NOW + 20_000;
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_EXPIRED",
    );
    expect(await code(L.engine.dispatch(t, OWNER_KEY))).toBe("TOKEN_EXPIRED");
    expect(L.signer.calls).toHaveLength(0);
    expect(L.store.of("NONCE")).toHaveLength(0);
  });
  it("unknown or tampered reviews are refused (the attestation binds every field)", async () => {
    const L = lane();
    expect(
      await code(() => L.engine.authorize("0x" + "00".repeat(16), OWNER_KEY)),
    ).toBe("REVIEW_UNKNOWN");
    const r = await L.engine.review(OWNER_KEY);
    r.amountOutMinimum = "1";
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_ATTESTED",
    );
    const r2 = await L.engine.review(OWNER_KEY);
    r2.gas.limits.APPROVE = "100000000";
    expect(await code(() => L.engine.authorize(r2.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_ATTESTED",
    );
    expect(L.signer.calls).toHaveLength(0);
  });
  it("expired record -> the review is not ready and cannot be authorized", async () => {
    const L = lane();
    L.clock.t = RECORD.notAfter;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    expect(r.problems).toContain("APPROVAL_EXPIRED");
    const e = await err(() => L.engine.authorize(r.reviewId, OWNER_KEY));
    expect(e.code).toBe("REVIEW_NOT_READY");
    expect(e.detail).toContain("APPROVAL_EXPIRED");
  });
  it("not-yet-valid record -> not ready", async () => {
    const L = lane();
    L.clock.t = RECORD.notBefore - 1;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toContain("NOT_YET_VALID");
    expect(r.ready).toBe(false);
  });
  it("a token never outlives the record (notAfter = min(review expiry, record end))", async () => {
    const record = { ...RECORD, notAfter: NOW + 10_000 };
    const L = lane({ record });
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready, r.problems.join()).toBe(true);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    L.clock.t = NOW + 10_000;
    expect(await code(L.engine.dispatch(t, OWNER_KEY))).toBe("TOKEN_EXPIRED");
    expect(L.signer.calls).toHaveLength(0);
  });
  it("an old read block -> REVIEW_BLOCK_TOO_OLD", async () => {
    const L = lane();
    L.chain.lagSec = 61;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toContain("REVIEW_BLOCK_TOO_OLD");
  });
});

describe("chain facts that keep the review not ready", () => {
  const notReady = async (L: Lane, ...problems: string[]) => {
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    for (const p of problems) expect(r.problems).toContain(p);
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    expect(L.signer.calls).toHaveLength(0);
    return r;
  };
  it("quote disagreement between the operators -> not ready, no dispatch possible", async () => {
    const L = lane();
    L.chain.tamper = (op, method, params, honest) => {
      if (op !== 1 || method !== "eth_call") return undefined;
      const to = (params[0] as { to: string }).to.toLowerCase();
      if (to !== BASE_PINS.quoter.address.toLowerCase()) return undefined;
      const s = honest as string;
      return s.slice(0, 65) + (s[65] === "0" ? "1" : "0") + s.slice(66);
    };
    await notReady(L, "QUOTE_OPERATORS_DISAGREE", "OPERATORS_NOT_PROVEN");
  });
  it("one operator failing the quote -> not ready", async () => {
    const L = lane();
    L.chain.tamper = (op, method, params) => {
      if (
        op === 0 &&
        method === "eth_call" &&
        (params[0] as { to: string }).to.toLowerCase() ===
          BASE_PINS.quoter.address.toLowerCase()
      )
        throw new Error("SIMULATION_FAILED");
      return undefined;
    };
    await notReady(L, "QUOTE_OPERATORS_DISAGREE", "NO_QUOTE");
  });
  it("a balance disagreement -> OPERATORS_DISAGREE:USDC, OPERATORS_NOT_PROVEN", async () => {
    const L = lane();
    L.chain.tamper = (op, method, params, honest) =>
      op === 1 &&
      method === "eth_call" &&
      (params[0] as { to: string; data: string }).to.toLowerCase() === U &&
      (params[0] as { data: string }).data.startsWith("0x70a08231")
        ? "0x" + (BigInt(honest as string) + 1n).toString(16).padStart(64, "0")
        : undefined;
    await notReady(L, "OPERATORS_DISAGREE:USDC", "OPERATORS_NOT_PROVEN");
  });
  it("code hash change -> CODE_CHANGED (both operators) / CODE_DISAGREE (one)", async () => {
    const L = lane();
    L.chain.code.set(R, "0x60806040deadbeef");
    await notReady(L, `CODE_CHANGED:${BASE_PINS.router.address}`);
    const L2 = lane();
    L2.chain.tamper = (op, method, params) =>
      op === 1 &&
      method === "eth_getCode" &&
      (params[0] as string).toLowerCase() === W
        ? "0x00"
        : undefined;
    await notReady(
      L2,
      `CODE_DISAGREE:${BASE_PINS.receive.address}`,
      "OPERATORS_NOT_PROVEN",
    );
    const L3 = lane();
    L3.chain.code.delete(BASE_PINS.pool.address.toLowerCase());
    await notReady(L3, `CODE_CHANGED:${BASE_PINS.pool.address}`);
  });
  it("USDC implementation / factory pool / pool shape changes", async () => {
    const L = lane();
    L.chain.impl = OTHER;
    await notReady(L, "USDC_IMPLEMENTATION_CHANGED");
    const L2 = lane();
    L2.chain.tamper = (_op, method, params) =>
      method === "eth_call" &&
      (params[0] as { to: string }).to.toLowerCase() ===
        BASE_PINS.factory.address.toLowerCase()
        ? "0x" + OTHER.slice(2).padStart(64, "0")
        : undefined;
    await notReady(L2, "FACTORY_POOL_MISMATCH");
    const L3 = lane();
    L3.chain.tamper = (_op, method, params) =>
      method === "eth_call" &&
      (params[0] as { to: string; data: string }).to.toLowerCase() ===
        BASE_PINS.pool.address.toLowerCase() &&
      (params[0] as { data: string }).data === "0xddca3f43"
        ? "0x" + (3000).toString(16).padStart(64, "0")
        : undefined;
    await notReady(L3, "POOL_SHAPE_MISMATCH");
  });
  it("price impact above the lane limit (50 bps) -> not ready; exactly 30 bps is accepted", async () => {
    const L = lane();
    L.chain.quoteOut = quoteAtImpact(50);
    const r = await notReady(L, "PRICE_IMPACT_ABOVE_LANE_LIMIT");
    expect(r.priceImpactBps).toBe(50);
    expect(r.guardian?.level).not.toBe("BLOCK");
    const ok = lane();
    ok.chain.quoteOut = quoteAtImpact(30);
    const r2 = await ok.engine.review(OWNER_KEY);
    expect(r2.priceImpactBps).toBe(30);
    expect(r2.ready, r2.problems.join()).toBe(true);
  });
  it("Guardian BLOCK (quote 15 % under spot: ROUTE_IMPACT critical) -> not ready", async () => {
    const L = lane();
    L.chain.quoteOut = quoteAtImpact(1500);
    const r = await notReady(
      L,
      "BLOCKED_BY_GUARDIAN:BLOCK",
      "PRICE_IMPACT_ABOVE_LANE_LIMIT",
    );
    expect(r.guardian?.level).toBe("BLOCK");
    expect(r.guardian?.findings).toContain("ROUTE_IMPACT:CRITICAL");
  });
  it("Guardian HOLD (4 % impact: ROUTE_IMPACT warning) -> not ready", async () => {
    const L = lane();
    L.chain.quoteOut = quoteAtImpact(400);
    const r = await notReady(L, "BLOCKED_BY_GUARDIAN:HOLD");
    expect(r.guardian?.findings).toContain("ROUTE_IMPACT:WARNING");
  });
  it("a simulation disagreement / a reverting simulation", async () => {
    const L = lane();
    L.chain.tamper = (op, method, _p, honest) => {
      if (op !== 1 || method !== "eth_simulateV1") return undefined;
      const b = structuredClone(honest) as {
        calls: { returnData: string }[];
      }[];
      b[0].calls[4].returnData = "0x" + "0".repeat(64);
      return b;
    };
    await notReady(L, "SIMULATION_OPERATORS_DISAGREE", "OPERATORS_NOT_PROVEN");
    const L2 = lane();
    L2.chain.usdc = 999_999n;
    await notReady(L2, "USDC_BALANCE_BELOW_AMOUNT", "SIMULATION_REVERTED");
  });
  it("simulated output below the minimum / allowance left after the simulated sequence", async () => {
    const L = lane();
    L.chain.tamper = (_op, method, _p, honest) => {
      if (method !== "eth_simulateV1") return undefined;
      const b = structuredClone(honest) as {
        calls: { returnData: string }[];
      }[];
      b[0].calls[5].returnData = "0x" + "0".repeat(64); // WETH balance after
      b[0].calls[6].returnData = "0x" + "1".padStart(64, "0"); // allowance after
      return b;
    };
    await notReady(
      L,
      "SIMULATED_WETH_BELOW_MINIMUM",
      "SIMULATED_ALLOWANCE_LEFT",
    );
  });
  it("an allowance left from before -> ALLOWANCE_NOT_ZERO_BEFORE_APPROVE", async () => {
    const L = lane();
    L.chain.allowance = 1n;
    await notReady(L, "ALLOWANCE_NOT_ZERO_BEFORE_APPROVE");
  });
  it("gas: fees above the budget, a gas need above the cap, too little ETH", async () => {
    const L = lane();
    L.chain.baseFee = 1_000_000_000n;
    await notReady(L, "GAS_BUDGET");
    const L2 = lane();
    L2.chain.gas.SWAP = 300_000n;
    await notReady(L2, "GAS_ABOVE_CAP:SWAP");
    const L3 = lane();
    L3.chain.eth = 1_000n;
    await notReady(L3, "ETH_BELOW_WORST_CASE");
  });
  it("the head block unavailable on one operator -> HEAD_UNAVAILABLE", async () => {
    const L = lane();
    L.chain.tamper = (op, method) =>
      op === 0 && method === "eth_blockNumber" ? null : undefined;
    expect(await code(L.engine.review(OWNER_KEY))).toBe("HEAD_UNAVAILABLE");
  });
});

describe("dispatch outcomes", () => {
  it("gate closed (deps.gate CLOSED) -> GATE_CLOSED journaled, the signer is NOT called", async () => {
    const L = lane({
      gate: () => ({
        state: "CLOSED",
        open: false,
        reasons: ["SWAP_LANE_NOT_WIRED"],
        scope: BASE,
        pinSet: BASE_PINS.set,
      }),
    });
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const e = await err(L.engine.dispatch(t, OWNER_KEY));
    expect(e.code).toBe("SWAP_LANE_GATE_CLOSED");
    expect(e.detail).toEqual(["SWAP_LANE_NOT_WIRED"]);
    expect(L.store.of("GATE_CLOSED").map((x) => x.data)).toEqual([
      { step: "APPROVE", reasons: ["SWAP_LANE_NOT_WIRED"] },
    ]);
    expect(L.signer.calls).toHaveLength(0);
    // nothing left the process, so nothing was spent either (NONCE / USE / PREPARED are written after the gate)
    expect(L.store.of("NONCE")).toHaveLength(0);
    expect(L.store.of("USE")).toHaveLength(0);
    expect(L.store.of("PREPARED")).toHaveLength(0);
  });
  it("without an injected gate the engine uses the PROTECTED gate: closed in this build", async () => {
    const L = lane({ gate: undefined });
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready, r.problems.join()).toBe(true);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const e = await err(L.engine.dispatch(t, OWNER_KEY));
    expect(e.code).toBe("SWAP_LANE_GATE_CLOSED");
    expect(e.detail).toEqual(
      expect.arrayContaining([
        "NO_OWNER_APPROVED_SWAP_LANE",
        "NO_OWNER_SWAP_LANE_KEY",
        "SWAP_LANE_NOT_WIRED",
      ]),
    );
    expect(L.signer.calls).toHaveLength(0);
  });
  it("the REAL signer adapter behind an open engine gate still refuses (its own gate re-run), fetch never called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // the real adapter's send, with the fake signer's status (the preflight passes; the adapter's own gate refuses)
    const status = lane();
    const L = lane({
      share: status,
      signer: {
        send: (a, tx, s) => sendLaneTransaction(a, tx, s),
        status: () => status.signer.status(),
      },
    });
    const r = await L.engine.review(OWNER_KEY);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    const d = await L.engine.dispatch(t, OWNER_KEY);
    expect(d.outcome).toBe("REFUSED_BEFORE_SIGNER");
    expect(d.hash).toBeNull();
    expect(d.problems).toEqual(
      expect.arrayContaining([
        "SWAP_LANE_GATE_CLOSED",
        "NO_OWNER_APPROVED_SWAP_LANE",
        "SWAP_LANE_NOT_WIRED",
      ]),
    );
    expect(L.store.of("DISPATCH").map((x) => x.data)).toEqual([
      expect.objectContaining({
        step: "APPROVE",
        outcome: "REFUSED_BEFORE_SIGNER",
        code: "SWAP_LANE_GATE_CLOSED",
      }),
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe("REFUSED");
  });
  it("signer REFUSED -> journaled, the step is consumed, there is no retry path", async () => {
    const L = lane();
    L.signer.answer = () => ({
      outcome: "REFUSED",
      hash: null,
      problems: ["POLICY_REFUSED"],
    });
    const { token, d } = await step(L);
    expect(d).toEqual({
      step: "APPROVE",
      outcome: "REFUSED",
      hash: null,
      problems: ["POLICY_REFUSED"],
    });
    expect(L.store.of("DISPATCH").map((x) => x.data)).toEqual([
      {
        step: "APPROVE",
        outcome: "REFUSED",
        hash: null,
        problems: ["POLICY_REFUSED"],
      },
    ]);
    expect(L.store.of("USE")).toHaveLength(1);
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe("REFUSED");
    expect(await code(L.engine.dispatch(token, OWNER_KEY))).toBe(
      "TOKEN_REPLAYED",
    );
    const r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("SWAP");
    expect(r.ready).toBe(false);
    expect(r.problems).toContain("APPROVAL_NOT_FINAL");
    // a refusal used no nonce: the journal (0 SENT / UNCERTAIN) still matches the chain
    expect(r.problems).not.toContain("NONCE_NOT_ANCHORED_TO_JOURNAL");
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    expect(L.signer.calls).toHaveLength(1);
  });
  it("signer throws -> REFUSED_BEFORE_SIGNER with its code, step consumed", async () => {
    const L = lane();
    L.signer.answer = () => {
      throw Object.assign(new Error("x"), {
        code: "NO_LOCAL_SIGNER",
        problems: ["P1"],
      });
    };
    const { d } = await step(L);
    expect(d).toEqual({
      step: "APPROVE",
      outcome: "REFUSED_BEFORE_SIGNER",
      hash: null,
      problems: ["NO_LOCAL_SIGNER", "P1"],
    });
    expect(L.engine.nextStep()).toBe("SWAP");
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe("REFUSED");
  });
  it("signer UNCERTAIN -> track reports UNCERTAIN, nothing is resent", async () => {
    const L = lane();
    L.signer.answer = () => ({
      outcome: "UNCERTAIN",
      hash: null,
      problems: ["SIGNER_UNREACHABLE_AFTER_SEND"],
    });
    const { token, d } = await step(L);
    expect(d.outcome).toBe("UNCERTAIN");
    for (let i = 0; i < 3; i++) {
      const t = await L.engine.track();
      expect(stepsOf(t).APPROVE).toEqual({ state: "UNCERTAIN", hash: null });
    }
    expect(
      L.chain.log.some((x) => x.method === "eth_getTransactionReceipt"),
    ).toBe(false);
    expect(await code(L.engine.dispatch(token, OWNER_KEY))).toBe(
      "TOKEN_REPLAYED",
    );
    const r = await L.engine.review(OWNER_KEY);
    expect(r.ready).toBe(false);
    expect(r.problems).toContain("APPROVAL_NOT_FINAL");
    // an UNCERTAIN dispatch MAY have used a nonce; the chain says it did not: never anchored, never ready
    expect(r.problems).toContain("NONCE_NOT_ANCHORED_TO_JOURNAL");
    expect(L.signer.calls).toHaveLength(1);
  });
  it("signer UNCERTAIN with a hash is tracked like SENT (by its hash, never resent) and the lane can continue", async () => {
    const L = lane();
    L.signer.answer = (_s, tx) => ({
      outcome: "UNCERTAIN",
      hash: L.chain.submit(tx),
      problems: ["SIGNER_HTTP_500"],
    });
    const { d } = await step(L);
    expect(d.outcome).toBe("UNCERTAIN");
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe("PENDING");
    settle(L);
    const t = await L.engine.track();
    expect(stepsOf(t).APPROVE).toMatchObject({
      state: "FINAL_SUCCESS",
      hash: d.hash,
    });
    expect(L.store.of("RECEIPT")).toHaveLength(1);
    expect(L.signer.calls).toHaveLength(1);
    // the UNCERTAIN dispatch counts as a used nonce, which the chain confirms: the swap is reviewable
    L.signer.answer = (_s, tx) => ({
      outcome: "SENT",
      hash: L.chain.submit(tx),
      problems: [],
    });
    const r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("SWAP");
    expect(r.problems).toEqual([]);
    expect(r.ready).toBe(true);
  });
  // Regression test for a bug this suite found (FIXED; engine.ts track() summary `state`): an UNCERTAIN / REFUSED /
  // PENDING / REORGED approve used to be summarised as "SWAP_NOT_DISPATCHED" (the APPROVE branch was unreachable).
  it("the summary state names an UNCERTAIN approve (not SWAP_NOT_DISPATCHED)", async () => {
    const L = lane();
    L.signer.answer = () => ({
      outcome: "UNCERTAIN",
      hash: null,
      problems: [],
    });
    await step(L);
    expect((await L.engine.track()).state).toBe("APPROVE_UNCERTAIN");
  });
});

describe("tracking", () => {
  it("receipt status 0 on the approve -> APPROVAL_FAILED (and the swap review refuses)", async () => {
    const L = lane();
    await step(L);
    L.chain.failNext = true;
    settle(L);
    const t = await L.engine.track();
    expect(t.state).toBe("APPROVAL_FAILED");
    expect(stepsOf(t).APPROVE.state).toBe("FINAL_FAILED");
    const r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("SWAP");
    expect(r.problems).toContain("APPROVAL_FAILED");
    expect(r.ready).toBe(false);
  });
  it("receipt status 0 on the swap -> SWAP_FAILED", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    L.chain.failNext = true;
    settle(L);
    const t = await L.engine.track();
    expect(t.state).toBe("SWAP_FAILED");
    expect(t.settlement).toBeNull();
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("tx pending (known by hash, no receipt) -> PENDING", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    const t = await L.engine.track();
    expect(stepsOf(t).SWAP.state).toBe("PENDING");
    expect(t.state).toBe("SWAP_PENDING");
  });
  it("unknown to both operators -> UNKNOWN_TO_BOTH_OPERATORS", async () => {
    const L = lane();
    L.signer.answer = () => ({
      outcome: "SENT",
      hash: "0x" + "77".repeat(32),
      problems: [],
    });
    await step(L);
    settle(L);
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe(
      "UNKNOWN_TO_BOTH_OPERATORS",
    );
  });
  it("operators disagree on the receipt (one has none / another status) -> OPERATORS_DISAGREE", async () => {
    for (const lie of [null, "status"] as const) {
      const L = lane();
      await approved(L);
      await step(L);
      settle(L);
      L.chain.tamper = (op, method, _p, honest) =>
        op === 1 && method === "eth_getTransactionReceipt"
          ? lie === null
            ? null
            : { ...(honest as object), status: "0x0" }
          : undefined;
      const t = await L.engine.track();
      expect(stepsOf(t).SWAP.state).toBe("OPERATORS_DISAGREE");
      // The tamper also hits the (re-read) approval receipt; since the track() fix the approval's own state is
      // reported first, so the lane state is the approval's disagreement — never a settled or a swap-only state.
      expect(stepsOf(t).APPROVE.state).toBe("OPERATORS_DISAGREE");
      expect(t.state).toBe("APPROVE_OPERATORS_DISAGREE");
      expect(L.store.of("SETTLED")).toHaveLength(0);
    }
  });
  it("reorg (the block hash at the receipt's height differs) -> REORGED", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    const n = settle(L);
    L.chain.forks.set(n, "other-branch");
    const t = await L.engine.track();
    expect(stepsOf(t).SWAP.state).toBe("REORGED");
    expect(t.state).toBe("SWAP_REORGED");
    expect(L.store.of("SETTLED")).toHaveLength(0);
    // one operator on another branch is a reorg too
    const L2 = lane();
    await step(L2);
    const n2 = settle(L2);
    L2.chain.tamper = (op, method, params, honest) =>
      op === 1 &&
      method === "eth_getBlockByNumber" &&
      BigInt(params[0] as string) === n2
        ? { ...(honest as object), hash: "0x" + "99".repeat(32) }
        : undefined;
    expect(stepsOf(await L2.engine.track()).APPROVE.state).toBe("REORGED");
  });
  it("a receipt from another sender -> DISCREPANCY_FROM", async () => {
    const L = lane();
    await step(L);
    settle(L);
    L.chain.tamper = (_op, method, _p, honest) =>
      method === "eth_getTransactionReceipt"
        ? { ...(honest as object), from: OTHER }
        : undefined;
    expect(stepsOf(await L.engine.track()).APPROVE.state).toBe(
      "DISCREPANCY_FROM",
    );
  });
  it("settlement discrepancy: WETH in below the minimum -> DISCREPANCY", async () => {
    const L = lane();
    await approved(L);
    const { r } = await step(L);
    settle(L);
    const rc = [...L.chain.receipts.values()].at(-1)!;
    const minOut = BigInt(r.amountOutMinimum);
    rc.logs[0] = L.chain.erc20Log(
      W,
      "Transfer",
      BASE_PINS.pool.address,
      OWNER,
      minOut - 1n,
    );
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(t.settlement).toMatchObject({
      wethIn: (minOut - 1n).toString(),
      problems: ["WETH_IN_BELOW_MINIMUM"],
    });
    // a discrepancy is reported, never journaled as the settlement (only SETTLED_VERIFIED is)
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("settlement discrepancy: allowance left after the swap -> DISCREPANCY", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    settle(L);
    L.chain.allowance = 1n;
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect(t.settlement).toMatchObject({
      allowanceAfter: "1",
      problems: ["ALLOWANCE_LEFT_OR_UNPROVEN"],
    });
  });
  it("settlement discrepancy: USDC out not exact, WETH to another recipient, allowance unproven", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    settle(L);
    const rc = [...L.chain.receipts.values()].at(-1)!;
    rc.logs[1] = L.chain.erc20Log(
      U,
      "Transfer",
      OWNER,
      BASE_PINS.pool.address,
      AMOUNT + 1n,
    );
    rc.logs[0] = L.chain.erc20Log(
      W,
      "Transfer",
      BASE_PINS.pool.address,
      OTHER,
      10n ** 18n,
    );
    L.chain.tamper = (op, method, params) =>
      op === 1 &&
      method === "eth_call" &&
      (params[0] as { data: string }).data.startsWith("0xdd62ed3e")
        ? "0x" + "0".repeat(63) + "1"
        : undefined;
    const t = await L.engine.track();
    expect(t.state).toBe("DISCREPANCY");
    expect((t.settlement as { problems: string[] }).problems).toEqual([
      "USDC_OUT_NOT_EXACT",
      "WETH_IN_BELOW_MINIMUM",
      "ALLOWANCE_LEFT_OR_UNPROVEN",
    ]);
  });
  it("SWAP review before the APPROVE receipt is final -> APPROVAL_NOT_FINAL", async () => {
    const L = lane();
    await step(L);
    // not tracked yet
    let r = await L.engine.review(OWNER_KEY);
    expect(r.step).toBe("SWAP");
    expect(r.problems).toContain("APPROVAL_NOT_FINAL");
    // mined, 4 confirmations: still not final
    L.chain.mine();
    L.chain.advance(3);
    expect(stepsOf(await L.engine.track()).APPROVE).toMatchObject({
      state: "CONFIRMING",
      confirmations: "4",
    });
    r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toContain("APPROVAL_NOT_FINAL");
    expect(r.ready).toBe(false);
    expect(await code(() => L.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    expect(L.signer.calls).toHaveLength(1);
    // final at the route's depth: the swap becomes reviewable
    L.chain.advance(BASE_ROUTE.confirmations - 4);
    await L.engine.track();
    r = await L.engine.review(OWNER_KEY);
    expect(r.ready, r.problems.join()).toBe(true);
  });
  it("the SWAP review requires the allowance to be exactly the amount", async () => {
    const L = lane();
    await approved(L);
    L.chain.allowance = AMOUNT + 1n;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toContain("ALLOWANCE_NOT_EXACT_BEFORE_SWAP");
  });
});

const isCall = (params: readonly unknown[], to: string, prefix = "") => {
  const c = params[0] as { to?: string; data?: string } | undefined;
  return (
    !!c &&
    typeof c === "object" &&
    c.to?.toLowerCase() === to.toLowerCase() &&
    (c.data ?? "").startsWith(prefix)
  );
};
const ORACLE = BASE_PINS.gasPriceOracle!;
const ALLOWANCE = "0xdd62ed3e";

describe("nonce anchoring (the journal is anchored on chain)", () => {
  it("a fresh journal after a completed run is not ready: the chain nonce is firstNonce + 2, the journal says + 0", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    settle(L);
    expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
    expect(L.chain.nonceAt(L.chain.head)).toBe(FIRST_NONCE + 2n);
    // a second engine with an EMPTY journal, same record, same chain (allowance 0, USDC left: everything else fine)
    const F = lane({ share: L });
    const r = await F.engine.review(OWNER_KEY);
    expect(r.step).toBe("APPROVE");
    expect(r.problems).toEqual(["NONCE_NOT_ANCHORED_TO_JOURNAL"]);
    expect(r.ready).toBe(false);
    expect(await code(() => F.engine.authorize(r.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
    expect(F.signer.calls).toHaveLength(0);
  });
  it("a second journal in the middle of a run (after the approve) is not ready either", async () => {
    const L = lane();
    await approved(L);
    const F = lane({ share: L });
    const r = await F.engine.review(OWNER_KEY);
    expect(r.problems).toContain("NONCE_NOT_ANCHORED_TO_JOURNAL");
    expect(r.ready).toBe(false);
    // the original journal still matches (firstNonce + 1 SENT)
    expect((await L.engine.review(OWNER_KEY)).ready).toBe(true);
  });
  it("operators disagreeing on the nonce (at the block or pending) -> not ready", async () => {
    for (const which of ["block", "pending"] as const) {
      const L = lane();
      L.chain.tamper = (op, method, params, honest) =>
        op === 1 &&
        method === "eth_getTransactionCount" &&
        (which === "pending") === (params[1] === "pending")
          ? "0x" + (BigInt(honest as string) + 1n).toString(16)
          : undefined;
      const r = await L.engine.review(OWNER_KEY);
      expect(r.problems, which).toEqual(["NONCE_NOT_ANCHORED_TO_JOURNAL"]);
    }
  });
  it("pending != latest (an owner transaction in flight that the journal does not know) -> not ready", async () => {
    const L = lane();
    L.chain.submit({
      chainId: "0x2105",
      from: OWNER,
      to: OTHER,
      value: "0x1",
      data: "0x",
      gas: "0x5208",
      maxFeePerGas: "0x1",
      maxPriorityFeePerGas: "0x1",
    });
    expect(L.chain.ownerPending()).toBe(1n);
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toEqual(["NONCE_NOT_ANCHORED_TO_JOURNAL"]);
  });
  it("the lane's own transaction still pending -> the next review is not anchored (pending != latest)", async () => {
    const L = lane();
    await step(L);
    const r = await L.engine.review(OWNER_KEY);
    expect(r.problems).toEqual(
      expect.arrayContaining([
        "APPROVAL_NOT_FINAL",
        "NONCE_NOT_ANCHORED_TO_JOURNAL",
      ]),
    );
  });
  it("a nonce read failing on one operator, or a record with another firstNonce -> not ready", async () => {
    const L = lane();
    L.chain.tamper = (op, method) => {
      if (op === 0 && method === "eth_getTransactionCount")
        throw new Error("READ_FAILED");
      return undefined;
    };
    // dry-review item 8: a FAILED read is named as such (still not ready), never as an anchor mismatch
    expect((await L.engine.review(OWNER_KEY)).problems).toEqual([
      "OPERATOR_READ_FAILED:NONCE",
    ]);
    // VEINED-MC1 review MINOR-1: the anchor is the SIGNER's (firstNonce + its signatures on this chain); the record's
    // firstNonce is a lower bound only — a record armed above the chain nonce is refused, one below it is not
    const W2 = lane({ record: { ...RECORD, firstNonce: "8" } });
    expect((await W2.engine.review(OWNER_KEY)).problems).toEqual([
      "NONCE_NOT_ANCHORED_TO_JOURNAL",
    ]);
    for (const firstNonce of ["6", "0"]) {
      const W3 = lane({ record: { ...RECORD, firstNonce } });
      expect((await W3.engine.review(OWNER_KEY)).problems, firstNonce).toEqual(
        [],
      );
    }
    // a signer whose own firstNonce / signature count does not explain the chain nonce -> not anchored
    const W4 = lane();
    W4.signer.tamperStatus = (raw) => {
      const c = (raw.chains as Record<string, { firstNonce: string }>)["8453"];
      c.firstNonce = "6";
      return raw;
    };
    expect((await W4.engine.review(OWNER_KEY)).problems).toEqual([
      "NONCE_NOT_ANCHORED_TO_JOURNAL",
    ]);
  });
});

describe("fees and gas limits", () => {
  it("the tip is the higher operator's, capped at maxTipWei; the fee cap is 3 x base fee + tip", async () => {
    const L = lane();
    L.chain.tamper = (op, method) =>
      op === 1 && method === "eth_maxPriorityFeePerGas"
        ? "0x" + 5_000_000_000n.toString(16)
        : undefined;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.gas.maxPriorityFeePerGas).toBe(BASE_ROUTE.maxTipWei.toString());
    expect(r.gas.maxFeePerGas).toBe(
      (3n * L.chain.baseFee + BASE_ROUTE.maxTipWei).toString(),
    );
    expect(r.ready, r.problems.join()).toBe(true);
    const L2 = lane();
    L2.chain.tamper = (op, method) =>
      op === 0 && method === "eth_maxPriorityFeePerGas"
        ? "0x1e8480"
        : undefined;
    const r2 = await L2.engine.review(OWNER_KEY);
    expect(r2.gas.maxPriorityFeePerGas).toBe("2000000");
    expect(r2.gas.maxFeePerGas).toBe("17000000");
  });
  it("a fee cap above the signer's ceiling (0.2 gwei) -> FEE_CAP_ABOVE_SIGNER_POLICY; exactly at it is accepted", async () => {
    // At the 0.2 gwei ceiling the default gas use would exceed the 1.77e13 wei budget (signer v5): smaller steps keep
    // the budget out of the way so the ceiling itself is what is tested.
    const L = lane();
    L.chain.gas = { APPROVE: 21_000n, SWAP: 50_000n };
    L.chain.tip = 2_000_000n;
    L.chain.baseFee = 66_000_000n; // 3 x 66e6 + 2e6 = 2e8
    const r = await L.engine.review(OWNER_KEY);
    expect(r.gas.maxFeePerGas).toBe(BASE_ROUTE.maxFeePerGasWei.toString());
    expect(r.ready, r.problems.join()).toBe(true);
    const L2 = lane();
    L2.chain.gas = { APPROVE: 21_000n, SWAP: 50_000n };
    L2.chain.tip = 2_000_000n;
    L2.chain.baseFee = 66_000_001n;
    const r2 = await L2.engine.review(OWNER_KEY);
    expect(r2.problems).toEqual(["FEE_CAP_ABOVE_SIGNER_POLICY"]);
    expect(await code(() => L2.engine.authorize(r2.reviewId, OWNER_KEY))).toBe(
      "REVIEW_NOT_READY",
    );
  });
  it("gas limits use the LARGER gasUsed of the two operators' simulations", async () => {
    const L = lane();
    // calls: [usdc, weth, APPROVE, SWAP, usdc, weth, allowance]
    L.chain.tamper = (op, method, _p, honest) => {
      if (method !== "eth_simulateV1") return undefined;
      const b = structuredClone(honest) as { calls: { gasUsed: string }[] }[];
      if (op === 1) b[0].calls[3].gasUsed = "0x" + (200_000).toString(16);
      if (op === 0) b[0].calls[2].gasUsed = "0x" + (60_000).toString(16);
      return b;
    };
    const r = await L.engine.review(OWNER_KEY);
    expect(r.simulation?.gasUsed).toEqual({ APPROVE: "60000", SWAP: "200000" });
    expect(r.gas.limits).toEqual({ APPROVE: "72000", SWAP: "240000" });
    expect(r.ready, r.problems.join()).toBe(true);
    const t = L.engine.authorize(r.reviewId, OWNER_KEY);
    await L.engine.dispatch(t, OWNER_KEY);
    expect(L.signer.calls[0].tx.gas).toBe("0x" + (72_000).toString(16));
  });
  it("a gas limit below 21 000 -> GAS_BELOW_FLOOR:<step>", async () => {
    const L = lane();
    L.chain.gas.APPROVE = 10_000n;
    const r = await L.engine.review(OWNER_KEY);
    expect(r.gas.limits.APPROVE).toBe("12000");
    expect(r.problems).toEqual(["GAS_BELOW_FLOOR:APPROVE"]);
  });
  it("an L1 fee unread on either operator -> L1_FEE_UNPROVEN (never silently 0)", async () => {
    for (const bad of [0, 1] as const)
      for (const answer of ["throw", "0x", null] as const) {
        const L = lane();
        // only getL1Fee (0x49948e0e); the operator fee read (signer v5 Isthmus check) stays honest
        L.chain.tamper = (op, method, params) => {
          if (
            op !== bad ||
            method !== "eth_call" ||
            !isCall(params, ORACLE, "0x49948e0e")
          )
            return undefined;
          if (answer === "throw") throw new Error("SIMULATION_FAILED");
          return answer;
        };
        const r = await L.engine.review(OWNER_KEY);
        expect(r.problems, bad + ":" + String(answer)).toEqual([
          "L1_FEE_UNPROVEN",
        ]);
        expect(r.ready).toBe(false);
      }
  });
});

describe("tracking: receipts, the transaction itself, the allowance", () => {
  it("a log difference between the operators' receipts -> OPERATORS_DISAGREE", async () => {
    const L = lane();
    await approved(L);
    const { d } = await step(L);
    settle(L);
    L.chain.tamper = (op, method, params, honest) => {
      if (
        op !== 1 ||
        method !== "eth_getTransactionReceipt" ||
        params[0] !== d.hash
      )
        return undefined;
      const r = structuredClone(honest) as { logs: { data: string }[] };
      r.logs[0].data = "0x" + "0".repeat(63) + "1";
      return r;
    };
    const t = await L.engine.track();
    expect(stepsOf(t).SWAP.state).toBe("OPERATORS_DISAGREE");
    expect(t.state).toBe("SWAP_OPERATORS_DISAGREE");
    expect(L.store.of("SETTLED")).toHaveLength(0);
  });
  it("a gasUsed difference (or a dropped log) between the receipts -> OPERATORS_DISAGREE", async () => {
    for (const change of ["gas", "drop"] as const) {
      const L = lane();
      await step(L);
      settle(L);
      L.chain.tamper = (op, method, _p, honest) => {
        if (op !== 0 || method !== "eth_getTransactionReceipt")
          return undefined;
        const r = structuredClone(honest) as {
          gasUsed: string;
          logs: unknown[];
        };
        if (change === "gas") r.gasUsed = "0x1";
        else r.logs = [];
        return r;
      };
      expect(stepsOf(await L.engine.track()).APPROVE.state, change).toBe(
        "OPERATORS_DISAGREE",
      );
      expect(L.store.of("RECEIPT")).toHaveLength(0);
    }
  });
  it("after a final receipt the transaction must be the PREPARED one (from / to / input) -> else DISCREPANCY_TX", async () => {
    const cases: [
      string,
      (op: 0 | 1, x: Record<string, unknown>) => unknown,
    ][] = [
      ["input on both", (_op, x) => ({ ...x, input: String(x.input) + "00" })],
      ["to on one", (op, x) => (op === 1 ? { ...x, to: OTHER } : undefined)],
      ["from on both", (_op, x) => ({ ...x, from: OTHER })],
      ["unknown by hash", () => null],
    ];
    for (const [name, lie] of cases) {
      const L = lane();
      await step(L);
      settle(L);
      L.chain.tamper = (op, method, _p, honest) =>
        method === "eth_getTransactionByHash" && honest
          ? lie(op, honest as Record<string, unknown>)
          : undefined;
      const t = await L.engine.track();
      expect(stepsOf(t).APPROVE.state, name).toBe("DISCREPANCY_TX");
      expect(t.state).toBe("APPROVE_DISCREPANCY_TX");
      expect(L.store.of("RECEIPT")).toHaveLength(0);
    }
  });
  it("a settlement DISCREPANCY is not journaled; a later verified settlement is journaled once", async () => {
    const L = lane();
    await approved(L);
    await step(L);
    settle(L);
    L.chain.allowance = 1n;
    expect((await L.engine.track()).state).toBe("DISCREPANCY");
    expect((await L.engine.track()).state).toBe("DISCREPANCY");
    expect(L.store.of("SETTLED")).toHaveLength(0);
    L.chain.allowance = 0n;
    expect((await L.engine.track()).state).toBe("SETTLED_VERIFIED");
    await L.engine.track();
    expect(
      L.store.of("SETTLED").map((x) => (x.data as { state: string }).state),
    ).toEqual(["SETTLED_VERIFIED"]);
  });
  it("track() reports the current allowance at (lower head - 1), with the operators' agreement", async () => {
    const L = lane();
    const t0 = await L.engine.track();
    expect(t0.state).toBe("APPROVE_NOT_DISPATCHED");
    expect(t0.allowance).toEqual({ value: "0", agree: true });
    // the operators' heads differ: the read block is the LOWER head minus one
    L.chain.tamper = (op, method) =>
      op === 1 && method === "eth_blockNumber"
        ? "0x" + (L.chain.head - 5n).toString(16)
        : undefined;
    await L.engine.track();
    const last = L.chain.log
      .filter(
        (x) =>
          x.method === "eth_call" &&
          isCall(x.params, BASE_PINS.pay.address, ALLOWANCE),
      )
      .at(-1);
    expect(last?.params[1]).toBe("0x" + (L.chain.head - 6n).toString(16));
    L.chain.tamper = (op, method, params) =>
      op === 1 &&
      method === "eth_call" &&
      isCall(params, BASE_PINS.pay.address, ALLOWANCE)
        ? "0x" + "0".repeat(63) + "5"
        : undefined;
    expect((await L.engine.track()).allowance).toEqual({
      value: null,
      agree: false,
    });
    expect(L.chain.violations).toEqual([]);
  });
});

describe("construction", () => {
  it("the engine needs no network: a review against the fakes made only lane-shaped reads", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const L = lane();
    await L.engine.review(OWNER_KEY);
    expect(L.chain.violations).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
