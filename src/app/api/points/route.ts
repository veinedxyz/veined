import type { NextRequest } from "next/server";
import { z } from "zod";
import { boundedBody } from "../../../server/body";
import { apiGuard, rateGuard } from "../../../server/api-guard";
import { accountSchema, PointsError } from "../../../points/model";
import { failure, reply } from "../../../points/http";
import { pointsService } from "../../../points/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Public points API. Every answer comes from PointsViews' public projections: schedule, published seasons,
// referral relations and task status. Live-season points, weights and ranks are not reachable from here.
const season = z.number().int().min(1).max(100_000);
const schema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("overview"),
      account: accountSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("leaderboard"),
      season,
      account: accountSchema.optional(),
    })
    .strict(),
  z.object({ action: z.literal("history"), account: accountSchema }).strict(),
  z
    .object({ action: z.literal("tasks"), account: accountSchema.optional() })
    .strict(),
  z
    .object({ action: z.literal("referral-code"), account: accountSchema })
    .strict(),
]);

export async function POST(req: NextRequest) {
  try {
    await apiGuard(req, "points", 60);
    const input = schema.parse(JSON.parse(await boundedBody(req, 2000)));
    const { views, engine, config } = await pointsService();
    if (input.action === "overview")
      return reply(await views.overview(input.account));
    if (!config.operational) throw new PointsError("PROGRAM_NOT_ACTIVE", 503);
    if (input.action === "leaderboard") {
      const board = await views.leaderboard(input.season, input.account);
      if (!board) throw new PointsError("SEASON_NOT_PUBLISHED", 404);
      return reply(board);
    }
    if (input.action === "history")
      return reply({ seasons: await views.history(input.account) });
    if (input.action === "tasks")
      return reply({ tasks: await views.tasks(input.account) });
    await rateGuard(req, "points-referral-code", 10);
    const code = await engine.referralCode(input.account, true);
    return reply({ code: code!.code, path: `/points?ref=${code!.code}` });
  } catch (error) {
    return failure(error);
  }
}
