// G7 pilot harness tests: owner-scope bounds, intent digest, one-shot session state machine, persistent lock,
// localhost HTTP security envelope and the static safety scan. Fixture sources only — no network, no wallet.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gasPlan } from "../../src/g7/prep";
import {
  decodeBridgeTokenIndependent,
  encodeBridgeTokenIndependent,
} from "../../src/g7/decoder";
import { NATIVE, PILOT_EOA, SUPERSEDED_PILOT_EOAS } from "../../src/g7/policy";
import { g7LocalPilotGate } from "../../src/server/g7-local-pilot";
import {
  G7_PILOT_PROFILES,
  PHASE_PRODUCTION_BUILD,
  PHASE_PRODUCTION_SERVER,
  g7BuildProfile,
} from "../../next.config";
import * as nextConstants from "next/constants";
import {
  EXPECT,
  verifyReview,
  type PilotReview,
} from "../../scripts/g7-pilot/product/verify";
import {
  fixtureTracker,
  type FixtureScenario,
} from "../../scripts/g7-pilot/fixture";
import { fixturePreflight, candidateSelection } from "../fixtures/g7-candidate";
import {
  maximumWalletDebit,
  pilotIntentDigest,
  pilotQuote,
  pilotScopeGates,
  walletTx,
  type PilotFees,
} from "../../scripts/g7-pilot/intent";
import {
  ARM_MAX_QUOTE_AGE_MS,
  BUTTON_LABEL,
  CONFIRMATION_PHRASE,
  MOCK_WALLET_RDNS,
  PILOT_BOUNDS,
  PILOT_SCOPE,
} from "../../scripts/g7-pilot/policy";
import {
  combineGates,
  type PreflightOutcome,
} from "../../scripts/g7-pilot/preflight";
import {
  PilotError,
  PilotSession,
  assertReviewConsistent,
  fileLockStore,
} from "../../scripts/g7-pilot/session";
import {
  CSP,
  startPilotServer,
  type PilotServer,
} from "../../scripts/g7-pilot/server";
import { scanG7Pilot } from "../../scripts/g7-pilot-safety";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { pilotApi, listenLoopback } from "../../scripts/g7-pilot/server";

const ONE = 10n ** 18n;
const WALLET = { account: PILOT_EOA, chainId: "0x956d7" };
const CONFIRM = { scope: true, trust: true, phrase: CONFIRMATION_PHRASE };
const dirs: string[] = [];
const sessions: PilotSession[] = [];
const servers: PilotServer[] = [];
afterEach(async () => {
  for (const s of sessions.splice(0)) s.stop();
  for (const s of servers.splice(0)) await s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "g7-pilot-"));
  dirs.push(d);
  return d;
};
function makeSession(
  scenario: FixtureScenario,
  opts: {
    mode?: "real" | "dry-run";
    lockPath?: string;
    now?: () => number;
    ttlMs?: number;
  } = {},
) {
  const mode = opts.mode ?? "real";
  const lockPath = opts.lockPath ?? join(tempDir(), "lock.json");
  const events: { event: string; data?: Record<string, unknown> }[] = [];
  const s = new PilotSession({
    mode,
    fixture: true,
    preflight: fixturePreflight(scenario, opts.now),
    tracker: fixtureTracker(scenario),
    lock: mode === "real" ? fileLockStore(lockPath) : null,
    journal: (event, data) => events.push({ event, data }),
    now: opts.now,
    ttlMs: opts.ttlMs,
    trackIntervalMs: 5,
    detectIntervalMs: 5,
  });
  sessions.push(s);
  return { s, events, lockPath };
}
const digestOf = (s: PilotSession) => s.latest!.review!.intentDigest;
async function armable(s: PilotSession) {
  await s.start();
  expect(s.state).toBe("READY");
  const fin = await s.final({
    intentDigest: digestOf(s),
    confirmations: CONFIRM,
    wallet: WALLET,
  });
  expect(fin.outcome).toBe("ARMABLE");
  return fin as typeof fin & { candidateId: string };
}
const waitFor = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("G7 pilot — owner scope bounds (S1-S6)", () => {
  const gas = gasPlan(
    126551n,
    [4_000_000_000n],
    [3_000_000_000n],
    1_000_000_000n,
  );
  const side = {
    block: 1,
    blockHash: "0x" + "aa".repeat(32),
    blockTimestamp: 1,
  };
  const evaluate = (
    fees: PilotFees,
    g = gas,
    mutateData?: (d: string) => string,
  ) => {
    const q = pilotQuote(fees, 1000, side);
    const data = encodeBridgeTokenIndependent({
      toChainID: 56n,
      fromToken: NATIVE,
      to: PILOT_EOA,
      value: q.amount,
      networkFee: q.networkFee,
      exFee: q.serviceFee,
      extraData: "0x",
    });
    const tx = walletTx(q, g, mutateData ? mutateData(data) : data);
    return { gates: pilotScopeGates({ fees, quote: q, gas: g, tx }), q, tx };
  };
  const base: PilotFees = {
    minimum: 5n * ONE,
    networkFee: 18n * 10n ** 16n,
    serviceFee: 0n,
  };
  const status = (gates: ReturnType<typeof pilotScopeGates>) =>
    combineGates(gates).status;

  it("the reviewed exposure is exactly at the bounds and passes", () => {
    const { gates, q, tx } = evaluate(base);
    expect(status(gates)).toBe("READY");
    expect(q.amount).toBe(5n * ONE);
    expect(q.value).toBe(5_180_000_000_000_000_000n);
    expect(maximumWalletDebit(q, gas)).toBe(PILOT_BOUNDS.maxWalletDebit);
    expect(tx).toEqual({
      from: PILOT_EOA,
      to: PILOT_SCOPE.contract,
      value: "0x47e30e8e20860000",
      data: tx.data,
      gas: "0x25136",
      maxFeePerGas: "0x12a05f200",
      maxPriorityFeePerGas: "0xb2d05e00",
      chainId: "0x956d7",
    });
  });
  it("principal is always exactly 5 ONE regardless of a lower minimum", () => {
    const { q } = evaluate({ ...base, minimum: 4n * ONE });
    expect(q.amount).toBe(5n * ONE);
  });
  it.each([
    [
      "network fee 0.18 ONE + 1 wei",
      { ...base, networkFee: base.networkFee + 1n },
      "S4",
    ],
    ["minimum 5 ONE + 1 wei", { ...base, minimum: 5n * ONE + 1n }, "S3"],
    ["service fee 1 wei", { ...base, serviceFee: 1n }, "S5"],
  ])("%s => OWNER_REAPPROVAL_REQUIRED", (_, fees, gate) => {
    const { gates } = evaluate(fees);
    expect(status(gates)).toBe("OWNER_REAPPROVAL_REQUIRED");
    expect(gates.find((g) => g.id === gate)!.status).toBe(
      "OWNER_REAPPROVAL_REQUIRED",
    );
  });
  it("maximum wallet debit above 5.18075931 ONE (gas estimate +1) => OWNER_REAPPROVAL_REQUIRED", () => {
    const g = gasPlan(
      126552n,
      [4_000_000_000n],
      [3_000_000_000n],
      1_000_000_000n,
    );
    const { gates } = evaluate(base, g);
    expect(gates.find((x) => x.id === "S6")!.status).toBe(
      "OWNER_REAPPROVAL_REQUIRED",
    );
  });
  it("maximum wallet debit above the bound (tip +1 wei) => OWNER_REAPPROVAL_REQUIRED", () => {
    const g = gasPlan(
      126551n,
      [4_000_000_000n],
      [3_000_000_001n],
      1_000_000_000n,
    );
    expect(status(evaluate(base, g).gates)).toBe("OWNER_REAPPROVAL_REQUIRED");
  });
  it.each([
    [
      "recipient replaced",
      (d: string) => d.replace(PILOT_EOA.slice(2), "11".repeat(20)),
    ],
    [
      "destination chain 97",
      (d: string) =>
        d.slice(0, 10) + (97).toString(16).padStart(64, "0") + d.slice(74),
    ],
    [
      "extraData non-empty",
      (d: string) =>
        d.slice(0, -64) + "1".padStart(64, "0") + "01".padEnd(64, "0"),
    ],
  ])("%s => FAIL (BLOCKED)", (_, mutate) => {
    expect(status(evaluate(base, gas, mutate).gates)).toBe("BLOCKED");
  });
});

