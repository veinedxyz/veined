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

describe("variant identity: exactly the two protected constants differ (test-only)", () => {
  it("is armed only by the synthetic record and the wiring constant", () => {
    expect(OWNER_CANARY_APPROVAL?.account.toLowerCase()).toBe(
      SYN.toLowerCase(),
    );
    expect(CANARY_LIVE_WIRING).toBe(true);
    expect(canaryArmed()).toEqual({ armed: true, reasons: [] });
  });
});

describe("POSITIVE: approve -> mined -> fresh review -> send -> source -> destination -> RECONCILED", () => {
  it("the whole canary on the real composition; exactly two financial requests; only RECONCILED reads completed", async () => {
    openCanaryRuntime({ dir });
    const { p, a } = wallet();
    const r1 = await review();
    expect(r1.status, JSON.stringify(r1.json).slice(0, 2000)).toBe(200);
    expect(r1.json.ready, JSON.stringify(r1.json.checks)).toBe(true);
    expect(r1.json.needsApproval).toBe(true);
    expect(r1.json.plan).toMatchObject({
      account: SYN,
      amountIn: "5000000",
      minimumOut: "4900000",
      ownerMinimumOut: "4900000",
      target: fx.estimate.approvalAddress,
      spender: fx.estimate.approvalAddress,
    });
    expect(r1.json.guardian.level).toMatch(/^(CLEAR|CAUTION)$/);
    // No review answer carries anything signable.
    expect(JSON.stringify(r1.json)).not.toMatch(
      /"data":"0x|transactionRequest/,
    );
    const s1 = await step(r1.json as never, a);
    expect(s1.result).toMatchObject({ action: "APPROVE", recorded: true });
    expect(s1.preparation.transaction.to.toLowerCase()).toBe(
      owner().token.toLowerCase(),
    );
    // Mined and confirmed (10 Base confirmations), tracked read-only.
    chain.mine(10);
    const t1 = await track(r1.json as never);
    expect(t1.json.state).toBe("APPROVAL_CONFIRMED");
    expect(t1.json.completed).toBe(false);
    // The SEND needs a FRESH review: same record, the exact allowance is now present -> no second approval.
    vi.setSystemTime(Date.now() + 3_000);
    const r2 = await review(r1.json.record, r1.json.session);
    expect(r2.status, JSON.stringify(r2.json).slice(0, 1500)).toBe(200);
    expect(r2.json.ready, JSON.stringify(r2.json.checks)).toBe(true);
    expect(r2.json.needsApproval).toBe(false);
    expect(
      r2.json.checks.find((c: { id: string }) => c.id === "ALLOWANCE"),
    ).toMatchObject({ status: "PASS", code: "EXACT_ALLOWANCE_PRESENT" });
    // The mined approval's real cost (receipt gas x price + L1 fee) is now part of the gas budget.
    expect(BigInt(r2.json.gas.spentWei)).toBe(
      0xd88dn * (5_000_000n + 1_000_000n) + 1_234n,
    );
    const s2 = await step(r2.json as never, a);
    expect(s2.result).toMatchObject({ action: "SEND", recorded: true });
    chain.mine(10);
    const t2 = await track(r2.json as never);
    expect(["SOURCE_CONFIRMED", "DESTINATION_PENDING"]).toContain(
      t2.json.state,
    );
    expect(t2.json.completed).toBe(false);
    // The relayer fills exactly the deposit; settlement and reconciliation from the server's own reads.
    chain.fill(s2.result.hash);
    const t3 = await track(r2.json as never);
    expect(t3.json.state, JSON.stringify(t3.json.notes)).toBe("RECONCILED");
    expect(t3.json.completed).toBe(true);
    expect(t3.json.audit.anchored).toBe(true);
    expect(t3.json.notes).not.toContain("ALLOWANCE_NOT_ZERO_AFTER");
    expect(BigInt(t3.json.gasSpentWei)).toBeLessThanOrEqual(
      BigInt(owner().nativeGasBudgetWei),
    );
    // Exactly two financial requests reached the fake wallet; no switch, add, sign or raw send at all.
    expect(p.count("eth_sendTransaction")).toBe(2);
    expect(
      p.calls.filter((c) =>
        /sign|sendRaw|addEthereumChain|switchEthereumChain/i.test(c.method),
      ),
    ).toEqual([]);
    // Single use: the canary cannot be reviewed into a third step.
    const again = await review();
    expect(again.json.ready).toBe(false);
    expect(
      again.json.checks.find((c: { id: string }) => c.id === "SINGLE_USE"),
    ).toMatchObject({ status: "FAIL", code: "CANARY_ALREADY_SENT" });
  });
});

