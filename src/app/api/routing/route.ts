import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { routingCore } from "../../../adapters/routing-core";
import { boundedBody } from "../../../server/body";
import {
  originGuard,
  rateGuard,
  guardStatus,
  refreshAllowed,
} from "../../../server/api-guard";
import {
  quoteInputSchema,
  RoutingError,
  executionGate,
} from "../../../routing/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const chain = z.string().regex(/^\d{1,18}$/);
const schema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("catalog"), refresh: z.boolean().optional() })
    .strict(),
  z
    .object({
      action: z.literal("connections"),
      source: chain,
      destination: chain,
    })
    .strict(),
  z.object({ action: z.literal("assets"), chain }).strict(),
  z.object({ action: z.literal("quote"), input: quoteInputSchema }).strict(),
  z
    .object({
      action: z.literal("status"),
      context: quoteInputSchema
        .extend({ minimum: z.string().regex(/^\d{1,78}$/) })
        .optional(),
      source: chain,
      destination: chain,
      hash: z
        .string()
        .regex(
          /^(0x[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{64,90}|[0-9a-fA-F]{64})$/,
        ),
    })
    .strict(),
]);
export function GET() {
  return NextResponse.json(
    {
      mode: "mainnet-readonly",
      provider: "routing-core",
      execution: executionGate,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(req: NextRequest) {
  const reply = (body: unknown, status = 200) =>
    NextResponse.json(body, {
      status,
      headers: { "Cache-Control": "no-store" },
    });
  try {
    originGuard(req);
    await rateGuard(req, "routing", 90);
    const input = schema.parse(JSON.parse(await boundedBody(req)));
    if (input.action === "quote") {
      await rateGuard(req, "routing-quote", 60, 7200);
      return reply(await routingCore.getQuotes(input.input, req.signal));
    }
    if (input.action === "catalog")
      return reply(
        await routingCore.listNetworks(
          req.signal,
          !!input.refresh && (await refreshAllowed("routing")),
        ),
      );
    if (input.action === "connections")
      return reply(
        await routingCore.getConnections(
          input.source,
          input.destination,
          req.signal,
        ),
      );
    if (input.action === "assets")
      return reply(await routingCore.getAssets(input.chain, req.signal));
    return reply(await routingCore.getStatus(input, req.signal));
  } catch (e) {
    const error =
      e instanceof RoutingError
        ? e.code
        : e instanceof z.ZodError
          ? "INVALID_REQUEST"
          : "PROVIDER_UNAVAILABLE";
    return reply({ error }, guardStatus(error));
  }
}
