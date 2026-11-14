// G14 closure — the POSITIVE end-to-end flow on the REAL composition. TEST-ONLY VARIANT ONLY.
// This file is a fixture of the final source: no suite of the final source runs it (it is outside the vitest include
// globs). It runs only in the separate positive variant copy made by the closure tools, where exactly two protected
// constants differ from the final source — a SYNTHETIC owner record for 0x3333…3333 and CANARY_LIVE_WIRING = true —
// and nothing else. There: the real API route -> the one runtime (durable store on disk, two-operator pool, protected
// gate, server Guardian, engine) -> the real submission boundary -> the real wallet adapter -> a fake EIP-1193 wallet,
// with a local fake chain (fake-chain.ts) behind the four exact pool URLs and a fake LI.FI behind the adapter's own
// transport. Nothing signs, sends or reaches a network; every account, hash and amount is synthetic.
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageServer } from "./page-server";
import { NextRequest } from "next/server";
import fx from "../g14-canary-across.json" with { type: "json" };
import { NOW, SYN, fakeWallet } from "../g14-protected-proposal/synthetic";
import {
  SYNTHETIC_OWNER_KEY,
  fakeChain,
  fakeHttps,
  fakeLookup,
  lifiAnswer,
} from "./fake-chain";

const net = vi.hoisted(() => ({
  lookup: (() => {
    throw new Error("NO_NETWORK");
  }) as (...a: unknown[]) => unknown,
  request: (() => {
    throw new Error("NO_NETWORK");
  }) as (...a: unknown[]) => unknown,
}));
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => net.lookup(...a),
}));
vi.mock("node:https", () => ({
  request: (...a: unknown[]) => net.request(...a),
}));

const { OWNER_CANARY_APPROVAL } =
  await import("../../../src/security/canary-approval");
const { CANARY_LIVE_WIRING } =
  await import("../../../src/execution/server/gate");
const runtimeModule =
  await import("../../../src/execution/server/canary/runtime");
const { canaryArmed, openCanaryRuntime, closeCanaryRuntime, CanaryRuntime } =
  runtimeModule;
const { POST } = await import("../../../src/app/api/execution/route");
const { setAppLimiterForTests } = await import("../../../src/server/api-guard");
const { MemoryRateLimiter } = await import("../../../src/server/rate-limit");
const { WalletProviderAdapter } =
  await import("../../../src/features/wallet/adapter");
const { submitCanary } =
  await import("../../../src/features/bridge/submission");
const { CanaryDurableStore } =
  await import("../../../src/execution/server/canary/durable-store");

