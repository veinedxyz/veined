// G14 PROTECTED PROPOSAL (B1–B5) — integration tests of the POSITIVE paths, with FAKE dependencies only.
// SYNTHETIC_TEST_ONLY. The protected owner record is disarmed in the build; here the module's constant is replaced by
// a test double holding a made-up record for the synthetic account 0x3333…3333, so the real code paths that read the
// constant (firewall canary control, wallet adapter, submission boundary, canary gate) can be driven end to end.
// The wallet is an in-memory EIP-1193 double (no key, no signature), the "server" that confirms a prepared step is
// the real canary engine with an injected gate, a FAKE durable journal and fixture reads; the live application path
// stays CLOSED (the API still answers WRITE_DISABLED, the real canary gate still says CANARY_NOT_WIRED).
// Nothing here signs, sends or reaches a network; no value is an owner-approved amount, minimum, budget or deadline.
// Every test arms a record with its own approvalId (the submission boundary keys its single-use state by it).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// G14 follow-up F2: installed BEFORE the wallet adapter module is evaluated (the adapter captures the page's fetch).
import { legacyServer, pageServer } from "../fixtures/g14-closure/page-server";
import { NextRequest } from "next/server";
import { decodeFunctionData, encodeFunctionData, type Hex } from "viem";
import fx from "../fixtures/g14-canary-across.json" with { type: "json" };
import {
  BASE_A,
  BASE_B,
  BLOCK,
  DIAMOND,
  FEES,
  NOW,
  OTHER,
  QUOTED_AT,
  SYN,
  USDC_ARB,
  USDC_BASE,
  approveData,
  fakeWallet,
  forbiddenWalletCalls,
  pinReads,
  quote,
  simCalls,
  src,
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
vi.mock("../../src/execution/server/canary/pin-reads", () => ({
  cachedCanaryPins: vi.fn(async () => pinReads()),
}));
// TEST DOUBLE of the B1 provenance predicate. In the build it is true only for a quote the routing adapter read
// through its real upstream transport (the network). Here the quotes come from the real adapter over a FAKE provider
// read, so the test registers exactly those objects as "came from the adapter"; everything else stays false.
const adapterQuotes = vi.hoisted(() => new WeakSet<object>());
vi.mock("../../src/adapters/routing-core", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/adapters/routing-core")>();
  return {
    ...actual,
    isCanaryQuote: (q: unknown) =>
      typeof q === "object" &&
      q !== null &&
      (adapterQuotes.has(q) || actual.isCanaryQuote(q)),
  };
});

const { ACROSS_V4_ABI } =
  await import("../../src/execution/canary/across-decoder");
const { CANARY_PINS } = await import("../../src/execution/canary/pins");
const {
  canaryContractEntry,
  canaryFirewallDecision,
  assertNotKilled,
  killPolicy,
  contractRegistry,
  CANARY_PIN_SET_ID,
} = await import("../../src/security/firewall");
const { WalletProviderAdapter, obtainCanaryDispatchAuthority } =
  await import("../../src/features/wallet/adapter");
/** G14 follow-up F2: the stub page server of each step, by attempt (several steps may be in flight at once). */
const stepServers = new Map<string, ReturnType<typeof legacyServer>>();
const routeByAttempt = (body: Record<string, unknown>) => {
  const attempt =
    (body.attempt as string | undefined) ??
    ((body.ref as Record<string, string> | undefined)?.attempt as string);
  const server = stepServers.get(attempt);
  return server ? server(body) : legacyServer({})(body);
};
pageServer.handler = routeByAttempt;
beforeEach(() => {
  pageServer.handler = routeByAttempt;
});
const submission = await import("../../src/features/bridge/submission");
const { CANARY_WALLET_WAIT_MS, CANARY_CONFIRM_WAIT_MS } = submission;
// G14 closure TEST ADAPTER (TEST_CONTRACT_CHANGES_TR.md): the repaired submitCanary needs the server's full
// preparation (owner approvalId, attempt, quote expiry, prepared digest) and hands every persist call the attempt
// reference. These PP1 tests were written against the earlier shape; this adapter seals each legacy preparation the
// way the server runtime does (canaryPreparationDigest) and maps a "server returns the transaction" double onto the
// full preparation. Every assertion below is unchanged; the new fields are tested in tests/*/g14-closure.test.ts.
type RealPreparation =
  import("../../src/features/bridge/submission").CanaryPreparation;
type RealContext =
  import("../../src/features/bridge/submission").CanarySubmissionContext;
type CanaryPreparation = Omit<
  RealPreparation,
  "approvalId" | "attempt" | "quoteExpiresAt" | "digest"
> &
  Partial<
    Pick<
      RealPreparation,
      "approvalId" | "attempt" | "quoteExpiresAt" | "digest"
    >
  >;
interface CanarySubmissionContext {
  confirmPrepared: (p: {
    record: string;
    action: "APPROVE" | "SEND";
    review: string;
  }) => Promise<unknown>;
  gesture: { trusted: boolean; at: number };
  persistUnknown: () => unknown;
  persistHash: (hash: string, action: "APPROVE" | "SEND") => unknown;
  persistRejected: () => unknown;
  persistLateHash: (hash: string, action: "APPROVE" | "SEND") => unknown;
  persistNotRequested: () => unknown;
}
let attempts = 0;
const sealPreparation = (p: CanaryPreparation): RealPreparation => {
  // A deliberately malformed legacy step is handed over as it is (the boundary must refuse it).
  if (
    !p ||
    typeof p !== "object" ||
    !p.transaction ||
    typeof p.transaction !== "object"
  )
    return p as RealPreparation;
  const body = {
    action: p.action,
    record: p.record,
    review: p.review,
    transaction: p.transaction,
    expiresAt: p.expiresAt,
    approvalId:
      p.approvalId ??
      (armed.record as { approvalId?: string } | null)?.approvalId ??
      "0x" + "0".repeat(64),
    attempt: p.attempt ?? (++attempts).toString(16).padStart(32, "0"),
    // The quote ends with the authorization (inside the adapter's 65 s dispatch horizon, review 2 R3); the
    // authorization is checked first, so every legacy expiry case keeps its own reason.
    quoteExpiresAt: p.quoteExpiresAt ?? p.expiresAt,
  };
  return {
    ...body,
    digest: p.digest ?? submission.canaryPreparationDigest(body),
  } as RealPreparation;
};
const submitCanary = (
  a: Parameters<typeof submission.submitCanary>[0],
  p: CanaryPreparation,
  c: CanarySubmissionContext,
) => {
  const sealed = sealPreparation(p);
  const legacy = (c ?? {}) as Partial<CanarySubmissionContext>;
  const fn = <K extends keyof CanarySubmissionContext>(k: K) =>
    typeof legacy[k] === "function" ? legacy[k] : (undefined as never);
  // G14 follow-up F2: the server's confirmation and its durable "requested" record are asked by the wallet adapter
  // itself; the two legacy doubles become the answers of a stub page SERVER (fixtures/g14-closure/page-server.ts).
  // Review 1 F3: the product needs an explicit `true` as the server's confirmation. These legacy doubles stand for
  // a server that answers (they record and return nothing): an answer that is not a rejection, not `false` and not
  // a throw is mapped to `true` HERE, explicitly; the boundary itself accepts nothing but `true`.
  stepServers.set(
    (sealed as { attempt?: string })?.attempt ?? "",
    legacyServer({
      confirmPrepared:
        typeof legacy.confirmPrepared === "function"
          ? async (q) => {
              const answer = await legacy.confirmPrepared!({
                record: q.record,
                action: q.action,
                review: q.review,
              });
              return answer &&
                typeof answer === "object" &&
                !("transaction" in answer)
                ? { ...sealed, transaction: answer }
                : answer;
            }
          : undefined,
      persistUnknown:
        fn("persistUnknown") &&
        (() =>
          Promise.resolve(legacy.persistUnknown!()).then((v) => v !== false)),
    }),
  );
  pageServer.handler = routeByAttempt;
  const context = {
    session: "e".repeat(64),
    gesture: legacy.gesture,
    // G14 follow-up F4: `recorded` needs the server's explicit `true` — mapped here the same way.
    persistHash:
      fn("persistHash") &&
      ((h: string, act: "APPROVE" | "SEND") =>
        Promise.resolve(legacy.persistHash!(h, act)).then((v) => v !== false)),
    persistRejected: fn("persistRejected") && (() => legacy.persistRejected!()),
    persistLateHash:
      fn("persistLateHash") &&
      ((h: string, act: "APPROVE" | "SEND") => legacy.persistLateHash!(h, act)),
    persistNotRequested:
      fn("persistNotRequested") &&
      (() =>
        Promise.resolve(legacy.persistNotRequested!()).then(
          (v) => v !== false,
        )),
  } as unknown as RealContext;
  return submission.submitCanary(a, sealed, context);
};
const { CANARY_RPC_POOL } = await import("../../src/swap/server/config");
const { canaryGateState, executionGateState } =
  await import("../../src/execution/server/gate");
const { CanaryEngine, MemoryUseJournal } =
  await import("../../src/execution/server/canary/engine");
const { CanaryAuthorizationStore } =
  await import("../../src/execution/server/canary/authorization-store");
const { ReviewAttestor } =
  await import("../../src/execution/server/canary/attestation");
const { AuditAnchorLog } =
  await import("../../src/execution/server/canary/audit-anchor");
const { RoutingCore } = await import("../../src/adapters/routing-core");
const { GET, POST } = await import("../../src/app/api/execution/route");
const { setAppLimiterForTests } = await import("../../src/server/api-guard");
const { MemoryRateLimiter } = await import("../../src/server/rate-limit");
type CanaryReviewInput =
  import("../../src/execution/server/canary/engine").CanaryReviewInput;
type CanaryGateFacts =
  import("../../src/execution/server/gate").CanaryGateFacts;
type SimulationRequest =
  import("../../src/execution/canary/simulation").SimulationRequest;
type CanaryFirewallInput =
  import("../../src/security/firewall").CanaryFirewallInput;
type ExecutableQuote =
  import("../../src/execution/canary/quote-verify").ExecutableQuote;

let approvals = 0;
/** Arms the TEST DOUBLE with a fresh made-up record (its own approvalId). */
const rearm = (over: Parameters<typeof syntheticApproval>[0] = {}) => {
  armed.record = syntheticApproval({
    approvalId: "0x" + (++approvals).toString(16).padStart(64, "0"),
    ...over,
  });
};
beforeEach(() => {
  rearm();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  setAppLimiterForTests(new MemoryRateLimiter());
});
afterEach(() => {
  armed.record = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setAppLimiterForTests(undefined);
});

const H = (n: number) => "0x" + n.toString(16).padStart(64, "0");
const hex = (x: string | bigint | number) => "0x" + BigInt(x).toString(16);
type AcrossArgs = [
  Record<string, unknown>,
  Record<string, unknown>[],
  Record<string, unknown>,
];
/** Re-encodes the real call with one field changed (canonical calldata: only a semantic check can catch it). */
function mutate(f: (args: AcrossArgs) => void): string {
  const d = decodeFunctionData({
    abi: ACROSS_V4_ABI,
    data: fx.transactionRequest.data as Hex,
  });
  const args = structuredClone(d.args) as unknown as AcrossArgs;
  f(args);
  return encodeFunctionData({
    abi: ACROSS_V4_ABI,
    functionName: "swapAndStartBridgeTokensViaAcrossV4",
    args: args as never,
  });
}
const b32 = (address: string) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");