describe("server composition: no client verdict, identity, transaction or settlement is taken", () => {
  it("strict schemas refuse client verdicts and extra fields; session, origin and content type are enforced", async () => {
    openCanaryRuntime({ dir });
    for (const extra of [
      { ready: true },
      { guardian: { level: "CLEAR" } },
      { proven: true },
      { digest: "a".repeat(64) },
      { spentWei: "0" },
      { minOut: "1" },
      { budget: "1" },
      { settlement: "DELIVERED" },
    ]) {
      const r = await api({
        action: "canary-review",
        account: SYN,
        chainId: "8453",
        amount: "5000000",
        ...extra,
      });
      expect(r.status, JSON.stringify(extra)).toBe(422);
      expect(r.json.error).toBe("INVALID_REQUEST");
    }
    // Another account or another amount is not the approved canary.
    expect(
      (
        await api({
          action: "canary-review",
          account: "0x" + "4".repeat(40),
          chainId: "8453",
          amount: "5000000",
        })
      ).json.error,
    ).toBe("NOT_THE_APPROVED_CANARY");
    expect(
      (
        await api({
          action: "canary-review",
          account: SYN,
          chainId: "8453",
          amount: "4999999",
        })
      ).json.error,
    ).toBe("NOT_THE_APPROVED_CANARY");
    const r = await review();
    expect(r.json.ready).toBe(true);
    // Wrong session / another record: refused.
    expect(
      (
        await api({
          action: "canary-authorize",
          session: "f".repeat(64),
          record: r.json.record,
          trustedGesture: true,
        })
      ).json.error,
    ).toBe("SESSION_INVALID");
    // A wallet that claims another network: the review is not ready.
    const other = await api({
      action: "canary-review",
      account: SYN,
      chainId: "1",
      amount: "5000000",
      ownerKey: SYNTHETIC_OWNER_KEY,
    });
    expect(other.json.ready).toBe(false);
    // A foreign origin and a non-JSON body never reach the runtime.
    expect(
      (
        await api(
          { action: "canary-status" },
          { origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    const res = await POST(
      new NextRequest(`${ORIGIN}/api/execution`, {
        method: "POST",
        headers: {
          host: "127.0.0.1:3100",
          origin: ORIGIN,
          "content-type": "text/plain",
        },
        body: "{}",
      }),
    );
    expect(res.status).toBe(422);
    // A hand-made authorization token is FORGED.
    const forged = await api({
      action: "canary-prepare",
      session: r.json.session,
      record: r.json.record,
      token: {
        action: "APPROVE",
        review: r.json.review,
        record: r.json.record,
        account: SYN,
        chainId: "8453",
        issuedAt: Date.now(),
        expiresAt: Date.now() + 1000,
        nonce: "1".repeat(32),
        mac: "0".repeat(64),
      },
    });
    expect(forged.json.error).toBe("FORGED");
  });
  it("a broad, unlimited or wrong-spender standing allowance stops the canary (no new approval is produced)", async () => {
    chain.state.allowance = 10n ** 30n;
    openCanaryRuntime({ dir });
    const r = await review();
    expect(r.json.ready).toBe(false);
    expect(
      r.json.checks.find((c: { id: string }) => c.id === "ALLOWANCE"),
    ).toMatchObject({ status: "FAIL", code: "UNEXPECTED_EXISTING_ALLOWANCE" });
    expect(
      (
        await api({
          action: "canary-authorize",
          session: r.json.session,
          record: r.json.record,
          trustedGesture: true,
        })
      ).json.error,
    ).toMatch(/^(GATE_CLOSED|NOT_REVIEWED)$/);
  });
  it("one operator missing or a disagreeing head: the review is never ready (no silent single source)", async () => {
    openCanaryRuntime({ dir });
    chain.diverge["8453"] = "OFFLINE";
    expect((await review()).json.ready).toBe(false);
    chain.diverge["8453"] = "OTHER_HEAD";
    expect((await review()).json.ready).toBe(false);
  });
});

void spawn;
void readFileSync;
void writeFileSync;
void join;