const ORIGIN = "http://127.0.0.1:3100";
/** An API answer, read loosely by the assertions (they state every value they rely on). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- test-only variant fixture: loose API answers.
type Json = any;
let dir = "";
let chain: ReturnType<typeof fakeChain>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  dir = mkdtempSync(join(tmpdir(), "g14-closure-positive-"));
  chain = fakeChain({ owner: SYN, now: () => Date.now() });
  vi.stubGlobal("fetch", chain.fetch);
  net.lookup = fakeLookup;
  net.request = fakeHttps(lifiAnswer);
  setAppLimiterForTests(new MemoryRateLimiter());
});
afterEach(() => {
  closeCanaryRuntime();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setAppLimiterForTests(undefined);
  rmSync(dir, { recursive: true, force: true });
});
const api = async (
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) => {
  const res = await POST(
    new NextRequest(`${ORIGIN}/api/execution`, {
      method: "POST",
      headers: {
        host: "127.0.0.1:3100",
        origin: ORIGIN,
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
    }),
  );
  return {
    status: res.status,
    json: (await res.json()) as Json,
  };
};
// G14 follow-up F2: the adapter's own server calls go to the same real API route, as the browser's would.
beforeEach(() => {
  pageServer.handler = (body) =>
    POST(
      new NextRequest(`${ORIGIN}/api/execution`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3100",
          origin: ORIGIN,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }),
    );
});
const owner = () => OWNER_CANARY_APPROVAL!;
const review = (record?: string, session?: string) =>
  api({
    action: "canary-review",
    account: SYN,
    chainId: "8453",
    amount: owner().exactAmount,
    ...(record ? { record } : { ownerKey: SYNTHETIC_OWNER_KEY }),
    ...(session ? { session } : {}),
  });
const wallet = () => {
  const p = fakeWallet({
    send: (params) => chain.submit((params as Record<string, string>[])[0]),
  });
  return {
    p,
    a: new WalletProviderAdapter(p, { address: SYN, chainId: 8453, epoch: 1 }),
  };
};
/** One owner step through the API exactly as the review panel does it. */
async function step(
  r: { record: string; session: string },
  a: InstanceType<typeof WalletProviderAdapter>,
  over: Record<string, unknown> = {},
) {
  const auth = await api({
    action: "canary-authorize",
    session: r.session,
    record: r.record,
    trustedGesture: true,
  });
  expect(auth.status, JSON.stringify(auth.json)).toBe(200);
  const prep = await api({
    action: "canary-prepare",
    session: r.session,
    record: r.record,
    token: auth.json.token,
  });
  expect(prep.status, JSON.stringify(prep.json)).toBe(200);
  const write = (kind: string, ref: unknown, hash?: string) =>
    api({
      action: "canary-record",
      session: r.session,
      kind,
      ref,
      ...(hash ? { hash } : {}),
    }).then((x) => x.status === 200 && x.json.ok === true);
  // G14 follow-up F2: the server's confirmation and the durable "requested" record are the wallet adapter's OWN
  // calls of this API (through the page fetch it captured); the page hands over only the session.
  const result = await submitCanary(a, prep.json.preparation, {
    session: r.session,
    gesture: { trusted: true, at: Date.now() },
    persistNotRequested: (ref) => write("not-requested", ref),
    persistHash: (h, _a, ref) => write("hash", ref, h),
    persistLateHash: async (h, _a, ref) =>
      void (await write("late-hash", ref, h)),
    persistRejected: async (ref) => void (await write("rejected", ref)),
    ...over,
  });
  return { result, preparation: prep.json.preparation as Json };
}
const track = (r: { record: string; session: string }) =>
  api({ action: "canary-track", session: r.session, record: r.record });

const amount = () => owner().exactAmount;
/** APPROVE through to a confirmed approval and the main step's fresh review (as the panel does it). */
async function toSendReview(a: InstanceType<typeof WalletProviderAdapter>) {
  const r1 = await review();
  const s1 = await step(r1.json as never, a);
  expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
  chain.mine(10);
  expect((await track(r1.json as never)).json.state).toBe("APPROVAL_CONFIRMED");
  vi.setSystemTime(Date.now() + 3_000);
  const r2 = await review(r1.json.record, r1.json.session);
  expect(r2.json.ready, JSON.stringify(r2.json.checks)).toBe(true);
  return { r1, r2 };
}

