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

// REVIEW 10 (VEINED-G14-CLOSURE-FOLLOWUP-20261113-01) — R10-2 / R10-3: the not-final tail and one chain view
// SYNTHETIC_TEST_ONLY: the account 0x3333…3333, the owner record and every chain value are made up; the wallet is an
// in-memory EIP-1193 double; the two operators per chain are the local fake chain. Nothing signs or reaches a network.
// API-driven (no page-side step registry), so one file holds several scenarios.
/** The step handed to a wallet whose answer never reached the server, then UNCERTAIN (authorization ended). */
async function uncertainStep() {
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
    request: "5".repeat(32),
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
  return { r1, s, prep, ref };
}
/** The step's own transaction verified on both operators: APPROVAL_SUBMITTED (API-driven, as the page would do it). */
async function submittedStep() {
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
    request: "6".repeat(32),
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
  const w = await api({
    action: "canary-record",
    session: s.session,
    kind: "hash",
    ref,
    hash,
  });
  expect(w.json.ok, JSON.stringify(w.json)).toBe(true);
  expect((await track(s)).json.state).toBe("APPROVAL_SUBMITTED");
  return { r1, s, prep, hash, nonce: chain.txs.get(hash)!.tx.nonce };
}
const otherAmount = (data: string) =>
  data.slice(0, -1) + (data.endsWith("1") ? "2" : "1");
const notAdopted = (t: Json) => {
  expect(t.state, JSON.stringify(t.notes)).toBe("UNCERTAIN");
  expect(t.hashes.approval).toBeNull();
  expect(
    t.notes.some((n: string) => n.startsWith("OWN_TRANSACTION_FOUND_ON_CHAIN")),
  ).toBe(false);
  expect(t.needsAttention).toBe(true);
};

