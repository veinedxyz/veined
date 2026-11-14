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

// REVIEW 15 (VEINED-G14-CLOSURE-FOLLOWUP-20261113-01) — R15-1: the reconciliation that ENDS a record reads FINAL
// blocks; R15-2: the destination and refund windows never pass a not-final block.
// SYNTHETIC_TEST_ONLY: the account 0x3333…3333, the owner record and every chain value are made up; the wallet is an
// in-memory EIP-1193 double; the two operators per chain are the local fake chain. Nothing signs or reaches a network.
const has = (t: Json, prefix: string) =>
  (t.notes as string[]).some((n) => n.startsWith(prefix));
/** The main step sent, mined with `extra` blocks after it, and tracked once. */
async function sent(extra = 10) {
  const { p, a } = wallet();
  const { r2 } = await toSendReview(a);
  const s2 = await step(r2.json as never, a);
  expect(s2.result).toMatchObject({ action: "SEND", recorded: true });
  chain.mine(extra);
  await track(r2.json as never);
  return {
    p,
    r: r2.json as { record: string; session: string },
    hash: s2.result.hash as string,
  };
}
const trackUntil = async (
  r: { record: string; session: string },
  want: string,
  max = 4,
) => {
  let t = (await track(r)).json;
  for (let k = 0; k < max && t.state !== want; k++) t = (await track(r)).json;
  return t;
};
describe("review 15 R15-1: the reconciliation that ends a record reads the FINAL block of each chain", () => {
  it("a not-final unrelated change decides nothing: the end waits for the final balances", async () => {
    openCanaryRuntime({ dir });
    const { p, r, hash } = await sent();
    chain.fill(hash);
    chain.move("42161", 1n, { final: true });
    chain.move("42161", -1n);
    const t = (await track(r)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("SETTLED");
    expect(t.terminal).toBe(false);
    expect(
      has(t, "RECONCILIATION:UNKNOWN:UNRELATED_ACTIVITY"),
      JSON.stringify(t.notes),
    ).toBe(true);
    chain.advance("42161", 10);
    const end = await trackUntil(r, "RECONCILED");
    expect(end.state, JSON.stringify(end.notes)).toBe("RECONCILED");
    expect(end.completed).toBe(true);
    expect(p.count("eth_sendTransaction")).toBe(2);
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
void copyFileSync;
void mkdirSync;
void writeFileSync;
void CanaryDurableStore;
void resume;
void untilChanged;
void walletWrites;
