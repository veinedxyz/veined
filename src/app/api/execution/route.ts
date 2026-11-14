import { z } from "zod";
import { guardStatus, originGuard, rateGuard } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { RoutingError } from "../../../routing/model";
import { wire } from "../../../swap/model";
import {
  CANARY_LIVE_WIRING,
  executionGateState,
} from "../../../execution/server/gate";
import { OWNER_CANARY_APPROVAL } from "../../../security/canary-approval";
import {
  canaryArmed,
  canaryRuntime,
  canaryStoreInspection,
  StoreError,
} from "../../../execution/server/canary/runtime";
import { reviewBridgeRoute } from "../../../execution/server/review";
import { reviewDeps } from "../../../execution/server/deps";
import { cachedCanaryPins } from "../../../execution/server/canary/pin-reads";
import { CANARY_PIN_SET, pinProblems } from "../../../execution/canary/pins";
import { CANARY_SCOPE } from "../../../execution/canary/scope";
import { canaryReadiness } from "../../../execution/canary/readiness";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// G13 owner-signed execution foundation — READ-ONLY. It reports the execution gate (CLOSED, read from the protected
// sources) and builds a server-side review of a Bridge route. It never signs, approves, relays, broadcasts or opens a
// deposit address, and there is no action that could: names of write actions are refused as WRITE_DISABLED.
const WRITE_ACTIONS = new Set([
  "send",
  "submit",
  "sign",
  "approve",
  "broadcast",
  "deposit",
  "execute",
  "relay",
  // G14: the canary pathway's wallet steps exist only in the engine; this API never exposes them.
  "authorize",
  "prepare",
]);
// Codes a client may see (review F18); anything else, including upstream or Node codes, reads PROVIDER_UNAVAILABLE.
const PUBLIC_CODES = new Set([
  "INVALID_REQUEST",
  "ORIGIN_REJECTED",
  "RATE_LIMITED",
  "RATE_LIMIT_UNAVAILABLE",
  // A fail-closed configuration outage stays a visible 503 (round-2 review N9), never a provider error.
  "CONFIG_INVALID",
  "BRIDGE_ONLY",
  "STALE_OR_UNKNOWN_NETWORK",
  "NO_EXECUTABLE_ROUTE",
  "QUOTE_ASSET_MISMATCH",
  "CATALOG_CHANGED",
  "PROVIDER_UNAVAILABLE",
  // G14 closure: the canary runtime's refusals (only reachable while the canary is armed).
  "WRITE_DISABLED",
  "STORE_NEEDS_ATTENTION",
  "SESSION_INVALID",
  "NOT_THE_APPROVED_CANARY",
  "RECORD_NOT_RE_REVIEWABLE",
  "ATTEMPT_UNKNOWN",
  "PREPARED_BEFORE_RESTART",
  "PREPARATION_NOT_CURRENT",
  "PREPARATION_MISMATCH",
  "AUTHORIZATION_EXPIRED",
  "QUOTE_EXPIRED",
  "APPROVAL_EXPIRED",
  "ATTEMPT_ALREADY_REQUESTED",
  "UNKNOWN_RECORD",
  "GATE_CLOSED",
  "NOT_REVIEWED",
  "CANARY_ALREADY_SENT",
  "APPROVAL_ALREADY_USED",
  "ANOTHER_CANARY_ACTIVE",
  "REVIEW_NOT_READY",
  "NO_ATTESTED_REVIEW",
  "STEP_NOT_PREPARED",
  "FORGED",
  "REVOKED",
  "NONCE_REUSED_GLOBAL",
  "UNTRUSTED_GESTURE",
  "QUOTE_TOO_CLOSE_TO_EXPIRY",
  // G14 closure, review 2.
  "STORE_UNAVAILABLE",
  "STORE_LOCKED",
  "OWNER_KEY_INVALID",
  "SESSION_OBSERVE_ONLY",
  "RESUME_KEY_INVALID",
  // G14 follow-up F4: the store refuses a deployment it does not support (one local machine, one main thread).
  "STORE_LOCKED_FOREIGN_HOST",
  "STORE_THREAD_UNSUPPORTED",
  "STORE_SHARED_PATH_UNSUPPORTED",
  "STORE_HOST_UNKNOWN",
]);
const requestSchema = z.discriminatedUnion("action", [
  // G14: read-only canary status (scope, release matrix, gate) + a live check of the pins through the Swap transport.
  z.object({ action: z.literal("canary") }).strict(),
  z
    .object({
      action: z.literal("gate"),
      chainId: z
        .string()
        .regex(/^\d{1,18}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("review"),
      input: z.unknown(),
      wallet: z
        .object({
          account: z
            .string()
            .regex(/^0x[0-9a-fA-F]{40}$/)
            .optional(),
          chainId: z
            .string()
            .regex(/^\d{1,18}$/)
            .optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
]);
// G14 closure: the canary's server actions. Read-only ones answer in every build; every action that could lead to a
// signature (authorize, prepare, confirm, record, track) is refused with 403 WRITE_DISABLED while the canary gate is
// structurally CLOSED — in this build always (no owner record, CANARY_LIVE_WIRING false) — BEFORE the runtime or its
// store is touched. Nothing signable is ever returned by a read-only action.
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{8,80}$/;
const session = z.string().regex(HEX64);
const record = z.string().regex(RECORD_ID);
const action = z.enum(["APPROVE", "SEND"]);
const attemptRef = z
  .object({
    record,
    action,
    attempt: z.string().regex(HEX32),
    digest: z.string().regex(HEX64),
    request: z.string().regex(HEX32),
  })
  .strict();
const canarySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("canary-status") }).strict(),
  z
    .object({
      action: z.literal("canary-review"),
      account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      chainId: z.string().regex(/^\d{1,18}$/),
      amount: z.string().regex(/^(0|[1-9]\d{0,40})$/),
      record: record.optional(),
      session: session.optional(),
      // Review 3 N12: the owner's own canary key; needed to start a record (never echoed, never stored).
      ownerKey: z.string().regex(HEX64).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("canary-authorize"),
      session,
      record,
      trustedGesture: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("canary-prepare"),
      session,
      record,
      token: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      action: z.literal("canary-confirm"),
      session,
      record,
      step: action,
      review: z.string().regex(HEX64),
      attempt: z.string().regex(HEX32),
      digest: z.string().regex(HEX64),
    })
    .strict(),
  z
    .object({
      action: z.literal("canary-record"),
      session,
      kind: z.enum([
        "requested",
        "not-requested",
        "hash",
        "late-hash",
        "rejected",
        "uncertain",
      ]),
      ref: attemptRef,
      hash: z
        .string()
        .regex(/^0x[0-9a-fA-F]{64}$/)
        .optional(),
    })
    .strict(),
  z.object({ action: z.literal("canary-track"), session, record }).strict(),
  // Review 1 F1 / review 2 N2: re-binding to an existing record of the approved account (after a restart / reload).
  // Without the record's resume key the session can only observe.
  z
    .object({
      action: z.literal("canary-resume"),
      account: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      amount: z.string().regex(/^(0|[1-9]\d{0,40})$/),
      record: record.optional(),
      resumeKey: z.string().regex(HEX64).optional(),
    })
    .strict(),
]);
const CANARY_WRITES = new Set([
  "canary-authorize",
  "canary-prepare",
  "canary-confirm",
  "canary-record",
  "canary-track",
]);
/** What the canary is in this build: implementation present, activation and owner record as the constants say. */
function canaryStatus() {
  const armed = canaryArmed();
  return {
    // The record's exact amount (public: it is in the client bundle whenever a record exists); null when disarmed.
    amount: armed.armed ? (OWNER_CANARY_APPROVAL?.exactAmount ?? null) : null,
    implementation: "PRESENT",
    activation: armed.armed ? "ENABLED" : "DISABLED",
    ownerRecord: OWNER_CANARY_APPROVAL === null ? "ABSENT" : "PRESENT",
    wiring: CANARY_LIVE_WIRING,
    gate: { state: armed.armed ? "ARMED" : "CLOSED", reasons: armed.reasons },
    scope: {
      id: CANARY_SCOPE.id,
      source: CANARY_SCOPE.sourceChainId,
      destination: CANARY_SCOPE.destinationChainId,
      maxAmount: CANARY_SCOPE.maxAmount.toString(),
    },
  };
}
async function canaryAction(raw: unknown) {
  const r = canarySchema.parse(raw);
  if (r.action === "canary-status") return reply(canaryStatus());
  const armed = canaryArmed();
  if (!armed.armed) {
    if (!CANARY_WRITES.has(r.action))
      // Read-only: nothing is read from a chain, nothing is recorded, nothing signable is built.
      return reply({ ...canaryStatus(), review: null, resume: null });
    guardStatus("WRITE_DISABLED");
    return reply({ error: "WRITE_DISABLED", gate: canaryStatus().gate }, 403);
  }
  let rt: ReturnType<typeof canaryRuntime>;
  try {
    rt = canaryRuntime();
  } catch (e) {
    // Review 2 R2: the store cannot be opened (another live writer holds it, or it cannot be used). Tracking and
    // resuming still SHOW what the journal holds, read-only; every other action is refused. Nothing is written.
    if (!(e instanceof StoreError)) throw e;
    // Review 3 N15: only a public code is named, and the journal is shown only to a resume that names the approved
    // account and amount (the same check a resume makes on an open store).
    const code = PUBLIC_CODES.has(e.code) ? e.code : "STORE_UNAVAILABLE";
    if (
      r.action === "canary-resume" &&
      r.account.toLowerCase() ===
        OWNER_CANARY_APPROVAL?.account.toLowerCase() &&
      r.amount === OWNER_CANARY_APPROVAL?.exactAmount
    )
      return reply(
        {
          error: "STORE_UNAVAILABLE",
          code,
          inspection: canaryStoreInspection(),
        },
        503,
      );
    return reply({ error: "STORE_UNAVAILABLE", code }, 503);
  }
  switch (r.action) {
    case "canary-review":
      return reply(
        await rt.review(
          {
            account: r.account,
            chainId: r.chainId,
            amount: r.amount,
            ...(r.record ? { record: r.record } : {}),
            ...(r.session ? { session: r.session } : {}),
            ...(r.ownerKey ? { ownerKey: r.ownerKey } : {}),
          },
          AbortSignal.timeout(45000),
        ),
      );
    case "canary-authorize":
      return reply({
        token: rt.authorize({
          session: r.session,
          record: r.record,
          trustedGesture: r.trustedGesture,
        }),
      });
    case "canary-prepare":
      return reply({
        preparation: rt.prepare({
          session: r.session,
          record: r.record,
          token: r.token,
        }),
      });
    case "canary-confirm":
      return reply({
        preparation: rt.confirm({
          session: r.session,
          record: r.record,
          action: r.step,
          review: r.review,
          attempt: r.attempt,
          digest: r.digest,
        }),
        // G14 follow-up F2: the server's clock at the confirmation, so the wallet adapter judges the server's own
        // time limits in server time (a page clock behind the server can never stretch them).
        serverNow: Date.now(),
      });
    case "canary-record":
      return reply(
        await rt.write({
          session: r.session,
          kind: r.kind,
          ref: r.ref,
          ...(r.hash ? { hash: r.hash } : {}),
        }),
      );
    case "canary-track":
      return reply(
        await rt.track(
          { session: r.session, record: r.record },
          AbortSignal.timeout(45000),
        ),
      );
    case "canary-resume":
      return reply(
        rt.resume({
          account: r.account,
          amount: r.amount,
          ...(r.record ? { record: r.record } : {}),
          ...(r.resumeKey ? { resumeKey: r.resumeKey } : {}),
        }),
      );
  }
}
const reply = (value: unknown, status = 200) =>
  new Response(wire(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
export function GET() {
  return reply(executionGateState());
}
export async function POST(req: Request) {
  try {
    // Exact origin and a JSON body first (no cross-site form can reach a write), then the per-client allowance:
    // a review costs a catalog read, two route quotes and RPC reads (review F18); the canary actions have their own
    // scope (one canary is a handful of calls).
    originGuard(req);
    if (!req.headers.get("content-type")?.startsWith("application/json"))
      throw new RoutingError("INVALID_REQUEST");
    const raw = JSON.parse(await boundedBody(req, 16000)) as unknown;
    const canary =
      !!raw &&
      typeof raw === "object" &&
      "action" in raw &&
      typeof raw.action === "string" &&
      raw.action.startsWith("canary-");
    // Review 2 N2: a resume (which costs no chain read) has its own, smaller scope.
    const resume =
      canary && (raw as { action: string }).action === "canary-resume";
    await rateGuard(
      req,
      resume
        ? "execution-canary-resume"
        : canary
          ? "execution-canary"
          : "execution",
      resume ? 10 : canary ? 30 : 5,
    );
    if (canary) return await canaryAction(raw);
    if (
      raw &&
      typeof raw === "object" &&
      "action" in raw &&
      typeof raw.action === "string" &&
      WRITE_ACTIONS.has(raw.action.toLowerCase())
    ) {
      guardStatus("WRITE_DISABLED");
      return reply(
        { error: "WRITE_DISABLED", gate: executionGateState() },
        403,
      );
    }
    const request = requestSchema.parse(raw);
    if (request.action === "gate")
      return reply(executionGateState(request.chainId));
    if (request.action === "canary") {
      // At most one live pin read per minute (each is ~14 upstream RPC calls on the shared transport, review N14).
      const reads = await cachedCanaryPins(AbortSignal.timeout(20000));
      return reply({
        scope: {
          id: CANARY_SCOPE.id,
          source: CANARY_SCOPE.sourceChainId,
          destination: CANARY_SCOPE.destinationChainId,
          token: "USDC",
          maxAmount: CANARY_SCOPE.maxAmount.toString(),
          tool: CANARY_SCOPE.tool,
        },
        pinSet: CANARY_PIN_SET,
        pins: {
          problems: pinProblems(reads),
          // One Base source is configured (protected config, item B4): agreement cannot be proven yet.
          agreement: "SINGLE_SOURCE",
        },
        readiness: canaryReadiness(),
        gate: executionGateState(CANARY_SCOPE.sourceChainId),
      });
    }
    return reply(
      await reviewBridgeRoute(
        { input: request.input, wallet: request.wallet },
        reviewDeps,
        AbortSignal.timeout(25000),
      ),
    );
  } catch (e) {
    const code =
      e instanceof z.ZodError || e instanceof SyntaxError
        ? "INVALID_REQUEST"
        : e &&
            typeof e === "object" &&
            "code" in e &&
            typeof e.code === "string" &&
            /^[A-Z][A-Z0-9_]{0,39}$/.test(e.code)
          ? e.code
          : "PROVIDER_UNAVAILABLE";
    const shown = PUBLIC_CODES.has(code) ? code : "PROVIDER_UNAVAILABLE";
    return reply(
      { error: shown },
      shown === "WRITE_DISABLED" ? 403 : guardStatus(shown),
    );
  }
}