/** The nonce is consumed by something nobody can identify; first sighting; then that block becomes final. */
async function consumedThenFinal() {
  const st = await submittedStep();
  chain.vanish(st.hash);
  chain.advance("8453", 12);
  vi.setSystemTime(Date.now() + 5 * 60_000);
  const first = (await track(st.s)).json;
  expect(first.notes).toContain("NONCE_USED_BY_ANOTHER_TRANSACTION");
  expect(first.state).toBe("APPROVAL_SUBMITTED");
  chain.advance("8453", 12);
  return st;
}
describe("review 10 R10-2 / R10-3: the not-final tail and the one chain view of the negative end", () => {
  it("R10-3 (M1/M2): a tail read stopped by the budget decides nothing; the same-intent consumer behind 9 other logs is found next call", async () => {
    const st = await consumedThenFinal();
    for (let k = 0; k < 9; k++) chain.strayApproval();
    const consumer = chain.submit(st.prep.transaction);
    chain.txs.get(consumer)!.tx.nonce = st.nonce;
    chain.mine(0);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_SUBMITTED");
    expect(t.notes).toContain("REPLACEMENT_SEARCH:SCANNING");
    const next = (await track(st.s)).json;
    expect(next.notes, JSON.stringify(next.notes)).toContain(
      `REPLACED_BY_SAME_INTENT:${consumer}`,
    );
  });
  it("R10-3 (M4): another intent in the not-final tail decides nothing; at the confirmation depth it is REPLACED by the other intent", async () => {
    const st = await consumedThenFinal();
    const consumer = chain.submit({
      ...st.prep.transaction,
      data: otherAmount(st.prep.transaction.data),
    });
    chain.txs.get(consumer)!.tx.nonce = st.nonce;
    chain.mine(0);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_SUBMITTED");
    expect(t.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:OTHER_INTENT_NOT_FINAL",
    );
    chain.advance("8453", 10);
    const deep = (await track(st.s)).json;
    expect(deep.notes, JSON.stringify(deep.notes)).toContain(
      `REPLACED_BY_OTHER_INTENT:${consumer}`,
    );
  });
  it("R9-4: a log of the attempt's own hash in range (its receipt and transaction read absent) never ends the record", async () => {
    const st = await submittedStep();
    chain.mine(10);
    chain.txs.delete(st.hash);
    chain.advance("8453", 12);
    for (const minutes of [31, 90]) {
      vi.setSystemTime(Date.now() + minutes * 60_000);
      const t = (await track(st.s)).json;
      expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_SUBMITTED");
      expect(t.notes).toContain(
        "REPLACEMENT_SEARCH_UNDECIDED:OWN_HASH_LOG_IN_RANGE",
      );
      expect(t.terminal).toBe(false);
    }
  });
  it("R10-2: when the nonce reads unused again during the deciding call, nothing ends; the same-intent transaction mined later is followed", async () => {
    const st = await consumedThenFinal();
    // During the deciding call, as the not-final tail is read, a reorganisation makes the nonce unused again.
    let armed = true;
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body ?? "null")) as {
        method: string;
        params: { toBlock?: string }[];
      };
      if (
        armed &&
        rpc?.method === "eth_getLogs" &&
        BigInt(rpc.params[0].toBlock ?? "0") ===
          BigInt(chain.head("8453").number)
      ) {
        armed = false;
        chain.state.nonce--;
      }
      return chain.fetch(url, init);
    });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(armed).toBe(false);
    expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_SUBMITTED");
    expect(t.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:NONCE_NOT_CONSUMED_AT_DECISION",
    );
    // Later the step's same-intent transaction (its nonce) is mined after all: it is followed.
    chain.state.nonce++;
    const consumer = chain.submit(st.prep.transaction);
    chain.txs.get(consumer)!.tx.nonce = st.nonce;
    chain.mine(12);
    let c = (await track(st.s)).json;
    for (let k = 0; k < 6 && c.state !== "APPROVAL_CONFIRMED"; k++)
      c = (await track(st.s)).json;
    expect(c.state, JSON.stringify(c.notes)).toBe("APPROVAL_CONFIRMED");
  });
  // Review 12 R12-1 — TEST CONTRACT CHANGE (this file's own R11-3 case): a block arriving during the deciding call no
  // longer postpones the decision (on Base a block arrives every 2 s); the tail is read again up to the new head.
  it("R12-1: the chain advances during EVERY deciding call (as on Base): the one negative end is still reached", async () => {
    const st = await consumedThenFinal();
    const onLogs = (toBlock: bigint) => {
      void toBlock;
      chain.advance("8453", 1);
    };
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body ?? "null")) as {
        method: string;
        params: { toBlock?: string }[];
      };
      if (rpc?.method === "eth_getLogs")
        onLogs(BigInt(rpc.params[0].toBlock ?? "0"));
      return chain.fetch(url, init);
    });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    let t = (await track(st.s)).json;
    for (let k = 0; k < 3 && t.state !== "DROPPED"; k++)
      t = (await track(st.s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("DROPPED");
    const ev = t.attempts[0].evidence;
    expect(ev).toMatchObject({
      rule: "INTENT_LOG_ABSENT_OVER_COMPLETE_AGREED_RANGE",
    });
    expect(BigInt(ev.notFinalTailReadTo) > BigInt(ev.agreedHead)).toBe(true);
  });
  it("R12-1 / R11-3: a reorganisation during the deciding call puts the consumer at a height already read as empty and moves the head on: found in the second tail read, never DROPPED", async () => {
    const st = await consumedThenFinal();
    let armed = true;
    let consumer = "";
    let tailAnswers = 0;
    // The reorganisation happens only AFTER both operators answered the first read of the not-final tail (which was
    // empty): the consumer then sits at a height that read already saw as empty, and the head moves on.
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body ?? "null")) as {
        method: string;
        params: { toBlock?: string }[];
      };
      const h = chain.head("8453").number;
      const answer = await chain.fetch(url, init);
      if (
        armed &&
        rpc?.method === "eth_getLogs" &&
        BigInt(rpc.params[0].toBlock ?? "0") === BigInt(h) &&
        ++tailAnswers === 2
      ) {
        armed = false;
        consumer = chain.submit(st.prep.transaction);
        chain.txs.get(consumer)!.tx.nonce = st.nonce;
        chain.mine(0, { at: h });
        chain.advance("8453", 1);
      }
      return answer;
    });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(armed).toBe(false);
    expect(t.state, JSON.stringify(t.notes)).not.toBe("DROPPED");
    expect(t.notes).toContain(`REPLACED_BY_SAME_INTENT:${consumer}`);
  });
  it("R13-1: the nonce is consumed only in the not-final tail (the consumer re-mined there after a reorganisation): nothing ends until it is consumed AT the final block", async () => {
    const st = await consumedThenFinal();
    // From two blocks below the head on, the nonce reads consumed; below that it reads unused.
    chain.state.nonceBefore = {
      block: chain.head("8453").number - 2,
      value: BigInt(st.nonce),
    };
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("APPROVAL_SUBMITTED");
    expect(t.notes).toContain(
      "REPLACEMENT_SEARCH_UNDECIDED:NONCE_NOT_CONSUMED_AT_FINAL_BLOCK",
    );
    // Once that block is final (and nothing of the step is on chain), the end is decided, with the final block's nonce.
    chain.advance("8453", 12);
    const end = (await track(st.s)).json;
    expect(end.state, JSON.stringify(end.notes)).toBe("DROPPED");
    expect(end.attempts[0].evidence).toMatchObject({
      rule: "INTENT_LOG_ABSENT_OVER_COMPLETE_AGREED_RANGE",
    });
    expect(
      BigInt(end.attempts[0].evidence.nonceAtFinalBlock) > BigInt(st.nonce),
    ).toBe(true);
  });
  it("R13-2: two overlapping tracking calls of one record both answer normally (they run one after another)", async () => {
    const st = await consumedThenFinal();
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      vi.setSystemTime(Date.now() + 3);
      return chain.fetch(url, init);
    });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const [x, y] = await Promise.all([track(st.s), track(st.s)]);
    expect(x.status, JSON.stringify(x.json)).toBe(200);
    expect(y.status, JSON.stringify(y.json)).toBe(200);
    expect(y.json.state).toBe("DROPPED");
  });
  it("R13-3: candidates read and journaled by the first tail read are not read again by the second: the end is decided in one call", async () => {
    const st = await consumedThenFinal();
    for (let k = 0; k < 5; k++) chain.strayApproval();
    vi.setSystemTime(Date.now() + 31 * 60_000);
    const t = (await track(st.s)).json;
    expect(t.state, JSON.stringify(t.notes)).toBe("DROPPED");
  });
});

void spawn;
void readFileSync;
void CanaryRuntime;
void canaryArmed;
void CANARY_LIVE_WIRING;
void fx;
void mkdtempSync;