describe("G7 pilot — preflight composition through the reviewed gates (fixture data)", () => {
  it.each([
    ["ready", "READY"],
    ["fee-above-bound", "OWNER_REAPPROVAL_REQUIRED"],
    ["minimum-above-bound", "OWNER_REAPPROVAL_REQUIRED"],
    ["service-fee", "OWNER_REAPPROVAL_REQUIRED"],
    ["debit-above-bound", "OWNER_REAPPROVAL_REQUIRED"],
    ["drift", "BLOCKED"],
    ["authority-drift", "BLOCKED"],
    ["reserve-failure", "BLOCKED"],
    ["pending-obligation", "BLOCKED"],
    ["in-flight-unenumerated", "BLOCKED"],
  ] as const)("%s => %s", async (scenario, expected) => {
    const o = await fixturePreflight(scenario).run("initial");
    expect(o.status).toBe(expected);
    if (expected === "READY") {
      expect(o.gates.every((g) => g.status === "PASS")).toBe(true);
      expect(o.gates.map((g) => g.id)).toEqual([
        ...Array.from({ length: 20 }, (_, i) => `P${i + 1}`),
        "R1",
        ...Array.from({ length: 8 }, (_, i) => `S${i + 1}`),
      ]);
    }
  });
  it("the ready transaction equals the reviewed V1.7 package calldata except the recipient (EOA change)", async () => {
    const o = await fixturePreflight("ready").run("initial");
    const d = decodeBridgeTokenIndependent(o.review!.tx.data);
    expect(d).toMatchObject({
      toChainID: 56n,
      value: 5n * ONE,
      networkFee: 18n * 10n ** 16n,
      exFee: 0n,
      extraData: "0x",
    });
    if (existsSync("G7_UNSIGNED_TRANSACTION.json")) {
      const pkg = JSON.parse(
        readFileSync("G7_UNSIGNED_TRANSACTION.json", "utf8"),
      );
      // The V1.7 package is the superseded old-EOA package: swapping only the recipient word reproduces it.
      expect(pkg.from).toBe(SUPERSEDED_PILOT_EOAS[0]);
      expect(
        o.review!.tx.data.replace(PILOT_EOA.slice(2), pkg.from.slice(2)),
      ).toBe(pkg.data);
      expect(o.review!.tx.data).not.toBe(pkg.data);
      expect(o.review!.tx.value).toBe(pkg.valueHex);
      expect(BigInt(o.review!.tx.gas).toString()).toBe(pkg.recommendedGasLimit);
    }
  });
  it("the intent digest ignores quote time/block but binds every transaction byte", async () => {
    const a = (await fixturePreflight("ready").run("initial")).review!;
    await new Promise((r) => setTimeout(r, 5));
    const b = (await fixturePreflight("ready").run("final")).review!;
    expect(b.quote.observedAt).not.toBe(a.quote.observedAt);
    expect(b.intentDigest).toBe(a.intentDigest);
    expect(pilotIntentDigest(a.intent)).toBe(a.intentDigest);
    for (const mutate of [
      (i: typeof a.intent) => ({ ...i, gasLimit: "151863" }),
      (i: typeof a.intent) => ({ ...i, maxFeePerGas: "5000000001" }),
      (i: typeof a.intent) => ({ ...i, recipient: "0x" + "11".repeat(20) }),
      (i: typeof a.intent) => ({
        ...i,
        trustModelAccepted: false as unknown as true,
      }),
      (i: typeof a.intent) => ({
        ...i,
        trust: { ...i.trust, source: { ...i.trust.source, threshold: 1 } },
      }),
    ])
      expect(pilotIntentDigest(mutate(a.intent))).not.toBe(a.intentDigest);
  });
  it("assertReviewConsistent detects any mismatch between the intent and the transaction", async () => {
    const r = (await fixturePreflight("ready").run("initial")).review!;
    expect(() => assertReviewConsistent(r)).not.toThrow();
    expect(() =>
      assertReviewConsistent({
        ...r,
        tx: { ...r.tx, value: "0x47e30e8e20860001" },
      }),
    ).toThrow(/REVIEW_INCONSISTENT/);
    expect(() =>
      assertReviewConsistent({ ...r, tx: { ...r.tx, gas: "0x25137" } }),
    ).toThrow(/gas/);
    expect(() =>
      assertReviewConsistent({ ...r, intentDigest: "0".repeat(64) }),
    ).toThrow(/digest/);
  });
});

