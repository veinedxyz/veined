// G14 CLOSURE (VEINED-G14-PP1-CLOSURE-20261112-01) — unit tests of the repaired boundaries.
// SYNTHETIC_TEST_ONLY: the account is 0x3333…3333, every "owner approval" is a made-up record that exists only in this
// test process (a test double of the protected constant, which is null in the build), the wallet is an in-memory
// EIP-1193 double without a key, and every RPC operator is a fetch double. Nothing here signs, sends or reaches a
// network. Each negative case counts the financial wallet primitive (eth_sendTransaction) and expects ZERO.
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// G14 follow-up F2: installed BEFORE the wallet adapter module is evaluated (the adapter captures the page's fetch).
import {
  json,
  legacyServer,
  pageServer,
} from "../fixtures/g14-closure/page-server";
import fx from "../fixtures/g14-canary-across.json" with { type: "json" };
import {
  ARB_A,
  ARB_B,
  BASE_A,
  BASE_B,
  DIAMOND,
  NOW,
  OTHER,
  QUOTED_AT,
  SYN,
  USDC_ARB,
  USDC_BASE,
  approveData,
  fakeWallet,
  syntheticApproval,
} from "../fixtures/g14-protected-proposal/synthetic";

const armed = vi.hoisted(() => ({ record: null as unknown }));
vi.mock("../../src/security/canary-approval", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/security/canary-approval")>();
  return {
    ...actual,
    // TEST DOUBLE of the protected constant (null in the build).
    get OWNER_CANARY_APPROVAL() {
      return armed.record;
    },
  };
});
const net = vi.hoisted(() => {
  const refuse = (): never => {
    throw new Error("NETWORK_NOT_ALLOWED_IN_UNIT_TESTS");
  };
  return {
    refuse,
    lookup: refuse as (...a: unknown[]) => unknown,
    request: refuse as (...a: unknown[]) => unknown,
  };
});
vi.mock("node:dns/promises", () => ({
  lookup: (...a: unknown[]) => net.lookup(...a),
}));
vi.mock("node:https", () => ({
  request: (...a: unknown[]) => net.request(...a),
}));

const {
  CANARY_APPROVAL_BOUNDS,
  REVOKED_CANARY_APPROVALS,
  approvalRecordProblems,
  canaryDispatchProblem,
  evaluateCanaryApproval,
} = await import("../../src/security/canary-approval");
const {
  WalletProviderAdapter,
  refusedBeforeWallet,
  CLOCK_SETBACK_TOLERANCE_MS,
  obtainCanaryDispatchAuthority,
  discardCanaryDispatchAuthority,
  CANARY_SERVER_WAIT_MS,
} = await import("../../src/features/wallet/adapter");
const { submitCanary, canaryPreparationDigest, CANARY_CONFIRM_WAIT_MS } =
  await import("../../src/features/bridge/submission");
const { RoutingCore, isCanaryQuote, upstreamRead } =
  await import("../../src/adapters/routing-core");
const {
  CANARY_READ_METHODS,
  CANARY_READ_LIMITS,
  canaryRead,
  canaryReadProblem,
  rpc,
} = await import("../../src/swap/server/transport");
const { CANARY_READ_CONTRACTS, CANARY_RPC_POOL, RPC_ORIGINS } =
  await import("../../src/swap/server/config");
const { assertSwapEgress } = await import("../../src/swap/server/egress");
const { CANARY_PINS } = await import("../../src/execution/canary/pins");
const pool = await import("../../src/execution/server/canary/rpc-pool");
const { CanaryDurableStore, readJournal, ownerHeadProblem, StoreError } =
  await import("../../src/execution/server/canary/durable-store");
const { canaryReleaseOrigins, releaseConfigurationErrors } =
  await import("../../src/release/config");
const { canaryArmed, openCanaryRuntime, canaryRuntime } =
  await import("../../src/execution/server/canary/runtime");
const { canaryGateState, CANARY_LIVE_WIRING } =
  await import("../../src/execution/server/gate");
const { canaryReadiness } =
  await import("../../src/execution/canary/readiness");

type Limits = import("../../src/security/canary-approval").CanaryDispatchLimits;
type Prep = import("../../src/features/bridge/submission").CanaryPreparation;
type Ctx =
  import("../../src/features/bridge/submission").CanarySubmissionContext;

let approvals = 0;
const arm = (over: Parameters<typeof syntheticApproval>[0] = {}) =>
  (armed.record = syntheticApproval({
    approvalId: "0x" + (++approvals).toString(16).padStart(64, "0"),
    ...over,
  }));
