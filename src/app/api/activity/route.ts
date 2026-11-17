import { randomUUID } from "node:crypto";
import { activityInput } from "../../../activity/model";
import { verifyTransaction, ActivityError } from "../../../activity/verify";
import { apiGuard, guardStatus } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { RoutingError } from "../../../routing/model";
export const runtime = "nodejs";
export async function POST(req: Request) {
  const requestId = randomUUID(),
    headers = {
      "Cache-Control": "private, no-store",
      "X-Request-Id": requestId,
    };
  try {
    await apiGuard(req, "activity-import", 30);
    const input = activityInput.parse(JSON.parse(await boundedBody(req, 2048)));
    return Response.json(
      { transaction: await verifyTransaction(input), requestId },
      { headers },
    );
  } catch (e) {
    const error =
      e instanceof ActivityError
        ? e.code
        : e instanceof RoutingError
          ? e.code
          : "INVALID_REQUEST";
    // No address/hash/payload in logs. Source and stable error codes are enough to diagnose failures.
    if (e instanceof ActivityError)
      console.warn(
        JSON.stringify({
          scope: "activity-import",
          requestId,
          error,
          sources: e.sources,
        }),
      );
    return Response.json(
      {
        error,
        requestId,
        ...(e instanceof ActivityError ? { sources: e.sources } : {}),
      },
      {
        status:
          e instanceof ActivityError
            ? error === "ADDRESS_NOT_INVOLVED"
              ? 422
              : 503
            : guardStatus(error),
        headers,
      },
    );
  }
}
