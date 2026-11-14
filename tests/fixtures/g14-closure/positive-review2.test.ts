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

describe("review 2 N1: a replaced or sped-up step is identified on both operators and never reads as a quiet PENDING", () => {
  it("a speed-up of the APPROVE (same nonce, same request, new hash) is found and tracked on to RECONCILED", async () => {
    openCanaryRuntime({ dir });
    const { p, a } = wallet();
    const r1 = await review();
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
    const sped = chain.replace(s1.result.hash);
    chain.mine(10);
    const t1 = await track(r1.json as never);
    expect(t1.json.notes, JSON.stringify(t1.json)).toContain(
      `REPLACED_BY_SAME_INTENT:${sped}`,
    );
    expect(t1.json.hashes.approval).toBe(sped);
    expect(t1.json.needsAttention).toBe(true);
    expect((await track(r1.json as never)).json.state).toBe(
      "APPROVAL_CONFIRMED",
    );
    vi.setSystemTime(Date.now() + 3_000);
    const r2 = await review(r1.json.record, r1.json.session);
    expect(r2.json.ready, JSON.stringify(r2.json.checks)).toBe(true);
    expect(r2.json.needsApproval).toBe(false);
    const s2 = await step(r2.json as never, a);
    expect(s2.result).toMatchObject({ action: "SEND", recorded: true });
    chain.mine(10);
    await track(r2.json as never);
    chain.fill(s2.result.hash);
    const done = await track(r2.json as never);
    expect(done.json.state, JSON.stringify(done.json.notes)).toBe("RECONCILED");
    expect(done.json.completed).toBe(true);
    expect(p.count("eth_sendTransaction")).toBe(2);
  });
});

describe("review 2 N2: only the page that started a record (its resume key) may step after a resume", () => {
  it("without the key a resume only observes; a wrong key is refused; with the key it steps; observers never evict the owner", async () => {
    openCanaryRuntime({ dir });
    const r1 = await review();
    expect(r1.json.resumeKey).toMatch(/^[0-9a-f]{64}$/);
    // A third party names the public account and amount.
    const obs = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
    });
    expect(obs.status, JSON.stringify(obs.json)).toBe(200);
    expect(obs.json.mode).toBe("OBSERVE");
    expect(
      (
        await api({
          action: "canary-authorize",
          session: obs.json.session,
          record: obs.json.record,
          trustedGesture: true,
        })
      ).json.error,
    ).toBe("SESSION_OBSERVE_ONLY");
    expect((await review(obs.json.record, obs.json.session)).json.error).toBe(
      "SESSION_OBSERVE_ONLY",
    );
    expect((await track(obs.json)).status).toBe(200);
    const wrong = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
      record: r1.json.record,
      resumeKey: "0".repeat(64),
    });
    expect(wrong.json.error).toBe("RESUME_KEY_INVALID");
    // Many observers (directly on the runtime, past the rate scope) never push the owner's STEP session out.
    for (let i = 0; i < 80; i++)
      runtimeModule.canaryRuntime().resume({ account: SYN, amount: amount() });
    const auth = await api({
      action: "canary-authorize",
      session: r1.json.session,
      record: r1.json.record,
      trustedGesture: true,
    });
    expect(auth.status, JSON.stringify(auth.json)).toBe(200);
    // With the key (kept by the page that started the record) the binding may step.
    const keyed = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
      record: r1.json.record,
      resumeKey: r1.json.resumeKey,
    });
    expect(keyed.json.mode).toBe("STEP");
    expect(JSON.stringify(keyed.json)).not.toMatch(
      /"data":"0x|transactionRequest|preparation|resumeKey/,
    );
    // A resume has its own, small rate scope.
    let limited = false;
    for (let i = 0; i < 12 && !limited; i++)
      limited =
        (await api({ action: "canary-resume", account: SYN, amount: amount() }))
          .json.error === "RATE_LIMITED";
    expect(limited).toBe(true);
  });
});

describe("review 2 N3: overlapping hash verification", () => {
  it("a page's hash write and tracking calls that overlap leave ONE correct SUBMITTED, never HASH_AFTER_END", async () => {
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
      request: "9".repeat(32),
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
    const hash = chain.submit(prep.transaction);
    const [w] = await Promise.all([
      api({
        action: "canary-record",
        session: s.session,
        kind: "hash",
        ref,
        hash,
      }),
      track(s),
      track(s),
    ]);
    expect(w.status, JSON.stringify(w.json)).toBe(200);
    const after = await track(s);
    expect(
      after.json.attempts.map((x: { recovery: string }) => x.recovery),
    ).toEqual(["SUBMITTED"]);
    expect(after.json.state).toBe("APPROVAL_SUBMITTED");
    expect(after.json.needsAttention).toBe(false);
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    const res = await api({
      action: "canary-resume",
      account: SYN,
      amount: amount(),
      record: s.record,
      resumeKey: r1.json.resumeKey,
    });
    expect(
      res.json.view.attempts.map((x: { recovery: string }) => x.recovery),
    ).toEqual(["SUBMITTED"]);
  });
});

describe("review 2 R2: a store that cannot be opened is still shown, read-only", () => {
  it("another live process holds the store: track / resume answer 503 with the journal's records; every step is refused", async () => {
    openCanaryRuntime({ dir });
    const r1 = await review();
    closeCanaryRuntime();
    const def = runtimeModule.DEFAULT_CANARY_STORE_DIR();
    try {
      mkdirSync(def, { recursive: true });
      copyFileSync(join(dir, "journal.ndjson"), join(def, "journal.ndjson"));
      writeFileSync(
        join(def, "writer.lock"),
        JSON.stringify({ pid: process.ppid, token: "d".repeat(32), at: 1 }),
      );
      const res = await api({
        action: "canary-resume",
        account: SYN,
        amount: amount(),
      });
      expect(res.status, JSON.stringify(res.json)).toBe(503);
      expect(res.json.error).toBe("STORE_UNAVAILABLE");
      expect(res.json.code).toBe("STORE_LOCKED");
      expect(res.json.inspection.needsAttention).toBe(true);
      expect(
        res.json.inspection.records.map((x: { record: string }) => x.record),
      ).toContain(r1.json.record);
      const t = await track(r1.json as never);
      expect(t.status).toBe(503);
      // Review 3 N15: the journal is shown only to a resume that names the approved account and amount.
      expect(t.json.inspection).toBeUndefined();
      expect(res.json.inspection.store.status).toBe("READY");
      const stranger = await api({
        action: "canary-resume",
        account: "0x" + "4".repeat(40),
        amount: amount(),
      });
      expect(stranger.status).toBe(503);
      expect(stranger.json.inspection).toBeUndefined();
      const auth = await api({
        action: "canary-authorize",
        session: r1.json.session,
        record: r1.json.record,
        trustedGesture: true,
      });
      expect(auth.status).toBe(503);
      expect(JSON.stringify(auth.json)).not.toMatch(
        /token|transaction|inspection/,
      );
    } finally {
      closeCanaryRuntime();
      rmSync(def, { recursive: true, force: true });
    }
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