// ------------------------------------------------------------------------------------------------ B2 firewall
const sendGas = {
  remaining: [
    { action: "SEND" as const, gasLimit: "670622", maxFeePerGas: "10000000" },
  ],
  spentWei: "0",
  l1FeeWei: "1000",
};
const approveGas = {
  remaining: [
    { action: "APPROVE" as const, gasLimit: "66524", maxFeePerGas: "10000000" },
    ...sendGas.remaining,
  ],
  spentWei: "0",
  l1FeeWei: "1000",
};
const fresh = { durable: true, approveConsumed: false, sendConsumed: false };
const pins = (over: Record<string, unknown> = {}) => ({
  set: CANARY_PIN_SET_ID,
  runtimeHash: canaryContractEntry.runtimeHash,
  implementationHash: canaryContractEntry.implementationHash,
  block: "56427300",
  observedAt: NOW - 1000,
  twoOperatorsAgree: true,
  ...over,
});
const sendInput = (
  over: Partial<CanaryFirewallInput> = {},
  tx: Record<string, string> = {},
): CanaryFirewallInput => ({
  now: NOW,
  action: "SEND",
  transaction: {
    chainId: "8453",
    from: SYN,
    to: DIAMOND,
    value: "0",
    data: fx.transactionRequest.data,
    ...tx,
  },
  pins: pins(),
  wallet: { account: SYN, chainId: "8453" },
  expectedOut: "4979689",
  gas: sendGas,
  use: fresh,
  ...over,
});
const approveInput = (
  over: Partial<CanaryFirewallInput> = {},
  tx: Record<string, string> = {},
): CanaryFirewallInput =>
  sendInput(
    { action: "APPROVE", gas: approveGas, ...over },
    { to: USDC_BASE, data: approveData(), ...tx },
  );

describe("B2 (armed test double): the narrow canary control", () => {
  it("allows exactly the record's approve and send, and lifts nothing else", () => {
    expect(canaryFirewallDecision(approveInput())).toMatchObject({
      decision: "CANARY_EXCEPTION",
      reasons: [],
    });
    expect(canaryFirewallDecision(sendInput())).toMatchObject({
      decision: "CANARY_EXCEPTION",
      reasons: [],
    });
    // The general firewall is exactly as closed as before: empty registry, global kill, entry paused.
    expect(contractRegistry).toEqual([]);
    expect(killPolicy.global).toBe(true);
    expect(() => assertNotKilled(canaryContractEntry, killPolicy)).toThrow(
      "EXECUTION_PAUSED",
    );
    expect(executionGateState("8453").open).toBe(false);
  });
  it("denies a wrong chain, token, spender, target, selector, pin, owner, amount, time or use state", () => {
    const start = "0xa1f1ce43" + fx.transactionRequest.data.slice(10);
    const everyToken = mutate((a) => {
      a[0].sendingAssetId = OTHER;
      a[1][0].sendingAssetId = OTHER;
      a[1][0].receivingAssetId = OTHER;
      a[2].sendingAssetId = b32(OTHER);
    });
    const cases: [string, CanaryFirewallInput, string][] = [
      ["chain", sendInput({}, { chainId: "1" }), "WRONG_CHAIN"],
      [
        "wallet on Linea",
        sendInput({ wallet: { account: SYN, chainId: "59144" } }),
        "OWNER_APPROVAL:WRONG_CHAIN",
      ],
      [
        "token: approve on another token",
        approveInput({}, { to: OTHER }),
        "NOT_AN_EXACT_APPROVAL",
      ],
      [
        "token: the call sends another token",
        sendInput({}, { data: mutate((a) => (a[0].sendingAssetId = OTHER)) }),
        "TOKEN_INCONSISTENT",
      ],
      [
        "token: every token field is another token",
        sendInput({}, { data: everyToken }),
        "OWNER_APPROVAL:TOKEN_MISMATCH",
      ],
      [
        "spender",
        approveInput({}, { data: approveData(OTHER) }),
        "NOT_AN_EXACT_APPROVAL",
      ],
      ["target", sendInput({}, { to: OTHER }), "REGISTRY_MISMATCH"],
      ["selector: start", sendInput({}, { data: start }), "REGISTRY_MISMATCH"],
      [
        "selector: transfer() on USDC",
        approveInput({}, { data: "0xa9059cbb" + approveData().slice(10) }),
        "NOT_AN_EXACT_APPROVAL",
      ],
      [
        "selector: transferFrom() on USDC",
        approveInput(
          {},
          { data: "0x23b872dd" + approveData().slice(10) + "0".repeat(64) },
        ),
        "NOT_AN_EXACT_APPROVAL",
      ],
      [
        "pin: Diamond code changed",
        sendInput({ pins: pins({ runtimeHash: "0x" + "1".repeat(64) }) }),
        "PIN_MISMATCH",
      ],
      [
        "pin: facet changed",
        sendInput({
          pins: pins({ implementationHash: "0x" + "2".repeat(64) }),
        }),
        "PIN_MISMATCH",
      ],
      [
        "pin: unreadable",
        sendInput({ pins: pins({ runtimeHash: null }) }),
        "PIN_MISMATCH",
      ],
      [
        "pin: the old set",
        sendInput({ pins: pins({ set: "g14-canary-pins.2026-11-12.1" }) }),
        "PIN_SET_MISMATCH",
      ],
      [
        "pin: one operator",
        sendInput({ pins: pins({ twoOperatorsAgree: false }) }),
        "PIN_SOURCES_NOT_AGREED",
      ],
      [
        "pin: agreement unknown",
        sendInput({ pins: pins({ twoOperatorsAgree: null }) }),
        "PIN_SOURCES_NOT_AGREED",
      ],
      [
        "pin: stale evidence",
        sendInput({ pins: pins({ observedAt: NOW - 61_000 }) }),
        "PIN_EVIDENCE_STALE",
      ],
      [
        "pin: evidence from the future",
        sendInput({ pins: pins({ observedAt: NOW + 1 }) }),
        "PIN_EVIDENCE_STALE",
      ],
      [
        "pin: block before the verified one",
        sendInput({ pins: pins({ block: "56427246" }) }),
        "PIN_BLOCK_INVALID",
      ],
      ["pin: no evidence", sendInput({ pins: null }), "PIN_EVIDENCE_MISSING"],
      [
        "owner: another sender",
        sendInput({}, { from: OTHER }),
        "RECIPIENT_NOT_SENDER",
      ],
      [
        "owner: wallet is another account",
        sendInput({ wallet: { account: OTHER, chainId: "8453" } }),
        "OWNER_APPROVAL:ACCOUNT_MISMATCH",
      ],
      [
        "owner: wallet not proven",
        sendInput({ wallet: { account: null, chainId: null } }),
        "OWNER_APPROVAL:ACCOUNT_MISMATCH",
      ],
      [
        "recipient is not the sender",
        sendInput({}, { data: mutate((a) => (a[0].receiver = OTHER)) }),
        "RECIPIENT_NOT_SENDER",
      ],
      [
        "Across recipient is not the sender",
        sendInput(
          {},
          { data: mutate((a) => (a[2].receiverAddress = b32(OTHER))) },
        ),
        "RECIPIENT_NOT_SENDER",
      ],
      [
        "refund is not the sender",
        sendInput(
          {},
          { data: mutate((a) => (a[2].refundAddress = b32(OTHER))) },
        ),
        "RECIPIENT_NOT_SENDER",
      ],
      [
        "another destination chain",
        sendInput({}, { data: mutate((a) => (a[0].destinationChainId = 10n)) }),
        "DESTINATION_MISMATCH",
      ],
      [
        "another destination token",
        sendInput(
          {},
          { data: mutate((a) => (a[2].receivingAssetId = b32(OTHER))) },
        ),
        "DESTINATION_MISMATCH",
      ],
      [
        "a destination call",
        sendInput(
          {},
          { data: mutate((a) => (a[0].hasDestinationCall = true)) },
        ),
        "DESTINATION_CALL",
      ],
      [
        "a destination message",
        sendInput({}, { data: mutate((a) => (a[2].message = "0x01")) }),
        "DESTINATION_CALL",
      ],
      [
        "amount: approve one unit more",
        approveInput({}, { data: approveData(DIAMOND, 5_000_001n) }),
        "OWNER_APPROVAL:AMOUNT_NOT_EXACT",
      ],
      [
        "amount: unlimited approve",
        approveInput({}, { data: approveData(DIAMOND, 2n ** 256n - 1n) }),
        "OWNER_APPROVAL:AMOUNT_NOT_EXACT",
      ],
      [
        "amount: the call pulls less",
        sendInput(
          {},
          { data: mutate((a) => (a[1][0].fromAmount = 4_000_000n)) },
        ),
        "OWNER_APPROVAL:AMOUNT_NOT_EXACT",
      ],
      [
        "output: not the reviewed one",
        sendInput({ expectedOut: "4979690" }),
        "OUTPUT_NOT_REVIEWED",
      ],
      [
        "output: the calldata delivers less than was reviewed",
        sendInput(
          {},
          {
            data: mutate(
              (a) => (a[2].outputAmountMultiplier = 980_000_000_000_000_000n),
            ),
          },
        ),
        "OUTPUT_NOT_REVIEWED",
      ],
      [
        "review 2 G1: almost everything diverted to the source step",
        sendInput(
          { expectedOut: "4900000" },
          {
            data: mutate((a) => {
              a[0].minAmount = 1n;
              a[2].outputAmountMultiplier = 4_900_000n * 10n ** 18n;
            }),
          },
        ),
        "BRIDGED_BELOW_OWNER_MINIMUM",
      ],
      [
        "review 2 G1: a multiplier above 1:1",
        sendInput(
          {},
          {
            data: mutate(
              (a) => (a[2].outputAmountMultiplier = 1_000_000_000_000_000_001n),
            ),
          },
        ),
        "MULTIPLIER_OUT_OF_BOUNDS",
      ],
      [
        "review 2 G1: the source step calls another contract",
        sendInput({}, { data: mutate((a) => (a[1][0].callTo = OTHER)) }),
        "SOURCE_STEP_NOT_PINNED_FEE",
      ],
      [
        "review 2 G1: the source step carries another call",
        sendInput(
          {},
          { data: mutate((a) => (a[1][0].callData = "0xdeadbeef")) },
        ),
        "SOURCE_STEP_NOT_PINNED_FEE",
      ],
      ["native value", sendInput({}, { value: "1" }), "NATIVE_VALUE_NOT_ZERO"],
      [
        "calldata not readable",
        sendInput({}, { data: "0x1794958f" + "0".repeat(64 * 40) }),
        "CALLDATA_NOT_READABLE",
      ],
      [
        "two source steps",
        sendInput(
          {},
          { data: mutate((a) => a[1].push(structuredClone(a[1][0]))) },
        ),
        "CALLDATA_NOT_READABLE",
      ],
      [
        "time: after the deadline",
        sendInput({
          now: QUOTED_AT + 3_600_000,
          pins: pins({ observedAt: QUOTED_AT + 3_599_000 }),
        }),
        "OWNER_APPROVAL:APPROVAL_EXPIRED",
      ],
      [
        "time: before the window",
        sendInput({
          now: QUOTED_AT - 61_000,
          pins: pins({ observedAt: QUOTED_AT - 62_000 }),
        }),
        "OWNER_APPROVAL:APPROVAL_NOT_YET_VALID",
      ],
      [
        "use: already sent",
        sendInput({
          use: { durable: true, approveConsumed: true, sendConsumed: true },
        }),
        "OWNER_APPROVAL:CANARY_ALREADY_SENT",
      ],
      [
        "use: approval already used",
        approveInput({
          use: { durable: true, approveConsumed: true, sendConsumed: false },
        }),
        "OWNER_APPROVAL:APPROVAL_ALREADY_USED",
      ],
      [
        "use: no durable store",
        sendInput({ use: null }),
        "OWNER_APPROVAL:USE_STORE_UNPROVEN",
      ],
      [
        "use: memory only",
        sendInput({ use: { ...fresh, durable: false } }),
        "OWNER_APPROVAL:USE_STORE_UNPROVEN",
      ],
      [
        "gas: not proven",
        sendInput({ gas: null }),
        "OWNER_APPROVAL:GAS_BUDGET_UNPROVEN",
      ],
      [
        "gas: above the budget",
        sendInput({ gas: { ...sendGas, l1FeeWei: "9000000000000" } }),
        "OWNER_APPROVAL:GAS_BUDGET_EXCEEDED",
      ],
      [
        "malformed transaction",
        sendInput({ transaction: { chainId: "8453" } as never }),
        "TRANSACTION_MALFORMED",
      ],
      [
        "unknown action",
        sendInput({ action: "REVOKE" as "SEND" }),
        "ACTION_UNKNOWN",
      ],
    ];
    for (const [name, input, reason] of cases) {
      const d = canaryFirewallDecision(input);
      expect(d.decision, name).toBe("DENIED");
      expect(d.reasons, name).toContain(reason);
    }
  });
  it("the owner's minimum binds the output read from the calldata; the record's own state decides", () => {
    // The real calldata delivers 4,979,689: a record asking for one unit more denies it.
    rearm({ minimumOut: "4979690" });
    expect(canaryFirewallDecision(sendInput()).reasons).toEqual([
      "OWNER_APPROVAL:OUTPUT_BELOW_OWNER_MINIMUM",
    ]);
    rearm({ minimumOut: "4979689" });
    expect(canaryFirewallDecision(sendInput()).decision).toBe(
      "CANARY_EXCEPTION",
    );
    // 4.887 USDC is inside the scope's 300 bps bound and is still refused by the 4.90 record, even if a caller
    // claims it is "the reviewed output".
    rearm();
    const low = mutate(
      (a) => (a[2].outputAmountMultiplier = 980_000_000_000_000_000n),
    );
    expect(
      canaryFirewallDecision(
        sendInput({ expectedOut: "4887750" }, { data: low }),
      ).reasons,
    ).toEqual(["OWNER_APPROVAL:OUTPUT_BELOW_OWNER_MINIMUM"]);
    rearm({ account: OTHER });
    expect(canaryFirewallDecision(sendInput()).reasons).toContain(
      "OWNER_APPROVAL:ACCOUNT_MISMATCH",
    );
    armed.record = { ...syntheticApproval(), armed: true };
    expect(canaryFirewallDecision(sendInput()).reasons).toEqual([
      "OWNER_APPROVAL:RECORD_SHAPE",
    ]);
    armed.record = null;
    expect(canaryFirewallDecision(sendInput()).reasons).toEqual([
      "OWNER_APPROVAL:NO_OWNER_APPROVED_CANARY",
    ]);
  });
});

