// G14 closure + follow-up — POSITIVE flows on the REAL composition. TEST-ONLY VARIANT ONLY.
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

// ------------------------------------------------------------------------------------------------------------------
// G14 FOLLOW-UP (VEINED-G14-CLOSURE-FOLLOWUP-20261113-01) — F1 / F3 / F4 on the REAL composition (test-only variant).
// SYNTHETIC_TEST_ONLY: the account 0x3333…3333, the owner record and every chain value are made up; the wallet is an
// in-memory EIP-1193 double; the two operators per chain are the local fake chain. Nothing signs or reaches a network.
// Every scenario counts the financial wallet primitive (eth_sendTransaction) and allows no other wallet write.
const walletWrites = (p: ReturnType<typeof wallet>["p"]) =>
  p.calls.filter((c) =>
    /sign|sendRaw|switchEthereumChain|addEthereumChain|wallet_/i.test(c.method),
  );
const resume = (o: { record?: string; resumeKey?: string } = {}) =>
  api({ action: "canary-resume", account: SYN, amount: amount(), ...o });
const untilChanged = async (
  bound: { record: string; session: string },
  from: string,
  max = 8,
): Promise<Json> => {
  let v: Json = null;
  for (let k = 0; k < max; k++) {
    v = (await track(bound)).json;
    if (v.state !== from) return v;
  }
  return v;
};

describe("follow-up F1 (R6-1 / G14-CLOSURE-AUDIT-01): an undecided replacement search never ends a record", () => {
  it("two failed reads a drop window apart, then hours of them: still active, attention kept; marks survive restart, resume and inspection; only agreed negative evidence ends it", async () => {
    openCanaryRuntime({ dir });
    const { p, a } = wallet();
    const r1 = await review();
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
    // The step's transaction disappears from both operators while its nonce stays consumed; the log reads of one
    // operator fail, so the replacement search cannot decide.
    // Review 8 R8-4 — TEST CONTRACT CHANGE: the search reads FINAL blocks only (the Base confirmation depth) and the
    // negative end needs the final range to reach the block the nonce was FIRST seen consumed at, so the synthetic chain
    // advances past that depth (here: so the first call reaches the log reads at all).
    chain.vanish(s1.result.hash);
    chain.mine(12);
    chain.diverge["8453:logs"] = "OFFLINE";
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const t1 = (await track(r1.json as never)).json;
    expect(t1.state).toBe("APPROVAL_SUBMITTED");
    expect(t1.notes).toEqual(
      expect.arrayContaining([
        "NONCE_USED_BY_ANOTHER_TRANSACTION",
        "REPLACEMENT_SEARCH:UNKNOWN",
        "REPLACEMENT_SEARCH_UNDECIDED:LOGS_NOT_AGREED",
        "RECORD_STAYS_ACTIVE_SEARCH_CONTINUES",
      ]),
    );
    expect(t1.needsAttention).toBe(true);
    // The exact R6-1 sequence: nobody tracks for more than a drop window, the next call fails once more.
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t2 = (await track(r1.json as never)).json;
    expect(t2.state).toBe("APPROVAL_SUBMITTED");
    expect(t2.terminal).toBe(false);
    expect(t2.attempts[0].recovery).not.toBe("NONCE_CONSUMED_UNIDENTIFIED");
    // Many more undecided calls over hours: no sample count and no elapsed time ends it.
    for (let k = 0; k < 8; k++) {
      vi.setSystemTime(Date.now() + 31 * 60_000);
      const t = (await track(r1.json as never)).json;
      expect(t.state, String(k)).toBe("APPROVAL_SUBMITTED");
      expect(t.needsAttention, String(k)).toBe(true);
      expect(t.completed, String(k)).toBe(false);
    }
    // A restart: the journaled mark, its reason and the consumed nonce are in the resume view and the inspection.
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    const res = await resume();
    const v = res.json.view;
    expect(v.state).toBe("APPROVAL_SUBMITTED");
    expect(v.attempts[0]).toMatchObject({
      nonceConsumed: true,
      search: { reason: "LOGS_NOT_AGREED" },
    });
    expect(typeof v.attempts[0].search.undecidedSince).toBe("number");
    expect(v.needsAttention).toBe(true);
    expect(
      v.notes.some((n: string) =>
        n.startsWith("REPLACEMENT_SEARCH_UNDECIDED_SINCE:"),
      ),
    ).toBe(true);
    const ins = runtimeModule.canaryStoreInspection(dir);
    expect(ins.attempts[0]).toMatchObject({
      nonceConsumed: true,
      search: { reason: "LOGS_NOT_AGREED" },
    });
    // Read only, always: the approval is the one financial request; nothing else ever reached the wallet.
    expect(p.count("eth_sendTransaction")).toBe(1);
    expect(walletWrites(p)).toEqual([]);
    // Real negative evidence: both operators answer again and agree over the complete range up to their common head
    // that no transaction of this nonce emitted the approval's log -> the ONE definitive end, with its evidence.
    delete chain.diverge["8453:logs"];
    // Review 8 R8-4: the block of the first sighting becomes final (confirmation depth) before the deciding call.
    chain.advance("8453", 10);
    const bound = { record: res.json.record, session: res.json.session };
    const end = await untilChanged(bound, "APPROVAL_SUBMITTED");
    expect(end.state, JSON.stringify(end.notes)).toBe("DROPPED");
    expect(end.attempts[0].recovery).toBe("NONCE_CONSUMED_UNIDENTIFIED");
    expect(end.attempts[0].evidence).toMatchObject({
      rule: "INTENT_LOG_ABSENT_OVER_COMPLETE_AGREED_RANGE",
    });
    expect(end.notes).toContain("CONSUMING_TRANSACTION_UNIDENTIFIED");
    expect(
      end.notes.some((n: string) =>
        n.startsWith("INTENT_LOG_ABSENT_TO_BLOCK:"),
      ),
    ).toBe(true);
    expect(end.needsAttention).toBe(true);
    expect(end.completed).toBe(false);
    // F3: the approval never executed, so the allowance read after the end is a verified zero: nothing may stand.
    expect(end.allowance).toMatchObject({ status: "ZERO", value: "0" });
    expect(end.notes.filter((n: string) => n.startsWith("ALLOWANCE_"))).toEqual(
      [],
    );
    // The ended record is still observed read only (its hash and the nonce).
    const after = (await track(bound)).json;
    expect(after.notes.some((n: string) => n.startsWith("CHAIN_NONCE:"))).toBe(
      true,
    );
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
void mkdtempSync;
