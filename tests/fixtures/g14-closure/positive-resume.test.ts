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

describe("review 1 F1: after a restart the record is reached again through the API and tracked to RECONCILED", () => {
  it("restart mid-canary -> canary-resume -> track -> fresh review -> send -> RECONCILED; no step is repeated", async () => {
    openCanaryRuntime({ dir });
    const { p, a } = wallet();
    const r1 = await review();
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
    // The server restarts. The old session is gone with the process.
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    expect((await track(r1.json as never)).json.error).toBe("SESSION_INVALID");
    // Read-only re-binding: same account / amount check as a review; a fresh session for the existing record.
    const wrong = await api({
      action: "canary-resume",
      account: "0x" + "4".repeat(40),
      amount: owner().exactAmount,
    });
    expect(wrong.json.error).toBe("NOT_THE_APPROVED_CANARY");
    const res = await api({
      action: "canary-resume",
      account: SYN,
      amount: owner().exactAmount,
      record: r1.json.record,
      resumeKey: r1.json.resumeKey,
    });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.mode).toBe("STEP");
    expect(res.json.record).toBe(r1.json.record);
    expect(res.json.view.state).toBe("APPROVAL_SUBMITTED");
    expect(JSON.stringify(res.json)).not.toMatch(
      /"data":"0x|transactionRequest|preparation/,
    );
    const bound = { record: res.json.record, session: res.json.session };
    chain.mine(10);
    const t1 = await track(bound);
    expect(t1.json.state).toBe("APPROVAL_CONFIRMED");
    vi.setSystemTime(Date.now() + 3_000);
    const r2 = await review(bound.record, bound.session);
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
  it("a store that cannot be written is shown read-only (nothing observed or written) and nothing can be prepared", async () => {
    openCanaryRuntime({ dir });
    const r1 = await review();
    expect(r1.json.ready).toBe(true);
    closeCanaryRuntime();
    // The last line is cut short (an interrupted write): the store opens read-only.
    const journal = join(dir, "journal.ndjson");
    writeFileSync(
      journal,
      readFileSync(journal, "utf8") + '{"s":999,"t":"USE"',
    );
    openCanaryRuntime({ dir });
    const res = await api({
      action: "canary-resume",
      account: SYN,
      amount: owner().exactAmount,
    });
    expect(res.json.store.status).toBe("TORN_TAIL");
    const t = await track({
      record: res.json.record,
      session: res.json.session,
    });
    expect(t.status).toBe(200);
    expect(
      t.json.notes.some((n: string) => n.startsWith("STORE_READ_ONLY")),
    ).toBe(true);
    // Still observed on the chain, read-only (review 2 R2): what both operators show is in the notes.
    expect(t.json.notes.some((n: string) => n.startsWith("CHAIN_NONCE:"))).toBe(
      true,
    );
    expect(t.json.needsAttention).toBe(true);
    const auth = await api({
      action: "canary-authorize",
      session: res.json.session,
      record: res.json.record,
      trustedGesture: true,
    });
    expect(auth.json.error).toBe("STORE_NEEDS_ATTENTION");
  });
  it("a page whose session died with the restart can still report its hash (bound by the attempt reference, verified on chain)", async () => {
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
      request: "7".repeat(32),
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
    // The wallet answers, the server restarts before the page reports.
    const hash = chain.submit(prep.transaction);
    closeCanaryRuntime();
    openCanaryRuntime({ dir });
    const late = await api({
      action: "canary-record",
      session: s.session,
      kind: "hash",
      ref,
      hash,
    });
    expect(late.status, JSON.stringify(late.json)).toBe(200);
    expect(late.json.state).toBe("SUBMITTED");
    // A forged reference is unknown; another action than a hash claim still needs a live session.
    expect(
      (
        await api({
          action: "canary-record",
          session: s.session,
          kind: "hash",
          ref: { ...ref, digest: "e".repeat(64) },
          hash,
        })
      ).json.error,
    ).toBe("ATTEMPT_UNKNOWN");
    expect(
      (
        await api({
          action: "canary-record",
          session: s.session,
          kind: "uncertain",
          ref,
        })
      ).json.error,
    ).toBe("SESSION_INVALID");
  });
});

void spawn;
void readFileSync;
void writeFileSync;
void join;