// --------------------------------------------------------------------------------------------- B3 the adapter
const approveRequest = (over: Record<string, string> = {}) => ({
  chainId: "0x2105",
  from: SYN,
  to: USDC_BASE,
  value: "0x0",
  data: approveData(),
  gas: "0x6270",
  maxFeePerGas: "0x989680",
  maxPriorityFeePerGas: "0xf4240",
  ...over,
});
const mainRequest = (over: Record<string, string> = {}) =>
  approveRequest({
    to: DIAMOND,
    data: fx.transactionRequest.data,
    gas: "0xa3b9e",
    ...over,
  });
const adapterOn = (p = fakeWallet()) => ({
  p,
  a: new WalletProviderAdapter(p, { address: SYN, chainId: 8453, epoch: 1 }),
});
// G14 closure TEST ADAPTER: the canary gate needs the prepared step's dispatch limits (PP1-AUDIT-01); these are the
// limits the submission boundary would pass for a step that is alive (record window, authorization, quote, gesture).
const canary = { gate: "veined-owner-canary" } as const;
const canaryFor = (tx: Record<string, string | undefined>) => ({
  gate: "veined-owner-canary" as const,
  canary: {
    limits: {
      approvalId:
        (armed.record as { approvalId?: string } | null)?.approvalId ??
        "0x" + "0".repeat(64),
      action:
        (tx.to ?? "").toLowerCase() === USDC_BASE.toLowerCase()
          ? ("APPROVE" as const)
          : ("SEND" as const),
      record: "canary-adapter-test",
      review: "c".repeat(64),
      attempt: "a".repeat(32),
      authorizationExpiresAt: Date.now() + 40_000,
      quoteExpiresAt: Date.now() + 60_000,
      gesture: { trusted: true, at: Date.now() },
    },
  },
});
// Review 1 F4: the limits carry the prepared digest of exactly this transaction (computed as the server does).
const canaryForSealed = (tx: Record<string, string | undefined>) => {
  const c = canaryFor(tx);
  const l = c.canary.limits;
  return {
    ...c,
    canary: {
      limits: {
        ...l,
        preparedDigest: submission.canaryPreparationDigest({
          action: l.action,
          record: l.record,
          review: l.review,
          transaction: tx as never,
          expiresAt: l.authorizationExpiresAt,
          approvalId: l.approvalId,
          attempt: l.attempt,
          quoteExpiresAt: l.quoteExpiresAt,
        }),
      },
    },
  };
};
/**
 * G14 follow-up F2 TEST ADAPTER: the adapter accepts no limits from a caller; it mints a dispatch authority from the
 * server's own answers. A stub page server confirms exactly the step `canaryForSealed` describes (one attempt per
 * call, answered by attempt) and commits its "requested" record; the authority is minted for THIS adapter.
 */
const sealedSteps = new Map<string, unknown>();
let sealedAttempts = 0;
const authorityOf = async (
  a: InstanceType<typeof WalletProviderAdapter>,
  tx: Record<string, string | undefined>,
) => {
  const l = canaryForSealed(tx).canary.limits;
  const attempt = (++sealedAttempts).toString(16).padStart(32, "b");
  const step = {
    action: l.action,
    record: l.record,
    review: l.review,
    transaction: tx,
    expiresAt: l.authorizationExpiresAt,
    approvalId: l.approvalId,
    attempt,
    quoteExpiresAt: l.quoteExpiresAt,
  };
  const digest = submission.canaryPreparationDigest(step as never);
  sealedSteps.set(attempt, { ...step, digest });
  stepServers.set(
    attempt,
    legacyServer({
      confirmPrepared: (q) => sealedSteps.get(q.attempt) ?? null,
      persistUnknown: () => true,
    }),
  );
  pageServer.handler = routeByAttempt;
  const got = await obtainCanaryDispatchAuthority(a, {
    session: "e".repeat(64),
    review: l.review,
    ref: {
      record: l.record,
      action: l.action,
      attempt,
      digest,
      request: "f".repeat(32),
    },
    gesture: l.gesture,
  });
  return {
    gate: "veined-owner-canary" as const,
    canary: { authority: (got.ok ? got.authority : undefined) as object },
  };
};
const withoutGas = (r: Record<string, string>) =>
  Object.fromEntries(Object.entries(r).filter(([k]) => k !== "gas"));
const HASH_AB = "0x" + "ab".repeat(32);
const send = async (
  a: InstanceType<typeof WalletProviderAdapter>,
  tx: Record<string, string>,
) => a.sendCanonicalTransaction(tx, { ...tx }, await authorityOf(a, tx));

