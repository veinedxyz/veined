import { randomBytes, randomUUID } from "node:crypto";
import { digest } from "./hash";
import {
  PointsError,
  taskInputSchema,
  verifiedActivitySchema,
  type AccountFlag,
  type ActivityRecord,
  type ActivityStatus,
  type FlagKind,
  type ReferralCode,
  type SeasonRecord,
  type TaskCompletion,
  type TaskRecord,
  type VerifiedActivity,
} from "./model";
import { minConfirmations, resolvePolicy, type WeightPolicy } from "./policy";
import { seasonAt, seasonWindow, withinProgram } from "./season";
import type { ProgramConfig } from "./config";
import type { PointsStore } from "./store";
import { parseUnits } from "./units";
// The points engine: trusted activity ingestion, referral binding, task verification and admin flags.
// Settlement lives in settlement.ts; user/admin projections in views.ts.

export interface EngineContext {
  store: PointsStore;
  config: ProgramConfig;
  clock: () => Date;
}
export type IngestResult =
  | ActivityStatus
  | "DUPLICATE_REPLAY"
  | "FINALITY_UPDATED"
  | "CONFLICT"
  | "IGNORED";

const CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32: no I, L, O, U
export const REFERRAL_CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const FUTURE_SKEW_MS = 5 * 60_000;
const byOccurrence = (a: ActivityRecord, b: ActivityRecord) => {
  const d = Date.parse(a.event.occurredAt) - Date.parse(b.event.occurredAt);
  if (d) return d;
  return a.event.eventId < b.event.eventId
    ? -1
    : a.event.eventId > b.event.eventId
      ? 1
      : 0;
};
// The identity of a verified operation: everything except the mutable confirmation count / finalized flag.
const identityHash = (e: VerifiedActivity) =>
  digest({
    ...e,
    finality: {
      blockNumber: e.finality.blockNumber,
      blockHash: e.finality.blockHash,
    },
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// A season whose ledger has not been written yet; anything built on reversed or cancelled input is voided there.
const unpaid = (s: SeasonRecord | null) =>
  !!s && s.state !== "FINALIZED" && s.state !== "PUBLISHED";

export class PointsEngine {
  constructor(readonly ctx: EngineContext) {}
  get store() {
    return this.ctx.store;
  }
  get config() {
    return this.ctx.config;
  }
  now() {
    return this.ctx.clock();
  }
  iso() {
    return this.now().toISOString();
  }
  assertOperational() {
    if (!this.config.operational)
      throw new PointsError("PROGRAM_NOT_ACTIVE", 503);
  }
  audit(
    actor: string,
    action: string,
    target: string,
    details: Record<string, unknown> = {},
  ) {
    return this.store.appendAudit({
      at: this.iso(),
      actor,
      action,
      target,
      details,
    });
  }

  /** Creates the season record on first touch, freezing the policy version and hash in force at that moment. */
  async ensureSeason(season: number): Promise<SeasonRecord> {
    const window = seasonWindow(this.config.schedule, season);
    const existing = await this.store.getSeason(season);
    if (existing) {
      if (
        existing.startsAt !== window.startsAt ||
        existing.endsAt !== window.endsAt
      )
        throw new PointsError("SCHEDULE_DRIFT", 500);
      return existing;
    }
    // Only a season that has started (or season 1 before launch) gets a record: freezing the current policy into a
    // future season early would defeat a later, owner-approved policy change for that season.
    if (season > Math.max(1, this.currentSeason()))
      throw new PointsError("SEASON_NOT_STARTED", 409);
    const record: SeasonRecord = {
      season,
      ...window,
      state: "OPEN",
      version: 1,
      configHash: this.config.configHash,
      policyVersion: this.config.policyVersion,
      policyHash: this.config.policyHash,
      rejectedCalculations: [],
      corrections: [],
    };
    if (await this.store.insertSeason(record))
      await this.audit("system", "SEASON_OPENED", `season:${season}`, {
        policyVersion: record.policyVersion,
        policyHash: record.policyHash,
        configHash: record.configHash,
        ...window,
      });
    return (await this.store.getSeason(season))!;
  }
  async seasonPolicy(
    season: number,
  ): Promise<{ policy: WeightPolicy; hash: string; record: SeasonRecord }> {
    const record = await this.ensureSeason(season);
    try {
      const { policy, hash } = resolvePolicy(
        record.policyVersion,
        record.policyHash,
      );
      return { policy, hash, record };
    } catch {
      throw new PointsError("POLICY_DRIFT", 500);
    }
  }
  currentSeason() {
    return seasonAt(this.config.schedule, this.now());
  }

  // ---------- trusted activity ingestion ----------
  async ingest(
    raw: unknown,
    verifier: string,
  ): Promise<{ result: IngestResult; record: ActivityRecord | null }> {
    this.assertOperational();
    if (!this.config.trustedVerifiers.includes(verifier)) {
      await this.audit(
        `verifier:${verifier}`,
        "ACTIVITY_UNTRUSTED_VERIFIER",
        "activity",
        {},
      );
      throw new PointsError("VERIFIER_NOT_TRUSTED", 403);
    }
    const parsed = verifiedActivitySchema.safeParse(raw);
    if (!parsed.success) throw new PointsError("EVENT_INVALID");
    const event = parsed.data;
    if (event.verifier !== verifier)
      throw new PointsError("VERIFIER_MISMATCH", 403);
    const contentHash = identityHash(event);
    const existing = await this.store.getActivity(event.eventId);
    if (existing) {
      if (existing.contentHash !== contentHash) {
        await this.audit(
          `verifier:${verifier}`,
          "ACTIVITY_CONFLICT",
          event.eventId,
          {
            stored: existing.contentHash,
            received: contentHash,
          },
        );
        return { result: "CONFLICT", record: existing };
      }
      // An exact replay never changes anything; a replay carrying more confirmations is a finality update.
      if (
        existing.status === "PENDING_FINALITY" &&
        (event.finality.finalized !== existing.event.finality.finalized ||
          event.finality.confirmations > existing.event.finality.confirmations)
      )
        return this.updateFinality(event.eventId, event.finality, verifier);
      return { result: "DUPLICATE_REPLAY", record: existing };
    }
    const now = this.now();
    const season = seasonAt(this.config.schedule, event.occurredAt);
    let status: ActivityStatus = "REJECTED";
    let reason: string | undefined;
    if (season < 1 || !withinProgram(this.config.schedule, event.occurredAt))
      reason = "OUTSIDE_PROGRAM";
    else if (Date.parse(event.occurredAt) > now.getTime() + FUTURE_SKEW_MS)
      reason = "FUTURE_TIMESTAMP";
    else if (
      event.category === "BRIDGE"
        ? event.outcome !== "COMPLETED"
        : event.outcome !== "SETTLED"
    )
      reason = `OUTCOME_${event.outcome}`;
    else if (
      event.category === "BRIDGE" &&
      event.bridge?.destinationVerified !== true
    )
      reason = "BRIDGE_DESTINATION_UNVERIFIED";
    else {
      const { policy, record } = await this.seasonPolicy(season);
      if (record.state !== "OPEN") reason = "SEASON_CLOSED";
      else if (!policy.categories[event.category].enabled)
        reason = "CATEGORY_DISABLED";
      else if (
        parseUnits(event.volumeUsdMicros) <
        parseUnits(policy.volume.minEligibleUsdMicros)
      )
        reason = "BELOW_MINIMUM_VOLUME";
      else
        status =
          event.finality.finalized ||
          event.finality.confirmations >=
            minConfirmations(policy, event.chainId)
            ? "ELIGIBLE"
            : "PENDING_FINALITY";
    }
    const at = now.toISOString();
    const record: ActivityRecord = {
      event,
      contentHash,
      season,
      status,
      reason,
      receivedAt: at,
      updatedAt: at,
      revision: 1,
    };
    let inserted = await this.store.insertActivity(record);
    if (inserted === "OPERATION_EXISTS") {
      // The same settlement reported again under another id or category: kept for audit, never counted.
      record.status = "REJECTED";
      record.reason = "DUPLICATE_OPERATION";
      inserted = await this.store.insertActivity(record);
    }
    if (inserted === "EVENT_EXISTS") return this.ingest(raw, verifier);
    await this.audit(
      `verifier:${verifier}`,
      `ACTIVITY_${record.status}`,
      event.eventId,
      {
        season,
        reason: record.reason,
        category: event.category,
        account: event.account,
        operationKey: event.operationKey,
      },
    );
    if (record.status === "ELIGIBLE") await this.onEligible(record);
    return {
      result: record.status,
      record: await this.store.getActivity(event.eventId),
    };
  }

  async updateFinality(
    eventId: string,
    finality: VerifiedActivity["finality"],
    verifier: string,
  ): Promise<{ result: IngestResult; record: ActivityRecord | null }> {
    this.assertOperational();
    const record = await this.store.getActivity(eventId);
    if (!record) throw new PointsError("EVENT_NOT_FOUND", 404);
    if (record.event.verifier !== verifier)
      throw new PointsError("VERIFIER_MISMATCH", 403);
    if (record.status === "REJECTED" || record.status === "REVERSED")
      return { result: "IGNORED", record };
    if (
      finality.blockHash !== record.event.finality.blockHash ||
      finality.blockNumber !== record.event.finality.blockNumber
    )
      return this.reverse(eventId, "REORG_BLOCK_CHANGED", verifier);
    const next: ActivityRecord = structuredClone(record);
    next.event.finality = {
      ...finality,
      confirmations: Math.max(
        finality.confirmations,
        record.event.finality.confirmations,
      ),
      finalized: finality.finalized || record.event.finality.finalized,
    };
    next.revision++;
    next.updatedAt = this.iso();
    let promoted = false;
    if (record.status === "PENDING_FINALITY") {
      const { policy, record: season } = await this.seasonPolicy(record.season);
      const final =
        next.event.finality.finalized ||
        next.event.finality.confirmations >=
          minConfirmations(policy, record.event.chainId);
      if (final && season.state === "OPEN") {
        next.status = "ELIGIBLE";
        promoted = true;
      } else if (final) {
        next.status = "REJECTED";
        next.reason = "LATE_FINALITY";
        next.afterFinalization =
          season.state === "FINALIZED" || season.state === "PUBLISHED";
      }
    }
    if (!(await this.store.updateActivity(eventId, record.revision, next)))
      return this.updateFinality(eventId, finality, verifier);
    await this.audit(`verifier:${verifier}`, "ACTIVITY_FINALITY", eventId, {
      status: next.status,
      confirmations: next.event.finality.confirmations,
      finalized: next.event.finality.finalized,
    });
    if (promoted) await this.onEligible(next);
    return {
      result: promoted ? "ELIGIBLE" : "FINALITY_UPDATED",
      record: await this.store.getActivity(eventId),
    };
  }

  /** Reorganisation, removal or later failure reported by the verifier. Never deletes; never rewrites a payout. */
  async reverse(
    eventId: string,
    reason: string,
    verifier: string,
  ): Promise<{ result: IngestResult; record: ActivityRecord | null }> {
    this.assertOperational();
    const record = await this.store.getActivity(eventId);
    if (!record) throw new PointsError("EVENT_NOT_FOUND", 404);
    if (record.event.verifier !== verifier)
      throw new PointsError("VERIFIER_MISMATCH", 403);
    if (record.status === "REVERSED" || record.status === "REJECTED")
      return { result: "IGNORED", record };
    const season =
      record.season > 0 ? await this.store.getSeason(record.season) : null;
    const wasEligible = record.status === "ELIGIBLE";
    const next: ActivityRecord = {
      ...structuredClone(record),
      status: "REVERSED",
      reason: reason.replace(/[^A-Z0-9_]/g, "").slice(0, 48) || "REVERSED",
      revision: record.revision + 1,
      updatedAt: this.iso(),
      afterFinalization:
        wasEligible &&
        (season?.state === "FINALIZED" || season?.state === "PUBLISHED"),
    };
    if (!(await this.store.updateActivity(eventId, record.revision, next)))
      return this.reverse(eventId, reason, verifier);
    // Task completions built on this event are voided unless their season is already paid (FINALIZED/PUBLISHED).
    // Voiding inside a calculated season changes its input hash, so that review becomes stale and is redone.
    for (const c of await this.store.listCompletions({
      account: record.event.account,
    }))
      if (
        c.eventIds.includes(eventId) &&
        (c.status === "APPROVED" || c.status === "PENDING_REVIEW")
      ) {
        if (unpaid(await this.store.getSeason(c.season)))
          await this.store.updateCompletion(c.id, c.revision, {
            ...c,
            status: "VOIDED",
            reason: "EVENT_REVERSED",
            revision: c.revision + 1,
          });
      }
    await this.audit(`verifier:${verifier}`, "ACTIVITY_REVERSED", eventId, {
      reason: next.reason,
      season: record.season,
      seasonState: season?.state ?? null,
      afterFinalization: !!next.afterFinalization,
    });
    return { result: "REVERSED", record: next };
  }

  private async onEligible(record: ActivityRecord) {
    if (record.event.attribution?.referralCode) await this.bindReferral(record);
    await this.evaluateTasks(record);
  }

  // ---------- referrals ----------
  private async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const owner = randomUUID();
    for (let attempt = 0; attempt < 80; attempt++) {
      const token = await this.store.acquireLock(
        name,
        owner,
        10_000,
        this.now(),
      );
      if (token !== null)
        try {
          return await fn();
        } finally {
          await this.store.releaseLock(name, token);
        }
      await sleep(25);
    }
    throw new PointsError("LOCK_BUSY", 409);
  }

  private async bindReferral(record: ActivityRecord) {
    const child = record.event.account;
    const code = (record.event.attribution?.referralCode ?? "")
      .trim()
      .toUpperCase();
    const result = await this.withLock("points:referral-graph", async () => {
      if (await this.store.getBinding(child)) return "ALREADY_BOUND";
      if (!REFERRAL_CODE.test(code)) return "INVALID_CODE";
      const owner = await this.store.getReferralCode(code);
      if (!owner) return "INVALID_CODE";
      const parent = owner.account;
      if (parent === child) return "SELF_REFERRAL";
      if ((await this.excluded()).has(parent)) return "REFERRER_EXCLUDED";
      // Only accounts without earlier verified activity can be referred: existing users cannot be captured.
      const prior = (await this.store.listActivities({ account: child })).some(
        (r) =>
          r.event.eventId !== record.event.eventId &&
          (r.status === "ELIGIBLE" || r.status === "PENDING_FINALITY") &&
          byOccurrence(r, record) < 0,
      );
      if (prior) return "PRIOR_ACTIVITY";
      // Cycle guard (unreachable under the prior-activity rule, enforced independently).
      let cursor: string | undefined = parent;
      for (let depth = 0; cursor && depth < 10_000; depth++) {
        if (cursor === child) return "CYCLE";
        cursor = (await this.store.getBinding(cursor))?.parent;
      }
      const inserted = await this.store.insertBinding({
        child,
        parent,
        code,
        bindingEventId: record.event.eventId,
        effectiveAt: record.event.occurredAt,
        createdAt: this.iso(),
      });
      return inserted === "INSERTED" ? "BOUND" : "ALREADY_BOUND";
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      const current = await this.store.getActivity(record.event.eventId);
      if (!current) break;
      if (
        await this.store.updateActivity(
          current.event.eventId,
          current.revision,
          {
            ...current,
            attributionResult: result,
            revision: current.revision + 1,
          },
        )
      )
        break;
    }
    await this.audit(
      "system",
      result === "BOUND" ? "REFERRAL_BOUND" : "REFERRAL_NOT_BOUND",
      child,
      {
        code,
        result,
        eventId: record.event.eventId,
      },
    );
    return result;
  }

  /** The account's code, created on first request when the account is eligible. */
  async referralCode(
    account: string,
    create: boolean,
  ): Promise<ReferralCode | null> {
    this.assertOperational();
    const existing = await this.store.getReferralCodeByAccount(account);
    if (existing || !create) return existing;
    if (!(await this.codeEligible(account)))
      throw new PointsError("REFERRAL_CODE_NOT_ELIGIBLE", 403);
    for (let attempt = 0; attempt < 8; attempt++) {
      const code = [...randomBytes(8)]
        .map((b) => CODE_ALPHABET[b & 31])
        .join("");
      const result = await this.store.insertReferralCode({
        code,
        account,
        createdAt: this.iso(),
      });
      if (result === "INSERTED") {
        await this.audit("system", "REFERRAL_CODE_CREATED", account, {});
        return this.store.getReferralCodeByAccount(account);
      }
      if (result === "ACCOUNT_HAS_CODE")
        return this.store.getReferralCodeByAccount(account);
    }
    throw new PointsError("REFERRAL_CODE_UNAVAILABLE", 503);
  }
  async codeEligible(account: string) {
    if ((await this.excluded()).has(account)) return false;
    const { policy } = await this.seasonPolicy(
      Math.max(1, this.currentSeason()),
    );
    if (!policy.referral.codeRequiresVerifiedActivity) return true;
    return (await this.store.listActivities({ account })).some(
      (r) => r.status === "ELIGIBLE",
    );
  }

  // ---------- flags ----------
  async excluded() {
    return new Set(
      (await this.store.listFlags())
        .filter((f) => f.active && f.kind === "EXCLUDED")
        .map((f) => f.account),
    );
  }
  async setFlag(
    actor: string,
    account: string,
    kind: FlagKind,
    active: boolean,
    reason: string,
  ) {
    const flag: AccountFlag = {
      account,
      kind,
      active,
      reason: reason.slice(0, 200),
      createdBy: actor,
      createdAt: this.iso(),
    };
    await this.store.putFlag(flag);
    await this.audit(
      actor,
      active ? "ACCOUNT_FLAGGED" : "ACCOUNT_UNFLAGGED",
      account,
      { kind, reason: flag.reason },
    );
    return flag;
  }

  // ---------- periodic tasks ----------
  private matches(task: TaskRecord, e: VerifiedActivity) {
    const t = Date.parse(e.occurredAt);
    return (
      t >= Date.parse(task.startsAt) &&
      t < Date.parse(task.endsAt) &&
      (!task.criteria.category || task.criteria.category === e.category) &&
      (!task.criteria.chainIds ||
        task.criteria.chainIds.includes(e.chainId) ||
        (!!e.bridge &&
          task.criteria.chainIds.includes(e.bridge.destinationChainId))) &&
      (!task.criteria.minEventVolumeUsdMicros ||
        parseUnits(e.volumeUsdMicros) >=
          parseUnits(task.criteria.minEventVolumeUsdMicros))
    );
  }

  /** Server-side completion: only ELIGIBLE verified activity, each event used at most once per task. */
  private async evaluateTasks(record: ActivityRecord) {
    const account = record.event.account;
    for (const task of await this.store.listTasks()) {
      if (task.status !== "APPROVED" || !this.matches(task, record.event))
        continue;
      for (let guard = 0; guard < task.perUserLimit; guard++) {
        const all = await this.store.listCompletions({ taskId: task.id });
        const counted = all.filter(
          (c) => c.status !== "REJECTED" && c.status !== "VOIDED",
        );
        const mine = all.filter((c) => c.account === account);
        if (
          counted.filter((c) => c.account === account).length >=
          task.perUserLimit
        )
          break;
        const used = new Set(counted.flatMap((c) => c.eventIds));
        const candidates = (await this.store.listActivities({ account }))
          .filter(
            (r) =>
              r.status === "ELIGIBLE" &&
              !used.has(r.event.eventId) &&
              this.matches(task, r.event),
          )
          .sort(byOccurrence);
        if (candidates.length < task.criteria.minCount) break;
        const chosen = candidates.slice(0, task.criteria.minCount);
        const completedAt = chosen.at(-1)!.event.occurredAt;
        const season = seasonAt(this.config.schedule, completedAt);
        if ((await this.store.getSeason(season))?.state !== "OPEN") break;
        const ordinal = mine.length + 1;
        const completion: TaskCompletion = {
          id: `${task.id}:${account}:${ordinal}`,
          taskId: task.id,
          account,
          ordinal,
          season,
          completedAt,
          eventIds: chosen.map((r) => r.event.eventId),
          weight: task.weight,
          status: task.requiresReview ? "PENDING_REVIEW" : "APPROVED",
          revision: 1,
        };
        const result = await this.store.insertCompletion(completion, {
          perUser: task.perUserLimit,
          global: task.globalLimit,
        });
        await this.audit(
          "system",
          result === "INSERTED" ? "TASK_COMPLETED" : "TASK_COMPLETION_REFUSED",
          completion.id,
          {
            result,
            status: completion.status,
            eventIds: completion.eventIds,
          },
        );
        if (result !== "INSERTED") break;
      }
    }
  }

  async createTask(actor: string, raw: unknown) {
    this.assertOperational();
    const parsed = taskInputSchema.safeParse(raw);
    if (!parsed.success) throw new PointsError("TASK_INVALID");
    if (parseUnits(parsed.data.weight) <= 0n)
      throw new PointsError("TASK_WEIGHT_INVALID");
    const task: TaskRecord = {
      ...parsed.data,
      status: "DRAFT",
      version: 1,
      createdBy: actor,
      createdAt: this.iso(),
    };
    if ((await this.store.insertTask(task)) !== "INSERTED")
      throw new PointsError("TASK_EXISTS", 409);
    await this.audit(actor, "TASK_DRAFTED", task.id, { task: parsed.data });
    return task;
  }
  /** Owner-approved activation: four-eyes, never retroactive. */
  async approveTask(actor: string, id: string) {
    this.assertOperational();
    const task = await this.store.getTask(id);
    if (!task) throw new PointsError("TASK_NOT_FOUND", 404);
    if (task.status !== "DRAFT")
      throw new PointsError("TASK_STATE_INVALID", 409);
    if (task.createdBy === actor)
      throw new PointsError("FOUR_EYES_REQUIRED", 403);
    if (Date.parse(task.startsAt) < this.now().getTime())
      throw new PointsError("TASK_RETROACTIVE", 409);
    const next: TaskRecord = {
      ...task,
      status: "APPROVED",
      version: task.version + 1,
      approvedBy: actor,
      approvedAt: this.iso(),
    };
    if (!(await this.store.updateTask(id, task.version, next)))
      throw new PointsError("CONFLICT", 409);
    await this.audit(actor, "TASK_APPROVED", id, {
      createdBy: task.createdBy,
      weight: task.weight,
    });
    return next;
  }
  async cancelTask(actor: string, id: string, reason: string) {
    this.assertOperational();
    const task = await this.store.getTask(id);
    if (!task) throw new PointsError("TASK_NOT_FOUND", 404);
    if (task.status === "CANCELLED") return task;
    const next: TaskRecord = {
      ...task,
      status: "CANCELLED",
      version: task.version + 1,
      cancelledBy: actor,
      cancelledAt: this.iso(),
    };
    if (!(await this.store.updateTask(id, task.version, next)))
      throw new PointsError("CONFLICT", 409);
    let voided = 0;
    for (const c of await this.store.listCompletions({ taskId: id }))
      if (
        (c.status === "APPROVED" || c.status === "PENDING_REVIEW") &&
        unpaid(await this.store.getSeason(c.season))
      )
        if (
          await this.store.updateCompletion(c.id, c.revision, {
            ...c,
            status: "VOIDED",
            reason: "TASK_CANCELLED",
            revision: c.revision + 1,
          })
        )
          voided++;
    await this.audit(actor, "TASK_CANCELLED", id, {
      reason: reason.slice(0, 200),
      voided,
    });
    return next;
  }
  async reviewCompletion(
    actor: string,
    id: string,
    approve: boolean,
    reason: string,
  ) {
    this.assertOperational();
    const completion = (await this.store.listCompletions({})).find(
      (c) => c.id === id,
    );
    if (!completion) throw new PointsError("COMPLETION_NOT_FOUND", 404);
    if (completion.status !== "PENDING_REVIEW")
      throw new PointsError("COMPLETION_STATE_INVALID", 409);
    if ((await this.store.getSeason(completion.season))?.state !== "OPEN")
      throw new PointsError("SEASON_CLOSED", 409);
    const next: TaskCompletion = {
      ...completion,
      status: approve ? "APPROVED" : "REJECTED",
      reviewedBy: actor,
      reason: reason.slice(0, 200),
      revision: completion.revision + 1,
    };
    if (!(await this.store.updateCompletion(id, completion.revision, next)))
      throw new PointsError("CONFLICT", 409);
    await this.audit(
      actor,
      approve ? "TASK_COMPLETION_APPROVED" : "TASK_COMPLETION_REJECTED",
      id,
      {},
    );
    return next;
  }
}
