import { profileManual } from "../../../manual-wallet/server/performance";
import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { manualLane } from "../../../manual-wallet/protocol";
import { MANUAL_WALLET_RELEASED } from "../../../manual-wallet/release";
import { manualAccount } from "../../../manual-wallet/server/runtime";
import { rateGuard } from "../../../server/api-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ORIGIN = "http://127.0.0.1:3470";
const COOKIE = "veined_manual_session";
const g = globalThis as typeof globalThis & {
  __manualSessions?: Map<
    string,
    { csrf: string; expires: number; account?: string }
  >;
};
const sessions = (g.__manualSessions ??= new Map());
const response = (body: unknown, status = 200) =>
  NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
function local(request: NextRequest) {
  // Next's proxy may normalize the internal request URL. The HTTP Host and POST Origin remain exact.
  if (request.headers.get("host") !== "127.0.0.1:3470")
    throw Error("MANUAL_LOOPBACK_ONLY");
}
export async function GET(request: NextRequest) {
  try {
    local(request);
    if (request.headers.get("sec-fetch-site") === "cross-site")
      throw Error("MANUAL_ORIGIN_REFUSED");
    await rateGuard(request, "manual-session", 30);
    for (const [id, s] of sessions)
      if (s.expires < Date.now()) sessions.delete(id);
    const existing = request.cookies.get(COOKIE)?.value;
    if (existing) sessions.delete(existing);
    if (sessions.size >= 128) throw Error("MANUAL_SESSION_LIMIT");
    const id = randomBytes(32).toString("hex");
    sessions.set(id, {
      csrf: randomBytes(32).toString("hex"),
      expires: Date.now() + 8 * 3600_000,
    });
    const reply = response({
      csrf: sessions.get(id)!.csrf,
      released: MANUAL_WALLET_RELEASED,
      source: 8453,
      routes: ["base-usdc-weth-univ3-max1", "bridge-8453-42161"],
    });
    reply.cookies.set(COOKIE, id, {
      httpOnly: true,
      sameSite: "strict",
      path: "/api/manual-wallet",
      maxAge: 8 * 3600,
    });
    return reply;
  } catch (error) {
    const code = (error as Error).message;
    return response(
      { error: code === "RATE_LIMITED" ? code : "MANUAL_LOOPBACK_ONLY" },
      code === "RATE_LIMITED" ? 429 : 403,
    );
  }
}
export async function POST(request: NextRequest) {
  try {
    local(request);
    if (
      request.headers.get("origin") !== ORIGIN ||
      request.headers.get("sec-fetch-site") === "cross-site" ||
      request.headers.get("content-type") !== "application/json"
    )
      throw Error("MANUAL_ORIGIN_REFUSED");
    const session = sessions.get(request.cookies.get(COOKIE)?.value ?? "");
    if (
      !session ||
      session.expires <= Date.now() ||
      request.headers.get("x-manual-csrf") !== session.csrf
    )
      throw Error("MANUAL_SESSION_REQUIRED");
    if (Number(request.headers.get("content-length")) > 8192)
      throw Error("MANUAL_BODY_LIMIT");
    const reader = request.body?.getReader();
    if (!reader) throw Error("MANUAL_BODY_INVALID");
    let size = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw Error("MANUAL_BODY_LIMIT");
      }
      chunks.push(value);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
      string,
      unknown
    >;
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw Error("MANUAL_BODY_INVALID");
    if (
      Object.keys(body).some(
        (k) =>
          ![
            "action",
            "lane",
            "account",
            "chainId",
            "reviewId",
            "id",
            "outcome",
            "hash",
          ].includes(k),
      )
    )
      throw Error("MANUAL_UNEXPECTED_FIELD");
    const lane = manualLane(body.lane);
    if (
      !["review", "prepare", "claim", "result", "track"].includes(
        String(body.action),
      )
    )
      throw Error("MANUAL_ACTION_UNSUPPORTED");
    if (body.action === "claim" && !MANUAL_WALLET_RELEASED)
      throw Error("OWNER_RELEASE_REQUIRED");
    await rateGuard(request, "manual-operations", 90);
    if (body.action === "review") await rateGuard(request, "manual-review", 12);
    if (typeof body.account !== "string") throw Error("WALLET_NOT_CONNECTED");
    if (session.account && session.account !== body.account.toLowerCase())
      throw Error("MANUAL_SESSION_ACCOUNT_CHANGED");
    session.account = body.account.toLowerCase();
    const account = await manualAccount(body.account, body.chainId);
    switch (body.action) {
      case "review": {
        const profiled = await profileManual(() => account.review(lane));
        return response({ review: profiled.value, timing: profiled.timing });
      }
      case "prepare":
        return response({ preparation: account.prepare(lane, body.reviewId) });
      case "claim":
        return response({ preparation: await account.claim(lane, body.id) });
      case "result":
        return response({
          result: await account.result(lane, body.id, body.outcome, body.hash),
        });
      case "track":
        return response({ tracking: await account.track(lane) });
      default:
        throw Error("MANUAL_ACTION_UNSUPPORTED");
    }
  } catch (e) {
    const raw = e as { code?: string; message?: string; detail?: unknown };
    const code = raw.code ?? raw.message ?? "MANUAL_REQUEST_FAILED";
    // Never return upstream error messages, URLs or credentials.
    return response(
      {
        error: /^[A-Z][A-Z0-9_:]*$/.test(code) ? code : "MANUAL_REQUEST_FAILED",
        detail: Array.isArray(raw.detail)
          ? raw.detail.filter(
              (x) => typeof x === "string" && /^[A-Z0-9_:]+$/.test(x),
            )
          : [],
      },
      code === "RATE_LIMITED"
        ? 429
        : code === "RATE_LIMIT_UNAVAILABLE"
          ? 503
          : 409,
    );
  }
}
