import { z } from "zod";
import { apiGuard, guardStatus, rateGuard } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { wire } from "../../../swap/model";
import { GUARDIAN_POLICY, type Verdict } from "../../../guardian/model";
import {
  nearAccountKind,
  nearMessageSchema,
  nearRecipients,
  parseNearTransaction,
  reviewNearMessage,
} from "../../../guardian/near";
import {
  review,
  reviewIntents,
  reviewNear,
  verdictOf,
} from "../../../guardian/verdict";
import { gateAgentRun } from "../../../guardian/agent";
import { AGENT_POLICIES } from "../../../guardian/scenarios";
import {
  INTENTS_KNOWN_ASSETS,
  INTENTS_ORIGIN,
  INTENTS_REVIEWED_ORIGINS,
  intentsFacts,
  intentsQuoteRequestSchema,
  intentsQuoteResponseSchema,
  quoteEcho,
  type IntentsQuoteRequest,
  type IntentsToken,
} from "../../../guardian/intents";
import { MPC_SIGNER } from "../../../guardian/signing";
import {
  IntentsError,
  intentsDryQuote,
  intentsTokens,
} from "../../../guardian/server/intents";
import {
  ONE_CLICK_MANAGER_KEY,
  verifyQuoteSignature,
} from "../../../guardian/server/quote-signature";
import { narrate, narratorConfig } from "../../../guardian/server/narrator";
import { chatDraft, chatToken } from "../../../guardian/server/chat-draft";
import {
  chatDraftRequestSchema,
  chatTokenRequestSchema,
} from "../../../guardian/chat/model";
import {
  onchainEnabled,
  onchainFindings,
} from "../../../guardian/server/near-rpc";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// VEINED Guardian API: a pre-signing review any client (the VEINED app, or an AI agent before it signs) can ask for.
// Read-only: it reviews, quotes dry, verifies and explains. It never signs, relays, broadcasts or opens a deposit
// address. Every request passes the app's exact-origin, content-type and rate guards; requests that reach an upstream
// (1Click quotes) share a second, smaller allowance. Owner policies are server-side: an agent names a policy, it can
// never supply or widen one.
const account = z
  .string()
  .max(128)
  .transform((s) => s.trim())
  .pipe(z.string().min(2).max(128));