describe("G7 pilot — one-shot session", () => {
  it("dry-run: the final step is fully verified but never releases a send capability or a lock", async () => {
    const { s, lockPath } = makeSession("ready", { mode: "dry-run" });
    const fin = await armable(s);
    const r = s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    });
    expect(r.dryRun).toBe(true);
    expect("armId" in r).toBe(false);
    expect(s.state).toBe("DRY_RUN_COMPLETE");
    expect(existsSync(lockPath)).toBe(false);
    expect(() =>
      s.walletOutcome({
        armId: "arm-0000000000000000",
        outcome: "TX_HASH",
        txHash: "0x" + "ab".repeat(32),
      }),
    ).toThrow(PilotError);
  });
  it("real: arming consumes the capability durably before releasing the tx, exactly once", async () => {
    const { s, lockPath, events } = makeSession("ready");
    const fin = await armable(s);
    const r = s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    });
    expect(r.dryRun).toBe(false);
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    expect(lock).toMatchObject({
      state: "ARMED",
      intentDigest: digestOf(s),
      txHash: null,
    });
    expect(lock.tx).toEqual((r as { tx: unknown }).tx);
    expect(s.snapshot().sendCapability).toBe(false);
    expect(() =>
      s.arm({
        candidateId: fin.candidateId,
        intentDigest: digestOf(s),
        wallet: WALLET,
      }),
    ).toThrow(/ARM_NOT_ALLOWED/);
    await expect(
      s.final({
        intentDigest: digestOf(s),
        confirmations: CONFIRM,
        wallet: WALLET,
      }),
    ).rejects.toThrow(/FINAL_NOT_ALLOWED/);
    await expect(s.refresh()).rejects.toThrow(/REFRESH_NOT_ALLOWED/);
    expect(events.map((e) => e.event)).toContain("ARMED");
    expect(JSON.stringify(events)).not.toContain(s.token);
  });
  it("tx hash => SENT => read-only tracking => G7_PASS only with exact on-chain evidence", async () => {
    const { s, lockPath } = makeSession("ready");
    const fin = await armable(s);
    const r = s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    }) as { armId: string };
    const hash = "0x" + "ab".repeat(32);
    s.walletOutcome({ armId: r.armId, outcome: "TX_HASH", txHash: hash });
    expect(s.state).toBe("SENT");
    expect(() =>
      s.walletOutcome({ armId: r.armId, outcome: "TX_HASH", txHash: hash }),
    ).toThrow(/NOT_ACCEPTED/);
    await waitFor(() => s.state === "G7_PASS");
    const snap = s.snapshot();
    expect(snap.tracking!.g7Pass).toBe(true);
    expect(snap.tracking!.txCheck.exact).toBe(true);
    expect(snap.tracking!.destination.payout!.amount).toBe(
      (5n * ONE).toString(),
    );
    expect(JSON.parse(readFileSync(lockPath, "utf8"))).toMatchObject({
      state: "G7_PASS",
      txHash: hash,
      hashSource: "wallet",
    });
  });
  it("a mined transaction that differs from the armed one is MANUAL_REVIEW, never G7_PASS", async () => {
    const { s } = makeSession("mined-mismatch");
    const fin = await armable(s);
    const r = s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    }) as { armId: string };
    s.walletOutcome({
      armId: r.armId,
      outcome: "TX_HASH",
      txHash: "0x" + "ab".repeat(32),
    });
    await waitFor(() =>
      (s.snapshot().tracking?.reasons.join() ?? "").includes(
        "MINED_TRANSACTION_VALUE",
      ),
    );
    await new Promise((r2) => setTimeout(r2, 50));
    expect(s.state).toBe("SENT");
    expect(s.snapshot().tracking!.status).toBe("MANUAL_REVIEW_REQUIRED");
    expect(s.snapshot().tracking!.g7Pass).toBe(false);
  });
  it.each([
    ["USER_REJECTED", "USER_REJECTED"],
    ["PROVIDER_ERROR", "MANUAL_REVIEW_REQUIRED"],
    ["ABORTED_BEFORE_WALLET_REQUEST", "ABORTED_BEFORE_WALLET_REQUEST"],
  ] as const)(
    "wallet outcome %s => %s, terminal, no retry",
    async (outcome, state) => {
      const { s, lockPath } = makeSession("ready");
      const fin = await armable(s);
      const r = s.arm({
        candidateId: fin.candidateId,
        intentDigest: digestOf(s),
        wallet: WALLET,
      }) as { armId: string };
      s.walletOutcome({
        armId: r.armId,
        outcome,
        errorCode: outcome === "USER_REJECTED" ? 4001 : -32603,
      });
      expect(s.state).toBe(state);
      expect(s.snapshot().terminal).toBe(true);
      expect(JSON.parse(readFileSync(lockPath, "utf8")).state).toBe(state);
      await expect(
        s.final({
          intentDigest: digestOf(s),
          confirmations: CONFIRM,
          wallet: WALLET,
        }),
      ).rejects.toThrow(PilotError);
      await expect(s.refresh()).rejects.toThrow(PilotError);
    },
  );
  it("an invalid hash from the wallet is MANUAL_REVIEW_REQUIRED", async () => {
    const { s } = makeSession("ready");
    const fin = await armable(s);
    const r = s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    }) as { armId: string };
    s.walletOutcome({ armId: r.armId, outcome: "TX_HASH", txHash: "0x1234" });
    expect(s.state).toBe("MANUAL_REVIEW_REQUIRED");
  });
  it("no hash but a transfer from the EOA appears on chain => adopted read-only, MANUAL_REVIEW_REQUIRED", async () => {
    const { s } = makeSession("orphan");
    const fin = await armable(s);
    s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(s),
      wallet: WALLET,
    });
    await waitFor(() => s.snapshot().hashSource === "chain-detected");
    expect(s.state).toBe("MANUAL_REVIEW_REQUIRED");
    expect(s.snapshot().txHash).toBe("0x" + "cd".repeat(32));
  });
  it("an existing lock (previous run) => LOCKED: no preflight, no final, no arm", async () => {
    const first = makeSession("ready");
    const fin = await armable(first.s);
    first.s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(first.s),
      wallet: WALLET,
    });
    const second = makeSession("ready", { lockPath: first.lockPath });
    expect(second.s.state).toBe("LOCKED");
    await second.s.start();
    expect(second.s.latest).toBeNull();
    expect(second.s.snapshot().sendCapability).toBe(false);
    await expect(
      second.s.final({
        intentDigest: "0".repeat(64),
        confirmations: CONFIRM,
        wallet: WALLET,
      }),
    ).rejects.toThrow(/FINAL_NOT_ALLOWED_IN_LOCKED/);
  });
  it("two live sessions sharing the lock: only one can ever arm", async () => {
    const a = makeSession("ready");
    const b = makeSession("ready", { lockPath: a.lockPath });
    const fa = await armable(a.s);
    const fb = await armable(b.s);
    a.s.arm({
      candidateId: fa.candidateId,
      intentDigest: digestOf(a.s),
      wallet: WALLET,
    });
    expect(() =>
      b.s.arm({
        candidateId: fb.candidateId,
        intentDigest: digestOf(b.s),
        wallet: WALLET,
      }),
    ).toThrow(/ALREADY_ARMED_LOCK_EXISTS/);
    expect(b.s.state).toBe("LOCKED");
  });
  it.each([
    [
      "missing scope checkbox",
      { ...CONFIRM, scope: false },
      WALLET,
      /CONFIRMATIONS_MISSING/,
    ],
    [
      "missing trust checkbox",
      { ...CONFIRM, trust: false },
      WALLET,
      /CONFIRMATIONS_MISSING/,
    ],
    ["phrase not exact", { ...CONFIRM, phrase: "g7 5 one" }, WALLET, /PHRASE/],
    [
      "phrase with whitespace",
      { ...CONFIRM, phrase: " G7 5 ONE" },
      WALLET,
      /PHRASE/,
    ],
    [
      "wrong account",
      CONFIRM,
      { ...WALLET, account: "0x" + "11".repeat(20) },
      /ACCOUNT/,
    ],
    ["wrong chain", CONFIRM, { ...WALLET, chainId: "0x38" }, /CHAIN/],
  ])(
    "final refused without consuming anything: %s",
    async (_, confirmations, wallet, err) => {
      const { s, lockPath } = makeSession("ready");
      await s.start();
      await expect(
        s.final({ intentDigest: digestOf(s), confirmations, wallet }),
      ).rejects.toThrow(err);
      expect(s.state).toBe("READY");
      expect(s.snapshot().sendCapability).toBe(true);
      expect(existsSync(lockPath)).toBe(false);
    },
  );
  it("a client digest that is not the latest review is refused", async () => {
    const { s } = makeSession("ready");
    await s.start();
    await expect(
      s.final({
        intentDigest: "0".repeat(64),
        confirmations: CONFIRM,
        wallet: WALLET,
      }),
    ).rejects.toThrow(/CLIENT_INTENT_NOT_LATEST_REVIEW/);
  });
  it("fresh final quote changes the transaction => INTENT_CHANGED (nothing consumed), new review can proceed", async () => {
    const { s, lockPath } = makeSession("final-intent-changed");
    await s.start();
    const before = digestOf(s);
    const r1 = await s.final({
      intentDigest: before,
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r1.outcome).toBe("INTENT_CHANGED");
    expect(s.state).toBe("READY");
    expect(digestOf(s)).not.toBe(before);
    expect(existsSync(lockPath)).toBe(false);
    const r2 = await s.final({
      intentDigest: digestOf(s),
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r2.outcome).toBe("ARMABLE");
  });
  it("fresh final quote exceeds a bound => OWNER_REAPPROVAL_REQUIRED, terminal, nothing armed", async () => {
    const { s, lockPath } = makeSession("final-reapproval");
    await s.start();
    const r = await s.final({
      intentDigest: digestOf(s),
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r.outcome).toBe("OWNER_REAPPROVAL_REQUIRED");
    expect(s.state).toBe("OWNER_REAPPROVAL_REQUIRED");
    expect(s.snapshot().sendCapability).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    await expect(s.refresh()).rejects.toThrow(PilotError);
  });
  it("final quote older than 17 s at decision => QUOTE_TOO_OLD; older than 20 s => BLOCKED", async () => {
    const slow = makeSession("final-slow");
    await slow.s.start();
    const r = await slow.s.final({
      intentDigest: digestOf(slow.s),
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r.outcome).toBe("QUOTE_TOO_OLD");
    expect(slow.s.state).toBe("READY");
    const stale = makeSession("final-stale");
    await stale.s.start();
    const r2 = await stale.s.final({
      intentDigest: digestOf(stale.s),
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r2.outcome).toBe("BLOCKED");
    expect(
      (stale.s.latest as PreflightOutcome).gates.find((g) => g.id === "P19")!
        .status,
    ).toBe("FAIL");
  });
  it("arm after the candidate aged beyond 17 s is refused and consumes nothing", async () => {
    let t = Date.now();
    const { s, lockPath } = makeSession("ready", { now: () => t });
    const fin = await armable(s);
    t += ARM_MAX_QUOTE_AGE_MS; // the fixture quote was already 4 s old
    expect(() =>
      s.arm({
        candidateId: fin.candidateId,
        intentDigest: digestOf(s),
        wallet: WALLET,
      }),
    ).toThrow(/QUOTE_TOO_OLD/);
    expect(s.state).toBe("READY");
    expect(existsSync(lockPath)).toBe(false);
  });
  it("arm with a different candidate or digest is refused", async () => {
    const { s } = makeSession("ready");
    const fin = await armable(s);
    expect(() =>
      s.arm({
        candidateId: "cand-0000000000000000",
        intentDigest: digestOf(s),
        wallet: WALLET,
      }),
    ).toThrow(/CANDIDATE_MISMATCH/);
    expect(() =>
      s.arm({
        candidateId: fin.candidateId,
        intentDigest: "f".repeat(64),
        wallet: WALLET,
      }),
    ).toThrow(/CANDIDATE_MISMATCH/);
  });
  it("an expired session cannot arm", async () => {
    let t = Date.now();
    const { s } = makeSession("ready", { now: () => t, ttlMs: 60_000 });
    await s.start();
    t += 61_000;
    const r = await s.final({
      intentDigest: digestOf(s),
      confirmations: CONFIRM,
      wallet: WALLET,
    });
    expect(r.outcome).toBe("EXPIRED");
    expect(s.state).toBe("EXPIRED");
  });
});

describe("G7 pilot — localhost HTTP security envelope", () => {
  async function boot() {
    const { s } = makeSession("ready", { mode: "dry-run" });
    const srv = await startPilotServer(s, 0, () => undefined);
    servers.push(srv);
    return { s, srv };
  }
  function call(
    srv: PilotServer,
    opts: {
      method?: string;
      path?: string;
      headers?: Record<string, string>;
      body?: string;
    },
  ): Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: srv.port,
          method: opts.method ?? "POST",
          path: opts.path ?? "/api/state",
          headers: opts.headers,
        },
        (res) => {
          let body = "";
          res.on("data", (c) => (body += c));
          res.on("end", () =>
            resolve({ status: res.statusCode!, headers: res.headers, body }),
          );
        },
      );
      req.on("error", reject);
      if (opts.body !== undefined) req.write(opts.body);
      req.end();
    });
  }
  const good = (srv: PilotServer, s: PilotSession, csrf?: string) => ({
    host: `127.0.0.1:${srv.port}`,
    origin: srv.origin,
    "content-type": "application/json",
    authorization: `Bearer ${s.token}`,
    ...(csrf ? { "x-g7-csrf": csrf } : {}),
  });
  it("binds 127.0.0.1 only", async () => {
    const { srv } = await boot();
    const a = srv.server.address();
    expect(typeof a === "object" && a?.address).toBe("127.0.0.1");
  });
  it("static page: strict CSP with frame-ancestors 'none', no-store, DENY framing, no CORS", async () => {
    const { srv } = await boot();
    const r = await call(srv, {
      method: "GET",
      path: "/",
      headers: { host: `127.0.0.1:${srv.port}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-security-policy"]).toBe(CSP);
    expect(CSP).toContain("frame-ancestors 'none'");
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).not.toContain("unsafe");
    expect(r.headers["cache-control"]).toContain("no-store");
    expect(r.headers["x-frame-options"]).toBe("DENY");
    expect(
      Object.keys(r.headers).some((h) => h.startsWith("access-control")),
    ).toBe(false);
  });
  it("exact Host required (DNS rebinding), even for static files", async () => {
    const { srv } = await boot();
    for (const host of [
      "localhost:" + srv.port,
      "evil.example:" + srv.port,
      "127.0.0.1",
    ])
      expect(
        (await call(srv, { method: "GET", path: "/", headers: { host } }))
          .status,
      ).toBe(421);
  });
  it("API: exact Origin, bearer token, CSRF, JSON, strict body; claim rotates CSRF", async () => {
    const { s, srv } = await boot();
    const claim = await call(srv, {
      path: "/api/claim",
      headers: good(srv, s),
      body: "{}",
    });
    expect(claim.status).toBe(200);
    const csrf = JSON.parse(claim.body).csrf as string;
    expect(JSON.parse(claim.body).sessionId).toBe(s.id);
    expect(
      (await call(srv, { headers: good(srv, s, csrf), body: "{}" })).status,
    ).toBe(200);
    const h = good(srv, s, csrf);
    const cases: [Record<string, string>, number][] = [
      [{ ...h, origin: "http://evil.example" }, 403],
      [{ ...h, origin: `http://localhost:${srv.port}` }, 403],
      [
        Object.fromEntries(Object.entries(h).filter(([k]) => k !== "origin")),
        403,
      ],
      [{ ...h, "sec-fetch-site": "cross-site" }, 403],
      [{ ...h, authorization: "Bearer " + "x".repeat(43) }, 401],
      [
        Object.fromEntries(
          Object.entries(h).filter(([k]) => k !== "authorization"),
        ),
        401,
      ],
      [{ ...h, "x-g7-csrf": "nope" }, 403],
      [{ ...h, "content-type": "text/plain" }, 415],
    ];
    for (const [headers, status] of cases)
      expect((await call(srv, { headers, body: "{}" })).status).toBe(status);
    expect((await call(srv, { headers: h, body: '{"extra":1}' })).status).toBe(
      400,
    );
    expect((await call(srv, { headers: h, body: "{" })).status).toBe(400);
    expect(
      (
        await call(srv, {
          headers: h,
          body: JSON.stringify({ pad: "x".repeat(20000) }),
        })
      ).status,
    ).toBe(413);
    expect(
      (await call(srv, { path: "/api/nope", headers: h, body: "{}" })).status,
    ).toBe(404);
    // a new claim (another tab) invalidates the old CSRF token
    await call(srv, { path: "/api/claim", headers: good(srv, s), body: "{}" });
    expect((await call(srv, { headers: h, body: "{}" })).status).toBe(403);
  });
  it("OPTIONS / PUT / DELETE are refused without any CORS header", async () => {
    const { srv } = await boot();
    for (const method of ["OPTIONS", "PUT", "DELETE"]) {
      const r = await call(srv, {
        method,
        headers: {
          host: `127.0.0.1:${srv.port}`,
          origin: "http://evil.example",
          "access-control-request-method": "POST",
        },
      });
      expect(r.status).toBe(405);
      expect(
        Object.keys(r.headers).some((x) => x.startsWith("access-control")),
      ).toBe(false);
    }
  });
  it("snapshots never contain the bearer token or CSRF token", async () => {
    const { s, srv } = await boot();
    const claim = JSON.parse(
      (
        await call(srv, {
          path: "/api/claim",
          headers: good(srv, s),
          body: "{}",
        })
      ).body,
    );
    const state = (
      await call(srv, { headers: good(srv, s, claim.csrf), body: "{}" })
    ).body;
    expect(state).not.toContain(s.token);
    expect(state).not.toContain(claim.csrf);
  });
});