describe("review 3 N10: a consumed nonce is journaled, searched forward, and never stays a quiet SUBMITTED", () => {
  it("the warning survives a restart (resume view); the search crosses many windows; an undecided search never ends the record, agreed negative evidence does", async () => {
    openCanaryRuntime({ dir });
    const { a } = wallet();
    const r1 = await review();
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
    chain.vanish(s1.result.hash);
    // Review 4 R4-1: an unrelated approval of the owner sits in the FIRST window (a log that matches the filter but is
    // not the step's nonce): the search must move past it.
    chain.strayApproval();
    // Nobody tracks for a long time: 12,000 Base blocks pass (more than two 5,000-block windows).
    chain.mine(12_000);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const t1 = await track(r1.json as never);
    expect(t1.json.state).toBe("APPROVAL_SUBMITTED");
    expect(t1.json.notes).toContain("NONCE_USED_BY_ANOTHER_TRANSACTION");
    // Review 8 R8-4 — TEST CONTRACT CHANGE: all windows up to the FINAL block were read in this one call and hold
    // nothing; the nonce was first seen consumed at the head, which is not final yet: undecided (attention), nothing ends.
    expect(t1.json.notes).toContain("REPLACEMENT_SEARCH:UNKNOWN");
    expect(t1.json.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:NONCE_BLOCK_NOT_FINAL",
    );
    expect(t1.json.attempts[0].nonceConsumed).toBe(true);
    // After a restart the plain resume view (no tracking call, no notes) still needs attention.
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    const res = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
    });
    // The undecided mark is journaled: the plain view names it (review 8 R8-5 keeps the reason visible).
    expect(res.json.view.notes).toHaveLength(1);
    expect(res.json.view.notes[0]).toMatch(
      /^REPLACEMENT_SEARCH_UNDECIDED_SINCE:\d+$/,
    );
    expect(res.json.view.attempts[0].nonceConsumed).toBe(true);
    expect(res.json.view.needsAttention).toBe(true);
    // Review 4 R4-3: after the drop window ONE undecided call (an operator whose log reads fail) ends nothing ...
    vi.setSystemTime(Date.now() + 31 * 60_000);
    chain.diverge["8453:logs"] = "OFFLINE";
    const bound = { record: res.json.record, session: res.json.session };
    const und = await track(bound);
    expect(und.json.state).toBe("APPROVAL_SUBMITTED");
    expect(und.json.needsAttention).toBe(true);
    // ... a few minutes later still nothing ends ...
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect((await track(bound)).json.state).toBe("APPROVAL_SUBMITTED");
    // Review 5 R5-1: a call that is NOT undecided clears the mark — here the search is on its way to the head again
    // (new blocks, operator 1 answers) — so a later failed read starts the count anew and ends nothing.
    delete chain.diverge["8453:logs"];
    chain.mine(25_000);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const scanning = await track(bound);
    expect(scanning.json.notes).toContain("REPLACEMENT_SEARCH:SCANNING");
    expect(scanning.json.state).toBe("APPROVAL_SUBMITTED");
    chain.diverge["8453:logs"] = "OFFLINE";
    vi.setSystemTime(Date.now() + 31 * 60_000);
    expect((await track(bound)).json.state).toBe("APPROVAL_SUBMITTED");
    // The standing mark is journaled: it survives a restart (the count does not start again from zero).
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    const again = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
    });
    bound.record = again.json.record;
    bound.session = again.json.session;
    expect(again.json.view.attempts[0].search.reason).toBe("LOGS_NOT_AGREED");
    // G14 follow-up F1 (R6-1 / G14-CLOSURE-AUDIT-01) — TEST CONTRACT CHANGE: this sequence used to END the record
    // (DROPPED after a search "undecided for a whole drop window", judged from two samples). An undecided search is no
    // evidence: the record stays APPROVAL_SUBMITTED, needs attention, and the read-only search goes on.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const still = await track(bound);
    expect(still.json.state, JSON.stringify(still.json.notes)).toBe(
      "APPROVAL_SUBMITTED",
    );
    expect(still.json.needsAttention).toBe(true);
    expect(still.json.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:LOGS_NOT_AGREED",
    );
    // Only agreed negative evidence over the complete range ends it — visibly, with the attempt marked.
    delete chain.diverge["8453:logs"];
    let end = await track(bound);
    for (let k = 0; k < 6 && end.json.state === "APPROVAL_SUBMITTED"; k++)
      end = await track(bound);
    expect(end.json.state, JSON.stringify(end.json.notes)).toBe("DROPPED");
    expect(end.json.attempts[0].recovery).toBe("NONCE_CONSUMED_UNIDENTIFIED");
    expect(end.json.needsAttention).toBe(true);
    // Follow-up F3: the vanished approval never executed: the allowance is read as a verified zero (no "may stand").
    expect(end.json.allowance).toMatchObject({ status: "ZERO" });
    expect(end.json.notes).not.toContain("ALLOWANCE_MAY_STAND_AFTER_END");
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
