import type { NextRequest } from "next/server";
import { z } from "zod";
import { boundedBody } from "../../../../server/body";
import { originGuard, rateGuard } from "../../../../server/api-guard";
import {
  authenticate,
  permitted,
  type AdminAction,
} from "../../../../points/admin-auth";
import {
  accountSchema,
  CATEGORIES,
  OUTCOMES,
  PointsError,
} from "../../../../points/model";
import { simulatedEvent } from "../../../../points/fixtures";
import { failure, reply } from "../../../../points/http";
import { pointsService } from "../../../../points/service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Admin points API: owner-configured bearer principals only (src/points/admin-auth.ts), least-privilege roles,
// four-eyes enforced by the engine, every refusal and every state change in the hash-chained audit log.
// Simulation actions exist only in an isolated, non-production simulation build.
const season = z.number().int().min(1).max(100_000);
const text = z.string().trim().min(3).max(200);
const schema = z.discriminatedUnion("action", [
  z
    .object({ action: z.literal("dashboard"), season: season.optional() })
    .strict(),
  z
    .object({ action: z.literal("explain"), account: accountSchema, season })
    .strict(),
  z.object({ action: z.literal("calculate"), season }).strict(),
  z.object({ action: z.literal("reject"), season, reason: text }).strict(),
  z
    .object({
      action: z.literal("finalize"),
      season,
      calculationId: z.string().regex(/^calc-[0-9a-f]{24}$/),
    })
    .strict(),
  z.object({ action: z.literal("publish"), season }).strict(),
  z
    .object({ action: z.literal("retain-undistributed"), season, note: text })
    .strict(),
  z
    .object({
      action: z.literal("flag"),
      account: accountSchema,
      kind: z.enum(["EXCLUDED", "REVIEW"]),
      active: z.boolean(),
      reason: text,
    })
    .strict(),
  z.object({ action: z.literal("task-create"), task: z.unknown() }).strict(),
  z
    .object({ action: z.literal("task-approve"), id: z.string().max(48) })
    .strict(),
  z
    .object({
      action: z.literal("task-cancel"),
      id: z.string().max(48),
      reason: text,
    })
    .strict(),
  z
    .object({
      action: z.literal("completion-review"),
      id: z.string().max(140),
      approve: z.boolean(),
      reason: text,
    })
    .strict(),
  z
    .object({
      action: z.literal("correction-propose"),
      season,
      eventId: z.string().max(128),
    })
    .strict(),
  z
    .object({
      action: z.literal("correction-decide"),
      id: z.string().max(80),
      apply: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("sim-ingest"),
      account: accountSchema,
      category: z.enum(CATEGORIES),
      usd: z.number().min(0).max(1e12),
      outcome: z.enum(OUTCOMES).optional(),
      referralCode: z.string().max(16).optional(),
      confirmations: z.number().int().min(0).max(10_000).optional(),
      minutesAgo: z
        .number()
        .int()
        .min(0)
        .max(60 * 24 * 60)
        .optional(),
      operation: z
        .string()
        .regex(/^[a-z0-9-]{1,40}$/)
        .optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("sim-finality"),
      eventId: z.string().max(128),
      confirmations: z.number().int().min(0).max(10_000),
      finalized: z.boolean(),
    })
    .strict(),
  z
    .object({ action: z.literal("sim-reverse"), eventId: z.string().max(128) })
    .strict(),
  z
    .object({
      action: z.literal("sim-clock"),
      advanceSeconds: z
        .number()
        .int()
        .min(60)
        .max(60 * 24 * 3600),
    })
    .strict(),
]);
let simulatedSequence = 0;

