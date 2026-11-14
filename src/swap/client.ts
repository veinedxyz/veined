import { z } from "zod";
import {
  ERRORS,
  MODES,
  quoteSchema,
  SwapError,
  wire,
  type QuoteEvent,
  type SwapIntent,
} from "./model";
const health = z
  .object({
    mode: z.enum(MODES),
    status: z.enum(["PENDING", "OK", ...ERRORS]),
    latencyMs: z.number().nullable(),
    quoteCount: z.number(),
  })
  .strict();
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("providers"),
    providers: z.array(health).max(12),
  }),
  z.object({ type: z.literal("health"), health }),
  z.object({ type: z.literal("quote"), quote: quoteSchema }),
  z.object({ type: z.literal("settled"), elapsedMs: z.number() }),
]);
export async function streamQuotes(
  i: SwapIntent,
  signal: AbortSignal,
  onEvent: (event: QuoteEvent) => void,
) {
  const r = await fetch("/api/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: wire({ action: "quote", intent: i }),
    signal,
  });
  if (!r.ok || !r.body) throw new SwapError("PROVIDER_UNAVAILABLE");
  const reader = r.body.getReader(),
    decoder = new TextDecoder();
  let buffer = "",
    total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 2_000_000) throw new SwapError("INVALID_SCHEMA");
      buffer += decoder.decode(value, { stream: true });
      let n;
      while ((n = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, n);
        buffer = buffer.slice(n + 1);
        if (line) {
          const e = eventSchema.safeParse(JSON.parse(line));
          if (!e.success) throw new SwapError("INVALID_SCHEMA");
          if (!signal.aborted) onEvent(e.data);
        }
      }
    }
    if (buffer.trim()) throw new SwapError("INVALID_SCHEMA");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