describe("G7 pilot — static safety", () => {
  it("pilot safety scan passes (single guarded wallet send, no signer/key/raw/approve surfaces)", () => {
    const r = scanG7Pilot(candidateSelection());
    expect(r.findings).toEqual([]);
    expect(r.clientSendOccurrences).toHaveLength(1);
    expect(r.clientWalletMethods).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_requestAccounts",
      "eth_sendTransaction",
      "wallet_addEthereumChain",
      "wallet_switchEthereumChain",
    ]);
  });
  it("browser constants equal the server policy (independent copy, same values)", () => {
    const js = readFileSync("scripts/g7-pilot/client/app.js", "utf8");
    const get = (k: string) =>
      new RegExp(`\\b${k}: ("[^"]*"|[0-9]+n?)`).exec(js)?.[1];
    expect(get("account")).toBe(`"${PILOT_SCOPE.account}"`);
    expect(get("contract")).toBe(`"${PILOT_SCOPE.contract}"`);
    expect(get("chainIdHex")).toBe(`"${PILOT_SCOPE.sourceChainIdHex}"`);
    expect(get("selector")).toBe(`"${PILOT_SCOPE.selector}"`);
    expect(get("principal")).toBe(`${PILOT_SCOPE.principal}n`);
    expect(get("maxNetworkFee")).toBe(`${PILOT_BOUNDS.maxNetworkFee}n`);
    expect(get("maxServiceFee")).toBe(`${PILOT_BOUNDS.maxServiceFee}n`);
    expect(get("maxWalletDebit")).toBe(`${PILOT_BOUNDS.maxWalletDebit}n`);
    expect(get("phrase")).toBe(`"${CONFIRMATION_PHRASE}"`);
    expect(get("buttonLabel")).toBe(`"${BUTTON_LABEL}"`);
    expect(get("mockRdns")).toBe(`"${MOCK_WALLET_RDNS}"`);
  });
});