describe("B3 (armed test double): the single financial primitive with a fake EIP-1193 wallet", () => {
  it("hands the wallet exactly the exact approval and exactly the main request", async () => {
    const { a, p } = adapterOn();
    const approve = approveRequest();
    await expect(send(a, approve)).resolves.toBe(HASH_AB);
    const main = mainRequest();
    await expect(send(a, main)).resolves.toBe(HASH_AB);
    const sends = p.calls.filter((c) => c.method === "eth_sendTransaction");
    expect(sends).toEqual([
      { method: "eth_sendTransaction", params: [approve] },
      { method: "eth_sendTransaction", params: [main] },
    ]);
    expect(Object.isFrozen((sends[0].params as unknown[])[0])).toBe(true);
    // Besides the two sends the wallet only saw identity reads: no switch, add, signature or raw send.
    expect([...new Set(p.calls.map((c) => c.method))].sort()).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_sendTransaction",
    ]);
    expect(forbiddenWalletCalls(p.calls)).toEqual([]);
  });
  it("refuses any tampered field before the wallet is asked", async () => {
    const good = mainRequest();
    const both = (r: Record<string, string>) => [r, { ...r }] as const;
    const startCall = mainRequest({
      data: "0xa1f1ce43" + good.data.slice(10),
    });
    const cases: [
      string,
      Record<string, string>,
      Record<string, string>,
      string,
      string?,
    ][] = [
      [
        "page copy differs from the canonical: data",
        good,
        { ...good, data: good.data + "00" },
        "CANONICAL_TX_MISMATCH",
      ],
      [
        "page copy differs: target",
        good,
        { ...good, to: OTHER },
        "CANONICAL_TX_MISMATCH",
      ],
      [
        "page copy differs: gas",
        good,
        { ...good, gas: "0xa3b9f" },
        "CANONICAL_TX_MISMATCH",
      ],
      [
        "page copy has an extra field",
        good,
        { ...good, nonce: "0x1" },
        "CANONICAL_TX_MISMATCH",
      ],
      [
        "both name another target",
        ...both({ ...good, to: OTHER }),
        "CANARY_REQUEST_REFUSED",
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "both use the start selector",
        ...both(startCall),
        "CANARY_REQUEST_REFUSED",
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "both carry native value",
        ...both({ ...good, value: "0x1" }),
        "CANARY_REQUEST_REFUSED",
        "NATIVE_VALUE_NOT_ZERO",
      ],
      [
        "both approve another spender",
        ...both(approveRequest({ data: approveData(OTHER) })),
        "CANARY_REQUEST_REFUSED",
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "both approve more",
        ...both(approveRequest({ data: approveData(DIAMOND, 5_000_001n) })),
        "CANARY_REQUEST_REFUSED",
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "both raise the fee cap past the budget",
        ...both({ ...good, maxFeePerGas: "0x5f5e100" }),
        "CANARY_REQUEST_REFUSED",
        "GAS_BUDGET_EXCEEDED",
      ],
      [
        "both drop the gas limit",
        ...both(withoutGas(good)),
        "CANARY_REQUEST_REFUSED",
        "GAS_FIELDS_REQUIRED",
      ],
      [
        "another sender",
        ...both({ ...good, from: OTHER }),
        "WALLET_ACCOUNT_MISMATCH",
      ],
      [
        "another chain",
        ...both({ ...good, chainId: "0x1" }),
        "WALLET_CHAIN_MISMATCH",
      ],
    ];
    for (const [name, canonical, request, code, reason] of cases) {
      const { a, p } = adapterOn();
      const e = await a
        .sendCanonicalTransaction(
          canonical,
          request,
          await authorityOf(a, canonical),
        )
        .catch((x: unknown) => x);
      expect(e, name).toMatchObject({
        code,
        beforeWalletRequest: true,
        ...(reason ? { reason } : {}),
      });
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
    // Without a gate, or with an invented one, nothing is sent either.
    const { a, p } = adapterOn();
    for (const gate of [undefined, "", "canary", "veined-owner-canary "])
      await expect(
        a.sendCanonicalTransaction(
          good,
          { ...good },
          { gate: gate as "veined-owner-canary" },
        ),
      ).rejects.toThrow("EXECUTION_GATE_REQUIRED");
    expect(p.calls).toEqual([]);
  });
  it("review 1 F4: the gate name with a page-built pinned-selector call is refused at the adapter itself", async () => {
    // Even with a valid record, the canary gate name and a call of the pinned selector on the pinned target are
    // not enough: the call's own arguments must be the record's transfer.
    const built: [string, string, string][] = [
      [
        "arbitrary argument words",
        "0x1794958f" + OTHER.slice(2).padStart(64, "0").repeat(30),
        "SEND_CALLDATA_UNREADABLE",
      ],
      [
        "the real call paying another account",
        mutate((a) => {
          a[0].receiver = OTHER;
          a[2].receiverAddress = b32(OTHER);
        }),
        "SEND_RECEIVER_NOT_OWNER",
      ],
      [
        "the real call refunding another account",
        mutate((a) => (a[2].refundAddress = b32(OTHER))),
        "SEND_REFUND_NOT_OWNER",
      ],
      [
        "the real call to another chain",
        mutate((a) => (a[0].destinationChainId = 1n)),
        "SEND_DESTINATION_MISMATCH",
      ],
      [
        "the real call with a destination message",
        mutate((a) => (a[2].message = "0xdeadbeef")),
        "SEND_DESTINATION_CALL",
      ],
      [
        "the real call pulling another amount",
        mutate((a) => (a[1][0].fromAmount = 1_000_000n)),
        "SEND_AMOUNT_NOT_EXACT",
      ],
      [
        "the real call delivering below the owner's minimum",
        mutate((a) => (a[2].outputAmountMultiplier = 970_000_000_000_000_000n)),
        "SEND_OUTPUT_BELOW_OWNER_MINIMUM",
      ],
      [
        "the real call sending another token",
        mutate((a) => (a[0].sendingAssetId = OTHER)),
        "SEND_TOKEN_MISMATCH",
      ],
      // review 2 G1 (the reviewer's repro): one unit bridged, 4,999,999 kept by the step, multiplier 4.9e24.
      [
        "almost everything diverted to the source step",
        mutate((a) => {
          a[0].minAmount = 1n;
          a[2].outputAmountMultiplier = 4_900_000n * 10n ** 18n;
        }),
        "SEND_BRIDGED_BELOW_OWNER_MINIMUM",
      ],
      [
        "a source step calling an arbitrary contract",
        mutate((a) => {
          a[1][0].callTo = OTHER;
          a[1][0].callData = "0xdeadbeef";
        }),
        "SEND_STEP_NOT_PINNED_FEE",
      ],
    ];
    for (const [name, data, reason] of built) {
      const { a, p } = adapterOn();
      const e = await send(a, mainRequest({ data })).catch((x: unknown) => x);
      expect(e, name).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason,
        beforeWalletRequest: true,
      });
      expect(p.calls, name).toEqual([]);
    }
  });
  it("an account or network change is refused, never repaired by a silent switch", async () => {
    const good = mainRequest();
    const changedAccount = adapterOn();
    changedAccount.p.set({ account: OTHER });
    await expect(send(changedAccount.a, good)).rejects.toMatchObject({
      code: "IDENTITY_CHANGED",
      beforeWalletRequest: true,
    });
    const onLinea = adapterOn();
    onLinea.p.set({ chain: "0xe708" });
    await expect(send(onLinea.a, good)).rejects.toMatchObject({
      code: "WALLET_CHAIN_MISMATCH",
      beforeWalletRequest: true,
    });
    // An adapter bound to another chain cannot send a Base canary; a canary cannot be sent on another chain.
    const bsc = new WalletProviderAdapter(fakeWallet({ chain: "0x38" }), {
      address: SYN,
      chainId: 56,
      epoch: 1,
    });
    await expect(send(bsc, good)).rejects.toThrow("WALLET_CHAIN_MISMATCH");
    await expect(send(bsc, { ...good, chainId: "0x38" })).rejects.toMatchObject(
      {
        code: "CANARY_REQUEST_REFUSED",
        reason: "WRONG_CHAIN",
      },
    );
    for (const p of [changedAccount.p, onLinea.p]) {
      expect(p.count("eth_sendTransaction")).toBe(0);
      expect(p.count("wallet_switchEthereumChain")).toBe(0);
      expect(forbiddenWalletCalls(p.calls)).toEqual([]);
    }
    const revoked = adapterOn();
    revoked.a.revoke();
    await expect(send(revoked.a, good)).rejects.toThrow("WALLET_SESSION_STALE");
  });
  it("the explicit switch to the source network is a separate action, Base only, with a valid record only", async () => {
    const { a, p } = adapterOn(fakeWallet({ chain: "0xe708" }));
    for (const id of [1, 56, 612055, 42161, 59144])
      await expect(a.switchChain(id, canary)).rejects.toThrow(
        "WALLET_CHAIN_NOT_TRUSTED",
      );
    await expect(a.switchChain(8453)).rejects.toThrow(
      "WALLET_CHAIN_NOT_TRUSTED",
    );
    await expect(a.addChain(8453)).rejects.toThrow("WALLET_CHAIN_NOT_TRUSTED");
    expect(p.calls).toEqual([]);
    await a.switchChain(8453, canary);
    expect(p.calls).toEqual([
      { method: "wallet_switchEthereumChain", params: [{ chainId: "0x2105" }] },
    ]);
    expect(forbiddenWalletCalls(p.calls)).toEqual([]);
    // A malformed or missing record: not even the switch request is made.
    armed.record = { ...syntheticApproval(), extra: 1 };
    await expect(a.switchChain(8453, canary)).rejects.toThrow(
      "WALLET_CHAIN_NOT_TRUSTED",
    );
    armed.record = null;
    await expect(a.switchChain(8453, canary)).rejects.toThrow(
      "WALLET_CHAIN_NOT_TRUSTED",
    );
    expect(p.count("wallet_switchEthereumChain")).toBe(1);
  });
  it("after the deadline the same exact request is refused", async () => {
    const { a, p } = adapterOn();
    vi.setSystemTime(QUOTED_AT + 3_600_000);
    await expect(send(a, mainRequest())).rejects.toMatchObject({
      code: "CANARY_REQUEST_REFUSED",
      reason: "APPROVAL_EXPIRED",
    });
    expect(p.calls).toEqual([]);
  });
  it("one request per wallet: a second call while one is open, or after an unclear answer, is refused", async () => {
    let release: (v: unknown) => void = () => {};
    const p = fakeWallet({ send: () => new Promise((r) => (release = r)) });
    const { a } = adapterOn(p);
    const approve = approveRequest();
    const first = send(a, approve);
    const second = await send(a, approve).catch((e: unknown) => e);
    expect(second).toMatchObject({
      code: "WALLET_REQUEST_PENDING",
      beforeWalletRequest: true,
    });
    // Another adapter on the same wallet is blocked as well.
    const other = adapterOn(p);
    await expect(send(other.a, approve)).rejects.toThrow(
      "WALLET_REQUEST_PENDING",
    );
    await vi.waitFor(() => expect(p.count("eth_sendTransaction")).toBe(1));
    release("0x" + "cd".repeat(32));
    await expect(first).resolves.toBe("0x" + "cd".repeat(32));
    expect(p.count("eth_sendTransaction")).toBe(1);
    // A provider error that is not a rejection leaves the wallet uncertain: no second financial request.
    const broken = adapterOn(
      fakeWallet({
        send: () => {
          throw Object.assign(new Error("timeout"), { code: -32603 });
        },
      }),
    );
    await expect(send(broken.a, approve)).rejects.toMatchObject({
      code: -32603,
    });
    await expect(send(broken.a, approve)).rejects.toThrow(
      "WALLET_REQUEST_UNCERTAIN",
    );
    expect(broken.p.count("eth_sendTransaction")).toBe(1);
    // review 1 F1: under the canary gate an answer that is not a transaction hash is unclear too.
    for (const answer of ["0x1234", null, { hash: HASH_AB }, ""]) {
      const odd = adapterOn(fakeWallet({ send: () => answer }));
      await expect(send(odd.a, approve)).resolves.toBe(answer);
      await expect(send(odd.a, approve)).rejects.toThrow(
        "WALLET_REQUEST_UNCERTAIN",
      );
      await expect(send(odd.a, mainRequest())).rejects.toThrow(
        "WALLET_REQUEST_UNCERTAIN",
      );
      expect(odd.p.count("eth_sendTransaction")).toBe(1);
    }
    // A definitive user rejection does not block a later request.
    let reject = true;
    const picky = adapterOn(
      fakeWallet({
        send: () => {
          if (reject)
            throw Object.assign(new Error("rejected"), { code: 4001 });
          return "0x" + "ef".repeat(32);
        },
      }),
    );
    await expect(send(picky.a, approve)).rejects.toMatchObject({ code: 4001 });
    reject = false;
    await expect(send(picky.a, approve)).resolves.toBe("0x" + "ef".repeat(32));
  });
});

// ------------------------------------------------------------------------------------- B3 the submission boundary
let serial = 0;
const prep = (
  action: "APPROVE" | "SEND" = "APPROVE",
  over: Partial<CanaryPreparation> = {},
): CanaryPreparation => ({
  action,
  record: `canary-sub-${++serial}`,
  review: "c".repeat(64),
  transaction: action === "APPROVE" ? approveRequest() : mainRequest(),
  expiresAt: Date.now() + 40_000,
  ...over,
});
const ctx = (
  p: CanaryPreparation,
  over: Partial<CanarySubmissionContext> = {},
) => {
  const log: string[] = [];
  const context: CanarySubmissionContext = {
    confirmPrepared: vi.fn(async () => ({ ...p.transaction })),
    gesture: { trusted: true, at: Date.now() - 500 },
    persistUnknown: () => void log.push("unknown"),
    persistHash: (h, a) => void log.push(`hash:${a}:${h}`),
    persistRejected: () => void log.push("rejected"),
    persistLateHash: (h, a) => void log.push(`late:${a}:${h}`),
    persistNotRequested: () => void log.push("not-requested"),
    ...over,
  };
  return { context, log };
};
const refusal = async (promise: Promise<unknown>) =>
  promise.then(
    () => null,
    (e: unknown) =>
      e as { code?: string; reason?: string; beforeWalletRequest?: boolean },
  );
/** Submits one step with default (confirming) context. */
const submit = (
  a: InstanceType<typeof WalletProviderAdapter>,
  step: CanaryPreparation,
  over: Partial<CanarySubmissionContext> = {},
) => submitCanary(a, step, ctx(step, over).context);

