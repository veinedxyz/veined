// VEINED-MC1 (BRIDGE LANE): the bridge lane's server route. In this build the lane is DISARMED: every action except
// "bridge-lane-status" answers 403 WRITE_DISABLED before the runtime is touched — nothing is quoted, nothing is read
// from a chain, nothing is journaled, nothing signable is built (verify-safety rule 13, bridge part, pins this order).
// Only a LOCAL armed variant (127.0.0.1) can reach the engine. Same exact-origin, JSON, size and rate guards as
// /api/swap-lane. The engine serves the one pair its protected record names; no request field selects or changes a pair.
import { z } from "zod";
import { guardStatus, originGuard, rateGuard } from "../../../server/api-guard";
import { boundedBody } from "../../../server/body";
import { wire } from "../../../swap/model";
import { bridgeLaneGateState } from "../../../swap/lane/bridge-approval";
import { BRIDGE_LANE_PAIRS } from "../../../swap/lane/bridge-scope";
import {
  bridgeLaneArmed,
  bridgeLaneRuntime,
} from "../../../swap/lane/bridge-runtime";

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
  z.object({ action: z.literal("bridge-lane-status") }).strict(),
  z.object({ action: z.literal("bridge-lane-review"), ownerKey: KEY }).strict(),
  z
    .object({
      action: z.literal("bridge-lane-authorize"),
      reviewId: z.string().regex(/^0x[0-9a-f]{32}$/),
      ownerKey: KEY,
    })
    .strict(),
  z
    .object({
      action: z.literal("bridge-lane-dispatch"),
      token: z.string().min(16).max(2000),
      ownerKey: KEY,
    })
    .strict(),
  z.object({ action: z.literal("bridge-lane-track") }).strict(),
  // review MINOR-5: the lane's own zero-allowance CLEANUP (decided by the engine; WRITE_DISABLED here)
  z.object({ action: z.literal("bridge-lane-revoke"), ownerKey: KEY }).strict(),
]);
// The pair table (public facts only: id, chains, status, the exact amount and minimum). The armed record's pair is the
// gate's `scope` (null while disarmed).
const PAIRS = Object.freeze(
  Object.values(BRIDGE_LANE_PAIRS).map((p) =>
    Object.freeze({
      id: p.id,
      sourceChainId: p.source,
      destinationChainId: p.destination,
      status: p.status,
      blockReason: p.blockReason,
      exactAmount: p.exactAmount.toString(),
      minimumOut: p.minimumOut.toString(),
      maxCostBps: p.maxCostBps,
    }),
  ),
);
const status = () => {
  const a = bridgeLaneArmed();
  return {
    lane: "BRIDGE",
    armed: a.armed,
    reasons: a.reasons,
    gate: bridgeLaneGateState(),
    pairs: PAIRS,
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
    await rateGuard(req, "bridge-lane", 30);
    const r = schema.parse(raw);
    if (r.action === "bridge-lane-status") return reply(status());
    if (!bridgeLaneArmed().armed) {
      guardStatus("WRITE_DISABLED");
      return reply(
        { error: "WRITE_DISABLED", gate: bridgeLaneGateState() },
        403,
      );
    }
    const lane = bridgeLaneRuntime();
    switch (r.action) {
      case "bridge-lane-review":
        return reply(await lane.review(r.ownerKey));
      case "bridge-lane-authorize":
        return reply({ token: lane.authorize(r.reviewId, r.ownerKey) });
      case "bridge-lane-dispatch":
        return reply(await lane.dispatch(r.token, r.ownerKey));
      case "bridge-lane-track":
        return reply(await lane.track());
      case "bridge-lane-revoke":
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
