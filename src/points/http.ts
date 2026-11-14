import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { PointsError } from "./model";
import { guardStatus } from "../server/api-guard";
// Shared response helpers for the points route handlers: no-store everywhere, stable error codes only.

export const NO_STORE = {
  "Cache-Control": "no-store, max-age=0",
  Pragma: "no-cache",
  "X-Robots-Tag": "noindex, nofollow",
};
export const reply = (body: unknown, status = 200) =>
  NextResponse.json(body, { status, headers: NO_STORE });

export function failure(error: unknown) {
  if (error instanceof PointsError)
    return reply({ error: error.code }, error.status);
  if (error instanceof ZodError || error instanceof SyntaxError)
    return reply({ error: "INVALID_REQUEST" }, 422);
  const code =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code
      : "";
  if (/^[A-Z][A-Z0-9_]{2,39}$/.test(code)) {
    const status =
      code === "REQUEST_TOO_LARGE"
        ? 413
        : code === "REQUEST_TIMEOUT"
          ? 408
          : guardStatus(code);
    return reply({ error: code }, status);
  }
  return reply({ error: "POINTS_UNAVAILABLE" }, 503);
}
