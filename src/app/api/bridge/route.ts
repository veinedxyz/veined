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
let requests = 0;
let windowStart = 0;
export async function GET() {
  return NextResponse.json(
    { mode: currentMode(), submission: false, version: "1" },
    { headers: { "Cache-Control": "no-store" } },
  );
}
export async function POST(req: NextRequest) {
  let validatedInput = false;
  try {
    const origin = new URL(
      req.headers.get("origin") ?? "https://invalid.example",
    );
    const host = req.headers.get("host");
    if (
      ![
        "127.0.0.1:3100",
        "localhost:3100",
        "127.0.0.1:3101",
        "localhost:3101",
      ].includes(host ?? "") ||
      origin.host !== host ||
      origin.protocol !== "http:"
    )
      throw new BridgeError("ORIGIN_REJECTED");
    if (Date.now() - windowStart > 60000) {
      windowStart = Date.now();
      requests = 0;
    }
    if (++requests > 120)
      return NextResponse.json({ error: "RATE_LIMITED" }, { status: 429 });
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