const approvalId = () => (armed.record as { approvalId: string }).approvalId;
beforeEach(() => {
  armed.record = null;
  vi.useFakeTimers({ toFake: ["Date", "performance"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  armed.record = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  net.lookup = net.refuse;
  net.request = net.refuse;
});

const approveTx = () => ({
  chainId: "0x2105",
  from: SYN,
  to: USDC_BASE,
  value: "0x0",
  data: approveData(),
  gas: "0x103dc",
  maxFeePerGas: "0x989680",
  maxPriorityFeePerGas: "0xf4240",
});
const mainTx = () => ({
  chainId: "0x2105",
  from: SYN,
  to: DIAMOND,
  value: "0x0",
  data: fx.transactionRequest.data,
  gas: "0xa3b9e",
  maxFeePerGas: "0x989680",
  maxPriorityFeePerGas: "0xf4240",
});
const limitsOf = (
  tx: Record<string, string>,
  over: Partial<Limits> = {},
): Limits => {
  const l = {
    approvalId: approvalId(),
    action: (tx.to.toLowerCase() === USDC_BASE.toLowerCase()
      ? "APPROVE"
      : "SEND") as Limits["action"],
    record: "canary-closure-0001",
    review: "c".repeat(64),
    attempt: "a".repeat(32),
    authorizationExpiresAt: NOW + 40_000,
    quoteExpiresAt: NOW + 60_000,
    gesture: { trusted: true, at: NOW },
    ...over,
  };
  // The server's prepared digest over exactly these limits and this transaction (review 1 F4).
  const digest = (() => {
    try {
      return canaryPreparationDigest({
        action: l.action,
        record: l.record,
        review: l.review,
        transaction: tx as never,
        expiresAt: l.authorizationExpiresAt,
        approvalId: l.approvalId,
        attempt: l.attempt,
        quoteExpiresAt: l.quoteExpiresAt,
      });
    } catch {
      return "d".repeat(64);
    }
  })();
  return { ...l, preparedDigest: over.preparedDigest ?? digest } as Limits;
};
/** A fake wallet whose identity read (the adapter's LAST await) runs `during` first. */
function slowIdentityWallet(
  during: () => void,
  opts: Parameters<typeof fakeWallet>[0] = {},
) {
  const p = fakeWallet(opts);
  const inner = p.request.bind(p);
  let ran = false;
  p.request = async (args) => {
    if (args.method === "eth_accounts" && !ran) {
      ran = true;
      during();
    }
    return inner(args);
  };
  return p;
}
const adapterOn = (p: ReturnType<typeof fakeWallet>) =>
  new WalletProviderAdapter(p, { address: SYN, chainId: 8453, epoch: 1 });
const LIMIT_KEYS = [
  "approvalId",
  "action",
  "record",
  "review",
  "attempt",
  "preparedDigest",
  "authorizationExpiresAt",
  "quoteExpiresAt",
  "gesture",
];
/**
 * G14 follow-up F2 TEST ADAPTER: what used to be "limits handed to the adapter" is now the SERVER's answer. A stub
 * page server confirms exactly the preparation these limits describe (plus any extra field, which makes it no
 * preparation) and commits the durable "requested" record; the adapter mints its authority from those answers.
 */
async function authorityFor(
  a: InstanceType<typeof WalletProviderAdapter>,
  tx: Record<string, string>,
  limits: unknown,
  serverNow?: () => number,
) {
  const l = limits as Record<string, unknown> | undefined;
  if (!l || typeof l !== "object")
    return { authority: undefined, code: "NO_LIMITS" };
  const extra = Object.fromEntries(
    Object.entries(l).filter(([k]) => !LIMIT_KEYS.includes(k)),
  );
  pageServer.handler = legacyServer({
    confirmPrepared: () => ({
      action: l.action,
      record: l.record,
      review: l.review,
      transaction: tx,
      expiresAt: l.authorizationExpiresAt,
      approvalId: l.approvalId,
      attempt: l.attempt,
      quoteExpiresAt: l.quoteExpiresAt,
      digest: l.preparedDigest,
      ...extra,
    }),
    persistUnknown: () => true,
    ...(serverNow ? { serverNow } : {}),
  });
  const got = await obtainCanaryDispatchAuthority(a, {
    session: "e".repeat(64),
    review: l.review as string,
    ref: {
      record: l.record as string,
      action: l.action as never,
      attempt: l.attempt as string,
      digest: l.preparedDigest as string,
      request: "f".repeat(32),
    },
    gesture: l.gesture as never,
  });
  return got.ok
    ? { authority: got.authority, code: null }
    : { authority: undefined, code: got.code };
}
const sendWith = async (
  a: InstanceType<typeof WalletProviderAdapter>,
  tx: Record<string, string>,
  canary: { limits: unknown; current?: () => boolean; notBefore?: number },
  signal?: AbortSignal,
) => {
  const { authority } = await authorityFor(a, tx, canary.limits);
  return a
    .sendCanonicalTransaction(
      tx,
      { ...tx },
      {
        gate: "veined-owner-canary",
        canary: {
          authority,
          ...(canary.current ? { current: canary.current } : {}),
          ...(canary.notBefore !== undefined
            ? { notBefore: canary.notBefore }
            : {}),
        } as never,
        ...(signal ? { signal } : {}),
      },
    )
    .then(
      (hash) => ({ ok: true as const, hash }),
      (e: unknown) => ({ ok: false as const, e: e as Record<string, unknown> }),
    );
};

// ------------------------------------------------------------------------------------------- PP1-AUDIT-01 adapter
describe("PP1-AUDIT-01: the adapter re-checks every limit after its last await, immediately before the wallet request", () => {
  it("null owner record: refused before ANY wallet method", async () => {
    const p = fakeWallet();
    const a = adapterOn(p);
    armed.record = null;
    const r = await sendWith(a, approveTx(), { limits: {} });
    expect(r).toMatchObject({
      ok: false,
      e: { code: "CANARY_REQUEST_REFUSED", reason: "NO_OWNER_APPROVED_CANARY" },
    });
    expect(p.calls).toEqual([]);
  });
  const late: [
    string,
    () => void,
    Parameters<typeof syntheticApproval>[0],
    Partial<Limits>,
    string,
  ][] = [
    // The independent reproduction: the owner window had 1 s left at entry, the identity read took 2 s.
    [
      "owner window expires during the identity read",
      () => vi.setSystemTime(NOW + 2_000),
      { notAfter: NOW + 1_000 },
      {},
      "APPROVAL_EXPIRED",
    ],
    [
      "action authorization expires during the identity read",
      () => vi.setSystemTime(NOW + 2_000),
      {},
      { authorizationExpiresAt: NOW + 1_000 },
      "AUTHORIZATION_EXPIRED",
    ],
    [
      "reviewed quote expires during the identity read",
      () => vi.setSystemTime(NOW + 2_000),
      {},
      { quoteExpiresAt: NOW + 1_000 },
      "QUOTE_EXPIRED",
    ],
    // The second reproduction: the gesture was 29 s old at entry and 31 s old at the request.
    [
      "owner gesture ages past 30 s during the identity read",
      () => vi.setSystemTime(NOW + 2_000),
      {},
      { gesture: { trusted: true, at: NOW - 29_000 } },
      "OWNER_GESTURE_REQUIRED",
    ],
    [
      "exact boundary: now == authorization expiry is already expired",
      () => vi.setSystemTime(NOW + 1_000),
      {},
      { authorizationExpiresAt: NOW + 1_000 },
      "AUTHORIZATION_EXPIRED",
    ],
    [
      "exact boundary: now == quote expiry is already expired",
      () => vi.setSystemTime(NOW + 500),
      {},
      { quoteExpiresAt: NOW + 500 },
      "QUOTE_EXPIRED",
    ],
    [
      "exact boundary: now == record notAfter is already expired",
      () => vi.setSystemTime(NOW + 700),
      { notAfter: NOW + 700 },
      {},
      "APPROVAL_EXPIRED",
    ],
    [
      "gesture one millisecond past its 30 s",
      () => vi.setSystemTime(NOW + 30_001),
      {},
      { authorizationExpiresAt: NOW + 60_000, quoteExpiresAt: NOW + 60_000 },
      "OWNER_GESTURE_REQUIRED",
    ],
    // A clock set BACK while the request is in flight cannot bring an expired step back to life (monotonic guard).
    [
      "clock set back during the identity read",
      () => {
        vi.advanceTimersByTime(2_000);
        vi.setSystemTime(NOW - 5_000);
      },
      {},
      { authorizationExpiresAt: NOW + 1_000 },
      "AUTHORIZATION_EXPIRED",
    ],
  ];
  for (const [name, during, record, limits, reason] of late)
    it(`${name}: refused, 0 financial requests`, async () => {
      arm(record);
      const p = slowIdentityWallet(during);
      const a = adapterOn(p);
      const tx = approveTx();
      const r = await sendWith(a, tx, { limits: limitsOf(tx, limits) });
      expect(r, name).toMatchObject({
        ok: false,
        e: {
          code: "CANARY_REQUEST_REFUSED",
          reason,
          beforeWalletRequest: true,
        },
      });
      expect(refusedBeforeWallet(r.ok ? null : r.e)).toBe(true);
      expect(p.count("eth_accounts"), name).toBe(1);
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    });
  it("still valid at the last instant (gesture exactly 30 s old): exactly ONE financial request", async () => {
    arm();
    const p = slowIdentityWallet(() => vi.setSystemTime(NOW + 30_000));
    const a = adapterOn(p);
    const tx = mainTx();
    const r = await sendWith(a, tx, {
      limits: limitsOf(tx, {
        authorizationExpiresAt: NOW + 30_001,
        quoteExpiresAt: NOW + 30_001,
      }),
    });
    expect(r).toEqual({ ok: true, hash: "0x" + "ab".repeat(32) });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("abort, revocation (account / network / disconnect) or a stale review during the identity read: 0 requests", async () => {
    arm();
    let controller = new AbortController();
    const cases: [
      string,
      (a: InstanceType<typeof WalletProviderAdapter>) => void,
      string,
    ][] = [
      ["abort signal", () => controller.abort(), "IDENTITY_CHANGED"],
      [
        "adapter revoked (identity epoch ended)",
        (a) => a.revoke(),
        "WALLET_SESSION_STALE",
      ],
    ];
    for (const [name, during, code] of cases) {
      controller = new AbortController();
      let adapter: InstanceType<typeof WalletProviderAdapter> | null = null;
      const p = slowIdentityWallet(() => during(adapter!));
      adapter = adapterOn(p);
      const tx = approveTx();
      const r = await sendWith(
        adapter,
        tx,
        { limits: limitsOf(tx) },
        controller.signal,
      );
      expect(r.ok, name).toBe(false);
      expect((r as unknown as { e: { code: string } }).e.code, name).toBe(code);
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
    let current = true;
    const p = slowIdentityWallet(() => (current = false));
    const r = await sendWith(adapterOn(p), approveTx(), {
      limits: limitsOf(approveTx()),
      current: () => current,
    });
    expect(r).toMatchObject({
      ok: false,
      e: { reason: "REVIEW_NO_LONGER_CURRENT" },
    });
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
  it("the limits must be the server's prepared evidence of THIS step: missing, malformed, other approval or other action = refused", async () => {
    arm();
    const tx = approveTx();
    // G14 follow-up F2: the "limits" are the SERVER's answer now. A malformed answer, one with an extra field, one
    // for another approval or another attempt mints NO authority (the minting code says why); the send is then
    // refused with DISPATCH_AUTHORITY_REQUIRED. An answer that mints one is still checked at the last instant.
    const cases: [string, unknown, string | null, string][] = [
      ["no limits", undefined, "NO_LIMITS", "DISPATCH_AUTHORITY_REQUIRED"],
      [
        "an extra field",
        { ...limitsOf(tx), ttlMs: 1 },
        "PREPARATION_NOT_CONFIRMED",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "a page-chosen lifetime instead of evidence",
        { gesture: { trusted: true, at: NOW } },
        "AUTHORITY_INPUT_MALFORMED",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "malformed attempt",
        limitsOf(tx, { attempt: "x" }),
        "AUTHORITY_INPUT_MALFORMED",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "unknown time",
        limitsOf(tx, { quoteExpiresAt: Number.NaN }),
        "PREPARATION_NOT_CONFIRMED",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "another approval",
        limitsOf(tx, { approvalId: "0x" + "9".repeat(64) }),
        "PREPARATION_APPROVAL_MISMATCH",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "a digest that is not the digest of the answer's own fields",
        limitsOf(tx, { preparedDigest: "d".repeat(64) }),
        "PREPARATION_DIGEST_MISMATCH",
        "DISPATCH_AUTHORITY_REQUIRED",
      ],
      [
        "the other action",
        limitsOf(tx, { action: "SEND" }),
        null,
        "DISPATCH_ACTION_MISMATCH",
      ],
      [
        "untrusted gesture",
        limitsOf(tx, { gesture: { trusted: false, at: NOW } }),
        null,
        "OWNER_GESTURE_REQUIRED",
      ],
      [
        "gesture in the future",
        limitsOf(tx, { gesture: { trusted: true, at: NOW + 1 } }),
        null,
        "OWNER_GESTURE_REQUIRED",
      ],
    ];
    for (const [name, limits, minted, reason] of cases) {
      const p = fakeWallet();
      const a = adapterOn(p);
      const got = await authorityFor(a, tx, limits);
      expect(got.code, name).toBe(minted);
      const r = await a
        .sendCanonicalTransaction(
          tx,
          { ...tx },
          {
            gate: "veined-owner-canary",
            canary: { authority: got.authority } as never,
          },
        )
        .then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      expect(r, name).toMatchObject({ ok: false, e: { reason } });
      expect(p.calls, name).toEqual([]);
    }
    // The pure check itself: null record first, then the exact time edges.
    expect(canaryDispatchProblem(null, tx, limitsOf(tx), NOW)).toBe(
      "NO_OWNER_APPROVED_CANARY",
    );
    expect(
      canaryDispatchProblem(
        armed.record,
        tx,
        limitsOf(tx, { authorizationExpiresAt: NOW + 1 }),
        NOW,
      ),
    ).toBeNull();
    expect(
      canaryDispatchProblem(
        armed.record,
        tx,
        limitsOf(tx, { authorizationExpiresAt: NOW }),
        NOW,
      ),
    ).toBe("AUTHORIZATION_EXPIRED");
  });
  it("a wallet cannot forge the pre-wallet marker: an error it throws from the request (even an adapter refusal object) is unclear", async () => {
    arm();
    const tx = approveTx();
    const first = await sendWith(adapterOn(fakeWallet()), tx, { limits: {} });
    const refusal = (first as { e: unknown }).e;
    expect(refusedBeforeWallet(refusal)).toBe(true);
    for (const thrown of [
      refusal,
      Object.assign(new Error("x"), { beforeWalletRequest: true }),
    ]) {
      const p = fakeWallet({ send: () => Promise.reject(thrown) });
      const a = adapterOn(p);
      const r = await sendWith(a, tx, { limits: limitsOf(tx) });
      expect(r.ok).toBe(false);
      expect(refusedBeforeWallet((r as { e: unknown }).e)).toBe(false);
      expect(p.count("eth_sendTransaction")).toBe(1);
      // The wallet stays blocked: no second financial request.
      const again = await sendWith(a, tx, { limits: limitsOf(tx) });
      expect(again).toMatchObject({
        ok: false,
        e: { code: "WALLET_REQUEST_UNCERTAIN" },
      });
      expect(p.count("eth_sendTransaction")).toBe(1);
    }
    expect(CLOCK_SETBACK_TOLERANCE_MS).toBe(1_000);
  });
});

// ------------------------------------------------------------------------------------- PP1-AUDIT-01 + H3 submission
let serial = 0;
const prepOf = (
  action: "APPROVE" | "SEND" = "SEND",
  over: Partial<Prep> = {},
): Prep => {
  const body = {
    action,
    record: `canary-closure-${++serial}`,
    review: "c".repeat(64),
    transaction: action === "APPROVE" ? approveTx() : mainTx(),
    expiresAt: NOW + 40_000,
    approvalId: approvalId(),
    attempt: serial.toString(16).padStart(32, "0"),
    quoteExpiresAt: NOW + 60_000,
    ...over,
  };
  return { ...body, digest: over.digest ?? canaryPreparationDigest(body) };
};
/**
 * G14 follow-up F2 TEST ADAPTER: `confirmPrepared` and `persistUnknown` are no longer callbacks of the page — the
 * wallet adapter asks the server itself. They stay as the two answers a stub page SERVER gives (page-server.ts
 * legacyServer): the preparation it confirms, and whether its durable "requested" commit answers (true = committed).
 */
type Over = Partial<Ctx> & {
  confirmPrepared?: (p: {
    record: string;
    action: "APPROVE" | "SEND";
    review: string;
    attempt: string;
    digest: string;
  }) => unknown;
  persistUnknown?: (ref: never) => unknown;
};
function ctxOf(p: Prep, over: Over = {}) {
  const log: string[] = [];
  const refs: unknown[] = [];
  const { confirmPrepared, persistUnknown, ...rest } = over;
  const server = {
    confirmPrepared: vi.fn(confirmPrepared ?? (async () => ({ ...p }))),
    persistUnknown:
      persistUnknown ??
      ((ref: never) => {
        refs.push(ref);
        log.push("requested");
        return true;
      }),
  };
  pageServer.handler = legacyServer(server);
  const context: Ctx = {
    session: "e".repeat(64),
    gesture: { trusted: true, at: NOW },
    persistHash: (h, a) => {
      log.push(`hash:${a}`);
      return true;
    },
    persistRejected: () => void log.push("rejected"),
    persistLateHash: (h) => void log.push(`late:${h.slice(0, 6)}`),
    persistNotRequested: (ref) => {
      refs.push(ref);
      log.push("not-requested");
      return true;
    },
    ...rest,
  };
  return { context, log, refs, server };
}
const outcome = (pr: Promise<unknown>) =>
  pr.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e: e as Record<string, unknown> }),
  );

describe("PP1-AUDIT-01 + H3 at the submission boundary", () => {
  it("the adapter's own final check catches an expiry during ITS identity read; the step is cleaned up by its own write only", async () => {
    arm();
    const step = prepOf("SEND", { expiresAt: NOW + 1_500 });
    const c = ctxOf(step);
    // The submission's own identity read passes; the adapter's identity read (the last await) takes 2 s.
    let reads = 0;
    const p = fakeWallet();
    const inner = p.request.bind(p);
    p.request = async (args) => {
      if (args.method === "eth_accounts" && ++reads === 2)
        vi.setSystemTime(NOW + 2_000);
      return inner(args);
    };
    const r = await outcome(submitCanary(adapterOn(p), step, c.context));
    expect(r).toMatchObject({
      ok: false,
      e: {
        code: "CANARY_REQUEST_REFUSED",
        reason: "AUTHORIZATION_EXPIRED",
        beforeWalletRequest: true,
      },
    });
    expect(c.log).toEqual(["requested", "not-requested"]);
    // The clean-up names exactly the write it cancels.
    expect(c.refs[0]).toEqual(c.refs[1]);
    expect(c.refs[0]).toMatchObject({
      record: step.record,
      action: "SEND",
      attempt: step.attempt,
      digest: step.digest,
    });
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
  it("a slow durable write moves past the gesture / authorization / quote / owner window: refused at the re-check, 0 requests", async () => {
    for (const [name, over, record, reason] of [
      [
        "authorization",
        { expiresAt: NOW + 1_000 },
        {},
        "AUTHORIZATION_EXPIRED",
      ],
      ["quote", { quoteExpiresAt: NOW + 1_000 }, {}, "QUOTE_EXPIRED"],
      ["owner window", {}, { notAfter: NOW + 1_000 }, "APPROVAL_EXPIRED"],
    ] as [
      string,
      Partial<Prep>,
      Parameters<typeof syntheticApproval>[0],
      string,
    ][]) {
      arm(record);
      const step = prepOf("SEND", over);
      const p = fakeWallet();
      const c = ctxOf(step, {
        persistUnknown: () => {
          vi.setSystemTime(NOW + 2_000);
          return true;
        },
      });
      const r = await outcome(submitCanary(adapterOn(p), step, c.context));
      expect(r, name).toMatchObject({ ok: false, e: { reason } });
      expect(p.count("eth_sendTransaction"), name).toBe(0);
      vi.setSystemTime(NOW);
    }
  });
  it("H3: a durable write whose outcome is unknown is cleaned up ONLY when the server confirms; otherwise the approval is uncertain", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(NOW);
    // (a) the write times out, the server confirms the conditional clean-up: refused, nothing asked, step given back.
    arm();
    const a1 = prepOf("SEND");
    const p1 = fakeWallet();
    const c1 = ctxOf(a1, {
      persistUnknown: () => new Promise<boolean>(() => undefined),
    });
    const r1 = outcome(submitCanary(adapterOn(p1), a1, c1.context));
    await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
    expect(await r1).toMatchObject({
      ok: false,
      e: { reason: "RECORD_NOT_WRITTEN" },
    });
    expect(p1.count("eth_sendTransaction")).toBe(0);
    // (b) the clean-up is NOT confirmed (server says no / never answers): RECORD_OUTCOME_UNKNOWN, and no further
    //     step of this approval is ever handed to a wallet in this runtime — under any label.
    for (const answer of [
      () => false,
      () => new Promise<boolean>(() => undefined),
      () => Promise.reject(new Error("x")),
    ]) {
      vi.setSystemTime(NOW);
      arm();
      const step = prepOf("SEND");
      const p = fakeWallet();
      const c = ctxOf(step, {
        persistUnknown: () => false,
        persistNotRequested: answer,
      });
      const r = outcome(submitCanary(adapterOn(p), step, c.context));
      await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
      expect(await r).toMatchObject({
        ok: false,
        e: { reason: "RECORD_OUTCOME_UNKNOWN" },
      });
      const again = await outcome(
        submitCanary(
          adapterOn(p),
          prepOf("SEND", {
            record: "label-x",
            expiresAt: Date.now() + 40_000,
            quoteExpiresAt: Date.now() + 60_000,
          }),
          {
            ...ctxOf(step).context,
            gesture: { trusted: true, at: Date.now() },
          },
        ),
      );
      expect(again).toMatchObject({
        ok: false,
        e: { reason: "PREVIOUS_STEP_UNCERTAIN" },
      });
      expect(p.count("eth_sendTransaction")).toBe(0);
    }
    // (c) every call writes under its OWN request id: an old clean-up can never name a newer write.
    vi.setSystemTime(NOW);
    arm();
    const s1 = prepOf("SEND");
    const c2 = ctxOf(s1, { persistUnknown: () => false });
    await outcome(submitCanary(adapterOn(fakeWallet()), s1, c2.context));
    const c3 = ctxOf(s1);
    await outcome(submitCanary(adapterOn(fakeWallet()), s1, c3.context));
    const r2 = c2.refs[0] as { request: string };
    const r3 = c3.refs[0] as { request: string };
    expect(r2.request).toMatch(/^[0-9a-f]{32}$/);
    expect(r3.request).toMatch(/^[0-9a-f]{32}$/);
    expect(r2.request).not.toBe(r3.request);
    // (d) the rejection and hash records never wait without a bound.
    vi.setSystemTime(NOW);
    arm();
    const rej = prepOf("SEND");
    const pr = fakeWallet({
      send: () =>
        Promise.reject(Object.assign(new Error("no"), { code: 4001 })),
    });
    const cr = ctxOf(rej, {
      persistRejected: () => new Promise<void>(() => undefined),
    });
    const rr = outcome(submitCanary(adapterOn(pr), rej, cr.context));
    await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
    expect(await rr).toMatchObject({
      ok: false,
      e: { code: "OWNER_REJECTED" },
    });
    vi.setSystemTime(NOW);
    arm();
    const ok = prepOf("SEND");
    const ch = ctxOf(ok, {
      persistHash: () => new Promise<void>(() => undefined),
    });
    const rh = outcome(submitCanary(adapterOn(fakeWallet()), ok, ch.context));
    await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
    expect(await rh).toEqual({
      ok: true,
      v: { action: "SEND", hash: "0x" + "ab".repeat(32), recorded: false },
    });
  });
  it("the preparation must be the server's: complete, bound to the owner approval, digested over its own fields, confirmed field by field", async () => {
    arm();
    const good = prepOf("SEND");
    const cases: [string, Prep, Over, string][] = [
      [
        "digest of other fields",
        { ...good, quoteExpiresAt: good.quoteExpiresAt + 60_000 },
        {},
        "PREPARATION_DIGEST_MISMATCH",
      ],
      [
        "another owner approval",
        prepOf("SEND", { approvalId: "0x" + "7".repeat(64) }),
        {},
        "PREPARATION_APPROVAL_MISMATCH",
      ],
      [
        "no attempt",
        { ...good, attempt: undefined as never },
        {},
        "PREPARATION_MALFORMED",
      ],
      [
        "server confirms another attempt",
        good,
        { confirmPrepared: async () => ({ ...good, attempt: "f".repeat(32) }) },
        "PREPARATION_MISMATCH",
      ],
      [
        // G14 follow-up F2: the adapter digests the server's answer over its own fields (was PREPARATION_MISMATCH
        // when the page compared the two copies; the adapter now sees only the server's).
        "server confirms a longer authorization",
        good,
        {
          confirmPrepared: async () => ({
            ...good,
            expiresAt: good.expiresAt + 1,
          }),
        },
        "PREPARATION_DIGEST_MISMATCH",
      ],
      [
        "server confirms only a transaction",
        good,
        { confirmPrepared: async () => ({ ...good.transaction }) },
        "PREPARATION_NOT_CONFIRMED",
      ],
    ];
    for (const [name, step, over, reason] of cases) {
      const p = fakeWallet();
      const c = ctxOf(step, over);
      const r = await outcome(submitCanary(adapterOn(p), step, c.context));
      expect(r, name).toMatchObject({ ok: false, e: { reason } });
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
    // The confirm call names the attempt and the digest.
    const p = fakeWallet();
    const c = ctxOf(good);
    await submitCanary(adapterOn(p), good, c.context);
    expect(c.server.confirmPrepared).toHaveBeenCalledWith({
      record: good.record,
      action: "SEND",
      review: good.review,
      attempt: good.attempt,
      digest: good.digest,
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("a revoked approval, an aborted signal or a stale review stop the step before the wallet", async () => {
    arm();
    const controller = new AbortController();
    controller.abort();
    const step = prepOf("SEND");
    const p = fakeWallet();
    expect(
      await outcome(
        submitCanary(adapterOn(p), step, {
          ...ctxOf(step).context,
          signal: controller.signal,
        }),
      ),
    ).toMatchObject({ ok: false, e: { reason: "IDENTITY_CHANGED" } });
    expect(
      await outcome(
        submitCanary(adapterOn(p), prepOf("SEND"), {
          ...ctxOf(step).context,
          current: () => false,
        }),
      ),
    ).toMatchObject({ ok: false, e: { reason: "REVIEW_NO_LONGER_CURRENT" } });
    expect(p.count("eth_sendTransaction")).toBe(0);
    expect(REVOKED_CANARY_APPROVALS).toEqual([]);
    expect(Object.isFrozen(REVOKED_CANARY_APPROVALS)).toBe(true);
    // The structural check knows the revocation list (the list is a protected constant; empty in this build).
    expect(approvalRecordProblems(syntheticApproval())).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------------------- H1
describe("H1: provenance follows the function that is actually called", () => {
  it("swapping the read field while the fake read runs cannot stamp the quote as an adapter quote", async () => {
    let core: InstanceType<typeof RoutingCore> | null = null;
    const swaps: string[] = [];
    const read = async (path: string) => {
      if (path !== "quote") throw new Error("NOT_REACHED");
      // While the injected read is running, try to turn the field into the real upstream transport.
      try {
        (core as unknown as { read: unknown }).read = upstreamRead;
        swaps.push("assigned");
      } catch {
        swaps.push("assignment refused");
      }
      Object.defineProperty(core, "read", {
        value: upstreamRead,
        configurable: true,
      });
      swaps.push("defined");
      return {
        tool: fx.tool,
        transactionRequest: { ...fx.transactionRequest },
        estimate: { ...fx.estimate },
      };
    };
    core = new RoutingCore(read as never);
    const q = await core.canaryExecutableQuote({
      source: "8453",
      destination: "42161",
      sourceAsset: USDC_BASE,
      destinationAsset: USDC_ARB,
      amount: "5000000",
      sourceAddress: SYN,
      destinationAddress: SYN,
    });
    expect(swaps).toContain("defined");
    expect(isCanaryQuote(q)).toBe(false);
    // The field is not a writable data property of the instance any more (#read is runtime-private).
    expect(Object.getOwnPropertyNames(new RoutingCore())).not.toContain("read");
  });
  it("the real upstream path still yields an adapter quote", async () => {
    vi.setSystemTime(QUOTED_AT);
    net.lookup = async () => [{ address: "93.184.216.34", family: 4 }];
    net.request = (_url, _options, callback) => {
      const req = {
        on: () => req,
        end: () =>
          queueMicrotask(() => {
            const res = Object.assign(new EventEmitter(), {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              resume: () => undefined,
              destroy: () => undefined,
            });
            (callback as (r: unknown) => void)(res);
            res.emit(
              "data",
              Buffer.from(
                JSON.stringify({
                  tool: fx.tool,
                  transactionRequest: fx.transactionRequest,
                  estimate: fx.estimate,
                }),
              ),
            );
            res.emit("end");
          }),
      };
      return req;
    };
    const q = await new RoutingCore().canaryExecutableQuote({
      source: "8453",
      destination: "42161",
      sourceAsset: USDC_BASE,
      destinationAsset: USDC_ARB,
      amount: "5000000",
      sourceAddress: SYN,
      destinationAddress: SYN,
    });
    expect(isCanaryQuote(q)).toBe(true);
    expect(q.quotedAt).toBe(QUOTED_AT);
    expect(Object.isFrozen(q)).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------- B4 / K4
type Rpc = { method: string; params: unknown[] };
function operators(
  handlers: Record<string, (r: Rpc) => unknown>,
  seen: { url: string; rpc: Rpc; init: RequestInit }[] = [],
) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      const rpc = JSON.parse(String(init.body)) as Rpc;
      seen.push({ url, rpc, init });
      const h = handlers[url];
      if (!h) throw new Error("NO_SUCH_OPERATOR");
      const result = await h(rpc);
      return new Response(
        JSON.stringify(
          result === undefined
            ? { jsonrpc: "2.0", id: 1, error: { code: -32000 } }
            : { jsonrpc: "2.0", id: 1, result },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  return seen;
}
const hex = (x: number | bigint | string) => "0x" + BigInt(x).toString(16);
const signal = () => AbortSignal.timeout(5_000);
describe("B4: the canary's own read capability on the protected transport", () => {
  it("one method list, reads only, shared by pool and transport; the general Swap reads are not widened", () => {
    expect(pool.POOL_READ_METHODS).toBe(CANARY_READ_METHODS);
    expect(Object.isFrozen(CANARY_READ_METHODS)).toBe(true);
    expect(
      CANARY_READ_METHODS.filter((m) =>
        /send|sign|debug|trace|admin|wallet_|personal|txpool|miner/i.test(m),
      ),
    ).toEqual([]);
    expect(CANARY_READ_LIMITS).toMatchObject({
      maxLogBlockRange: 5000,
      maxLogAddresses: 2,
      maxSimulationCalls: 6,
      timeoutMs: 8000,
    });
  });
  it("the read contracts are exactly the pinned contracts of the pin set", () => {
    const P = CANARY_PINS;
    expect(
      [...CANARY_READ_CONTRACTS["8453"]].map((a) => a.toLowerCase()).sort(),
    ).toEqual(
      [
        P.diamond.address,
        P.facet.address,
        P.spokePools["8453"].address,
        P.spokePools["8453"].implementation.address,
        P.usdc["8453"].address,
        P.usdc["8453"].implementation.address,
        P.feeCollector.address,
        P.gasPriceOracle,
      ]
        .map((a) => a.toLowerCase())
        .sort(),
    );
    expect(
      [...CANARY_READ_CONTRACTS["42161"]].map((a) => a.toLowerCase()).sort(),
    ).toEqual(
      [
        P.spokePools["42161"].address,
        P.spokePools["42161"].implementation.address,
        P.usdc["42161"].address,
        P.usdc["42161"].implementation.address,
      ]
        .map((a) => a.toLowerCase())
        .sort(),
    );
  });
  it("refuses every read outside the narrow shapes, before any network use", async () => {
    const seen = operators({});
    const USDC = CANARY_PINS.usdc["8453"].address;
    const topic = "0x" + "1".repeat(64);
    const cases: [string, unknown, unknown, string, unknown][] = [
      ["unknown chain", "1", 0, "eth_chainId", []],
      ["prototype key as chain", "__proto__", 0, "eth_chainId", []],
      ["third operator", "8453", 2, "eth_chainId", []],
      ["write method", "8453", 0, "eth_sendRawTransaction", ["0x00"]],
      ["send", "8453", 0, "eth_sendTransaction", [{}]],
      ["trace", "8453", 0, "debug_traceCall", [{}, "latest"]],
      ["estimate (not a canary read)", "8453", 0, "eth_estimateGas", [{}]],
      [
        "full block with transactions",
        "8453",
        0,
        "eth_getBlockByNumber",
        ["latest", true],
      ],
      ["pending block", "8453", 0, "eth_getBlockByNumber", ["pending", false]],
      [
        "code of an unpinned contract",
        "8453",
        0,
        "eth_getCode",
        [OTHER, "0x1"],
      ],
      ["code at 'latest'", "8453", 0, "eth_getCode", [USDC, "latest"]],
      [
        "call to an unpinned contract",
        "8453",
        0,
        "eth_call",
        [{ to: OTHER, data: "0x70a08231" }, "0x1"],
      ],
      [
        "call with a from / value / state",
        "8453",
        0,
        "eth_call",
        [{ to: USDC, data: "0x70a08231", from: SYN }, "0x1"],
      ],
      [
        "call with a third parameter (state override)",
        "8453",
        0,
        "eth_call",
        [{ to: USDC, data: "0x70a08231" }, "0x1", {}],
      ],
      [
        "balance with the record disarmed",
        "8453",
        0,
        "eth_getBalance",
        [SYN, "0x1"],
      ],
      [
        "nonce with the record disarmed",
        "8453",
        0,
        "eth_getTransactionCount",
        [SYN, "latest"],
      ],
      [
        "receipt of a non-hash",
        "8453",
        0,
        "eth_getTransactionReceipt",
        ["0x1"],
      ],
      [
        "logs over too many blocks",
        "8453",
        0,
        "eth_getLogs",
        [
          {
            address: USDC,
            fromBlock: "0x1",
            toBlock: hex(5_002),
            topics: [topic],
          },
        ],
      ],
      [
        "logs without the event topic",
        "8453",
        0,
        "eth_getLogs",
        [{ address: USDC, fromBlock: "0x1", toBlock: "0x2", topics: [null] }],
      ],
      [
        "logs of an unpinned contract",
        "8453",
        0,
        "eth_getLogs",
        [{ address: OTHER, fromBlock: "0x1", toBlock: "0x2", topics: [topic] }],
      ],
      [
        "logs of three contracts",
        "8453",
        0,
        "eth_getLogs",
        [
          {
            address: [USDC, USDC, USDC],
            fromBlock: "0x1",
            toBlock: "0x2",
            topics: [topic],
          },
        ],
      ],
      [
        "logs with a block hash filter",
        "8453",
        0,
        "eth_getLogs",
        [{ address: USDC, blockHash: topic, topics: [topic] }],
      ],
      [
        "simulation on Arbitrum",
        "42161",
        0,
        "eth_simulateV1",
        [
          { blockStateCalls: [], validation: false, traceTransfers: true },
          "0x1",
        ],
      ],
      [
        "simulation with a state override",
        "8453",
        0,
        "eth_simulateV1",
        [
          {
            blockStateCalls: [
              {
                blockOverrides: { baseFeePerGas: "0x1" },
                calls: [{ from: SYN, to: USDC, data: "0x70a08231" }],
                stateOverrides: {},
              },
            ],
            validation: false,
            traceTransfers: true,
          },
          "0x1",
        ],
      ],
      [
        "simulation with a time override",
        "8453",
        0,
        "eth_simulateV1",
        [
          {
            blockStateCalls: [
              {
                blockOverrides: { baseFeePerGas: "0x1", time: "0x1" },
                calls: [{ from: SYN, to: USDC, data: "0x70a08231" }],
              },
            ],
            validation: false,
            traceTransfers: true,
          },
          "0x1",
        ],
      ],
    ];
    for (const [name, chain, index, method, params] of cases) {
      expect(
        canaryReadProblem(chain, index, method, params),
        name,
      ).not.toBeNull();
      await expect(
        canaryRead(
          chain as "8453",
          index as 0,
          method as string,
          params as unknown[],
          signal(),
        ),
        name,
      ).rejects.toThrow("EXECUTION_CLOSED");
    }
    expect(seen).toEqual([]);
    // The account reads exist only for the protected record's own account.
    arm();
    expect(
      canaryReadProblem("8453", 0, "eth_getBalance", [SYN, "0x1"]),
    ).toBeNull();
    expect(canaryReadProblem("8453", 0, "eth_getBalance", [OTHER, "0x1"])).toBe(
      "CANARY_ACCOUNT_NOT_APPROVED",
    );
    expect(
      canaryReadProblem("8453", 0, "eth_simulateV1", [
        {
          blockStateCalls: [
            {
              blockOverrides: { baseFeePerGas: "0x1" },
              calls: [{ from: OTHER, to: USDC, data: "0x70a08231" }],
            },
          ],
          validation: false,
          traceTransfers: true,
        },
        "0x1",
      ]),
    ).toBe("CANARY_ACCOUNT_NOT_APPROVED");
    // The general transport is unchanged: no canary-only read crosses rpc().
    for (const m of [
      "eth_getBalance",
      "eth_getLogs",
      "eth_getTransactionReceipt",
      "eth_getTransactionCount",
      "eth_getTransactionByHash",
      "eth_maxPriorityFeePerGas",
    ])
      await expect(rpc("8453", m, [], signal())).rejects.toThrow(
        "EXECUTION_CLOSED",
      );
  });
  it("a canary read leaves only to one of the four exact pool URLs, through the reviewed boundary (POST, no redirect, no cache)", async () => {
    const seen = operators({
      [BASE_A]: () => "0x2105",
      [BASE_B]: () => "0x2105",
      [ARB_A]: () => "0xa4b1",
      [ARB_B]: () => "0xa4b1",
    });
    await canaryRead("8453", 0, "eth_chainId", [], signal());
    await canaryRead("8453", 1, "eth_chainId", [], signal());
    await canaryRead("42161", 0, "eth_chainId", [], signal());
    await canaryRead("42161", 1, "eth_chainId", [], signal());
    expect(seen.map((s) => s.url)).toEqual([BASE_A, BASE_B, ARB_A, ARB_B]);
    for (const s of seen)
      expect(s.init).toMatchObject({
        method: "POST",
        redirect: "error",
        cache: "no-store",
      });
    expect(
      Object.values(CANARY_RPC_POOL).flatMap((p) => p.map((x) => x.url)),
    ).toEqual([BASE_A, BASE_B, ARB_A, ARB_B]);
    // Egress: the exact strings only (no trailing slash, path, port, credential or plain http variant).
    for (const bad of [
      BASE_B + "/",
      ARB_B + "/x",
      "http://mainnet.base.org",
      "https://u:p@mainnet.base.org",
      "https://mainnet.base.org:8443",
      "https://127.0.0.1",
      "https://10.0.0.1/rpc",
    ])
      expect(() => assertSwapEgress(bad), bad).toThrow("REVIEW_REQUIRED");
    expect(RPC_ORIGINS["8453"]).toBe(BASE_A);
  });
});

// Fake two-operator chain (SYNTHETIC_TEST_ONLY): a head block, balances, fees, receipts, transactions and logs.
function chainOf(o: {
  head?: number;
  hash?: string;
  baseFee?: string;
  tip?: string;
  native?: string;
  nonce?: string;
  receipt?: unknown;
  tx?: unknown;
  logs?: unknown[];
  l1Fee?: string;
  sim?: unknown;
}) {
  const head = o.head ?? 100;
  const block = (n: number) => ({
    number: hex(n),
    hash:
      (o.hash ?? "0x" + "a".repeat(62)) +
      n.toString(16).padStart(2, "0").slice(-2),
    timestamp: hex(1_800_000_000 + n),
    baseFeePerGas: o.baseFee ?? "0x4c4b40",
  });
  return (r: Rpc): unknown => {
    switch (r.method) {
      case "eth_chainId":
        return "0x2105";
      case "eth_getBlockByNumber":
        return r.params[0] === "latest"
          ? block(head)
          : block(Number(BigInt(r.params[0] as string)));
      case "eth_maxPriorityFeePerGas":
        return o.tip ?? "0xf4240";
      case "eth_getBalance":
        return o.native ?? hex(10n ** 16n);
      case "eth_getTransactionCount":
        return o.nonce ?? "0x7";
      case "eth_getTransactionReceipt":
        return o.receipt ?? null;
      case "eth_getTransactionByHash":
        return o.tx ?? null;
      case "eth_getLogs":
        return o.logs ?? [];
      case "eth_simulateV1":
        return o.sim ?? [{ calls: [] }];
      case "eth_call":
        return (
          "0x" +
          BigInt(o.l1Fee ?? 1000)
            .toString(16)
            .padStart(64, "0")
        );
      default:
        return undefined;
    }
  };
}
const H64 = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const receiptOf = (over: Record<string, unknown> = {}) => ({
  transactionHash: H64(9),
  blockNumber: hex(90),
  blockHash: "0x" + "b".repeat(64),
  status: "0x1",
  from: SYN.toLowerCase(),
  to: DIAMOND.toLowerCase(),
  gasUsed: hex(500_000),
  effectiveGasPrice: hex(6_000_000),
  l1Fee: hex(1_234),
  logs: [],
  ...over,
});
describe("B4: two independent operators at one block for every new read", () => {
  it("receipts: AGREE only when both return the same mined receipt; one missing or different = UNKNOWN; none = ABSENT", async () => {
    arm();
    operators({
      [BASE_A]: chainOf({ receipt: receiptOf() }),
      [BASE_B]: chainOf({ receipt: receiptOf() }),
    });
    const a = await pool.readReceiptPair("8453", H64(9), signal());
    expect(a).toMatchObject({
      status: "AGREE",
      confirmations: 11,
      receipt: {
        success: true,
        gasUsed: "500000",
        effectiveGasPrice: "6000000",
        l1FeeWei: "1234",
      },
    });
    operators({
      [BASE_A]: chainOf({ receipt: receiptOf() }),
      [BASE_B]: chainOf({}),
    });
    expect((await pool.readReceiptPair("8453", H64(9), signal())).status).toBe(
      "UNKNOWN",
    );
    operators({
      [BASE_A]: chainOf({ receipt: receiptOf() }),
      [BASE_B]: chainOf({
        receipt: receiptOf({ blockHash: "0x" + "c".repeat(64) }),
      }),
    });
    expect((await pool.readReceiptPair("8453", H64(9), signal())).status).toBe(
      "UNKNOWN",
    );
    operators({ [BASE_A]: chainOf({}), [BASE_B]: chainOf({}) });
    expect((await pool.readReceiptPair("8453", H64(9), signal())).status).toBe(
      "ABSENT",
    );
    // Different heads (one operator behind on another block hash): no agreed head -> UNKNOWN, never a single source.
    operators({
      [BASE_A]: chainOf({ receipt: receiptOf() }),
      [BASE_B]: chainOf({ receipt: receiptOf(), hash: "0x" + "e".repeat(62) }),
    });
    expect((await pool.readReceiptPair("8453", H64(9), signal())).status).toBe(
      "UNKNOWN",
    );
    // One operator down: UNKNOWN (no silent fallback to the other).
    operators({
      [BASE_A]: chainOf({ receipt: receiptOf() }),
      [BASE_B]: () => undefined,
    });
    expect((await pool.readReceiptPair("8453", H64(9), signal())).status).toBe(
      "UNKNOWN",
    );
  });
  it("logs: bounded, both operators equal, removed logs kept as removed, too many = UNKNOWN; transactions and nonce agree", async () => {
    arm();
    const log = {
      address: USDC_BASE.toLowerCase(),
      topics: [CANARY_PINS.topics.transfer],
      data: "0x" + "0".repeat(64),
      transactionHash: H64(3),
      blockNumber: hex(95),
      blockTimestamp: hex(1_800_000_095),
    };
    operators({
      [BASE_A]: chainOf({ logs: [log, { ...log, removed: true }] }),
      [BASE_B]: chainOf({ logs: [log, { ...log, removed: true }] }),
    });
    const r = await pool.readLogsPair(
      "8453",
      {
        address: USDC_BASE,
        topics: [CANARY_PINS.topics.transfer],
        fromBlock: "90",
        toBlock: "100",
      },
      signal(),
    );
    expect(r.status).toBe("AGREE");
    expect(r.logs![1].removed).toBe(true);
    expect(r.logs![0].timestamp).toBe(1_800_000_095);
    operators({
      [BASE_A]: chainOf({ logs: [log] }),
      [BASE_B]: chainOf({ logs: [] }),
    });
    expect(
      (
        await pool.readLogsPair(
          "8453",
          {
            address: USDC_BASE,
            topics: [CANARY_PINS.topics.transfer],
            fromBlock: "90",
            toBlock: "100",
          },
          signal(),
        )
      ).status,
    ).toBe("UNKNOWN");
    const many = Array.from({ length: pool.MAX_LOGS + 1 }, () => log);
    operators({
      [BASE_A]: chainOf({ logs: many }),
      [BASE_B]: chainOf({ logs: many }),
    });
    expect(
      (
        await pool.readLogsPair(
          "8453",
          {
            address: USDC_BASE,
            topics: [CANARY_PINS.topics.transfer],
            fromBlock: "90",
            toBlock: "100",
          },
          signal(),
        )
      ).status,
    ).toBe("UNKNOWN");
    // A range that reaches past the agreed head is never read.
    operators({ [BASE_A]: chainOf({}), [BASE_B]: chainOf({}) });
    expect(
      (
        await pool.readLogsPair(
          "8453",
          {
            address: USDC_BASE,
            topics: [CANARY_PINS.topics.transfer],
            fromBlock: "90",
            toBlock: "101",
          },
          signal(),
        )
      ).status,
    ).toBe("UNKNOWN");
    const tx = {
      hash: H64(9),
      from: SYN,
      to: DIAMOND,
      input: "0x1794958f",
      value: "0x0",
      nonce: "0x7",
      blockNumber: null,
    };
    operators({
      [BASE_A]: chainOf({ tx }),
      [BASE_B]: chainOf({ tx: { ...tx, blockNumber: hex(90) } }),
    });
    expect(
      await pool.readTransactionPair("8453", H64(9), signal()),
    ).toMatchObject({
      status: "AGREE",
      transaction: { nonce: "7", value: "0" },
    });
    operators({
      [BASE_A]: chainOf({ tx }),
      [BASE_B]: chainOf({ tx: { ...tx, nonce: "0x8" } }),
    });
    expect(
      (await pool.readTransactionPair("8453", H64(9), signal())).status,
    ).toBe("UNKNOWN");
    operators({
      [BASE_A]: chainOf({ nonce: "0x7" }),
      [BASE_B]: chainOf({ nonce: "0x8" }),
    });
    expect((await pool.readNoncePair("8453", SYN, signal())).nonce).toBeNull();
  });
  it("review 15 R15-2 / R15-1: the at-block reads (nonce, balances) answer only for THE asked block of both operators, and read there", async () => {
    arm();
    // An operator that answers a header request by number with ANOTHER block (its own number, hash and time).
    const answersWith =
      (h: ReturnType<typeof chainOf>, n: number) =>
      (r: Rpc): unknown =>
        r.method === "eth_getBlockByNumber" && r.params[0] !== "latest"
          ? h({ ...r, params: [hex(n), false] })
          : h(r);
    const tags: unknown[] = [];
    let requests = 0;
    const rec = (h: (r: Rpc) => unknown) => (r: Rpc) => {
      requests++;
      if (
        r.method === "eth_call" ||
        r.method === "eth_getBalance" ||
        r.method === "eth_getTransactionCount"
      )
        tags.push(r.params[1]);
      return h(r);
    };
    operators({ [BASE_A]: rec(chainOf({})), [BASE_B]: rec(chainOf({})) });
    const n = await pool.readNonceAtBlockPair("8453", SYN, "90", signal());
    expect(n.block).toMatchObject({ number: "90" });
    expect(n.nonce).not.toBeNull();
    const b = await pool.readBalancesAtBlockPair("8453", SYN, "90", signal());
    expect(b.block).toMatchObject({ number: "90" });
    expect(b.balances.map((x) => x?.block?.number)).toEqual(["90", "90"]);
    expect(b.balances.every((x) => x?.values.usdc != null)).toBe(true);
    // Every state read of both helpers was made AT the asked block, never at the head.
    expect(tags.length).toBeGreaterThan(0);
    expect(new Set(tags)).toEqual(new Set([hex(90)]));
    // Both operators state a HIGHER block, both a LOWER one, or one of them another block: no answer at all.
    for (const [x, y] of [
      [95, 95],
      [85, 85],
      [90, 95],
      [95, 90],
    ] as const) {
      operators({
        [BASE_A]: answersWith(chainOf({}), x),
        [BASE_B]: answersWith(chainOf({}), y),
      });
      expect(
        await pool.readNonceAtBlockPair("8453", SYN, "90", signal()),
        `${x}/${y}`,
      ).toEqual({ nonce: null, block: null });
      expect(
        await pool.readBalancesAtBlockPair("8453", SYN, "90", signal()),
        `${x}/${y}`,
      ).toEqual({ balances: [null, null], block: null });
    }
    // One operator without an answer: none. A malformed number: nothing is asked.
    operators({ [BASE_A]: chainOf({}), [BASE_B]: () => undefined });
    expect(
      (await pool.readBalancesAtBlockPair("8453", SYN, "90", signal())).block,
    ).toBeNull();
    requests = 0;
    operators({ [BASE_A]: rec(chainOf({})), [BASE_B]: rec(chainOf({})) });
    for (const bad of ["0x5a", "-1", "", "9".repeat(21)]) {
      expect(
        await pool.readNonceAtBlockPair("8453", SYN, bad, signal()),
      ).toEqual({ nonce: null, block: null });
      expect(
        (await pool.readBalancesAtBlockPair("8453", SYN, bad, signal())).block,
      ).toBeNull();
    }
    expect(requests).toBe(0);
  });
  it("native balance, fees and the L1 data fee come from both operators; unknown is null, never 0", async () => {
    arm();
    const calls: string[] = [];
    const rec = (h: ReturnType<typeof chainOf>) => (r: Rpc) => (
      calls.push(r.method),
      h(r)
    );
    operators({
      [BASE_A]: rec(chainOf({ tip: "0xf4240" })),
      [BASE_B]: rec(chainOf({ tip: "0x1e8480" })),
    });
    const r = await pool.readCanaryReview(
      {
        owner: SYN,
        selector: "0x1794958f",
        amountIn: "5000000",
        call: { to: DIAMOND, data: fx.transactionRequest.data, gas: "670622" },
      },
      signal(),
    );
    expect(r.balances[0]!.values.native).toBe((10n ** 16n).toString());
    // The higher of the two priority-fee suggestions; the block's own base fee; cap = 2 x base + tip.
    expect(r.fees).toEqual({
      baseFeePerGas: "5000000",
      maxPriorityFeePerGas: "2000000",
      maxFeePerGas: "12000000",
    });
    expect(r.nonce).toBe("7");
    // Allowance 0 (the double's eth_call answers 1000 for every call) - here it reads 1000 >= ... so one transaction.
    expect(r.l1FeeWei).toMatch(/^\d+$/);
    expect(calls.filter((m) => m === "eth_getBalance")).toHaveLength(2);
    // Different base fees at the "same" block are not one block: no fees.
    operators({
      [BASE_A]: chainOf({ baseFee: "0x1" }),
      [BASE_B]: chainOf({ baseFee: "0x2" }),
    });
    const d = await pool.readCanaryReview(
      {
        owner: SYN,
        selector: "0x1794958f",
        amountIn: "5000000",
        call: { to: DIAMOND, data: fx.transactionRequest.data, gas: "670622" },
      },
      signal(),
    );
    expect(d.fees).toBeNull();
    expect(d.l1FeeWei).toBeNull();
    // The L1 fee differs between operators: unknown.
    operators({
      [BASE_A]: chainOf({ l1Fee: "1000" }),
      [BASE_B]: chainOf({ l1Fee: "1001" }),
    });
    const l = await pool.readCanaryReview(
      {
        owner: SYN,
        selector: "0x1794958f",
        amountIn: "5000000",
        call: { to: DIAMOND, data: fx.transactionRequest.data, gas: "670622" },
      },
      signal(),
    );
    expect(l.l1FeeWei).toBeNull();
    // With the record disarmed the native balance is not read at all (transport policy).
    armed.record = null;
    operators({ [BASE_A]: chainOf({}), [BASE_B]: chainOf({}) });
    const n = await pool.readOwnerBalancesPair("8453", SYN, signal());
    expect(n[0]!.values.native).toBeNull();
  });
  it("simulation: counted only when both operators return the same result; never with a state override", async () => {
    arm();
    const request = {
      blockStateCalls: [
        {
          blockOverrides: { baseFeePerGas: "0x1" },
          calls: [{ from: SYN, to: USDC_BASE, data: "0x70a08231" }],
        },
      ],
      validation: false,
      traceTransfers: true,
    };
    operators({
      [BASE_A]: chainOf({ sim: [{ calls: [1] }] }),
      [BASE_B]: chainOf({ sim: [{ calls: [1] }] }),
    });
    expect(await pool.simulatePair(request as never, "100", signal())).toEqual([
      { calls: [1] },
    ]);
    operators({
      [BASE_A]: chainOf({ sim: [{ calls: [1] }] }),
      [BASE_B]: chainOf({ sim: [{ calls: [2] }] }),
    });
    expect(
      await pool.simulatePair(request as never, "100", signal()),
    ).toBeNull();
    const seen = operators({ [BASE_A]: chainOf({}), [BASE_B]: chainOf({}) });
    expect(
      await pool.simulatePair(
        {
          ...request,
          blockStateCalls: [
            { ...request.blockStateCalls[0], stateOverrides: {} },
          ],
        } as never,
        "100",
        signal(),
      ),
    ).toBeNull();
    expect(seen).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------- durable store
const tmp = () => mkdtempSync(join(tmpdir(), "g14-closure-store-"));
/** The store's file operations on the real disk (a test overrides one of them). */
const nodeIo = () => ({
  openSync: fs.openSync,
  writeSync: (fd: number, data: Uint8Array) => fs.writeSync(fd, data),
  fsyncSync: (fd: number) => fs.fsyncSync(fd),
  closeSync: fs.closeSync,
  readFileSync: (p: string) => fs.readFileSync(p),
  existsSync: fs.existsSync,
  mkdirSync: (p: string) => void fs.mkdirSync(p, { recursive: true }),
  renameSync: fs.renameSync,
  linkSync: fs.linkSync,
  unlinkSync: fs.unlinkSync,
});
describe("durable store: fsync before success, one writer, closed on every failure", () => {
  it("appends survive a reopen; the chain verifies; the owner-held head detects rewrite and truncation", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      const s = CanaryDurableStore.open(dir);
      s.append("USE", { line: "a" });
      s.batch(() => {
        s.append("NONCE", { nonce: "1".repeat(32) });
        s.append("NONCE", { nonce: "2".repeat(32) });
      });
      const head = s.head();
      s.close();
      const t = CanaryDurableStore.open(dir);
      expect(t.status).toBe("READY");
      expect(
        t.of("NONCE").map((e) => (e.data as { nonce: string }).nonce),
      ).toEqual(["1".repeat(32), "2".repeat(32)]);
      expect(t.of("OPEN")).toHaveLength(2);
      // Honest append after the owner's head: fine.
      t.append("USE", { line: "b" });
      expect(ownerHeadProblem(t.entries(), head)).toBeNull();
      t.close();
      // Rewrite of an early line (even with the chain recomputed by the writer): refused against the owner's head.
      const journal = CanaryDurableStore.journalPath(dir);
      const lines = readFileSync(journal, "utf8").trim().split("\n");
      const forged = readJournal(
        Buffer.from(lines.slice(0, 1).join("\n") + "\n"),
      );
      expect(ownerHeadProblem(forged.entries, head)).toBe("JOURNAL_TRUNCATED");
      expect(
        ownerHeadProblem(readJournal(readFileSync(journal)).entries, {
          length: head.length,
          hash: "f".repeat(64),
        }),
      ).toBe("JOURNAL_REWRITTEN");
      // A changed byte in the middle breaks the chain: CORRUPT, read-only.
      writeFileSync(
        journal,
        lines
          .map((l, i) => (i === 1 ? l.replace('"a"', '"z"') : l))
          .join("\n") + "\n",
      );
      const u = CanaryDurableStore.open(dir);
      expect(u.status).toBe("CORRUPT");
      expect(u.writable).toBe(false);
      expect(() => u.append("USE", { line: "c" })).toThrow(
        "STORE_NEEDS_ATTENTION:CORRUPT",
      );
      u.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("an interrupted write (torn last line) opens read-only as TORN_TAIL; its verified prefix is kept", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      const s = CanaryDurableStore.open(dir);
      s.append("USE", { line: "a" });
      s.close();
      const journal = CanaryDurableStore.journalPath(dir);
      writeFileSync(
        journal,
        readFileSync(journal, "utf8") + '{"s":3,"t":"USE","d":{"line":',
      );
      const t = CanaryDurableStore.open(dir);
      expect(t.status).toBe("TORN_TAIL");
      // OPEN + USE survive; the torn line does not count.
      expect(t.entries().map((e) => e.type)).toEqual(["OPEN", "USE"]);
      expect(t.writable).toBe(false);
      t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("disk full, permission, short write and fsync failure poison the store: nothing more is written", () => {
    vi.useRealTimers();
    for (const [name, fault, code] of [
      ["disk full", "ENOSPC", "STORE_WRITE_FAILED:DISK_FULL"],
      ["permission", "EACCES", "STORE_WRITE_FAILED:PERMISSION"],
      ["short write", "SHORT", "STORE_WRITE_FAILED"],
      ["fsync", "FSYNC", "STORE_WRITE_FAILED"],
    ] as const) {
      const dir = tmp();
      try {
        let armedFault = false;
        const io = {
          openSync: fs.openSync,
          writeSync: (fd: number, data: Uint8Array) => {
            if (armedFault && fault === "SHORT") return 0;
            if (armedFault && (fault === "ENOSPC" || fault === "EACCES"))
              throw Object.assign(new Error(fault), { code: fault });
            return fs.writeSync(fd, data);
          },
          fsyncSync: (fd: number) => {
            if (armedFault && fault === "FSYNC")
              throw Object.assign(new Error("EIO"), { code: "EIO" });
            fs.fsyncSync(fd);
          },
          closeSync: fs.closeSync,
          readFileSync: (p: string) => fs.readFileSync(p),
          existsSync: fs.existsSync,
          mkdirSync: (p: string) => void fs.mkdirSync(p, { recursive: true }),
          renameSync: fs.renameSync,
          linkSync: fs.linkSync,
          unlinkSync: fs.unlinkSync,
        };
        const s = CanaryDurableStore.open(dir, { io });
        const before = s.entries().length;
        armedFault = true;
        expect(() => s.append("USE", { line: "x" }), name).toThrow(code);
        expect(s.status, name).toBe("FAILED");
        expect(s.entries().length, name).toBe(before);
        armedFault = false;
        expect(() => s.append("USE", { line: "y" }), name).toThrow(
          /STORE_NEEDS_ATTENTION:FAILED/,
        );
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it("one writer: a live holder refuses a second open; a dead holder's lock is taken over and journaled; an unreadable lock refuses", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      const s = CanaryDurableStore.open(dir);
      expect(() => CanaryDurableStore.open(dir)).toThrow("STORE_LOCKED");
      s.close();
      // A lock left by a process that is gone.
      writeFileSync(
        CanaryDurableStore.lockPath(dir),
        JSON.stringify({ pid: 999_999_999, token: "f".repeat(32), at: 1 }),
      );
      const t = CanaryDurableStore.open(dir, { alive: () => false });
      expect(t.of("OPEN").at(-1)!.data).toMatchObject({
        takeoverOf: 999_999_999,
      });
      t.close();
      writeFileSync(
        CanaryDurableStore.lockPath(dir),
        JSON.stringify({ pid: 4242, token: "e".repeat(32), at: 1 }),
      );
      expect(() =>
        CanaryDurableStore.open(dir, { alive: (pid) => pid === 4242 }),
      ).toThrow("STORE_LOCKED");
      writeFileSync(CanaryDurableStore.lockPath(dir), "{not json");
      expect(() => CanaryDurableStore.open(dir)).toThrow("STORE_LOCKED");
      expect(StoreError).toBeTypeOf("function");
      expect(existsSync(CanaryDurableStore.journalPath(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a batch commits with ONE write; a step that refuses after buffering lines poisons the store", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      let writes = 0;
      const io = {
        openSync: fs.openSync,
        writeSync: (fd: number, data: Uint8Array) => (
          writes++,
          fs.writeSync(fd, data)
        ),
        fsyncSync: fs.fsyncSync,
        closeSync: fs.closeSync,
        readFileSync: (p: string) => fs.readFileSync(p),
        existsSync: fs.existsSync,
        mkdirSync: (p: string) => void fs.mkdirSync(p, { recursive: true }),
        renameSync: fs.renameSync,
        linkSync: fs.linkSync,
        unlinkSync: fs.unlinkSync,
      };
      const s = CanaryDurableStore.open(dir, { io });
      writes = 0;
      s.batch(() => {
        s.append("A_ONE", 1);
        s.append("A_TWO", 2);
        s.append("A_THREE", 3);
      });
      expect(writes).toBe(1);
      expect(() =>
        s.batch(() => {
          s.append("A_ONE", 1);
          throw new Error("refused");
        }),
      ).toThrow("STORE_BATCH_ABANDONED");
      expect(s.writable).toBe(false);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------------------------- disarmed composition & release
describe("the composition is present and CLOSED in this build", () => {
  it("not armed: no owner record, wiring false; the runtime refuses to open (no store is created)", () => {
    expect(CANARY_LIVE_WIRING).toBe(false);
    expect(canaryArmed()).toMatchObject({ armed: false });
    expect(canaryArmed().reasons).toEqual(
      expect.arrayContaining(["NO_OWNER_APPROVED_CANARY", "CANARY_NOT_WIRED"]),
    );
    const dir = join(tmpdir(), `g14-closure-never-${process.pid}`);
    expect(() => openCanaryRuntime({ dir })).toThrow("WRITE_DISABLED");
    expect(() => canaryRuntime()).toThrow("WRITE_DISABLED");
    expect(existsSync(dir)).toBe(false);
    // Even with an armed record (test double) the wiring constant keeps it closed.
    arm();
    expect(canaryArmed()).toMatchObject({
      armed: false,
      reasons: ["CANARY_NOT_WIRED", "OWNER_KEY_MISSING"],
    });
    expect(() => openCanaryRuntime({ dir })).toThrow("WRITE_DISABLED");
    expect(canaryGateState().open).toBe(false);
    expect(canaryReadiness()).toMatchObject({
      wired: true,
      active: false,
      activation: "DISABLED",
    });
  });
  it("release egress sees the canary pool: every canary origin must be in the release allowlist", () => {
    expect(canaryReleaseOrigins()).toEqual([
      "https://arb1.arbitrum.io",
      "https://arbitrum-one-rpc.publicnode.com",
      "https://base-rpc.publicnode.com",
      "https://mainnet.base.org",
    ]);
    // SYNTHETIC_TEST_ONLY production profile and a schema-valid synthetic config (never a real release).
    const production = {
      OTHERBRIDGE_DEPLOYMENT_ENV: "production",
      OTHERBRIDGE_SECRET_ENVIRONMENT: "production",
      OTHERBRIDGE_APP_ORIGINS: "https://veined.xyz",
      OTHERBRIDGE_PUBLIC_ORIGIN: "https://veined.xyz",
      NEXT_PUBLIC_PRIVY_APP_ID: "production-public-app-id",
    };
    const config = (rpcOrigins: string[]) => ({
      schemaVersion: 1,
      identity: {
        rcId: "OTHERBRIDGE_RC_V1_16_synthetic-test",
        sourceCheckpoint: "a".repeat(64),
        sourceManifest: "b".repeat(64),
        buildHash: "c".repeat(64),
        protectedBaseline: "d".repeat(64),
      },
      origin: "https://veined.xyz",
      apiOrigin: "https://veined.xyz",
      processCount: 1,
      providerEndpoints: {
        uniswap: "https://trade-api.gateway.uniswap.org/v1/quote",
        pcsx: "https://x.pancakeswap.com/order-price/get-price",
        jupiterOrder: "https://api.jup.ag/swap/v2/order",
        jupiterBuild: "https://api.jup.ag/swap/v2/build",
        titan: "wss://api.titan.exchange/api/v1/ws",
      },
      rpcOrigins,
      routerPinsSha256: "a".repeat(64),
      solanaPinsSha256: "b".repeat(64),
      evidenceManifest: "release/evidence.json",
      evidenceManifestSha256: "c".repeat(64),
      privyAppId: "production-public-app-id",
      privyDashboardReviewRef: "synthetic-dashboard-review",
      secretEnvironment: "production",
      execution: "CLOSED",
      globalKill: true,
      feeBps: 0,
    });
    const swapOnly = releaseConfigurationErrors(
      production,
      config(Object.values(RPC_ORIGINS)),
    );
    expect(swapOnly).not.toContain("PRODUCTION_CONFIG_INVALID");
    expect(swapOnly).toContain("CANARY_RPC_NOT_IN_RELEASE_ALLOWLIST");
    const withPool = releaseConfigurationErrors(
      production,
      config([
        ...new Set([...Object.values(RPC_ORIGINS), ...canaryReleaseOrigins()]),
      ]),
    );
    expect(withPool).not.toContain("CANARY_RPC_NOT_IN_RELEASE_ALLOWLIST");
    // Listing them is not an approval: each canary origin still has to pass the same provenance check (UNAPPROVED_RPC).
    expect(withPool).toContain("UNAPPROVED_RPC");
  });
  it("the owner's minimum binds: 5.000000 in / 4.900000 minimum (record) and the 300 bps bound are separate criteria", () => {
    arm();
    const facts = (expectedOut: string) => ({
      now: NOW,
      action: "SEND" as const,
      account: SYN,
      chainId: "8453",
      pinSet: CANARY_APPROVAL_BOUNDS.pinSet,
      pinsVerified: true,
      token: USDC_BASE,
      spender: DIAMOND,
      target: DIAMOND,
      selector: "0x1794958f",
      amount: "5000000",
      expectedOut,
      gas: {
        remaining: [
          {
            action: "SEND" as const,
            gasLimit: "670622",
            maxFeePerGas: "10000000",
          },
        ],
        spentWei: "0",
        l1FeeWei: "1000",
      },
      use: { durable: true, approveConsumed: true, sendConsumed: false },
    });
    expect(
      evaluateCanaryApproval(armed.record, facts("4899999")).reasons,
    ).toContain("OUTPUT_BELOW_OWNER_MINIMUM");
    // Inside the 300 bps cost bound, still below the owner's absolute minimum: refused.
    expect(
      evaluateCanaryApproval(armed.record, facts("4850000")).reasons,
    ).toContain("OUTPUT_BELOW_OWNER_MINIMUM");
    expect(
      evaluateCanaryApproval(armed.record, facts("4900000")).reasons,
    ).not.toContain("OUTPUT_BELOW_OWNER_MINIMUM");
    // A stricter owner minimum is the binding one.
    arm({ minimumOut: "4950000" });
    expect(
      evaluateCanaryApproval(armed.record, facts("4900000")).reasons,
    ).toContain("OUTPUT_BELOW_OWNER_MINIMUM");
    // No proportional minimum for another amount: the record covers exactly one amount.
    arm();
    expect(
      evaluateCanaryApproval(armed.record, {
        ...facts("4900000"),
        amount: "4000000",
      }).reasons,
    ).toContain("AMOUNT_NOT_EXACT");
    // An unknown L1 fee is never 0: the budget is unproven.
    expect(
      evaluateCanaryApproval(armed.record, {
        ...facts("4979689"),
        gas: { ...facts("4979689").gas, l1FeeWei: null as never },
      }).reasons,
    ).toContain("GAS_BUDGET_UNPROVEN");
  });
});

// ------------------------------------------------------------------------------------------ G7 scan: canary inventory
describe("G7 scan: the canary path's proposed protected inventory is hashed and complete", () => {
  it("hashes every inventory file; an unlisted canary file, a missing file, an armed record or a second selector are findings", async () => {
    vi.useRealTimers();
    const { scanCanaryInventory } =
      await import("../../scripts/g7-safety-scan");
    const clean = scanCanaryInventory();
    expect(clean.findings).toEqual([]);
    expect(clean.inventory).toHaveLength(78);
    expect(
      Object.values(clean.hashes).every((h) => /^[0-9a-f]{64}$/.test(h ?? "")),
    ).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "g14-closure-g7-"));
    try {
      fs.cpSync("src", join(root, "src"), { recursive: true });
      const at = (p: string) => join(root, p);
      const mutate = (p: string, from: string, to: string) => {
        const t = readFileSync(at(p), "utf8");
        if (!t.includes(from)) throw new Error("ANCHOR " + p);
        writeFileSync(at(p), t.replace(from, to));
        return () => writeFileSync(at(p), t);
      };
      writeFileSync(
        at("src/execution/server/canary/extra.ts"),
        "export const x = 1;\n",
      );
      expect(scanCanaryInventory(root).findings.map((f) => f.rule)).toContain(
        "canary-inventory-unlisted",
      );
      rmSync(at("src/execution/server/canary/extra.ts"));
      rmSync(at("src/execution/server/canary/durable-store.ts"));
      expect(scanCanaryInventory(root).findings.map((f) => f.rule)).toContain(
        "canary-inventory-missing",
      );
      fs.copyFileSync(
        "src/execution/server/canary/durable-store.ts",
        at("src/execution/server/canary/durable-store.ts"),
      );
      const undo1 = mutate(
        "src/security/canary-approval.ts",
        "null as Readonly<OwnerCanaryApproval> | null;",
        "({}) as Readonly<OwnerCanaryApproval> | null;",
      );
      expect(scanCanaryInventory(root).findings.map((f) => f.rule)).toContain(
        "canary-owner-record-armed",
      );
      undo1();
      const undo2 = mutate(
        "src/execution/server/gate.ts",
        "CANARY_LIVE_WIRING = false as const;",
        "CANARY_LIVE_WIRING = true as const;",
      );
      expect(scanCanaryInventory(root).findings.map((f) => f.rule)).toContain(
        "canary-wiring-on",
      );
      undo2();
      const undo3 = mutate(
        "src/security/firewall.ts",
        'selector: "0x1794958f",',
        'selector: "0xa1f1ce43",',
      );
      expect(scanCanaryInventory(root).findings.map((f) => f.rule)).toContain(
        "canary-selector-scope",
      );
      undo3();
      expect(scanCanaryInventory(root).findings).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});

// ------------------------------------------------------------------------------------- review 1 repairs (unit)
describe("review 1 repairs: digest-bound limits, explicit confirmation, lock ownership, whole batches, armed only when well formed", () => {
  it("F4: limits whose lifetime was inflated without the server's digest are refused; the entry snapshot is what counts", async () => {
    arm();
    const tx = approveTx();
    const inflated = {
      ...limitsOf(tx, { authorizationExpiresAt: NOW + 1_000 }),
      authorizationExpiresAt: NOW + 31_000,
    };
    const p = fakeWallet();
    const r = await sendWith(adapterOn(p), tx, { limits: inflated });
    // G14 follow-up F2: an answer whose digest is not the digest of its own fields mints no authority at all.
    expect(r).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    // Inflated past every lifetime the server can grant: refused by the horizon whatever the digest (review 2 R3).
    const far = await sendWith(adapterOn(p), tx, {
      limits: {
        ...limitsOf(tx, { authorizationExpiresAt: NOW + 1_000 }),
        authorizationExpiresAt: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(far).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    expect(p.calls).toEqual([]);
    // The caller changes its limits object while the identity read runs: the adapter's entry copy is used.
    const limits = limitsOf(tx, { authorizationExpiresAt: NOW + 1_000 });
    const q = slowIdentityWallet(() => {
      vi.setSystemTime(NOW + 2_000);
      (limits as { authorizationExpiresAt: number }).authorizationExpiresAt =
        NOW + 99_999;
    });
    const s = await sendWith(adapterOn(q), tx, { limits });
    expect(s).toMatchObject({
      ok: false,
      e: { reason: "AUTHORIZATION_EXPIRED" },
    });
    expect(q.count("eth_sendTransaction")).toBe(0);
  });
  it("F3: a durable write or clean-up that does not answer `true` is NOT a confirmation", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(NOW);
    for (const [name, unknown, cleared, reason] of [
      [
        "write answers nothing, clean-up confirmed",
        () => undefined,
        () => true,
        "RECORD_NOT_WRITTEN",
      ],
      [
        "write answers nothing, clean-up answers nothing",
        () => undefined,
        () => undefined,
        "RECORD_OUTCOME_UNKNOWN",
      ],
      [
        "write answers 1, clean-up answers 'ok'",
        () => 1,
        () => "ok",
        "RECORD_OUTCOME_UNKNOWN",
      ],
    ] as [string, () => unknown, () => unknown, string][]) {
      vi.setSystemTime(NOW);
      arm();
      const step = prepOf("SEND");
      const p = fakeWallet();
      const c = ctxOf(step, {
        persistUnknown: unknown,
        persistNotRequested: cleared,
      });
      const r = await outcome(submitCanary(adapterOn(p), step, c.context));
      expect(r, name).toMatchObject({ ok: false, e: { reason } });
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
  });
  it("F11: a present but malformed owner record arms nothing", () => {
    armed.record = { version: "x" };
    expect(canaryArmed().reasons).toContain("OWNER_RECORD_MALFORMED");
    expect(canaryArmed().armed).toBe(false);
  });
  it("F2: a writer whose lock was replaced or removed stops at its next commit (STORE_LOCK_LOST)", () => {
    vi.useRealTimers();
    for (const how of ["replaced", "removed"] as const) {
      const dir = tmp();
      try {
        const s = CanaryDurableStore.open(dir);
        s.append("USE", { line: "a" });
        const lock = CanaryDurableStore.lockPath(dir);
        if (how === "replaced")
          writeFileSync(
            lock,
            JSON.stringify({ pid: process.pid, token: "b".repeat(32), at: 1 }),
          );
        else rmSync(lock);
        expect(() => s.append("USE", { line: "b" }), how).toThrow(
          "STORE_LOCK_LOST",
        );
        expect(s.writable, how).toBe(false);
        expect(
          CanaryDurableStore.inspect(dir).entries.filter(
            (e) => e.type === "USE",
          ),
        ).toHaveLength(1);
        s.close();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // A lock whose token is not a token is never used in a path: refused.
    const dir = tmp();
    try {
      writeFileSync(
        join(dir, "writer.lock"),
        JSON.stringify({ pid: 999_999_999, token: "../../x", at: 1 }),
      );
      expect(() =>
        CanaryDurableStore.open(dir, { alive: () => false }),
      ).toThrow("STORE_LOCKED");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("F5: a batch that did not fully reach the file is not read (TORN_TAIL / INCOMPLETE_BATCH, the prefix before it is kept)", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      const s = CanaryDurableStore.open(dir);
      s.append("USE", { line: "kept" });
      s.batch(() => {
        s.append("A_ONE", 1);
        s.append("A_TWO", 2);
        s.append("A_THREE", 3);
      });
      s.close();
      const journal = CanaryDurableStore.journalPath(dir);
      const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
      // Cut the file after the batch's first two lines — on a line boundary.
      writeFileSync(
        journal,
        lines.slice(0, lines.length - 1).join("\n") + "\n",
      );
      const r = readJournal(readFileSync(journal));
      expect(r.status).toBe("TORN_TAIL");
      expect(r.problem).toBe("INCOMPLETE_BATCH");
      expect(r.entries.map((e) => e.type)).toEqual(["OPEN", "USE"]);
      const t = CanaryDurableStore.open(dir);
      expect(t.writable).toBe(false);
      t.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------- review 2 repairs (unit)
describe("review 2 repairs: dispatch horizon, marked refusals, own stale lock, damaged batches, the attention notice", () => {
  it("R3: limits whose digest is RECOMPUTED for a lifetime beyond the server's are refused (authorization, quote); the exact horizon passes", async () => {
    arm();
    const tx = approveTx();
    const H = CANARY_APPROVAL_BOUNDS.dispatchHorizonMs;
    expect(H).toBe(65_000);
    for (const over of [
      { authorizationExpiresAt: NOW + 10 * 60_000 },
      { quoteExpiresAt: NOW + H + 1 },
    ]) {
      const p = fakeWallet();
      // limitsOf computes the REAL digest over the inflated values (what a direct caller could do).
      const r = await sendWith(adapterOn(p), tx, {
        limits: limitsOf(tx, over),
      });
      expect(r, JSON.stringify(over)).toMatchObject({
        ok: false,
        e: { reason: "DISPATCH_LIMITS_UNBOUNDED", beforeWalletRequest: true },
      });
      expect(p.count("eth_sendTransaction")).toBe(0);
    }
    const p = fakeWallet();
    const ok = await sendWith(adapterOn(p), tx, {
      limits: limitsOf(tx, {
        authorizationExpiresAt: NOW + H,
        quoteExpiresAt: NOW + H,
      }),
    });
    expect(ok).toMatchObject({ ok: true });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("N9: a canary context whose getter throws is a MARKED refusal before the wallet (never an unmarked error)", async () => {
    arm();
    const tx = approveTx();
    const p = fakeWallet();
    // G14 follow-up F2: the context names an authority (and may wrongly name limits); a throwing getter on either is
    // a marked refusal before the wallet.
    for (const key of ["authority", "limits"]) {
      const context = {} as Record<string, unknown>;
      Object.defineProperty(context, key, {
        enumerable: true,
        get() {
          throw new Error("GETTER");
        },
      });
      const r = await adapterOn(p)
        .sendCanonicalTransaction(
          tx,
          { ...tx },
          { gate: "veined-owner-canary", canary: context as never },
        )
        .then(
          () => ({ ok: true as const }),
          (e: unknown) => ({ ok: false as const, e }),
        );
      expect(r.ok, key).toBe(false);
      expect(refusedBeforeWallet((r as { e: unknown }).e), key).toBe(true);
    }
    expect(p.calls).toEqual([]);
  });
  it("N5: a lock naming THIS process with a token no open store holds is our own stale lock (taken over); a live one is not", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      CanaryDurableStore.open(dir).close();
      writeFileSync(
        CanaryDurableStore.lockPath(dir),
        JSON.stringify({
          ...CanaryDurableStore.lockIdentity,
          token: "e".repeat(32),
          at: 1,
        }),
      );
      const s = CanaryDurableStore.open(dir);
      expect(s.writable).toBe(true);
      const open = s
        .entries()
        .filter((e) => e.type === "OPEN")
        .at(-1);
      expect((open!.data as { takeoverOf: number }).takeoverOf).toBe(
        process.pid,
      );
      // A second open in the same process while the first is alive: refused (its token is live).
      expect(() => CanaryDurableStore.open(dir)).toThrow("STORE_LOCKED");
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("N5: a lock name that is empty for a moment (a contender's rename -> link back) is read again, not lost", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      let hide = 0;
      const io = {
        ...nodeIo(),
        readFileSync: (path: string) => {
          if (path.endsWith("writer.lock") && hide > 0) {
            hide--;
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }
          return fs.readFileSync(path);
        },
      };
      const s = CanaryDurableStore.open(dir, { io });
      hide = 3;
      s.append("USE", { line: "kept" });
      expect(s.writable).toBe(true);
      expect(
        CanaryDurableStore.inspect(dir).entries.map((e) => e.type),
      ).toEqual(["OPEN", "USE"]);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("N6: damage inside a batch drops the whole batch from the verified prefix (CORRUPT too, not only a torn tail)", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      const s = CanaryDurableStore.open(dir);
      s.append("USE", { line: "kept" });
      s.batch(() => {
        s.append("A_ONE", 1);
        s.append("A_TWO", 2);
        s.append("A_THREE", 3);
      });
      s.close();
      const journal = CanaryDurableStore.journalPath(dir);
      const lines = readFileSync(journal, "utf8").split("\n").filter(Boolean);
      lines[3] = lines[3].replace('"d":2', '"d":7');
      writeFileSync(journal, lines.join("\n") + "\n");
      const r = readJournal(readFileSync(journal));
      expect(r.status).toBe("CORRUPT");
      expect(r.entries.map((e) => e.type)).toEqual(["OPEN", "USE"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("N1: the panel shows an explicit attention message with its reasons whenever the server says so; never a quiet PENDING", async () => {
    const { CanaryViewNotice } =
      await import("../../src/components/execution-review");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const t = (k: string, v?: Record<string, string | number>) =>
      `${k}${v ? JSON.stringify(v) : ""}`;
    const html = (view: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(CanaryViewNotice, { view: view as never, t: t as never }),
      );
    const base = {
      state: "SUBMITTED",
      label: "PENDING",
      completed: false,
      needsAttention: false,
      hashes: { approval: null, main: null },
      attempts: [],
      notes: [],
    };
    // A quiet pending step: the state line only.
    expect(html(base)).not.toContain("canary-attention");
    // A replaced / sped-up step (review 2 N1 scenario 1).
    const replaced = html({
      ...base,
      needsAttention: true,
      notes: [
        "NONCE_USED_BY_ANOTHER_TRANSACTION",
        "REPLACEMENT_SEARCH:NOT_FOUND",
      ],
      hashes: { approval: null, main: "0x" + "ab".repeat(32) },
    });
    expect(replaced).toContain('data-testid="canary-attention"');
    expect(replaced).toContain("NONCE_USED_BY_ANOTHER_TRANSACTION");
    expect(replaced).toContain('role="alert"');
    // A read-only store (review 2 N1 scenario 2).
    const readOnly = html({
      ...base,
      needsAttention: true,
      store: { status: "TORN_TAIL", writable: false },
      notes: ["STORE_READ_ONLY:INCOMPLETE_BATCH"],
    });
    expect(readOnly).toContain("STORE_TORN_TAIL");
    expect(readOnly).toContain("STORE_READ_ONLY:INCOMPLETE_BATCH");
    // A record that reads RECONCILED from memory that is not durable is never shown completed (review 2 N4).
    const notDurable = html({
      ...base,
      state: "RECONCILED",
      label: "COMPLETED",
      completed: false,
      notDurable: true,
      needsAttention: true,
    });
    expect(notDurable).not.toContain("g14.c.completed");
    expect(notDurable).toContain("NOT_DURABLE");
    expect(notDurable).toContain('data-completed="false"');
    // Completed and nothing to look at: the completed line, no alert.
    const done = html({
      ...base,
      state: "RECONCILED",
      label: "COMPLETED",
      completed: true,
    });
    expect(done).toContain("g14.c.completed");
    expect(done).not.toContain("canary-attention");
  });
});

// ------------------------------------------------------------------------------------- review 3 repairs (unit)
describe("review 3 repairs: the owner key arms, a foreign instance's lock is live, a failed OPEN leaves nothing", () => {
  it("N12: without the owner's key digest (null in this build) the canary is not armed, whatever the record says", () => {
    arm();
    const a = canaryArmed();
    expect(a.armed).toBe(false);
    expect(a.reasons).toContain("OWNER_KEY_MISSING");
  });
  it("N14 / review 4 R4-2: a same-pid lock is live for another thread or an unknown writer, and DEAD for an earlier process start", () => {
    vi.useRealTimers();
    const me = CanaryDurableStore.lockIdentity;
    for (const [lock, live] of [
      [{ pid: process.pid, token: "e".repeat(32), at: 1 }, true],
      [{ ...me, thread: me.thread + 1, token: "e".repeat(32), at: 1 }, true],
      // A container restarted with the same pid: the lock of the process that crashed is taken over.
      [{ ...me, boot: me.boot - 60_000, token: "e".repeat(32), at: 1 }, false],
    ] as const) {
      const dir = tmp();
      try {
        writeFileSync(CanaryDurableStore.lockPath(dir), JSON.stringify(lock));
        if (live)
          expect(
            () => CanaryDurableStore.open(dir),
            JSON.stringify(lock),
          ).toThrow("STORE_LOCKED");
        else {
          const st = CanaryDurableStore.open(dir);
          expect(st.writable).toBe(true);
          st.close();
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  it("N14: an open whose first line cannot be written leaves no lock and no live token (the next open works)", () => {
    vi.useRealTimers();
    const dir = tmp();
    try {
      let fail = true;
      const io = {
        ...nodeIo(),
        fsyncSync: (fd: number) => {
          // The lock's own fsync succeeds; the journal's first commit fails once.
          if (fail && seenJournal) {
            fail = false;
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          }
          fs.fsyncSync(fd);
        },
        openSync: ((path: string, flags: string) => {
          if (String(path).endsWith("journal.ndjson")) seenJournal = true;
          return fs.openSync(path, flags);
        }) as typeof fs.openSync,
      };
      let seenJournal = false;
      expect(() => CanaryDurableStore.open(dir, { io })).toThrow(
        "STORE_WRITE_FAILED",
      );
      expect(existsSync(CanaryDurableStore.lockPath(dir))).toBe(false);
      const s = CanaryDurableStore.open(dir);
      expect(s.writable).toBe(true);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --------------------------------------------------------------------- G14 follow-up F2 (R3): the dispatch authority
describe("follow-up F2 (R3): only an authority the adapter minted from the SERVER's own answers reaches the wallet", () => {
  const settle = (pr: Promise<unknown>) =>
    pr.then(
      (hash) => ({ ok: true as const, hash }),
      (e: unknown) => ({ ok: false as const, e: e as Record<string, unknown> }),
    );
  const sendRaw = (
    a: InstanceType<typeof WalletProviderAdapter>,
    tx: Record<string, string>,
    canary: Record<string, unknown>,
  ) =>
    settle(
      a.sendCanonicalTransaction(
        tx,
        { ...tx },
        { gate: "veined-owner-canary", canary: canary as never },
      ),
    );
  it("the independent reproduction: a caller rebuilds the limits (+60 s) and recomputes the plain digest — refused, 0 financial calls", async () => {
    arm();
    const tx = approveTx();
    for (const [name, over] of [
      ["valid lifetimes", {}],
      [
        "expired original lifetimes",
        { authorizationExpiresAt: NOW - 2_000, quoteExpiresAt: NOW - 1_000 },
      ],
      [
        "both lifetimes moved +60 s, digest recomputed",
        { authorizationExpiresAt: NOW + 60_000, quoteExpiresAt: NOW + 60_000 },
      ],
      [
        "beyond the horizon",
        { authorizationExpiresAt: NOW + 66_000, quoteExpiresAt: NOW + 66_000 },
      ],
    ] as [string, Partial<Limits>][]) {
      const p = fakeWallet();
      const r = await sendRaw(adapterOn(p), tx, { limits: limitsOf(tx, over) });
      expect(r, name).toMatchObject({
        ok: false,
        e: {
          code: "CANARY_REQUEST_REFUSED",
          reason: "DISPATCH_LIMITS_FROM_CALLER",
          beforeWalletRequest: true,
        },
      });
      expect(p.calls, name).toEqual([]);
    }
    // A REAL authority whose server authorization has ended cannot be stretched by caller limits next to it; the
    // attempt spends the authority, so presenting it again finds nothing.
    const p = fakeWallet();
    const a = adapterOn(p);
    const { authority } = await authorityFor(
      a,
      tx,
      limitsOf(tx, { authorizationExpiresAt: NOW + 1_000 }),
    );
    expect(authority).toBeDefined();
    vi.setSystemTime(NOW + 2_000);
    const stretched = await sendRaw(a, tx, {
      authority,
      limits: limitsOf(tx, { authorizationExpiresAt: NOW + 60_000 }),
    });
    expect(stretched).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_LIMITS_FROM_CALLER" },
    });
    expect(await sendRaw(a, tx, { authority })).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
  it("an authority is single use and bound: a copy, clone, JSON round trip, another adapter, epoch or transaction, a discarded one or a re-evaluated module reach nothing", async () => {
    arm();
    const tx = approveTx();
    const p = fakeWallet();
    const a = adapterOn(p);
    const { authority } = await authorityFor(a, tx, limitsOf(tx));
    expect(Object.keys(authority as object)).toEqual([]);
    expect(Object.isFrozen(authority)).toBe(true);
    for (const [name, copy] of [
      ["structuredClone", structuredClone(authority)],
      ["JSON round trip", JSON.parse(JSON.stringify(authority))],
      ["spread copy", { ...(authority as object) }],
      ["prototype child", Object.create(authority as object)],
      ["a fresh empty frozen object", Object.freeze(Object.create(null))],
    ] as [string, unknown][]) {
      const r = await sendRaw(a, tx, { authority: copy });
      expect(r, name).toMatchObject({
        ok: false,
        e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
      });
    }
    expect(p.count("eth_sendTransaction")).toBe(0);
    // The original was never touched by the copies: it reaches the wallet exactly once ...
    expect(await sendRaw(a, tx, { authority })).toEqual({
      ok: true,
      hash: "0x" + "ab".repeat(32),
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
    // ... and never again.
    expect(await sendRaw(a, tx, { authority })).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
    // Another adapter (another identity epoch) on the same wallet, or another transaction: refused, and spent.
    const q = fakeWallet();
    const qa = adapterOn(q);
    const other = new WalletProviderAdapter(q, {
      address: SYN,
      chainId: 8453,
      epoch: 2,
    });
    const forQa = await authorityFor(qa, tx, limitsOf(tx));
    expect(
      await sendRaw(other, tx, { authority: forQa.authority }),
    ).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_OTHER_WALLET" },
    });
    expect(await sendRaw(qa, tx, { authority: forQa.authority })).toMatchObject(
      {
        ok: false,
        e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
      },
    );
    const forApprove = await authorityFor(qa, tx, limitsOf(tx));
    expect(
      await sendRaw(qa, mainTx(), { authority: forApprove.authority }),
    ).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_TRANSACTION_MISMATCH" },
    });
    const discarded = await authorityFor(qa, tx, limitsOf(tx));
    discardCanaryDispatchAuthority(discarded.authority);
    expect(
      await sendRaw(qa, tx, { authority: discarded.authority }),
    ).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    expect(q.count("eth_sendTransaction")).toBe(0);
    // A page reload / restart: the module is evaluated again; an authority of the earlier evaluation is nothing.
    const kept = await authorityFor(qa, tx, limitsOf(tx));
    vi.resetModules();
    const fresh = await import("../../src/features/wallet/adapter");
    const r = fakeWallet();
    const ra = new fresh.WalletProviderAdapter(r, {
      address: SYN,
      chainId: 8453,
      epoch: 1,
    });
    expect(
      await settle(
        ra.sendCanonicalTransaction(
          tx,
          { ...tx },
          {
            gate: "veined-owner-canary",
            canary: { authority: kept.authority } as never,
          },
        ),
      ),
    ).toMatchObject({
      ok: false,
      e: { reason: "DISPATCH_AUTHORITY_REQUIRED" },
    });
    expect(r.calls).toEqual([]);
  });
  it("minting asks the server itself through the page fetch captured at load: a disarmed record, a fetch replaced later, a refused / foreign / missing durable answer mint nothing", async () => {
    vi.useRealTimers();
    vi.useFakeTimers({
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    vi.setSystemTime(NOW);
    const tx = approveTx();
    const l = () => limitsOf(tx);
    const mint = (a: InstanceType<typeof WalletProviderAdapter>, lim: Limits) =>
      obtainCanaryDispatchAuthority(a, {
        session: "e".repeat(64),
        review: lim.review,
        ref: {
          record: lim.record,
          action: lim.action,
          attempt: lim.attempt,
          digest: lim.preparedDigest,
          request: "f".repeat(32),
        },
        gesture: lim.gesture,
      });
    // Disarmed: refused before ANY request of the page's API.
    arm();
    const disarmedLimits = limitsOf(approveTx());
    armed.record = null;
    const before = pageServer.calls.length;
    expect(await mint(adapterOn(fakeWallet()), disarmedLimits)).toEqual({
      ok: false,
      written: false,
      code: "NO_OWNER_APPROVED_CANARY",
    });
    expect(pageServer.calls.length).toBe(before);
    arm();
    const confirmOk = (lim: Limits) => () =>
      ({
        action: lim.action,
        record: lim.record,
        review: lim.review,
        transaction: tx,
        expiresAt: lim.authorizationExpiresAt,
        approvalId: lim.approvalId,
        attempt: lim.attempt,
        quoteExpiresAt: lim.quoteExpiresAt,
        digest: lim.preparedDigest,
      }) as unknown;
    // A fetch replaced AFTER the adapter was loaded is never asked (the forged answers would mint).
    const evil = vi.fn(async (_u: unknown, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body));
      const lim = l();
      return b.action === "canary-confirm"
        ? json({ preparation: confirmOk(lim)(), serverNow: Date.now() })
        : json({
            ok: true,
            state: "REQUESTED",
            attempt: lim.attempt,
            digest: lim.preparedDigest,
            request: "f".repeat(32),
          });
    });
    const page = globalThis.fetch;
    globalThis.fetch = evil as unknown as typeof fetch;
    pageServer.handler = async () => json({ error: "ATTEMPT_UNKNOWN" }, 422);
    try {
      expect(await mint(adapterOn(fakeWallet()), l())).toMatchObject({
        ok: false,
        written: false,
      });
      expect(evil).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = page;
    }
    // The durable write: refused (definitive), answered for another write, not a commit, or no answer in time.
    for (const [name, answer, written] of [
      [
        "refused by the server",
        () =>
          json({
            ok: false,
            state: "REQUESTED",
            code: "ATTEMPT_ALREADY_REQUESTED",
          }),
        false,
      ],
      [
        "an answer naming another write",
        () =>
          json({
            ok: true,
            state: "REQUESTED",
            attempt: "9".repeat(32),
            digest: l().preparedDigest,
            request: "f".repeat(32),
          }),
        "UNKNOWN",
      ],
      [
        "a failed commit",
        () => json({ error: "STORE_NEEDS_ATTENTION" }, 422),
        "UNKNOWN",
      ],
      ["no answer", () => new Promise<Response>(() => undefined), "UNKNOWN"],
    ] as [string, () => Promise<Response> | Response, false | "UNKNOWN"][]) {
      const lim = l();
      pageServer.handler = async (b) =>
        b.action === "canary-confirm"
          ? json({ preparation: confirmOk(lim)(), serverNow: Date.now() })
          : answer();
      const pending = mint(adapterOn(fakeWallet()), lim);
      await vi.advanceTimersByTimeAsync(CANARY_SERVER_WAIT_MS + 1);
      const got = await pending;
      expect(got.ok, name).toBe(false);
      expect((got as { written: unknown }).written, name).toBe(written);
    }
  });
  it("the server's limits are judged in SERVER time: a page clock behind the server cannot stretch them", async () => {
    arm();
    const tx = approveTx();
    // The server is 20 s ahead of the page and granted 10 s (its expiry is page time + 30 s).
    const ahead = () => Date.now() + 20_000;
    const lim = limitsOf(tx, {
      authorizationExpiresAt: NOW + 30_000,
      quoteExpiresAt: NOW + 30_000,
    });
    const p = slowIdentityWallet(() => vi.setSystemTime(NOW + 11_000));
    const a = adapterOn(p);
    const { authority } = await authorityFor(a, tx, lim, ahead);
    expect(await sendRaw(a, tx, { authority })).toMatchObject({
      ok: false,
      e: { reason: "AUTHORIZATION_EXPIRED" },
    });
    expect(p.count("eth_sendTransaction")).toBe(0);
    // A clock difference beyond five minutes mints nothing.
    vi.setSystemTime(NOW);
    const far = await authorityFor(
      a,
      tx,
      limitsOf(tx),
      () => Date.now() + 301_000,
    );
    expect(far.code).toBe("CLOCK_OFFSET_TOO_LARGE");
  });
});

// ------------------------------------------------------------------------------ G14 follow-up F4: the lock boundary
describe("review 7 (R7-1 / R7-6 / R7-7): general gates, a definitive commit refusal, the late check in server time", () => {
  it("R7-1: neither general gate reaches Base (the canary's chain), owner record or not; nothing reaches the wallet", async () => {
    for (const owner of [false, true]) {
      if (owner) arm();
      for (const gate of [
        "otherbridge-submission",
        "g7-local-pilot",
      ] as const) {
        const p = fakeWallet();
        const a = adapterOn(p);
        for (const tx of [approveTx(), mainTx()]) {
          const r = await outcome(
            a.sendCanonicalTransaction(tx, { ...tx }, { gate }),
          );
          expect(r, `${gate} owner=${owner}`).toMatchObject({
            ok: false,
            e: { code: "WALLET_CHAIN_NOT_TRUSTED", beforeWalletRequest: true },
          });
        }
        expect(p.count("eth_sendTransaction")).toBe(0);
      }
    }
  });
  it("R7-6: a commit the server refuses definitively (nothing written) gives the step back with the server's code; no clean-up is asked", async () => {
    arm();
    const step = prepOf("APPROVE");
    const c = ctxOf(step);
    const confirmOnly = pageServer.handler!;
    pageServer.handler = async (body) =>
      body.action === "canary-record" && body.kind === "requested"
        ? json({ error: "ATTEMPT_ALREADY_REQUESTED" }, 422)
        : confirmOnly(body);
    const p = fakeWallet();
    const r = await outcome(submitCanary(adapterOn(p), step, c.context));
    expect(r).toMatchObject({
      ok: false,
      e: {
        code: "CANARY_REQUEST_REFUSED",
        reason: "ATTEMPT_ALREADY_REQUESTED",
        beforeWalletRequest: true,
      },
    });
    expect(c.log).toEqual([]);
    expect(p.count("eth_sendTransaction")).toBe(0);
    // The step was given back (not marked uncertain): the same step with a committing server reaches the wallet once.
    const again = ctxOf(step);
    const r2 = await outcome(submitCanary(adapterOn(p), step, again.context));
    expect(r2).toMatchObject({ ok: true });
    expect(again.log[0]).toBe("requested");
    expect(again.log.filter((x) => x.startsWith("hash:"))).toHaveLength(1);
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("R7-6: a commit whose outcome is unknown is always followed by the conditional clean-up (confirmed: RECORD_NOT_WRITTEN; not confirmed: RECORD_OUTCOME_UNKNOWN)", async () => {
    arm();
    for (const cleared of [true, false]) {
      const step = prepOf("APPROVE");
      const c = ctxOf(step, {
        persistUnknown: () => "NO_COMMIT",
        persistNotRequested: () => {
          c.log.push("not-requested");
          return cleared;
        },
      });
      const p = fakeWallet();
      const r = await outcome(submitCanary(adapterOn(p), step, c.context));
      expect(r, String(cleared)).toMatchObject({
        ok: false,
        e: {
          reason: cleared ? "RECORD_NOT_WRITTEN" : "RECORD_OUTCOME_UNKNOWN",
        },
      });
      expect(c.log).toEqual(["not-requested"]);
      expect(p.count("eth_sendTransaction")).toBe(0);
    }
  });
  it("R7-7: the page's late check judges in the SERVER's time: a server clock 45 s ahead refuses before the adapter is asked (clean-up of this write only)", async () => {
    arm();
    const step = prepOf("SEND", { expiresAt: NOW + 40_000 });
    const c = ctxOf(step);
    const page = pageServer.handler!;
    pageServer.handler = legacyServer({
      confirmPrepared: async () => ({ ...step }),
      persistUnknown: (ref: never) => {
        c.refs.push(ref);
        c.log.push("requested");
        return true;
      },
      serverNow: () => Date.now() + 45_000,
    });
    void page;
    const p = fakeWallet();
    const r = await outcome(submitCanary(adapterOn(p), step, c.context));
    expect(r).toMatchObject({
      ok: false,
      e: {
        code: "CANARY_REQUEST_REFUSED",
        reason: "AUTHORIZATION_EXPIRED",
        beforeWalletRequest: true,
      },
    });
    expect(c.log).toEqual(["requested", "not-requested"]);
    expect(c.refs[0]).toEqual(c.refs[1]);
    // Refused by the page's own late check: the adapter's send (its second identity read) was never reached.
    expect(p.count("eth_accounts")).toBe(1);
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
});

describe("review 8 R8-2: the late check judges the owner's click in server time too", () => {
  it("a server 5 s behind, or 20 s ahead during an 11 s flow, still reaches the wallet exactly once (the click is moved into server time)", async () => {
    for (const [offset, flow] of [
      [-5_000, 0],
      [20_000, 11_000],
    ] as const) {
      arm();
      vi.setSystemTime(NOW);
      const step = prepOf("APPROVE");
      const c = ctxOf(step);
      pageServer.handler = legacyServer({
        confirmPrepared: async () => ({ ...step }),
        persistUnknown: () => true,
        serverNow: () => Date.now() + offset,
      });
      let reads = 0;
      const p = fakeWallet();
      const inner = p.request.bind(p);
      p.request = async (args) => {
        if (args.method === "eth_accounts" && ++reads === 1 && flow > 0)
          vi.setSystemTime(NOW + flow);
        return inner(args);
      };
      const r = await outcome(submitCanary(adapterOn(p), step, c.context));
      expect(r, `offset ${offset}`).toMatchObject({ ok: true });
      expect(p.count("eth_sendTransaction"), `offset ${offset}`).toBe(1);
    }
  });
  it("a click that is really more than 30 s old at the late check is refused there (same clock), before the adapter; only this write is cleaned up", async () => {
    arm();
    vi.setSystemTime(NOW);
    const step = prepOf("APPROVE");
    const c = ctxOf(step);
    let reads = 0;
    const p = fakeWallet();
    const inner = p.request.bind(p);
    p.request = async (args) => {
      if (args.method === "eth_accounts" && ++reads === 1)
        vi.setSystemTime(NOW + 31_000);
      return inner(args);
    };
    const r = await outcome(submitCanary(adapterOn(p), step, c.context));
    expect(r).toMatchObject({
      ok: false,
      e: {
        code: "CANARY_REQUEST_REFUSED",
        reason: "OWNER_GESTURE_REQUIRED",
        beforeWalletRequest: true,
      },
    });
    expect(c.log).toEqual(["requested", "not-requested"]);
    expect(p.count("eth_accounts")).toBe(1);
    expect(p.count("eth_sendTransaction")).toBe(0);
  });
});

describe("follow-up F4: the store's supported deployment and its lock, tested by behaviour", () => {
  const tmpStore = () => mkdtempSync(join(tmpdir(), "g14-f4-store-"));
  it("a live lock of THIS boot and thread refuses a second open; after close the store opens again", () => {
    vi.useRealTimers();
    const dir = tmpStore();
    try {
      const a = CanaryDurableStore.open(dir);
      const lock = JSON.parse(
        readFileSync(CanaryDurableStore.lockPath(dir), "utf8"),
      ) as Record<string, unknown>;
      expect(lock).toMatchObject(CanaryDurableStore.lockIdentity);
      expect(typeof lock.host).toBe("string");
      expect(() => CanaryDurableStore.open(dir)).toThrow("STORE_LOCKED");
      a.close();
      const b = CanaryDurableStore.open(dir);
      expect(b.writable).toBe(true);
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a lock that names another host is never taken over, even when its pid is not alive here", () => {
    vi.useRealTimers();
    const dir = tmpStore();
    try {
      CanaryDurableStore.open(dir).close();
      writeFileSync(
        CanaryDurableStore.lockPath(dir),
        JSON.stringify({
          pid: 999_999,
          boot: 1,
          thread: 0,
          host: "another-host.example",
          token: "c".repeat(32),
          at: 1,
        }),
      );
      expect(() =>
        CanaryDurableStore.open(dir, { alive: () => false }),
      ).toThrow("STORE_LOCKED_FOREIGN_HOST");
      // The same lock without a host field is judged by its pid as before (no deployed lock lacks it).
      writeFileSync(
        CanaryDurableStore.lockPath(dir),
        JSON.stringify({ pid: 999_999, token: "c".repeat(32), at: 1 }),
      );
      const s = CanaryDurableStore.open(dir, { alive: () => false });
      expect(s.writable).toBe(true);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a store on a network share (UNC path) is refused before anything is created", () => {
    for (const dir of [
      "\\\\fileserver\\share\\canary",
      "//fileserver/share/canary",
    ])
      expect(() => CanaryDurableStore.open(dir), dir).toThrow(
        "STORE_SHARED_PATH_UNSUPPORTED",
      );
  });
  it("a writer that loses its lock between the check and its write never reports that write as durable", () => {
    vi.useRealTimers();
    const dir = tmpStore();
    try {
      const lock = CanaryDurableStore.lockPath(dir);
      let steal = false;
      const io = {
        ...fs,
        openSync: fs.openSync,
        writeSync: (fd: number, data: Uint8Array) => fs.writeSync(fd, data),
        fsyncSync: (fd: number) => {
          fs.fsyncSync(fd);
          // Another contender takes the lock over right after this writer's check (the R7 / N6 window).
          if (steal)
            writeFileSync(
              lock,
              JSON.stringify({
                pid: process.pid,
                token: "d".repeat(32),
                at: 1,
              }),
            );
        },
        closeSync: fs.closeSync,
        readFileSync: (p: string) => fs.readFileSync(p),
        existsSync: fs.existsSync,
        mkdirSync: (p: string) => void fs.mkdirSync(p, { recursive: true }),
        renameSync: fs.renameSync,
        linkSync: fs.linkSync,
        unlinkSync: fs.unlinkSync,
      };
      const s = CanaryDurableStore.open(dir, { io });
      const before = s.entries().length;
      steal = true;
      expect(() => s.append("USE", { line: "after-lost-lock" })).toThrow(
        "STORE_LOCK_LOST",
      );
      expect(s.entries().length).toBe(before);
      expect(s.status).toBe("FAILED");
      expect(s.writable).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("inside a batch append() returns no entry (its committed hash exists only after the commit)", () => {
    vi.useRealTimers();
    const dir = tmpStore();
    try {
      const s = CanaryDurableStore.open(dir);
      const outside = s.append("USE", { line: "a" });
      expect(outside?.hash).toMatch(/^[0-9a-f]{64}$/);
      const inside: unknown[] = [];
      s.batch(() => {
        inside.push(s.append("USE", { line: "b" }));
        inside.push(s.append("USE", { line: "c" }));
      });
      expect(inside).toEqual([null, null]);
      const last = s.entries().slice(-2);
      expect(last.map((e) => (e.data as { line: string }).line)).toEqual([
        "b",
        "c",
      ]);
      expect(last.every((e) => /^[0-9a-f]{64}$/.test(e.hash) && e.n)).toBe(
        true,
      );
      s.close();
      expect(CanaryDurableStore.inspect(dir).status).toBe("READY");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------- G14 follow-up F3 / F4: what the panel says
describe("follow-up F3 / F4: the panel's completed label and allowance line follow the server's view", () => {
  it("only a RECONCILED, attention-free, durable record reads completed; the allowance state is always shown, never as zero when unknown", async () => {
    const { CanaryViewNotice, canaryShowsCompleted, canaryAttentionCodes } =
      await import("../../src/components/execution-review");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const t = (k: string, v?: Record<string, string | number>) =>
      `${k}${v ? JSON.stringify(v) : ""}`;
    const html = (view: Record<string, unknown>) =>
      renderToStaticMarkup(
        createElement(CanaryViewNotice, { view: view as never, t: t as never }),
      );
    const done = {
      state: "RECONCILED",
      label: "COMPLETED",
      completed: true,
      needsAttention: false,
      hashes: { approval: null, main: null },
      attempts: [],
      notes: [],
      allowance: { status: "ZERO", value: "0", block: "7" },
    };
    expect(canaryShowsCompleted(done as never)).toBe(true);
    expect(html(done)).toContain('data-completed="true"');
    expect(html(done)).toContain("g14.c.completed");
    // A server answer that says completed for another state, with attention, or not durable never reads completed.
    for (const [name, v] of [
      ["needs attention", { ...done, needsAttention: true }],
      ["not reconciled", { ...done, state: "SETTLED" }],
      ["unknown / needs attention state", { ...done, state: "UNCERTAIN" }],
      ["not durable", { ...done, notDurable: true }],
    ] as [string, Record<string, unknown>][]) {
      expect(canaryShowsCompleted(v as never), name).toBe(false);
      expect(html(v), name).toContain('data-completed="false"');
      expect(html(v), name).not.toContain("g14.c.completed");
    }
    // Review 7 R7-4 — TEST CONTRACT CHANGE: the allowance line states what the server READ for an ENDED record (two
    // operators, one block: its value and block), that it is unknown, or that it may stand while unread — each with
    // its own text, no raw code; a state no read stands behind, and an active record, show no allowance line.
    const ended = (
      status: string,
      value: string | null,
      block: string | null,
    ) =>
      html({
        ...done,
        state: "SOURCE_FAILED",
        terminal: true,
        completed: false,
        needsAttention: status !== "ZERO",
        allowance: { status, value, block },
      });
    const zero = ended("ZERO", "0", "7");
    expect(zero).toContain('data-testid="canary-allowance"');
    expect(zero).toContain('data-status="ZERO"');
    expect(zero).toContain(
      "g14.c.allowance{&quot;value&quot;:&quot;0&quot;,&quot;block&quot;:&quot;7&quot;}",
    );
    const nonzero = ended("NONZERO", "5000000", "9");
    expect(nonzero).toContain('data-status="NONZERO"');
    expect(nonzero).toContain(
      "g14.c.allowance{&quot;value&quot;:&quot;5000000&quot;,&quot;block&quot;:&quot;9&quot;}",
    );
    const unknown = ended("UNKNOWN", null, "9");
    expect(unknown).toContain('data-status="UNKNOWN"');
    expect(unknown).toContain("g14.c.allowanceUnknown");
    expect(unknown).not.toContain("g14.c.allowance{");
    const mayStand = ended("MAY_STAND_UNREAD", null, null);
    expect(mayStand).toContain('data-status="MAY_STAND_UNREAD"');
    expect(mayStand).toContain("g14.c.allowanceMayStand");
    for (const status of ["EXPECTED_ZERO_UNREAD", "NOT_READ"])
      expect(ended(status, null, null), status).not.toContain(
        'data-testid="canary-allowance"',
      );
    // A read without its value or block is no read: no line.
    expect(ended("ZERO", null, null)).not.toContain(
      'data-testid="canary-allowance"',
    );
    // An active record shows no allowance line, whatever it carries.
    expect(
      html({
        ...done,
        state: "APPROVAL_CONFIRMED",
        terminal: false,
        completed: false,
        allowance: { status: "NONZERO", value: "5000000", block: "9" },
      }),
    ).not.toContain('data-testid="canary-allowance"');
    // Review 10 R10-1: an UNCERTAIN record (not ended) shows the allowance the server read once its nonce moved.
    const uncertain = html({
      ...done,
      state: "UNCERTAIN",
      terminal: false,
      completed: false,
      needsAttention: true,
      allowance: { status: "NONZERO", value: "5000000", block: "9" },
    });
    expect(uncertain).toContain('data-testid="canary-allowance"');
    expect(uncertain).toContain('data-status="NONZERO"');
    // Review 11 R11-5: an UNCERTAIN record has not ended: no "not read yet after the end" text for it.
    expect(
      html({
        ...done,
        state: "UNCERTAIN",
        terminal: false,
        completed: false,
        needsAttention: true,
        allowance: { status: "MAY_STAND_UNREAD", value: null, block: null },
      }),
    ).not.toContain("g14.c.allowanceMayStand");
    const codes = (status: string) =>
      canaryAttentionCodes({
        ...done,
        state: "EXPIRED",
        completed: false,
        needsAttention: true,
        allowance: { status, value: null, block: null },
      } as never);
    expect(codes("UNKNOWN")).toContain("ALLOWANCE:UNKNOWN");
    expect(codes("NONZERO")).toContain("ALLOWANCE:NONZERO");
    expect(codes("MAY_STAND_UNREAD")).toContain("ALLOWANCE:MAY_STAND_UNREAD");
    expect(codes("ZERO").some((c) => c.startsWith("ALLOWANCE:"))).toBe(false);
  });
});
