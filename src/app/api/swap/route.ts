import { z } from "zod";
import { apiGuard, guardStatus } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { EXECUTION, parseIntent, SwapError, wire } from "../../../swap/model";
import { swapService } from "../../../swap/server/service";
import { gateSwap, GuardianBlocked } from "../../../guardian/server/swap-gate";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const requestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("quote"), intent: z.unknown() }).strict(),
  z
    .object({
      action: z.literal("review"),
      id: z.string().regex(/^[a-f0-9]{64}$/),
      intent: z.unknown(),
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
  return reply({ execution: EXECUTION });
}
export async function POST(req: Request) {
  try {
    await apiGuard(req, "swap", 30);
    const request = requestSchema.parse(JSON.parse(await boundedBody(req)));
    const intent = parseIntent(request.intent);
    if (request.action === "review") {
      // Guardian gates the review on the server too: a BLOCK verdict (before the build, from the intent; after it,
      // from the reviewed quote) refuses the review for every caller, not only in VEINED's own panel.
      gateSwap(intent);
      const reviewed = await swapService().review(
        request.id,
        intent,
        AbortSignal.any([req.signal, AbortSignal.timeout(8000)]),
      );
      const verdict = gateSwap(intent, reviewed.quote);
      return reply({
        ...reviewed,
        guardian: {
          policy: verdict.policy,
          level: verdict.level,
          digest: verdict.digest,
        },
      });
    }
    const abort = new AbortController(),
      signal = AbortSignal.any([req.signal, abort.signal]);
    const stream = new ReadableStream({
      start(controller) {
        void swapService()
          .quote(intent, signal, (e) => {
            if (!signal.aborted)
              controller.enqueue(new TextEncoder().encode(wire(e) + "\n"));
          })
          .catch(() => {})
          .finally(() => {
            try {
              controller.close();
            } catch {}
          });
      },
      cancel() {
        abort.abort();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    if (e instanceof GuardianBlocked)
      return reply({ error: "GUARDIAN_BLOCKED", verdict: e.verdict }, 403);
    const code =
      e instanceof SwapError
        ? e.code
        : e instanceof z.ZodError
          ? "INVALID_REQUEST"
          : e &&
              typeof e === "object" &&
              "code" in e &&
              typeof e.code === "string" &&
              [
                "INVALID_REQUEST",
                "RATE_LIMITED",
                "ORIGIN_REJECTED",
                "CONFIG_INVALID",
                "RATE_LIMIT_UNAVAILABLE",
              ].includes(e.code)
            ? e.code
            : "PROVIDER_UNAVAILABLE";
    return reply(
      { error: code },
      code === "INVALID_REQUEST"
        ? 422
        : code === "QUOTE_STALE"
          ? 409
          : code === "EXECUTION_CLOSED"
            ? 403
            : guardStatus(code),
    );
  }
}
