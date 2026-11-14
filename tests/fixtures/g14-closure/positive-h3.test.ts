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

describe("H3 + persistence on the runtime: conditional, attempt-bound, durable transitions", () => {
  it("a late write of a cancelled request is refused; an old clean-up cannot clear a newer write; replay is refused", async () => {
    const rt = openCanaryRuntime({ dir });
    const r = await review();
    const s = r.json as { record: string; session: string };
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
    const ref = (request: string) => ({
      record: prep.record,
      action: prep.action,
      attempt: prep.attempt,
      digest: prep.digest,
      request,
    });
    const w = (kind: string, request: string, hash?: string) =>
      api({
        action: "canary-record",
        session: s.session,
        kind,
        ref: ref(request),
        ...(hash ? { hash } : {}),
      }).then((x) => x.json);
    const r1 = "1".repeat(32),
      r2 = "2".repeat(32);
    // The clean-up of r1 arrives BEFORE r1's own (timed-out) write: r1 is cancelled ahead and can never count.
    expect(await w("not-requested", r1)).toMatchObject({
      ok: true,
      state: "PREPARED",
    });
    expect(await w("requested", r1)).toMatchObject({
      ok: false,
      code: "REQUEST_CANCELLED",
    });
    // A new write r2 is accepted; r1's stale clean-up cannot clear it.
    expect(await w("requested", r2)).toMatchObject({
      ok: true,
      state: "REQUESTED",
    });
    expect(await w("not-requested", r1)).toMatchObject({
      ok: false,
      code: "CLEANUP_NOT_OWN_WRITE",
    });
    // The same token is single use; the prepared step is never re-prepared.
    expect(
      (
        await api({
          action: "canary-prepare",
          session: s.session,
          record: s.record,
          token: auth.json.token,
        })
      ).json.error,
    ).toMatch(/NONCE_REUSED_GLOBAL|REVOKED|NOT_REVIEWED|GATE_CLOSED/);
    // An answer for another digest / attempt is unknown.
    expect(
      (
        await api({
          action: "canary-record",
          session: s.session,
          kind: "uncertain",
          ref: { ...ref(r2), digest: "e".repeat(64) },
        })
      ).json.error,
    ).toBe("ATTEMPT_UNKNOWN");
    // The step's outcome is not known: UNCERTAIN, no new request, ever.
    expect(await w("uncertain", r2)).toMatchObject({
      ok: true,
      state: "UNCERTAIN",
    });
    expect(await w("requested", "3".repeat(32))).toMatchObject({
      ok: false,
      code: "ATTEMPT_ALREADY_REQUESTED",
    });
    // Every transition is on disk, chained, in order.
    const types = CanaryDurableStore.inspect(dir)
      .entries.filter((e) => e.type === "ATTEMPT")
      .map((e) => (e.data as { state: string }).state);
    expect(types).toEqual(["PREPARED", "REQUESTED", "UNCERTAIN"]);
    expect(rt.store.status).toBe("READY");
  });
  it("a second writer process is refused by the OS lock while the first is alive", async () => {
    openCanaryRuntime({ dir });
    expect(() => new CanaryRuntime(dir)).toThrow("STORE_LOCKED");
  });
});

void spawn;
void readFileSync;
void writeFileSync;
void join;
