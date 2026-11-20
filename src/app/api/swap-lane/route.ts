// VEINED-FIN-LIVE-20261115-01: the swap lane's server route (SWAP-LIVE-01). In this build the lane is DISARMED:
// every action except "swap-lane-status" answers 403 WRITE_DISABLED before the runtime is touched — nothing is read
// from a chain, nothing is journaled, nothing signable is built (verify-safety rule 13 pins this order). Only a LOCAL
// armed variant (127.0.0.1) can reach the engine. Same exact-origin, JSON, size and rate guards as /api/execution.
// The engine serves the one route its protected record names; no request field selects or changes a route.
import { z } from "zod";
import { guardStatus, originGuard, rateGuard } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { wire } from "../../../swap/model";
import { swapLaneGateState } from "../../../swap/lane/approval";
import { SWAP_LANE_ROUTES } from "../../../swap/lane/scope";
import { swapLaneArmed, swapLaneRuntime } from "../../../swap/lane/runtime";

export const dynamic = "force-dynamic";
const GUARD_CODES = new Set([
  "ORIGIN_REJECTED",
  "RATE_LIMITED",
  "RATE_LIMIT_UNAVAILABLE",
  "CONFIG_INVALID",
]);
const reply = (value: unknown, status = 200) =>
  new Response(wire(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const KEY = z.string().regex(/^[0-9a-f]{64}$/);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("swap-lane-status") }).strict(),
  z.object({ action: z.literal("swap-lane-review"), ownerKey: KEY }).strict(),
  z
    .object({
      action: z.literal("swap-lane-authorize"),
      reviewId: z.string().regex(/^0x[0-9a-f]{32}$/),
      ownerKey: KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal("swap-lane-dispatch"),
      token: z.string().min(16).max(2000),
      ownerKey: KEY,
    })
    .strict(),
  z.object({ action: z.literal("swap-lane-track") }).strict(),
  // VEINED-MC1 review MINOR-5: the lane's own zero-allowance CLEANUP (decided by the engine; WRITE_DISABLED here)
  z.object({ action: z.literal("swap-lane-revoke"), ownerKey: KEY }).strict(),
]);
// The route table (public facts only: id, chain, status, the 1-unit maximum). The armed record's route is the gate's
// `scope` (null while disarmed).
const ROUTES = Object.freeze(
  Object.values(SWAP_LANE_ROUTES).map((r) =>
    Object.freeze({
      id: r.id,
      chainId: r.chainId,
      status: r.status,
      blockReason: r.blockReason,
      maxAmount: r.maxAmount.toString(),
    }),
  ),
);
const status = () => {
  const a = swapLaneArmed();
  return {
    lane: "SWAP",
    armed: a.armed,
    reasons: a.reasons,
    gate: swapLaneGateState(),
    routes: ROUTES,
  };
};
export function GET() {
  return reply(status());
}
export async function POST(req: Request) {
  try {
    originGuard(req);
    if (!req.headers.get("content-type")?.startsWith("application/json"))
      return reply({ error: "INVALID_REQUEST" }, 400);
    const raw = JSON.parse(await boundedBody(req, 8000)) as unknown;
    await rateGuard(req, "swap-lane", 30);
    const r = schema.parse(raw);
    if (r.action === "swap-lane-status") return reply(status());
    if (!swapLaneArmed().armed) {
      guardStatus("WRITE_DISABLED");
      return reply({ error: "WRITE_DISABLED", gate: swapLaneGateState() }, 403);
    }
    const lane = swapLaneRuntime();
    switch (r.action) {
      case "swap-lane-review":
        return reply(await lane.review(r.ownerKey));
      case "swap-lane-authorize":
        return reply({ token: lane.authorize(r.reviewId, r.ownerKey) });
      case "swap-lane-dispatch":
        return reply(await lane.dispatch(r.token, r.ownerKey));
      case "swap-lane-track":
        return reply(await lane.track());
      case "swap-lane-revoke":
        return reply(await lane.revoke(r.ownerKey));
    }
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
    const detail =
      e && typeof e === "object" && "detail" in e && Array.isArray(e.detail)
        ? (e.detail as unknown[]).map(String).slice(0, 32)
        : [];
    return reply(
      { error: code, detail },
      code === "WRITE_DISABLED"
        ? 403
        : code === "INVALID_REQUEST"
          ? 400
          : GUARD_CODES.has(code)
            ? guardStatus(code)
            : 409,
    );
  }
}