describe("B3 (armed test double): submitCanary — the canary at the single submission boundary", () => {
  it("sends the server-confirmed approval and main request, each once, and records each hash under its own action", async () => {
    const { a, p } = adapterOn();
    const approve = prep("APPROVE");
    const one = ctx(approve);
    await expect(submitCanary(a, approve, one.context)).resolves.toEqual({
      action: "APPROVE",
      hash: HASH_AB,
      recorded: true,
    });
    expect(one.context.confirmPrepared).toHaveBeenCalledWith({
      record: approve.record,
      action: "APPROVE",
      review: approve.review,
    });
    expect(one.log).toEqual(["unknown", "hash:APPROVE:" + HASH_AB]);
    const main = prep("SEND", { record: approve.record });
    const two = ctx(main);
    await expect(submitCanary(a, main, two.context)).resolves.toEqual({
      action: "SEND",
      hash: HASH_AB,
      recorded: true,
    });
    expect(two.log).toEqual(["unknown", "hash:SEND:" + HASH_AB]);
    expect(p.calls.filter((c) => c.method === "eth_sendTransaction")).toEqual([
      { method: "eth_sendTransaction", params: [approve.transaction] },
      { method: "eth_sendTransaction", params: [main.transaction] },
    ]);
    expect(forbiddenWalletCalls(p.calls)).toEqual([]);
    expect(p.count("wallet_switchEthereumChain")).toBe(0);
    // Replay with the identical step: refused.
    for (const again of [approve, main])
      expect(await refusal(submit(a, again))).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "STEP_ALREADY_REQUESTED",
        beforeWalletRequest: true,
      });
    expect(p.count("eth_sendTransaction")).toBe(2);
  });
  it("review 1 F1: single use is bound to the owner record, not to a label the page chooses", async () => {
    const { a, p } = adapterOn();
    await expect(
      submit(a, prep("SEND", { record: "label-r1" })),
    ).resolves.toMatchObject({ action: "SEND" });
    // The same transaction under other record labels and review digests.
    for (const again of [
      prep("SEND", { record: "label-r2" }),
      prep("SEND", { record: "label-r3", review: "d".repeat(64) }),
      prep("SEND", { record: "x" }),
    ])
      expect(await refusal(submit(a, again)), again.record).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "STEP_ALREADY_REQUESTED",
        beforeWalletRequest: true,
      });
    // ... through another adapter on another wallet object.
    const elsewhere = adapterOn();
    expect(
      await refusal(submit(elsewhere.a, prep("SEND", { record: "label-r4" }))),
    ).toMatchObject({ reason: "STEP_ALREADY_REQUESTED" });
    expect(p.count("eth_sendTransaction")).toBe(1);
    expect(elsewhere.p.calls).toEqual([]);
    // Many labels never evict the key (at most two keys exist per approval).
    for (let i = 0; i < 80; i++)
      expect(
        await refusal(submit(a, prep("SEND", { record: `spam-${i}` }))),
      ).toMatchObject({ reason: "STEP_ALREADY_REQUESTED" });
    expect(p.count("eth_sendTransaction")).toBe(1);
    // A NEW owner record (another approvalId) is a new canary with its own single use.
    rearm();
    await expect(
      submit(a, prep("SEND", { record: "label-r1" })),
    ).resolves.toMatchObject({ action: "SEND" });
    expect(p.count("eth_sendTransaction")).toBe(2);
  });
  it("a gate name and a page-built transaction are not enough: the server's own prepared step is required", async () => {
    const cases: [
      string,
      (p: CanaryPreparation) => Partial<CanarySubmissionContext>,
      string,
    ][] = [
      [
        "no server confirmation at all",
        // G14 follow-up F2: the confirmation is the adapter's own server call; no confirmation = the server
        // answers none (was PREPARATION_CONTEXT_REQUIRED for a missing page callback).
        () => ({ confirmPrepared: undefined as never }),
        "ATTEMPT_UNKNOWN",
      ],
      [
        "the server knows no such step",
        () => ({ confirmPrepared: async () => null }),
        "PREPARATION_NOT_CONFIRMED",
      ],
      [
        "the server call fails",
        () => ({
          confirmPrepared: async () => {
            throw new Error("503");
          },
        }),
        "PREPARATION_NOT_CONFIRMED",
      ],
      [
        "the server answers another shape",
        (p) => ({
          confirmPrepared: async () => ({ ...p.transaction, nonce: "0x0" }),
        }),
        "PREPARATION_NOT_CONFIRMED",
      ],
      [
        "the server prepared another calldata",
        (p) => ({
          confirmPrepared: async () => ({
            ...p.transaction,
            data: approveData(DIAMOND, 4_000_000n),
          }),
        }),
        // G14 follow-up F2: the adapter digests the SERVER's answer over its own fields (the page copy is no longer
        // compared with it in the page); a changed field under the old digest is refused there.
        "PREPARATION_DIGEST_MISMATCH",
      ],
      [
        "the server prepared another gas limit",
        (p) => ({
          confirmPrepared: async () => ({ ...p.transaction, gas: "0x6271" }),
        }),
        // G14 follow-up F2: the adapter digests the SERVER's answer over its own fields (the page copy is no longer
        // compared with it in the page); a changed field under the old digest is refused there.
        "PREPARATION_DIGEST_MISMATCH",
      ],
      [
        "no owner gesture",
        () => ({ gesture: undefined as never }),
        "OWNER_GESTURE_REQUIRED",
      ],
      [
        "a scripted (untrusted) click",
        () => ({ gesture: { trusted: false, at: NOW } }),
        "OWNER_GESTURE_REQUIRED",
      ],
      [
        "a stale gesture",
        () => ({ gesture: { trusted: true, at: NOW - 30_001 } }),
        "OWNER_GESTURE_REQUIRED",
      ],
      [
        "a gesture from the future",
        () => ({ gesture: { trusted: true, at: NOW + 1 } }),
        "OWNER_GESTURE_REQUIRED",
      ],
      [
        "no persistence",
        // G14 follow-up F2: the durable "requested" record is the adapter's own server call; no record = the server
        // does not answer it: the outcome is unknown, the clean-up is asked and confirmed (was a missing callback).
        () => ({ persistUnknown: undefined as never }),
        "RECORD_NOT_WRITTEN",
      ],
    ];
    for (const [name, over, reason] of cases) {
      const { a, p } = adapterOn();
      const step = prep("APPROVE");
      expect(await refusal(submit(a, step, over(step))), name).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason,
        beforeWalletRequest: true,
      });
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
    const paysAnother = mutate((x) => {
      x[0].receiver = OTHER;
      x[2].receiverAddress = b32(OTHER);
    });
    const shapes: [string, CanaryPreparation, string][] = [
      [
        "expired authorization",
        prep("APPROVE", { expiresAt: NOW }),
        "AUTHORIZATION_EXPIRED",
      ],
      [
        "SEND action with the approval transaction",
        prep("SEND", { transaction: approveRequest() }),
        "ACTION_TARGET_MISMATCH",
      ],
      [
        "APPROVE action with the main transaction",
        prep("APPROVE", { transaction: mainRequest() }),
        "ACTION_TARGET_MISMATCH",
      ],
      [
        "unknown action",
        prep("APPROVE", { action: "REVOKE" as "APPROVE" }),
        "PREPARATION_MALFORMED",
      ],
      [
        "no review digest",
        prep("APPROVE", { review: "" }),
        "PREPARATION_MALFORMED",
      ],
      [
        "a record id with path characters",
        prep("APPROVE", { record: "../x" }),
        "PREPARATION_MALFORMED",
      ],
      [
        "a transaction outside the scope",
        prep("SEND", { transaction: mainRequest({ to: OTHER }) }),
        "REQUEST_NOT_IN_CANARY_SCOPE",
      ],
      [
        "a pinned-selector call paying another account",
        prep("SEND", { transaction: mainRequest({ data: paysAnother }) }),
        "SEND_RECEIVER_NOT_OWNER",
      ],
      [
        "a transaction with an extra field",
        prep("APPROVE", {
          transaction: { ...approveRequest(), nonce: "0x0" } as never,
        }),
        "WRONG_CHAIN",
      ],
      [
        "no transaction",
        prep("APPROVE", { transaction: undefined as never }),
        "WRONG_CHAIN",
      ],
      ["nothing", undefined as never, "WRONG_CHAIN"],
    ];
    for (const [name, step, reason] of shapes) {
      const { a, p } = adapterOn();
      expect(
        await refusal(submitCanary(a, step, ctx(step ?? prep()).context)),
        name,
      ).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason,
        beforeWalletRequest: true,
      });
      expect(p.calls, name).toEqual([]);
    }
    // None of these refusals spent the step: the approval can still be sent once.
    const { a, p } = adapterOn();
    await expect(submit(a, prep("APPROVE"))).resolves.toMatchObject({
      action: "APPROVE",
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("reviews 1 F3 / 2 G2: gesture and authorization are re-checked last, with nothing awaited before the wallet request", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    const slow = (ms: number, p: CanaryPreparation) => () =>
      new Promise<unknown>((resolve) =>
        setTimeout(() => resolve({ ...p.transaction }), ms),
      );
    // The server takes 10 minutes: the page stops waiting after CANARY_CONFIRM_WAIT_MS and asks nothing.
    {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND");
      const pending = refusal(
        submit(a, step, { confirmPrepared: slow(600_000, step) }),
      );
      await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
      expect(await pending).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "PREPARATION_NOT_CONFIRMED",
        beforeWalletRequest: true,
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(p.calls).toEqual([]);
    }
    // The authorization ends while the server is answering (inside the wait bound): refused at the re-check.
    {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND", { expiresAt: NOW + 3_000 });
      const pending = refusal(
        submit(a, step, {
          confirmPrepared: slow(5_000, step),
          gesture: { trusted: true, at: NOW },
        }),
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "AUTHORIZATION_EXPIRED",
        beforeWalletRequest: true,
      });
      expect(p.count("eth_sendTransaction")).toBe(0);
    }
    // The gesture goes stale while the server is answering: refused at the re-check.
    {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND", { expiresAt: NOW + 60_000 });
      const pending = refusal(
        submit(a, step, {
          confirmPrepared: slow(5_000, step),
          gesture: { trusted: true, at: NOW - 27_000 },
        }),
      );
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "OWNER_GESTURE_REQUIRED",
        beforeWalletRequest: true,
      });
      expect(p.count("eth_sendTransaction")).toBe(0);
    }
    // review 2 G2: the UNKNOWN record is written BEFORE the last lifetime check. A record that takes 10 minutes is
    // given up after the bounded wait; one that outlives the authorization or the gesture is refused at the check.
    {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND");
      const c = ctx(step, {
        persistUnknown: () => new Promise<void>((r) => setTimeout(r, 600_000)),
      });
      const pending = refusal(submitCanary(a, step, c.context));
      await vi.advanceTimersByTimeAsync(CANARY_CONFIRM_WAIT_MS + 1);
      expect(await pending).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "RECORD_NOT_WRITTEN",
        beforeWalletRequest: true,
      });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(p.calls.filter((x) => x.method === "eth_sendTransaction")).toEqual(
        [],
      );
    }
    for (const [name, over, expires, reason] of [
      [
        "authorization ends",
        { trusted: true, at: NOW },
        NOW + 3_000,
        "AUTHORIZATION_EXPIRED",
      ],
      [
        "gesture goes stale",
        { trusted: true, at: NOW - 27_000 },
        NOW + 60_000,
        "OWNER_GESTURE_REQUIRED",
      ],
    ] as const) {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND", { expiresAt: expires });
      const c = ctx(step, {
        gesture: over,
        persistUnknown: () =>
          new Promise<void>((r) =>
            setTimeout(() => {
              c.log.push("unknown");
              r();
            }, 5_000),
          ),
      });
      const pending = refusal(submitCanary(a, step, c.context));
      await vi.advanceTimersByTimeAsync(5_001);
      expect(await pending, name).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason,
        beforeWalletRequest: true,
      });
      // The record that was written is cleared again: no wallet was asked.
      expect(c.log, name).toEqual(["unknown", "not-requested"]);
      expect(p.count("eth_sendTransaction"), name).toBe(0);
    }
    // The same slow answer inside both lifetimes goes through — the step was not spent by the refusals above.
    {
      vi.setSystemTime(NOW);
      const { a, p } = adapterOn();
      const step = prep("SEND", { expiresAt: NOW + 60_000 });
      const pending = submit(a, step, {
        confirmPrepared: slow(5_000, step),
        gesture: { trusted: true, at: NOW },
      });
      await vi.advanceTimersByTimeAsync(5_001);
      await expect(pending).resolves.toMatchObject({
        action: "SEND",
        hash: HASH_AB,
      });
      expect(p.count("eth_sendTransaction")).toBe(1);
    }
  });
  it("a changed account or network is refused without a switch; the step is not spent", async () => {
    for (const change of [{ account: OTHER }, { chain: "0xe708" }]) {
      rearm();
      const { a, p } = adapterOn();
      p.set(change);
      const step = prep("SEND");
      const first = ctx(step);
      expect(await refusal(submitCanary(a, step, first.context))).toMatchObject(
        { code: "IDENTITY_CHANGED", beforeWalletRequest: true },
      );
      expect(first.log).toEqual([]);
      expect(p.count("eth_sendTransaction")).toBe(0);
      expect(p.count("wallet_switchEthereumChain")).toBe(0);
      // Back on the owner's account and Base (the owner's own separate action), the same step can still be sent.
      p.set({ account: SYN, chain: "0x2105" });
      await expect(submit(a, step)).resolves.toMatchObject({ action: "SEND" });
    }
  });
  it("4001 is OWNER_REJECTED: recorded, definitive, and the step is spent", async () => {
    const { a, p } = adapterOn(
      fakeWallet({
        send: () => {
          throw Object.assign(new Error("User rejected"), { code: 4001 });
        },
      }),
    );
    const step = prep("APPROVE");
    const { context, log } = ctx(step);
    await expect(submitCanary(a, step, context)).rejects.toMatchObject({
      code: "OWNER_REJECTED",
    });
    expect(log).toEqual(["unknown", "rejected"]);
    expect(p.count("eth_sendTransaction")).toBe(1);
    for (const again of [step, prep("APPROVE", { record: "another-label" })])
      expect(await refusal(submit(a, again))).toMatchObject({
        reason: "STEP_ALREADY_REQUESTED",
      });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("a provider error or an unreadable answer is SUBMISSION_UNCERTAIN: no retry, no further canary step, under any label", async () => {
    const outcomes: (() => unknown)[] = [
      () => {
        throw Object.assign(new Error("internal"), { code: -32603 });
      },
      () => "0x1234",
      () => ({ hash: HASH_AB }),
      () => null,
      // A wallet cannot make its own error look like an adapter refusal (review 1 F11).
      () => {
        throw Object.assign(new Error("fake refusal"), {
          beforeWalletRequest: true,
          code: "CANARY_REQUEST_REFUSED",
        });
      },
    ];
    for (const [i, outcome] of outcomes.entries()) {
      rearm();
      const { a, p } = adapterOn(fakeWallet({ send: outcome }));
      const step = prep("APPROVE");
      const { context, log } = ctx(step);
      await expect(
        submitCanary(a, step, context),
        String(i),
      ).rejects.toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
      expect(log, String(i)).toEqual(["unknown"]);
      expect(p.count("eth_sendTransaction"), String(i)).toBe(1);
      // The same step, the same step under another label, and the OTHER action of this approval: all refused,
      // on this wallet and on a fresh one. Nothing is asked again.
      const second = adapterOn();
      const later: [CanaryPreparation, typeof a][] = [
        [step, a],
        [prep("APPROVE", { record: "relabelled" }), a],
        [prep("SEND", { record: step.record }), a],
        [prep("SEND", { record: "relabelled-send" }), second.a],
        [prep("APPROVE", { record: "relabelled-approve" }), second.a],
      ];
      for (const [next, adapter] of later)
        expect(await refusal(submit(adapter, next)), String(i)).toMatchObject({
          code: "CANARY_REQUEST_REFUSED",
          reason: "PREVIOUS_STEP_UNCERTAIN",
          beforeWalletRequest: true,
        });
      expect(p.count("eth_sendTransaction"), String(i)).toBe(1);
      expect(second.p.calls, String(i)).toEqual([]);
      // The wallet itself is blocked for every financial request as well (adapter level).
      await expect(send(a, mainRequest()), String(i)).rejects.toThrow(
        "WALLET_REQUEST_UNCERTAIN",
      );
    }
  });
  it("timeout is SUBMISSION_UNCERTAIN; a late hash or a late rejection is only recorded, never a reason to ask again", async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let release: (v: unknown) => void = () => {};
    const { a, p } = adapterOn(
      fakeWallet({ send: () => new Promise((r) => (release = r)) }),
    );
    const step = prep("SEND");
    const { context, log } = ctx(step);
    const pending = refusal(submitCanary(a, step, context));
    await vi.advanceTimersByTimeAsync(CANARY_WALLET_WAIT_MS - 1);
    expect(log).toEqual(["unknown"]);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
    expect(p.count("eth_sendTransaction")).toBe(1);
    // While the wallet may still hold the request: no canary step of any kind, under any label.
    for (const next of [
      prep("APPROVE"),
      prep("SEND", { record: "relabelled" }),
      { ...step, expiresAt: Date.now() + 40_000 },
    ])
      expect(await refusal(submit(a, next))).toMatchObject({
        code: "CANARY_REQUEST_REFUSED",
        reason: "PREVIOUS_STEP_UNCERTAIN",
        beforeWalletRequest: true,
      });
    // ... and the wallet is busy for the adapter too.
    await expect(send(a, approveRequest())).rejects.toThrow(
      "WALLET_REQUEST_PENDING",
    );
    expect(p.count("eth_sendTransaction")).toBe(1);
    // The late hash: recorded for tracking under its action; nothing is sent again, the approval stays blocked.
    release("0x" + "9a".repeat(32));
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(["unknown", "late:SEND:0x" + "9a".repeat(32)]);
    expect(await refusal(submit(a, prep("APPROVE")))).toMatchObject({
      reason: "PREVIOUS_STEP_UNCERTAIN",
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
    // A late answer that is not a hash is ignored; a late rejection is recorded as a rejection.
    const lateCases: [
      (resolve: (v: unknown) => void, reject: (e: unknown) => void) => void,
      string[],
    ][] = [
      [(resolve) => resolve("not-a-hash"), ["unknown"]],
      [
        (_, reject) =>
          reject(Object.assign(new Error("rejected"), { code: 4001 })),
        ["unknown", "rejected"],
      ],
      [(_, reject) => reject(new Error("closed")), ["unknown"]],
    ];
    for (const [late, expected] of lateCases) {
      rearm();
      vi.setSystemTime(NOW);
      let res: (v: unknown) => void = () => {};
      let rej: (e: unknown) => void = () => {};
      const w = adapterOn(
        fakeWallet({
          send: () =>
            new Promise((r, j) => {
              res = r;
              rej = j;
            }),
        }),
      );
      const s2 = prep("SEND");
      const c2 = ctx(s2);
      const p2 = refusal(submitCanary(w.a, s2, c2.context));
      await vi.advanceTimersByTimeAsync(CANARY_WALLET_WAIT_MS + 1);
      expect(await p2).toMatchObject({ code: "SUBMISSION_UNCERTAIN" });
      late(res, rej);
      await vi.advanceTimersByTimeAsync(1);
      expect(c2.log).toEqual(expected);
      expect(w.p.count("eth_sendTransaction")).toBe(1);
    }
  });
  it("two concurrent calls for one action reach the wallet once, whatever labels they carry", async () => {
    let release: (v: unknown) => void = () => {};
    const { a, p } = adapterOn(
      fakeWallet({ send: () => new Promise((r) => (release = r)) }),
    );
    const first = submit(a, prep("APPROVE"));
    const second = refusal(
      submit(a, prep("APPROVE", { record: "other-label" })),
    );
    expect(await second).toMatchObject({
      code: "CANARY_REQUEST_REFUSED",
      reason: "STEP_ALREADY_REQUESTED",
      beforeWalletRequest: true,
    });
    await vi.waitFor(() => expect(p.count("eth_sendTransaction")).toBe(1));
    release(HASH_AB);
    await expect(first).resolves.toMatchObject({
      action: "APPROVE",
      hash: HASH_AB,
    });
    expect(p.count("eth_sendTransaction")).toBe(1);
  });
  it("review 2 G6: a refusal after the UNKNOWN record was written clears it and gives the step back", async () => {
    // The wallet is busy with another financial request, so the adapter refuses before asking it.
    let release: (v: unknown) => void = () => {};
    let asked = 0;
    const { a, p } = adapterOn(
      fakeWallet({
        // Only the first request stays open; later ones are answered at once.
        send: () =>
          asked++ === 0 ? new Promise((r) => (release = r)) : HASH_AB,
      }),
    );
    const busy = send(a, approveRequest());
    await vi.waitFor(() => expect(p.count("eth_sendTransaction")).toBe(1));
    const step = prep("SEND");
    const first = ctx(step);
    expect(await refusal(submitCanary(a, step, first.context))).toMatchObject({
      code: "WALLET_REQUEST_PENDING",
      beforeWalletRequest: true,
    });
    expect(first.log).toEqual(["unknown", "not-requested"]);
    release(HASH_AB);
    await busy;
    // The step was not spent: it can still be sent once.
    await expect(submit(a, step)).resolves.toMatchObject({ action: "SEND" });
    expect(p.count("eth_sendTransaction")).toBe(2);
    // A record that cannot be written at all: nothing is asked, nothing is spent.
    rearm();
    const w = adapterOn();
    const s2 = prep("APPROVE");
    expect(
      await refusal(
        submit(w.a, s2, {
          persistUnknown: () => {
            throw new Error("disk full");
          },
        }),
      ),
    ).toMatchObject({
      code: "CANARY_REQUEST_REFUSED",
      reason: "RECORD_NOT_WRITTEN",
      beforeWalletRequest: true,
    });
    expect(w.p.count("eth_sendTransaction")).toBe(0);
    await expect(submit(w.a, s2)).resolves.toMatchObject({ action: "APPROVE" });
  });
  it("a failing record of the hash still returns the hash, marked as not recorded", async () => {
    const { a } = adapterOn();
    await expect(
      submit(a, prep("SEND"), {
        persistHash: () => {
          throw new Error("disk full");
        },
      }),
    ).resolves.toEqual({ action: "SEND", hash: HASH_AB, recorded: false });
  });
});

// -------------------------------------------------------------- B1 + B2 + B3 + B4 + B5 together: the fake flow
/** A quote produced by the REAL routing adapter (B1) over a fake provider read that returns the fixture quote. */
async function adapterQuote(at: number): Promise<ExecutableQuote> {
  const restore = Date.now();
  vi.setSystemTime(at);
  const core = new RoutingCore(async (path) => {
    if (path !== "quote") throw new Error("NOT_REACHED");
    return {
      tool: fx.tool,
      transactionRequest: { ...fx.transactionRequest },
      estimate: { ...fx.estimate },
    };
  });
  const q = await core.canaryExecutableQuote({
    source: "8453",
    destination: "42161",
    sourceAsset: USDC_BASE,
    destinationAsset: USDC_ARB,
    amount: "5000000",
    sourceAddress: SYN,
    destinationAddress: SYN,
  });
  vi.setSystemTime(restore);
  // An injected read never yields an adapter quote in the build; the TEST DOUBLE above stands in for the upstream.
  expect(
    (
      await vi.importActual<typeof import("../../src/adapters/routing-core")>(
        "../../src/adapters/routing-core",
      )
    ).isCanaryQuote(q),
  ).toBe(false);
  adapterQuotes.add(q);
  return q;
}
const input = async (
  over: Partial<CanaryReviewInput> = {},
): Promise<CanaryReviewInput> => {
  const v = { usdc: "5000000", native: "10000000000000000", allowance: "0" };
  return {
    record: "canary-flow-0001",
    owner: SYN,
    amountIn: "5000000",
    // The owner record's absolute minimum is what the review is asked to enforce (4.90 USDC for 5 USDC).
    minimumOut: "4900000",
    now: NOW,
    wallet: { account: SYN, chainId: "8453", proven: true },
    quote: "quote" in over ? over.quote! : await adapterQuote(QUOTED_AT),
    pins: [pinReads(BASE_A), pinReads(BASE_B)],
    balances: [src(BASE_A, v, BLOCK), src(BASE_B, v, BLOCK)],
    fees: FEES,
    l1FeeWei: "1000",
    guardian: { level: "CLEAR", digest: "d".repeat(64) },
    ...over,
  };
};
const noApproval = () => {
  const c = simCalls().filter((_, i) => i !== 2);
  c[1] = {
    ...c[1],
    returnData: "0x" + 5_000_000n.toString(16).padStart(64, "0"),
  };
  return c;
};
/** FAKE durable journal: an in-memory journal that CLAIMS durability, for tests only. It proves nothing about restarts. */
const fakeDurableJournal = () =>
  Object.assign(new MemoryUseJournal(), { durable: true as const });
type Gate = (facts?: CanaryGateFacts) => {
  open: boolean;
  reasons: readonly string[];
};
/** The real canary gate with ONLY its wiring switch ignored (everything else it decides is real). */
const allButWiring: Gate = (facts) => {
  const s = canaryGateState(facts);
  const reasons = s.reasons.filter((r) => r !== "CANARY_NOT_WIRED");
  return { open: reasons.length === 0, reasons };
};
function engine(
  o: {
    uses?: InstanceType<typeof MemoryUseJournal>;
    pool?: typeof CANARY_RPC_POOL | null;
    gate?: Gate;
    approvalCostWei?: (owner: string) => string | null;
  } = {},
) {
  const seen: { facts?: CanaryGateFacts; reasons: readonly string[] }[] = [];
  const anchors = new AuditAnchorLog();
  const uses = o.uses ?? fakeDurableJournal();
  const e = new CanaryEngine({
    gate: (facts) => {
      const r = (o.gate ?? allButWiring)(facts);
      seen.push({ facts, reasons: r.reasons });
      return r;
    },
    authorizations: new CanaryAuthorizationStore(),
    attestor: new ReviewAttestor(),
    anchors,
    uses,
    simulate: async (r: SimulationRequest) => [
      {
        calls:
          r.blockStateCalls[0].calls.length === 6 ? simCalls() : noApproval(),
      },
    ],
    ...(o.pool === null ? {} : { pool: o.pool ?? CANARY_RPC_POOL }),
    approvalCostWei: o.approvalCostWei ?? (() => "665240000000"),
  });
  return { e, uses, seen, anchors };
}
const RECORD = "canary-flow-0001";

describe("the whole canary in a fake environment: B1 quote -> engine -> gate (B2 firewall, B4, B5) -> submission (B3) -> fake wallet", () => {
  it("one exact approval and one main send reach the fake wallet; nothing else does", async () => {
    const { e, uses, seen } = engine();
    const { a, p } = adapterOn();
    const first = await input();
    const r1 = await e.review(first);
    expect(r1.checks.filter((c) => c.status !== "PASS")).toEqual([]);
    expect(r1.ready).toBe(true);
    expect(r1.plan?.minimumOut).toBe("4900000");
    expect(() => e.walletRequest(RECORD)).toThrow("UNKNOWN_RECORD");
    e.start(RECORD, NOW + 10);
    // Nothing signable is handed out before prepare().
    expect(() => e.walletRequest(RECORD)).toThrow("STEP_NOT_PREPARED");
    // What the engine proves to the gate about the approval step.
    expect(e.stepFacts(RECORD, NOW + 11)).toEqual({
      step: {
        now: NOW + 11,
        action: "APPROVE",
        transaction: {
          chainId: "8453",
          from: SYN,
          to: CANARY_PINS.usdc["8453"].address,
          value: "0",
          data: approveData(),
        },
        pins: {
          set: "g14-canary-pins.2026-11-12.2",
          runtimeHash: canaryContractEntry.runtimeHash,
          implementationHash: canaryContractEntry.implementationHash,
          block: BLOCK.number,
          // The review block's own time (review 2 G5), not the caller's clock.
          observedAt: BLOCK.timestamp * 1000,
          twoOperatorsAgree: true,
        },
        wallet: { account: SYN, chainId: "8453" },
        expectedOut: "4979689",
        gas: {
          remaining: [
            { action: "APPROVE", gasLimit: "66524", maxFeePerGas: "10000000" },
            { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
          ],
          spentWei: "0",
          l1FeeWei: "1000",
        },
        use: { durable: true, approveConsumed: false, sendConsumed: false },
      },
      operatorsConfigured: true,
      quoteFromAdapter: true,
    });
    vi.setSystemTime(NOW + 11);
    const t1 = e.authorize(RECORD, { now: NOW + 11, trustedGesture: true });
    expect(t1.action).toBe("APPROVE");
    // The gate ran the firewall's canary control on the step's own transaction and it agreed.
    expect(seen.at(-1)!.reasons).toEqual([]);
    expect(canaryFirewallDecision(seen.at(-1)!.facts!.step).decision).toBe(
      "CANARY_EXCEPTION",
    );
    const approveTx = e.prepare(RECORD, t1, NOW + 12);
    expect(approveTx.data).toBe(approveData());
    const approveReq = e.walletRequest(RECORD);
    expect(approveReq).toEqual({
      chainId: "0x2105",
      from: SYN,
      to: CANARY_PINS.usdc["8453"].address,
      value: "0x0",
      data: approveData(),
      gas: hex(66524),
      maxFeePerGas: hex(FEES.maxFeePerGas),
      maxPriorityFeePerGas: hex(FEES.maxPriorityFeePerGas),
    });
    // review 2 G3: the fee caps are not part of the plan digest, so a second review of the SAME quote with other
    // caps has the same plan hash — but the request handed out at prepare() is a frozen snapshot and does not move.
    const rereview = await e.review({
      ...first,
      fees: {
        ...FEES,
        maxFeePerGas: "90000000",
        maxPriorityFeePerGas: "9000000",
      },
    });
    expect(rereview.planHash).toBe(r1.planHash);
    expect(e.walletRequest(RECORD)).toBe(approveReq);
    expect(Object.isFrozen(approveReq)).toBe(true);
    await e.review(first);
    vi.setSystemTime(NOW + 13);
    const review1 = e.record(RECORD)!.review!;
    const step1: CanaryPreparation = {
      action: "APPROVE",
      record: RECORD,
      review: review1,
      transaction: approveReq,
      expiresAt: t1.expiresAt,
    };
    await expect(
      submit(a, step1, {
        // The "server" double: the engine's own prepared request for this record / action / review.
        confirmPrepared: async (q) =>
          q.record === RECORD && q.action === "APPROVE" && q.review === review1
            ? e.walletRequest(RECORD)
            : null,
        gesture: { trusted: true, at: NOW + 12 },
      }),
    ).resolves.toEqual({ action: "APPROVE", hash: HASH_AB, recorded: true });
    const nonce = e.record(RECORD)!.pending!.nonce;
    e.observe(RECORD, {
      type: "TX_SUBMITTED",
      at: NOW + 13,
      role: "approval",
      hash: H(2),
      nonce,
    });
    e.observe(RECORD, {
      type: "TX_CONFIRMED",
      at: NOW + 14,
      role: "approval",
      hash: H(2),
      block: "99",
      blockHash: H(3),
      confirmations: 12,
    });
    expect(e.record(RECORD)!.state).toBe("APPROVAL_CONFIRMED");
    expect(() => e.walletRequest(RECORD)).toThrow("STEP_NOT_PREPARED");
    // Re-review with a NEW adapter quote: the allowance is now exactly the amount; the approval hash proved no transfer.
    const standing = {
      usdc: "5000000",
      native: "10000000000000000",
      allowance: "5000000",
    };
    const r2 = await e.review(
      await input({
        now: NOW + 15,
        quote: await adapterQuote(NOW + 14),
        balances: [src(BASE_A, standing, BLOCK), src(BASE_B, standing, BLOCK)],
      }),
    );
    expect(r2.ready).toBe(true);
    expect(r2.needsApproval).toBe(false);
    // A new quote is a new plan: nothing reviewed or authorized for the first one carries over.
    expect(r2.planHash).not.toBe(r1.planHash);
    expect(r2.plan?.quoteId).not.toBe(r1.plan?.quoteId);
    // review 1 F7: between the new review and its start the recorded plan is still the old one — no facts, gate closed.
    expect(e.stepFacts(RECORD, NOW + 16)).toBeUndefined();
    expect(e.start(RECORD, NOW + 20).state).toBe("REVIEWED");
    expect(e.record(RECORD)!.review).not.toBe(review1);
    expect(() => e.prepare(RECORD, t1, NOW + 21)).toThrow();
    vi.setSystemTime(NOW + 21);
    const t2 = e.authorize(RECORD, { now: NOW + 21, trustedGesture: true });
    expect(t2.action).toBe("SEND");
    expect(seen.at(-1)!.reasons).toEqual([]);
    // The mined approval's cost (a server read, here a fake) counts against the same budget.
    expect(seen.at(-1)!.facts!.step.gas).toEqual({
      remaining: [
        { action: "SEND", gasLimit: "670622", maxFeePerGas: "10000000" },
      ],
      spentWei: "665240000000",
      l1FeeWei: "1000",
    });
    expect(seen.at(-1)!.facts!.step.transaction.data).toBe(
      fx.transactionRequest.data,
    );
    const mainTx = e.prepare(RECORD, t2, NOW + 22);
    expect(mainTx.to).toBe(DIAMOND);
    const mainReq = e.walletRequest(RECORD);
    expect(mainReq).toEqual({
      chainId: "0x2105",
      from: SYN,
      to: DIAMOND,
      value: "0x0",
      data: fx.transactionRequest.data,
      gas: fx.transactionRequest.gasLimit,
      maxFeePerGas: hex(FEES.maxFeePerGas),
      maxPriorityFeePerGas: hex(FEES.maxPriorityFeePerGas),
    });
    vi.setSystemTime(NOW + 23);
    const step2: CanaryPreparation = {
      action: "SEND",
      record: RECORD,
      review: e.record(RECORD)!.review!,
      transaction: mainReq,
      expiresAt: t2.expiresAt,
    };
    await expect(
      submit(a, step2, {
        confirmPrepared: async () => e.walletRequest(RECORD),
        gesture: { trusted: true, at: NOW + 22 },
      }),
    ).resolves.toEqual({ action: "SEND", hash: HASH_AB, recorded: true });
    // The fake wallet's whole call record: identity reads and exactly two sends with the exact objects.
    expect(p.calls.filter((c) => c.method === "eth_sendTransaction")).toEqual([
      { method: "eth_sendTransaction", params: [approveReq] },
      { method: "eth_sendTransaction", params: [mainReq] },
    ]);
    expect([...new Set(p.calls.map((c) => c.method))].sort()).toEqual([
      "eth_accounts",
      "eth_chainId",
      "eth_sendTransaction",
    ]);
    expect(forbiddenWalletCalls(p.calls)).toEqual([]);
    expect(uses.load().map((l) => l.split(":").at(-1))).toEqual([
      "APPROVE",
      "SEND",
    ]);
    // Single use: nothing further is authorized, prepared or handed to the wallet for this owner.
    expect(() =>
      e.authorize(RECORD, { now: NOW + 24, trustedGesture: true }),
    ).toThrow();
    expect(() => e.prepare(RECORD, t2, NOW + 24)).toThrow();
    const again = await e.review(
      await input({
        record: "canary-flow-0002",
        now: NOW + 25,
        quote: await adapterQuote(NOW + 24),
      }),
    );
    expect(again.ready).toBe(false);
    expect(again.checks.find((c) => c.id === "SINGLE_USE")?.status).toBe(
      "FAIL",
    );
    for (const step of [step1, step2, { ...step2, record: "another-label" }])
      expect(await refusal(submit(a, step))).toMatchObject({
        reason: "STEP_ALREADY_REQUESTED",
      });
    expect(p.count("eth_sendTransaction")).toBe(2);
  });
  it("the real canary gate stays CLOSED even when everything else is proven: it is not wired", async () => {
    const { e, seen } = engine({ gate: canaryGateState });
    await e.review(await input());
    e.start(RECORD, NOW + 10);
    expect(() =>
      e.authorize(RECORD, { now: NOW + 11, trustedGesture: true }),
    ).toThrow("GATE_CLOSED");
    expect(() => e.prepare(RECORD, {}, NOW + 11)).toThrow("GATE_CLOSED");
    expect(seen.at(-1)!.reasons).toEqual(["CANARY_NOT_WIRED"]);
    expect(() => e.walletRequest(RECORD)).toThrow("STEP_NOT_PREPARED");
    expect(canaryGateState()).toMatchObject({
      state: "CLOSED",
      open: false,
      reasons: ["CANARY_FACTS_MISSING", "CANARY_NOT_WIRED"],
    });
  });
  it("B5 / B2 bind the step: wrong amount, minimum, budget, time, account, pins, use store, operators or quote keep the gate closed", async () => {
    const closed = async (
      name: string,
      reason: string,
      o: Parameters<typeof engine>[0] = {},
      over: Partial<CanaryReviewInput> = {},
      at = NOW + 11,
    ) => {
      const { e, seen } = engine(o);
      const r = await e.review(await input(over));
      expect(r.ready, name).toBe(true);
      e.start(RECORD, NOW + 10);
      expect(
        () => e.authorize(RECORD, { now: at, trustedGesture: true }),
        name,
      ).toThrow("GATE_CLOSED");
      expect(() => e.prepare(RECORD, {}, at), name).toThrow("GATE_CLOSED");
      expect(seen.at(-1)!.reasons, name).toContain(reason);
    };
    rearm({ exactAmount: "4000000", minimumOut: "3920000" });
    await closed(
      "the record covers another amount",
      "OWNER_APPROVAL:AMOUNT_NOT_EXACT",
    );
    rearm({ minimumOut: "4979690" });
    await closed(
      "the reviewed output is one unit below the owner's minimum",
      "OWNER_APPROVAL:OUTPUT_BELOW_OWNER_MINIMUM",
    );
    // (66524 + 670622) x 1e7 + 1000 = 7371460001000 wei
    rearm({ nativeGasBudgetWei: "7371460000999" });
    await closed(
      "the budget is one wei short",
      "OWNER_APPROVAL:GAS_BUDGET_EXCEEDED",
    );
    rearm({ nativeGasBudgetWei: "7371460001000" });
    {
      const { e } = engine();
      await e.review(await input());
      e.start(RECORD, NOW + 10);
      expect(
        e.authorize(RECORD, { now: NOW + 11, trustedGesture: true }).action,
      ).toBe("APPROVE");
    }
    rearm({ notAfter: NOW + 5 });
    await closed(
      "the record expired before the step",
      "OWNER_APPROVAL:APPROVAL_EXPIRED",
    );
    rearm({ account: OTHER });
    await closed(
      "the record names another account",
      "OWNER_APPROVAL:ACCOUNT_MISMATCH",
    );
    rearm({ pinSet: "g14-canary-pins.2026-11-12.1" });
    await closed(
      "the record names the old pin set",
      "OWNER_APPROVAL:PIN_SET_MISMATCH",
    );
    rearm();
    await closed(
      "a memory-only use journal proves no single use",
      "OWNER_APPROVAL:USE_STORE_UNPROVEN",
      { uses: new MemoryUseJournal() },
    );
    await closed("no configured operator pool", "CANARY_OPERATORS_NOT_PROVEN", {
      pool: null,
    });
    await closed(
      "a hand-made quote object of the right shape",
      "CANARY_QUOTE_NOT_FROM_ADAPTER",
      {},
      { quote: quote() },
    );
    await closed(
      "a copy of an adapter quote",
      "CANARY_QUOTE_NOT_FROM_ADAPTER",
      {},
      { quote: { ...(await adapterQuote(QUOTED_AT)) } },
    );
    await closed(
      "pin evidence older than 60 s at the step",
      "FIREWALL:PIN_EVIDENCE_STALE",
      {},
      {},
      NOW + 60_001,
    );
    await closed(
      "the gas facts are unknown",
      "OWNER_APPROVAL:GAS_BUDGET_UNPROVEN",
      {
        gate: (f) =>
          allButWiring(f ? { ...f, step: { ...f.step, gas: null } } : f),
      },
    );
    await closed(
      "the wallet moved to another account after the review",
      "OWNER_APPROVAL:ACCOUNT_MISMATCH",
      {
        gate: (f) =>
          allButWiring(
            f
              ? {
                  ...f,
                  step: {
                    ...f.step,
                    wallet: { account: OTHER, chainId: "8453" },
                  },
                }
              : f,
          ),
      },
    );
    armed.record = null;
    await closed("the disarmed record", "NO_OWNER_APPROVED_CANARY");
  });
  it("the mined approval's cost must be known before the send: unknown keeps the gate closed", async () => {
    const { e, seen } = engine({ approvalCostWei: () => null });
    const { a } = adapterOn();
    await e.review(await input());
    e.start(RECORD, NOW + 10);
    vi.setSystemTime(NOW + 11);
    const t1 = e.authorize(RECORD, { now: NOW + 11, trustedGesture: true });
    e.prepare(RECORD, t1, NOW + 12);
    const approveReq = e.walletRequest(RECORD);
    await expect(
      submit(
        a,
        {
          action: "APPROVE",
          record: RECORD,
          review: e.record(RECORD)!.review!,
          transaction: approveReq,
          expiresAt: t1.expiresAt,
        },
        {
          confirmPrepared: async () => e.walletRequest(RECORD),
          gesture: { trusted: true, at: NOW + 11 },
        },
      ),
    ).resolves.toMatchObject({ action: "APPROVE" });
    e.observe(RECORD, {
      type: "TX_SUBMITTED",
      at: NOW + 13,
      role: "approval",
      hash: H(2),
      nonce: e.record(RECORD)!.pending!.nonce,
    });
    e.observe(RECORD, {
      type: "TX_CONFIRMED",
      at: NOW + 14,
      role: "approval",
      hash: H(2),
      block: "99",
      blockHash: H(3),
      confirmations: 12,
    });
    const standing = {
      usdc: "5000000",
      native: "10000000000000000",
      allowance: "5000000",
    };
    const r2 = await e.review(
      await input({
        now: NOW + 15,
        quote: await adapterQuote(NOW + 14),
        balances: [src(BASE_A, standing, BLOCK), src(BASE_B, standing, BLOCK)],
      }),
    );
    expect(r2.ready).toBe(true);
    e.start(RECORD, NOW + 20);
    expect(() =>
      e.authorize(RECORD, { now: NOW + 21, trustedGesture: true }),
    ).toThrow("GATE_CLOSED");
    expect(seen.at(-1)!.reasons).toEqual([
      "OWNER_APPROVAL:GAS_BUDGET_UNPROVEN",
    ]);
  });
  it("B4 in the engine: with the configured pool, reads from outside it or from one operator never make a review ready", async () => {
    const v = { usdc: "5000000", native: "10000000000000000", allowance: "0" };
    const older = { ...BLOCK, number: "56427299" };
    const cases: [string, Partial<CanaryReviewInput>][] = [
      [
        "balances from an unconfigured origin",
        {
          balances: [
            src(BASE_A, v, BLOCK),
            src("https://rpc.example.org", v, BLOCK),
          ],
        },
      ],
      [
        "pins from an unconfigured origin",
        { pins: [pinReads(BASE_A), pinReads("https://rpc.example.org")] },
      ],
      [
        "both balances from one operator",
        { balances: [src(BASE_A, v, BLOCK), src(BASE_A, v, BLOCK)] },
      ],
      [
        "an Arbitrum origin for Base",
        {
          balances: [
            src(BASE_A, v, BLOCK),
            src("https://arb1.arbitrum.io", v, BLOCK),
          ],
        },
      ],
      ["one source down", { balances: [src(BASE_A, v, BLOCK), null] }],
      [
        "the second source at an older block",
        { balances: [src(BASE_A, v, BLOCK), src(BASE_B, v, older)] },
      ],
      [
        "the second source with another hash",
        {
          pins: [
            pinReads(BASE_A),
            pinReads(BASE_B, {
              block: { ...BLOCK, hash: "0x" + "b".repeat(64) },
            }),
          ],
        },
      ],
      [
        "pins and balances at different blocks",
        {
          pins: [
            pinReads(BASE_A, { block: older }),
            pinReads(BASE_B, { block: older }),
          ],
        },
      ],
      [
        "the native balance not read (as with the accepted method list today)",
        {
          balances: [
            src(BASE_A, { ...v, native: null }, BLOCK),
            src(BASE_B, { ...v, native: null }, BLOCK),
          ],
        },
      ],
      ["a stale review block", { now: NOW + 61_000 + 5_000 }],
    ];
    for (const [name, over] of cases) {
      const { e } = engine();
      const r = await e.review(await input(over));
      expect(r.ready, name).toBe(false);
      expect(() => e.start(RECORD, NOW + 10), name).toThrow();
    }
    // Without the pool the older heuristic would have accepted an unconfigured second origin: the pool is what binds it.
    const loose = engine({ pool: null });
    const r = await loose.e.review(
      await input({
        balances: [
          src(BASE_A, v, BLOCK),
          src("https://rpc.example.org", v, BLOCK),
        ],
        pins: [pinReads(BASE_A), pinReads("https://rpc.example.org")],
      }),
    );
    expect(r.ready).toBe(true);
    loose.e.start(RECORD, NOW + 10);
    expect(() =>
      loose.e.authorize(RECORD, { now: NOW + 11, trustedGesture: true }),
    ).toThrow("GATE_CLOSED");
    expect(loose.seen.at(-1)!.reasons).toContain("CANARY_OPERATORS_NOT_PROVEN");
  });
});

// ----------------------------------------------------------------------------- the application stays CLOSED
const ORIGIN = "http://127.0.0.1:3100";
const call = async (body: unknown) => {
  // Each request gets a fresh per-client allowance (the route allows 5 per window).
  setAppLimiterForTests(new MemoryRateLimiter());
  const res = await POST(
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
  return { status: res.status, json: await res.json() };
};

describe("even with an armed record (test double) the API and the gates expose no execution", () => {
  it("authorize, prepare, send and every other write action are refused; nothing signable is returned", async () => {
    for (const action of [
      "authorize",
      "prepare",
      "send",
      "approve",
      "submit",
      "sign",
      "broadcast",
      "execute",
      "relay",
      "deposit",
      "AUTHORIZE",
      "Prepare",
    ]) {
      const r = await call({
        action,
        record: RECORD,
        owner: SYN,
        amount: "5000000",
        gate: "veined-owner-canary",
      });
      expect(r.status, action).toBe(403);
      expect(r.json.error, action).toBe("WRITE_DISABLED");
      expect(r.json.gate, action).toMatchObject({
        state: "CLOSED",
        open: false,
      });
      expect(JSON.stringify(r.json), action).not.toMatch(
        /transactionRequest|"data":"0x|calldata|token|nonce/i,
      );
    }
    const status = await call({ action: "canary" });
    expect(status.status).toBe(200);
    expect(status.json.gate).toMatchObject({ state: "CLOSED", open: false });
    expect(JSON.stringify(status.json)).not.toMatch(
      /transactionRequest|"data":"0x/,
    );
    expect(status.json.readiness).toMatchObject({
      wired: true,
      active: false,
      activation: "DISABLED",
    });
    // G14 closure: the canary's signing-path actions exist and are refused (403, nothing signable, no reads).
    for (const action of [
      "canary-authorize",
      "canary-prepare",
      "canary-confirm",
      "canary-record",
      "canary-track",
    ]) {
      const body =
        action === "canary-authorize"
          ? {
              action,
              session: "a".repeat(64),
              record: RECORD,
              trustedGesture: true,
            }
          : action === "canary-prepare"
            ? { action, session: "a".repeat(64), record: RECORD, token: {} }
            : action === "canary-confirm"
              ? {
                  action,
                  session: "a".repeat(64),
                  record: RECORD,
                  step: "SEND",
                  review: "c".repeat(64),
                  attempt: "a".repeat(32),
                  digest: "d".repeat(64),
                }
              : action === "canary-record"
                ? {
                    action,
                    session: "a".repeat(64),
                    kind: "requested",
                    ref: {
                      record: RECORD,
                      action: "SEND",
                      attempt: "a".repeat(32),
                      digest: "d".repeat(64),
                      request: "b".repeat(32),
                    },
                  }
                : { action, session: "a".repeat(64), record: RECORD };
      const r = await call(body);
      expect(r.status, action).toBe(403);
      expect(r.json.error, action).toBe("WRITE_DISABLED");
      expect(JSON.stringify(r.json), action).not.toMatch(
        /transactionRequest|"data":"0x|calldata|"token"|nonce/i,
      );
    }
    // Unknown canary-looking actions are plain invalid requests.
    for (const action of [
      "canaryPrepare",
      "canary_send",
      "walletRequest",
      "stepFacts",
    ]) {
      const r = await call({ action });
      expect(r.status, action).toBe(422);
      expect(r.json.error, action).toBe("INVALID_REQUEST");
    }
    const gate = await (await GET()).json();
    expect(gate).toMatchObject({
      state: "CLOSED",
      open: false,
      platformFeeBps: 0,
    });
  });
  it("a well-formed record only removes its own reason from the general gate; every other lock holds", () => {
    expect(executionGateState("8453")).toMatchObject({
      state: "CLOSED",
      open: false,
    });
    expect(executionGateState("8453").reasons).toEqual([
      "G5_GLOBAL_EXECUTION_DISABLED",
      "ROUTING_WRITE_DISABLED",
      "SWAP_EXECUTION_CLOSED",
      "FIREWALL_GLOBAL_KILL",
      "NO_ACTIVE_CONTRACT_ENTRY",
      "WALLET_CHAIN_NOT_TRUSTED",
    ]);
    armed.record = { ...syntheticApproval(), extra: 1 };
    expect(executionGateState("8453").reasons).toContain(
      "NO_OWNER_APPROVED_CANARY",
    );
    armed.record = null;
    expect(executionGateState("8453").reasons).toContain(
      "NO_OWNER_APPROVED_CANARY",
    );
    expect(canaryGateState().reasons).toEqual([
      "NO_OWNER_APPROVED_CANARY",
      "CANARY_NOT_WIRED",
    ]);
  });
});