export async function POST(req: NextRequest) {
  try {
    originGuard(req);
    await rateGuard(req, "points-admin", 120);
    const service = await pointsService();
    const { engine, settlement, views, config, admin } = service;
    if (!admin.principals.length)
      throw new PointsError("ADMIN_NOT_CONFIGURED", 503);
    const principal = authenticate(
      req.headers.get("authorization"),
      admin.principals,
    );
    if (!principal) {
      await engine.audit("anonymous", "ADMIN_AUTH_FAILED", "admin", {});
      throw new PointsError("UNAUTHORIZED", 401);
    }
    if (!req.headers.get("content-type")?.startsWith("application/json"))
      throw new PointsError("INVALID_REQUEST");
    const input = schema.parse(JSON.parse(await boundedBody(req, 16_000)));
    const action = input.action as AdminAction;
    if (!permitted(principal, action)) {
      await engine.audit(principal.id, "ADMIN_FORBIDDEN", action, {});
      throw new PointsError("FORBIDDEN", 403);
    }
    if (action.startsWith("sim-") && !service.simulation)
      throw new PointsError("NOT_FOUND", 404);
    const actor = principal.id;
    const who = { id: principal.id, roles: principal.roles };
    if (input.action === "dashboard") {
      if (!config.operational)
        return reply({
          principal: who,
          config: {
            operational: false,
            errors: config.errors,
            simulation: config.simulation,
          },
        });
      return reply({
        principal: who,
        ...(await views.adminDashboard(input.season)),
      });
    }
    engine.assertOperational();
    switch (input.action) {
      case "explain":
        return reply(await views.adminExplain(input.account, input.season));
      case "calculate":
        return reply(await settlement.calculate(input.season, actor));
      case "reject":
        return reply(
          await settlement.reject(input.season, actor, input.reason),
        );
      case "finalize":
        return reply(
          await settlement.finalize(input.season, actor, input.calculationId),
        );
      case "publish":
        return reply(await settlement.publish(input.season, actor));
      case "retain-undistributed":
        return reply(
          await settlement.retainUndistributed(input.season, actor, input.note),
        );
      case "flag":
        return reply(
          await engine.setFlag(
            actor,
            input.account,
            input.kind,
            input.active,
            input.reason,
          ),
        );
      case "task-create":
        return reply(await engine.createTask(actor, input.task));
      case "task-approve":
        return reply(await engine.approveTask(actor, input.id));
      case "task-cancel":
        return reply(await engine.cancelTask(actor, input.id, input.reason));
      case "completion-review":
        return reply(
          await engine.reviewCompletion(
            actor,
            input.id,
            input.approve,
            input.reason,
          ),
        );
      case "correction-propose":
        return reply(
          await settlement.proposeCorrection(
            input.season,
            input.eventId,
            actor,
          ),
        );
      case "correction-decide":
        return reply(
          await settlement.decideCorrection(input.id, actor, input.apply),
        );
      case "sim-ingest": {
        const occurredAt = new Date(
          engine.now().getTime() - (input.minutesAgo ?? 0) * 60_000,
        ).toISOString();
        const event = simulatedEvent({
          id: `sim-${engine.now().getTime().toString(36)}-${++simulatedSequence}`,
          account: input.account,
          category: input.category,
          occurredAt,
          usd: input.usd,
          outcome: input.outcome,
          operation: input.operation,
          referralCode: input.referralCode,
          confirmations: input.confirmations,
          finalized: input.confirmations === undefined ? true : false,
        });
        return reply(await engine.ingest(event, event.verifier));
      }
      case "sim-finality": {
        const record = await engine.store.getActivity(input.eventId);
        if (!record) throw new PointsError("EVENT_NOT_FOUND", 404);
        return reply(
          await engine.updateFinality(
            input.eventId,
            {
              ...record.event.finality,
              confirmations: input.confirmations,
              finalized: input.finalized,
            },
            record.event.verifier,
          ),
        );
      }
      case "sim-reverse": {
        const record = await engine.store.getActivity(input.eventId);
        if (!record) throw new PointsError("EVENT_NOT_FOUND", 404);
        return reply(
          await engine.reverse(
            input.eventId,
            "REORG_BLOCK_CHANGED",
            record.event.verifier,
          ),
        );
      }
      case "sim-clock": {
        service.simulation!.offsetMs += input.advanceSeconds * 1000;
        await engine.audit(actor, "SIMULATION_CLOCK_ADVANCED", "clock", {
          advanceSeconds: input.advanceSeconds,
        });
        return reply({
          now: engine.iso(),
          offsetMs: service.simulation!.offsetMs,
        });
      }
    }
  } catch (error) {
    return failure(error);
  }
}