const known = z.array(account).max(16).optional();
const narration = {
  narrate: z.boolean().optional(),
  locale: z
    .string()
    .regex(/^[A-Za-z-]{2,10}$/)
    .optional(),
};
const requestSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("near-transaction"),
      tx: z.unknown(),
      known,
      ...narration,
    })
    .strict(),
  z
    .object({
      action: z.literal("near-message"),
      message: nearMessageSchema,
      known,
      ...narration,
    })
    .strict(),
  z
    .object({
      action: z.literal("address"),
      value: account,
      known,
      ...narration,
    })
    .strict(),
  z
    .object({
      action: z.literal("agent-run"),
      policyId: z.string().regex(/^[a-z0-9-]{1,40}$/),
      proposals: z
        .array(
          z
            .object({
              id: z.string().regex(/^[a-z0-9-]{1,40}$/),
              reason: z.string().max(400),
              tx: z.unknown(),
            })
            .strict(),
        )
        .min(1)
        .max(12),
    })
    .strict(),
  z.object({ action: z.literal("intents-tokens") }).strict(),
  // Guardian chat: a draft (or one token) prepared by the deterministic conversation engine, reviewed from local data
  // only. Strict: no verdict, level or decision can be supplied by the client.
  z
    .object({ action: z.literal("chat-draft"), draft: chatDraftRequestSchema })
    .strict(),
  z
    .object({ action: z.literal("chat-token"), check: chatTokenRequestSchema })
    .strict(),
  z
    .object({
      action: z.literal("intents-quote"),
      request: intentsQuoteRequestSchema,
      sender: account,
      ...narration,
    })
    .strict(),
  z
    .object({
      action: z.literal("intents-verify"),
      request: intentsQuoteRequestSchema,
      response: z.unknown(),
      sender: account,
    })
    .strict(),
]);
const reply = (value: unknown, status = 200) =>
  new Response(wire(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
export function GET() {
  return reply({
    policy: GUARDIAN_POLICY.version,
    execution: "CLOSED",
    signer: MPC_SIGNER,
    intents: {
      origin: INTENTS_ORIGIN,
      quotes: "DRY_ONLY",
      signatureKey: ONE_CLICK_MANAGER_KEY,
    },
    onchain: onchainEnabled() ? "NEAR_RPC" : "OFF",
    narrator: narratorConfig() ? "NEAR_AI_CLOUD" : "TEMPLATES",
    agentPolicies: Object.keys(AGENT_POLICIES),
  });
}
async function withNarration(
  verdict: Verdict,
  request: { narrate?: boolean; locale?: string },
) {
  return request.narrate
    ? { verdict, narration: await narrate(verdict, request.locale ?? "en") }
    : { verdict };
}
/** Asset metadata: the reviewed static lists first (work offline), then the live 1Click list. */
async function assetsFor(request: IntentsQuoteRequest, signal: AbortSignal) {
  const find = (list: readonly IntentsToken[], id: string) =>
    list.find((t) => t.assetId === id);
  const reviewed = [...INTENTS_KNOWN_ASSETS, ...INTENTS_REVIEWED_ORIGINS];
  let origin = find(reviewed, request.originAsset),
    destination = find(INTENTS_KNOWN_ASSETS, request.destinationAsset);
  if (!origin || !destination) {
    const live = await intentsTokens(fetch, Date.now(), signal);
    origin ??= find(live, request.originAsset);
    destination ??= find(live, request.destinationAsset);
  }
  if (!origin || !destination) throw new IntentsError("INTENTS_REJECTED");
  return { origin, destination };
}
/** Authenticity first, on the response exactly as received; the parsed view is only used for display facts. */
async function reviewSignedQuote(
  request: IntentsQuoteRequest,
  raw: unknown,
  sender: string,
  signal: AbortSignal,
) {
  const parsed = intentsQuoteResponseSchema.safeParse(raw);
  if (!parsed.success) throw new IntentsError("INTENTS_INVALID");
  const { origin, destination } = await assetsFor(request, signal);
  const signature = verifyQuoteSignature(raw);
  const issued = parsed.data.timestamp
    ? Date.parse(parsed.data.timestamp)
    : NaN;
  const authenticity = {
    signature: signature.state,
    mismatch: quoteEcho(request, raw),
    issuedAt: Number.isFinite(issued) ? issued : null,
  };
  const extra =
    destination.blockchain === "near"
      ? await onchainFindings([request.recipient])
      : [];
  const verdict = reviewIntents(
    intentsFacts(
      request,
      origin,
      destination,
      parsed.data,
      sender,
      authenticity,
    ),
    Date.now(),
    extra,
  );
  return {
    quote: parsed.data.quote,
    verification: {
      signature: signature.state,
      message: signature.message,
      managerKey: ONE_CLICK_MANAGER_KEY,
      issuedAt: parsed.data.timestamp ?? null,
      mismatch: authenticity.mismatch,
    },
    verdict,
  };
}
export async function POST(req: Request) {
  try {
    await apiGuard(req, "guardian", 40);
    const request = requestSchema.parse(
      JSON.parse(await boundedBody(req, 32000)),
    );
    if (request.action === "near-transaction") {
      const tx = parseNearTransaction(request.tx);
      return reply(
        await withNarration(
          reviewNear(
            tx,
            request.known,
            await onchainFindings(nearRecipients(tx)),
          ),
          request,
        ),
      );
    }
    if (request.action === "near-message") {
      const r = reviewNearMessage(request.message, request.known);
      return reply(
        await withNarration(
          verdictOf(
            "near-message",
            request.message,
            r.findings,
            r.steps,
            r.checks,
          ),
          request,
        ),
      );
    }
    if (request.action === "address") {
      const extra = nearAccountKind(request.value)
        ? await onchainFindings([request.value])
        : [];
      return reply(
        await withNarration(
          review(
            { kind: "address", value: request.value, known: request.known },
            Date.now(),
            extra,
          ),
          request,
        ),
      );
    }
    if (request.action === "agent-run") {
      const policy = AGENT_POLICIES[request.policyId];
      if (!policy) return reply({ error: "POLICY_UNKNOWN" }, 422);
      return reply({
        policyId: request.policyId,
        mode: "SIMULATION",
        results: gateAgentRun(
          policy,
          request.proposals.map((p) => ({
            ...p,
            tx: parseNearTransaction(p.tx),
          })),
        ),
      });
    }
    if (request.action === "chat-draft") return reply(chatDraft(request.draft));
    if (request.action === "chat-token") return reply(chatToken(request.check));
    if (request.action === "intents-tokens")
      return reply({
        tokens: await intentsTokens(fetch, Date.now(), req.signal),
      });
    if (request.action === "intents-verify")
      return reply(
        await reviewSignedQuote(
          request.request,
          request.response,
          request.sender,
          req.signal,
        ),
      );
    // A live dry quote reaches the upstream: it has its own, smaller allowance.
    await rateGuard(req, "guardian-intents", 10);
    await assetsFor(request.request, req.signal);
    const { raw } = await intentsDryQuote(request.request, fetch, req.signal);
    const reviewed = await reviewSignedQuote(
      request.request,
      raw,
      request.sender,
      req.signal,
    );
    return reply({
      ...reviewed,
      signed: raw,
      ...(request.narrate
        ? { narration: await narrate(reviewed.verdict, request.locale ?? "en") }
        : {}),
    });
  } catch (e) {
    const code =
      e instanceof IntentsError
        ? e.code
        : e instanceof z.ZodError || e instanceof SyntaxError
          ? "INVALID_REQUEST"
          : e &&
              typeof e === "object" &&
              "code" in e &&
              typeof e.code === "string" &&
              /^[A-Z][A-Z0-9_]{0,39}$/.test(e.code)
            ? e.code
            : "INVALID_REQUEST";
    return reply(
      { error: code },
      code === "INVALID_REQUEST" ||
        code === "INTENTS_REJECTED" ||
        code === "INTENTS_INVALID"
        ? 422
        : code === "INTENTS_UNAVAILABLE"
          ? 502
          : code === "INTENTS_AUTH_REQUIRED"
            ? 424
            : guardStatus(code),
    );
  }
}
