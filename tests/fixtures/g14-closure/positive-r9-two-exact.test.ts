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

// REVIEW 9 (VEINED-G14-CLOSURE-FOLLOWUP-20261113-01) — R9-2 / R8-1 boundaries: only ONE exact own transaction is adopted
// SYNTHETIC_TEST_ONLY: the account 0x3333…3333, the owner record and every chain value are made up; the wallet is an
// in-memory EIP-1193 double; the two operators per chain are the local fake chain. Nothing signs or reaches a network.

describe("review 9 R9-2 / R8-1: an UNCERTAIN step adopts only exactly one exact transaction over the complete final range", () => {
  it("another amount is never adopted; two exact transactions in different windows are MORE_THAN_ONE_CANDIDATE and nothing is adopted", async () => {
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
    vi.setSystemTime(Date.now() + 61_000);
    expect((await track(s)).json.state).toBe("UNCERTAIN");
    // An approval of ANOTHER amount from the owner (same target, other calldata): not the step.
    const data = prep.transaction.data as string;
    const other = data.slice(0, -1) + (data.endsWith("1") ? "2" : "1");
    chain.submit({ ...prep.transaction, data: other });
    chain.mine(12);
    vi.setSystemTime(Date.now() + 60_000);
    const t1 = (await track(s)).json;
    expect(t1.state, JSON.stringify(t1.notes)).toBe("UNCERTAIN");
    expect(t1.notes).toContain("OWN_TRANSACTION_SEARCH:NOT_FOUND");
    // Two EXACT transactions of the step (two nonces), 6,000 blocks apart (different search windows).
    chain.submit(prep.transaction);
    chain.mine(6_000);
    chain.submit(prep.transaction);
    chain.mine(12);
    vi.setSystemTime(Date.now() + 60_000);
    let t2 = (await track(s)).json;
    for (
      let k = 0;
      k < 4 &&
      !t2.notes.includes(
        "OWN_TRANSACTION_SEARCH:UNKNOWN:MORE_THAN_ONE_CANDIDATE",
      );
      k++
    )
      t2 = (await track(s)).json;
    expect(t2.notes, JSON.stringify(t2.notes)).toContain(
      "OWN_TRANSACTION_SEARCH:UNKNOWN:MORE_THAN_ONE_CANDIDATE",
    );
    expect(t2.state).toBe("UNCERTAIN");
    expect(t2.hashes.approval).toBeNull();
    expect(t2.needsAttention).toBe(true);
    expect(
      t2.notes.some((n: string) =>
        n.startsWith("OWN_TRANSACTION_FOUND_ON_CHAIN"),
      ),
    ).toBe(false);
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
void mkdtempSync;