describe("G7 pilot — EOA change (new EOA authorized, old EOA superseded)", () => {
  it("the single authorized pilot EOA is the new one; the old one is superseded and refused", async () => {
    expect(PILOT_EOA).toBe("0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c");
    expect(PILOT_SCOPE.account).toBe(PILOT_EOA);
    expect(PILOT_SCOPE.recipient).toBe(PILOT_EOA);
    expect(PILOT_SCOPE.accountDisplay.toLowerCase()).toBe(PILOT_EOA);
    expect(SUPERSEDED_PILOT_EOAS).toEqual([
      "0x28136a77ec8ba3d918114712a588b4095ba12a6b",
    ]);
    const { s } = makeSession("ready");
    await s.start();
    await expect(
      s.final({
        intentDigest: digestOf(s),
        confirmations: CONFIRM,
        wallet: { account: SUPERSEDED_PILOT_EOAS[0], chainId: "0x956d7" },
      }),
    ).rejects.toThrow(/WALLET_ACCOUNT_NOT_OWNER_EOA/);
    expect(s.snapshot().sendCapability).toBe(true);
  });
  it("the old-EOA artifacts are preserved byte-identical and marked SUPERSEDED_BY_G7_PILOT_EOA_CHANGE", () => {
    const m = JSON.parse(
      readFileSync("G7_SUPERSEDED_BY_G7_PILOT_EOA_CHANGE.json", "utf8"),
    );
    expect(m.status).toBe("SUPERSEDED_BY_G7_PILOT_EOA_CHANGE");
    expect(m.supersededEoa).toBe(SUPERSEDED_PILOT_EOAS[0]);
    expect(m.activePilotEoa.toLowerCase()).toBe(PILOT_EOA);
    expect(m.artifacts.length).toBeGreaterThanOrEqual(3);
    for (const a of m.artifacts as { path: string; sha256: string }[])
      expect(
        createHash("sha256").update(readFileSync(a.path)).digest("hex"),
      ).toBe(a.sha256);
  });
});

