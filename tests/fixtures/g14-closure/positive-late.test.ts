// G14 closure — the POSITIVE end-to-end flow on the REAL composition. TEST-ONLY VARIANT ONLY.
// This file is a fixture of the final source: no suite of the final source runs it (it is outside the vitest include
// globs). It runs only in the separate positive variant copy made by the closure tools, where exactly two protected
// constants differ from the final source — a SYNTHETIC owner record for 0x3333…3333 and CANARY_LIVE_WIRING = true —
// and nothing else. There: the real API route -> the one runtime (durable store on disk, two-operator pool, protected
// gate, server Guardian, engine) -> the real submission boundary -> the real wallet adapter -> a fake EIP-1193 wallet,
// with a local fake chain (fake-chain.ts) behind the four exact pool URLs and a fake LI.FI behind the adapter's own
// transport. Nothing signs, sends or reaches a network; every account, hash and amount is synthetic.
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
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

describe("review 1 F5 / F6 / F7: late hash after the end, destination baseline, replacement", () => {
  // G14 follow-up (review 7 R7-3) — TEST CONTRACT CHANGE: this scenario used to end the record DROPPED after 31 minutes
  // of an unanswered prompt (elapsed time) and then keep the late hash as HASH_AFTER_END. Elapsed time is no evidence
  // (an open prompt can still be confirmed), so the record now stays UNCERTAIN with the owner's attention, and the
  // late verified hash is adopted and tracked to its confirmation. Stronger: no end without chain evidence.
  it("F5 / review 7 R7-3: an unanswered prompt is never ended by elapsed time; a verified hash that arrives much later is adopted and tracked", async () => {
    openCanaryRuntime({ dir });
    const r1 = await review();
    const s = r1.json as { record: string; session: string };
    const auth = await api({
      action: "canary-authorize",
      session: s.session,
      record: s.record,
      trustedGesture: true,
    });
    const prep = (
      await api({
        action: "canary-prepare",
        session: s.session,
        record: s.record,
        token: auth.json.token,
      })
    ).json.preparation;
    const ref = {
      record: prep.record,
      action: prep.action,
      attempt: prep.attempt,
      digest: prep.digest,
      request: "8".repeat(32),
    };
    expect(
      (
        await api({
          action: "canary-record",
          session: s.session,
          kind: "requested",
          ref,
        })
      ).json.ok,
    ).toBe(true);
    // No answer; the authorization ends (UNCERTAIN), then hours pass with the nonce unchanged: still UNCERTAIN.
    vi.setSystemTime(Date.now() + 61_000);
    expect((await track(s)).json.state).toBe("UNCERTAIN");
    for (const minutes of [31, 240]) {
      vi.setSystemTime(Date.now() + minutes * 60_000);
      const waiting = (await track(s)).json;
      expect(waiting.state, JSON.stringify(waiting.notes)).toBe("UNCERTAIN");
      expect(waiting.notes).toContain(
        "RECORD_STAYS_ACTIVE_PROMPT_MAY_STILL_BE_CONFIRMED",
      );
      expect(waiting.needsAttention).toBe(true);
      expect(waiting.terminal).toBe(false);
      expect(waiting.completed).toBe(false);
    }
    // The owner approves the still-open prompt much later.
    const hash = chain.submit(prep.transaction);
    const w = await api({
      action: "canary-record",
      session: s.session,
      kind: "late-hash",
      ref,
      hash,
    });
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    chain.mine(10);
    let t = (await track(s)).json;
    for (let k = 0; k < 6 && t.state !== "APPROVAL_CONFIRMED"; k++)
      t = (await track(s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_CONFIRMED");
    expect(t.hashes.approval).toBe(hash);
    expect(
      t.attempts.map((x: { recovery: string }) => x.recovery),
    ).not.toContain("HASH_AFTER_END");
  });
  it("F6: without an agreed destination baseline the review is not ready", async () => {
    openCanaryRuntime({ dir });
    chain.diverge["42161"] = "OFFLINE";
    const r = await review();
    expect(r.json.ready).toBe(false);
    expect(
      r.json.checks.find(
        (c: { id: string }) => c.id === "DESTINATION_BASELINE",
      ),
    ).toMatchObject({
      status: "UNKNOWN",
      code: "ARBITRUM_BASELINE_NOT_AGREED",
    });
  });
  it("F7 / review 2 N1: a nonce consumed by a transaction nobody can identify needs attention at once and, after the drop window, ends visibly", async () => {
    openCanaryRuntime({ dir });
    const { a } = wallet();
    const r1 = await review();
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE" });
    chain.vanish(s1.result.hash);
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const early = await track(r1.json as never);
    expect(early.json.state).toBe("APPROVAL_SUBMITTED");
    expect(early.json.notes).toContain("NONCE_USED_BY_ANOTHER_TRANSACTION");
    // Review 8 R8-4 — TEST CONTRACT CHANGE: the search reads FINAL blocks only (the Base confirmation depth) and the
    // negative end needs the final range to reach the block the nonce was FIRST seen consumed at, so the synthetic chain
    // advances past that depth before the deciding call.
    expect(early.json.notes).toContain("REPLACEMENT_SEARCH:UNKNOWN");
    expect(early.json.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:NONCE_BLOCK_NOT_FINAL",
    );
    expect(early.json.needsAttention).toBe(true);
    chain.advance("8453", 10);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = await track(r1.json as never);
    expect(t.json.state).toBe("DROPPED");
    expect(t.json.label).toBe("NEEDS_ATTENTION");
    expect(
      t.json.attempts.map((x: { recovery: string }) => x.recovery),
    ).toEqual(["NONCE_CONSUMED_UNIDENTIFIED"]);
    expect(t.json.needsAttention).toBe(true);
    expect(t.json.completed).toBe(false);
  });
});

void spawn;
void readFileSync;
void writeFileSync;
void join;
