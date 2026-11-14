import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { BridgeError, addressSchema, recordSchema } from "../../../core/model";
import { balances } from "../../../adapters/read-only";
import {
  liveQuote,
  nativeHealth,
  nativeTrack,
} from "../../../adapters/native-service";
import { currentMode, localAllowed } from "../../../server/config";
import { boundedBody } from "../../../server/body";
import { checkOrigin } from "../../../server/origin-policy";
import { rateGuard } from "../../../server/api-guard";
import { RoutingError } from "../../../routing/model";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const input = z.discriminatedUnion("action", [
  z.object({ action: z.literal("health") }).strict(),
  z.object({ action: z.literal("balance"), account: addressSchema }).strict(),
  z
    .object({
      action: z.literal("quote"),
      account: addressSchema,
      amount: z.string().max(80),
    })
    .strict(),
  z.object({ action: z.literal("track"), record: recordSchema }).strict(),
]);
export async function GET() {
  return NextResponse.json(
    { mode: currentMode(), submission: false, version: "1" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
// Every bridge response (balances, records, errors) is private and never cached.
export async function POST(req: NextRequest) {
  const response = await handlePost(req);
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
async function handlePost(req: NextRequest): Promise<Response> {
  let validatedInput = false;
  try {
    // Shared exact-origin policy; this route keeps its accepted 422 envelope for rejections.
    const verdict = checkOrigin(req);
    if (verdict !== "OK") throw new BridgeError(verdict);
    try {
      await rateGuard(req, "bridge", 120);
    } catch (e) {
      const code =
        e instanceof RoutingError ? e.code : "RATE_LIMIT_UNAVAILABLE";
      return NextResponse.json(
        { error: code },
        { status: code === "RATE_LIMITED" ? 429 : 503 },
      );
    }
    const raw = await boundedBody(req);
    const data = input.parse(JSON.parse(raw));
    validatedInput = true;
    if (localAllowed(req.headers.get("host") ?? "")) {
      const local = await import("../../../../tests/fixtures/local");
      if (data.action === "health")
        return NextResponse.json({
          mode: "local-test",
          status: "local",
          observedAt: Date.now(),
          reasons: ["SYNTHETIC_TEST_ONLY"],
        });
      if (data.action === "balance")
        return NextResponse.json({
          balance: (100n * 10n ** 18n).toString(),
          bnb: "0",
          sourceCode: "0x",
          destinationCode: "0x",
        });
      if (data.action === "quote")
        return new NextResponse(
          JSON.stringify(
            local.localQuote(data.account, data.amount),
            (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
          ),
          {
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "no-store",
            },
          },
        );
      if (data.record.mode !== "local-test")
        throw new BridgeError("MODE_MISMATCH");
      return NextResponse.json({
        kind: "synthetic",
        record: local.localTrack(data.record),
        observedAt: Date.now(),
      });
    }
    if (data.action === "health")
      return NextResponse.json(await nativeHealth());
    if (data.action === "balance")
      return NextResponse.json(await balances(data.account));
    if (data.action === "quote")
      return new NextResponse(
        JSON.stringify(
          await liveQuote(data.account, data.amount),
          (_key, value) =>
            typeof value === "bigint" ? value.toString() : value,
        ),
        {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        },
      );
    if (data.action === "track") {
      if (data.record.mode !== "mainnet-readonly")
        throw new BridgeError("MODE_MISMATCH");
      return NextResponse.json(await nativeTrack(data.record));
    }
    throw new BridgeError("UNSUPPORTED_ROUTE");
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof BridgeError
            ? e.code
            : validatedInput
              ? "INVALID_RESPONSE"
              : "INVALID_REQUEST",
      },
      { status: 422 },
    );
  }
}