describe("G7 pilot — launcher expiry monitor", () => {
  it("expireIfDue: an expired session that never armed becomes EXPIRED; before expiry and after arming nothing changes", async () => {
    let t = Date.now();
    const now = () => t;
    const idle = makeSession("ready", { mode: "dry-run", now, ttlMs: 60_000 });
    await idle.s.start();
    expect(idle.s.expireIfDue()).toBe(false);
    expect(idle.s.state).toBe("READY");
    t += 61_000;
    expect(idle.s.expireIfDue()).toBe(true);
    expect(idle.s.snapshot()).toMatchObject({
      state: "EXPIRED",
      sendCapability: false,
    });
    expect(idle.events.map((e) => e.event)).toContain("EXPIRED");
    // An armed run keeps observing: the monitor never turns it into EXPIRED.
    t = Date.now();
    const armed = makeSession("ready", { now, ttlMs: 60_000 });
    const fin = await armable(armed.s);
    armed.s.arm({
      candidateId: fin.candidateId,
      intentDigest: digestOf(armed.s),
      wallet: WALLET,
    });
    expect(armed.s.state).toBe("ARMED");
    t += 61_000;
    expect(armed.s.expireIfDue()).toBe(false);
    expect(armed.s.state).toBe("ARMED");
  });
});

describe("G7 pilot — in-product local-only gate (fail closed)", () => {
  const ok = {
    NODE_ENV: "production",
    OTHERBRIDGE_G7_LOCAL_PILOT: "1",
    OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN: "http://127.0.0.1:3197",
  };
  it("opens only for the local-g7-pilot artifact (bundle constant 1) + production runtime + flag + launcher loopback origin + exact Host", () => {
    expect(g7LocalPilotGate("127.0.0.1:3197", ok, "1")).toEqual({
      apiBase: "/g7-pilot/api",
      origin: "http://127.0.0.1:3197",
    });
    // A public artifact folds the constant to "0": no runtime environment can open the gate there.
    expect(g7LocalPilotGate("127.0.0.1:3197", ok, "0")).toBeNull();
    expect(g7LocalPilotGate("127.0.0.1:3197", ok, undefined)).toBeNull();
    expect(g7LocalPilotGate("127.0.0.1:3197", ok)).toBeNull();
    expect(
      g7LocalPilotGate(
        "127.0.0.1:3197",
        { ...ok, NODE_ENV: "development" },
        "1",
      ),
    ).toBeNull();
    expect(
      g7LocalPilotGate("127.0.0.1:3197", { ...ok, NODE_ENV: "test" }, "1"),
    ).toBeNull();
    expect(
      g7LocalPilotGate(
        "127.0.0.1:3197",
        { ...ok, OTHERBRIDGE_G7_LOCAL_PILOT: "true" },
        "1",
      ),
    ).toBeNull();
    expect(
      g7LocalPilotGate(
        "127.0.0.1:3197",
        { ...ok, OTHERBRIDGE_G7_LOCAL_PILOT: undefined },
        "1",
      ),
    ).toBeNull();
    expect(
      g7LocalPilotGate(
        "127.0.0.1:3197",
        { ...ok, OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN: undefined },
        "1",
      ),
    ).toBeNull();
    expect(
      g7LocalPilotGate(
        "example.com",
        { ...ok, OTHERBRIDGE_G7_LOCAL_PILOT_ORIGIN: "http://example.com" },
        "1",
      ),
    ).toBeNull();
    expect(g7LocalPilotGate("localhost:3197", ok, "1")).toBeNull();
    expect(g7LocalPilotGate("127.0.0.1:3100", ok, "1")).toBeNull();
    expect(g7LocalPilotGate(null, ok, "1")).toBeNull();
  });
  it("next.config: public builds fold the constant to 0; the pilot profile builds only into its own directory and is served only by the launcher", () => {
    const build = "phase-production-build",
      server = "phase-production-server",
      dev = "phase-development-server";
    // production-public: default directory, constant "0", in every phase.
    for (const phase of [build, server, dev])
      expect(g7BuildProfile(phase, undefined, undefined)).toEqual({
        bundle: "0",
      });
    expect(g7BuildProfile(build, "", "")).toEqual({ bundle: "0" });
    // local-g7-pilot: built (without the runtime flag) into .next-g7-pilot, served only with the launcher flag.
    expect(g7BuildProfile(build, "local-g7-pilot", undefined)).toEqual({
      bundle: "1",
      distDir: ".next-g7-pilot",
    });
    expect(g7BuildProfile(server, "local-g7-pilot", "1")).toEqual({
      bundle: "1",
      distDir: ".next-g7-pilot",
    });
    expect(g7BuildProfile(build, "local-g7-pilot-test", undefined)).toEqual({
      bundle: "1",
      distDir: ".next-g7-pilot-test",
    });
    expect(Object.values(G7_PILOT_PROFILES)).not.toContain(".next");
    expect(PHASE_PRODUCTION_BUILD).toBe(nextConstants.PHASE_PRODUCTION_BUILD);
    expect(PHASE_PRODUCTION_SERVER).toBe(nextConstants.PHASE_PRODUCTION_SERVER);
    // Fail closed: the flag on the public product, the profile in `next start` / dev / with a build-time flag,
    // unknown profiles, and non-exact flag values.
    for (const phase of [build, server, dev])
      expect(() => g7BuildProfile(phase, undefined, "1")).toThrow(
        /local-g7-pilot build profile/,
      );
    expect(() => g7BuildProfile(server, "local-g7-pilot", undefined)).toThrow(
      /served only by/,
    );
    expect(() => g7BuildProfile(dev, "local-g7-pilot", "1")).toThrow(
      /served only by/,
    );
    expect(() => g7BuildProfile(build, "local-g7-pilot", "1")).toThrow(
      /served only by/,
    );
    expect(() => g7BuildProfile(server, "local-g7-pilot", "true")).toThrow();
    expect(() => g7BuildProfile(build, "production", undefined)).toThrow(
      /UNKNOWN_OTHERBRIDGE_BUILD_PROFILE/,
    );
    expect(() => g7BuildProfile(build, "__proto__", undefined)).toThrow(
      /UNKNOWN_OTHERBRIDGE_BUILD_PROFILE/,
    );
  });
  it("the pilot API mounted under /g7-pilot/api/ keeps the full envelope and serves nothing else", async () => {
    const { s } = makeSession("ready", { mode: "dry-run" });
    const api = pilotApi(s, () => undefined, "/g7-pilot/api/");
    let origin = "";
    const server = createServer((req, res) => void api(req, res, origin));
    const bound = await listenLoopback(server, 0);
    origin = bound.origin;
    try {
      const call = (path: string, headers: Record<string, string>) =>
        new Promise<number>((resolve, reject) => {
          const r = request(
            {
              host: "127.0.0.1",
              port: bound.port,
              path,
              method: "POST",
              headers,
              agent: false,
            },
            (res) => {
              res.resume();
              resolve(res.statusCode!);
            },
          );
          r.on("error", reject);
          r.end("{}");
        });
      const h = {
        host: bound.host,
        origin,
        "content-type": "application/json",
        authorization: `Bearer ${s.token}`,
      };
      expect(await call("/g7-pilot/api/claim", h)).toBe(200);
      expect(await call("/api/claim", h)).toBe(404);
      expect(
        await call("/g7-pilot/api/claim", {
          ...h,
          origin: "http://localhost:" + bound.port,
        }),
      ).toBe(403);
      expect(await call("/g7-pilot/api/state", h)).toBe(403); // CSRF missing
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});

describe("G7 pilot — in-product browser verifier (independent of the server)", () => {
  const ready = async () =>
    (await fixturePreflight("ready").run("initial"))
      .review! as unknown as PilotReview;
  it("browser constants equal the server policy", () => {
    expect(EXPECT.account).toBe(PILOT_SCOPE.account);
    expect(EXPECT.accountDisplay).toBe(PILOT_SCOPE.accountDisplay);
    expect(EXPECT.contract).toBe(PILOT_SCOPE.contract);
    expect(EXPECT.chainIdHex).toBe(PILOT_SCOPE.sourceChainIdHex);
    expect(EXPECT.selector).toBe(PILOT_SCOPE.selector);
    expect(EXPECT.signature).toBe(PILOT_SCOPE.signature);
    expect(EXPECT.principal).toBe(PILOT_SCOPE.principal);
    expect(EXPECT.maxNetworkFee).toBe(PILOT_BOUNDS.maxNetworkFee);
    expect(EXPECT.maxServiceFee).toBe(PILOT_BOUNDS.maxServiceFee);
    expect(EXPECT.maxWalletDebit).toBe(PILOT_BOUNDS.maxWalletDebit);
    expect(EXPECT.phrase).toBe(CONFIRMATION_PHRASE);
  });
  it("accepts the exact reviewed transaction and recomputes the same digest", async () => {
    const r = await ready();
    const v = await verifyReview(r);
    expect(v.failures).toEqual([]);
    expect(v.digest).toBe(r.intentDigest);
  });
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  it.each([
    [
      "amount 10 ONE",
      (d: string) =>
        d.slice(0, 10 + 64 * 3) + word(10n * ONE) + d.slice(10 + 64 * 4),
      "PRINCIPAL_NOT_EXACTLY_5_ONE",
    ],
    [
      "recipient = old EOA",
      (d: string) =>
        d.replace(PILOT_EOA.slice(2), SUPERSEDED_PILOT_EOAS[0].slice(2)),
      "RECIPIENT_NOT_PILOT_EOA",
    ],
    [
      "destination chain 1",
      (d: string) => d.slice(0, 10) + word(1n) + d.slice(74),
      "DESTINATION_NOT_BSC_56",
    ],
    [
      "network fee 0.19 ONE",
      (d: string) =>
        d.slice(0, 10 + 64 * 4) + word(19n * 10n ** 16n) + d.slice(10 + 64 * 5),
      "NETWORK_FEE_ABOVE_0_18_ONE",
    ],
    [
      "service fee 1 wei",
      (d: string) => d.slice(0, 10 + 64 * 5) + word(1n) + d.slice(10 + 64 * 6),
      "SERVICE_FEE_ABOVE_0",
    ],
    [
      "selector flipped",
      (d: string) => "0xff" + d.slice(4),
      "SELECTOR_NOT_BRIDGE_TOKEN",
    ],
  ])("rejects calldata mutation: %s", async (_, mutate, failure) => {
    const r = await ready();
    const v = await verifyReview({
      ...r,
      tx: { ...r.tx, data: mutate(r.tx.data) },
    });
    expect(v.ok).toBe(false);
    expect(v.failures.join()).toContain(failure);
  });
  it.each([
    ["chain 56", { chainId: "0x38" }, "CHAIN_NOT_612055"],
    [
      "from = old EOA",
      { from: SUPERSEDED_PILOT_EOAS[0] },
      "FROM_NOT_PILOT_EOA",
    ],
    [
      "to = BSC proxy",
      { to: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5" },
      "TO_NOT_PINNED_PROXY",
    ],
    [
      "value + 1 wei",
      { value: "0x47e30e8e20860001" },
      "MSG_VALUE_NOT_EXACT_SUM",
    ],
    [
      "gas limit raised (debit above bound)",
      { gas: "0x25137" },
      "MAX_WALLET_DEBIT_ABOVE_5_18075931_ONE",
    ],
    ["extra tx field", { nonce: "0x0" } as Record<string, string>, "TX_KEYS"],
  ])("rejects transaction mutation: %s", async (_, patch, failure) => {
    const r = await ready();
    const v = await verifyReview({ ...r, tx: { ...r.tx, ...patch } });
    expect(v.ok).toBe(false);
    expect(v.failures.join()).toContain(failure);
  });
  it("rejects an intent/digest mismatch", async () => {
    const r = await ready();
    expect(
      (await verifyReview({ ...r, intentDigest: "0".repeat(64) })).failures,
    ).toContain("INTENT_DIGEST_MISMATCH");
    expect(
      (
        await verifyReview({
          ...r,
          intent: { ...r.intent, trustModelAccepted: false },
        })
      ).failures.join(),
    ).toContain("INTENT_SCOPE");
  });
});
