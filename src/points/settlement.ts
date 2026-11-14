import { randomUUID } from "node:crypto";
import { allocate, type AllocatedLine } from "./allocation";
import type { PointsEngine } from "./engine";
import { digest } from "./hash";
import {
  PointsError,
  type AllocationSummary,
  type CalculationRecord,
  type CorrectionRecord,
  type LedgerEntry,
  type SeasonRecord,
} from "./model";
import { buildLines, type ExplainLine, type SeasonInputs } from "./weights";
import { REFERRAL_COMMISSION_BPS } from "./units";
// Deterministic weekly settlement: OPEN -> CALCULATING -> REVIEW_PENDING -> FINALIZED -> PUBLISHED.
// Preview never writes. Calculation is lock-fenced and idempotent on its input hash. Finalization requires a
// second principal, re-derives the result from current inputs (stale or irreproducible results are refused) and
// commits the ledger with the weekly budget check in one store operation. Published results are never recalculated;
// a later reversal becomes an explicit, approved clawback correction.

const LOCK_TTL_MS = 120_000;
export interface Computation {
  season: number;
  inputHash: string;
  policyVersion: string;
  policyHash: string;
  calculationId: string;
  resultHash: string;
  summary: AllocationSummary;
  entries: LedgerEntry[];
  lines: AllocatedLine[];
  explain: ExplainLine[];
}
export interface LeaderboardRow {
  rank: number;
  account: string;
  activityUnits: string;
  taskUnits: string;
  referralUnits: string;
  totalUnits: string;
}

/** Standard competition ranking by total (desc), ties ordered by account; deterministic. */
export function leaderboard(entries: readonly LedgerEntry[]): LeaderboardRow[] {
  const rows = new Map<
    string,
    { activity: bigint; task: bigint; referral: bigint }
  >();
  for (const e of entries) {
    if (e.kind === "CORRECTION") continue;
    const row = rows.get(e.account) ?? { activity: 0n, task: 0n, referral: 0n };
    const amount = BigInt(e.amountUnits);
    if (e.kind === "ACTIVITY") row.activity += amount;
    else if (e.kind === "TASK") row.task += amount;
    else row.referral += amount;
    rows.set(e.account, row);
  }
  const sorted = [...rows.entries()]
    .map(([account, r]) => ({
      account,
      ...r,
      total: r.activity + r.task + r.referral,
    }))
    .sort((a, b) =>
      a.total !== b.total
        ? a.total > b.total
          ? -1
          : 1
        : a.account < b.account
          ? -1
          : a.account > b.account
            ? 1
            : 0,
    );
  let rank = 0;
  return sorted.map((r, i) => {
    if (i === 0 || r.total !== sorted[i - 1].total) rank = i + 1;
    return {
      rank,
      account: r.account,
      activityUnits: r.activity.toString(),
      taskUnits: r.task.toString(),
      referralUnits: r.referral.toString(),
      totalUnits: r.total.toString(),
    };
  });
}

export class Settlement {
  constructor(private engine: PointsEngine) {}
  private get store() {
    return this.engine.store;
  }
  private get pool() {
    return BigInt(this.engine.config.poolUnits);
  }

  async inputs(season: number) {
    const { policy, hash, record } = await this.engine.seasonPolicy(season);
    const activities = await this.store.listActivities({ season });
    const completions = await this.store.listCompletions({ season });
    const tasks = new Map((await this.store.listTasks()).map((t) => [t.id, t]));
    const allBindings = await this.store.listBindings();
    const excludedAll = await this.engine.excluded();
    const eligible = activities.filter((r) => r.status === "ELIGIBLE");
    const approved = completions.filter((c) => c.status === "APPROVED");
    const accounts = new Set([
      ...eligible.map((r) => r.event.account),
      ...approved.map((c) => c.account),
    ]);
    const bindings = new Map(
      allBindings.filter((b) => accounts.has(b.child)).map((b) => [b.child, b]),
    );
    const relevant = new Set([
      ...accounts,
      ...[...bindings.values()].map((b) => b.parent),
    ]);
    const excluded = new Set([...excludedAll].filter((a) => relevant.has(a)));
    const inputs: SeasonInputs = {
      policy,
      activities,
      completions,
      tasks,
      bindings,
      excluded,
    };
    // Only what can change the result is hashed, so live activity in later seasons never stales this season.
    const inputHash = digest({
      season,
      configHash: record.configHash,
      policyHash: hash,
      activities: eligible.map((r) => [r.event.eventId, r.contentHash]).sort(),
      completions: approved.map((c) => [c.id, c.weight, c.eventIds]).sort(),
      tasks: [...new Set(approved.map((c) => c.taskId))]
        .sort()
        .map((id) => [id, tasks.get(id)?.status ?? null]),
      bindings: [...bindings.values()]
        .map((b) => [b.child, b.parent, b.effectiveAt])
        .sort(),
      excluded: [...excluded].sort(),
    });
    return { inputs, inputHash, policyHash: hash, record };
  }

  async compute(season: number): Promise<Computation> {
    const { inputs, inputHash, policyHash, record } = await this.inputs(season);
    const { lines, explain } = buildLines(inputs);
    const allocation = allocate(this.pool, lines, REFERRAL_COMMISSION_BPS);
    const calculationId = `calc-${digest({ season, inputHash, policyHash }).slice(0, 24)}`;
    // Entries carry the season close as their timestamp, so the result hash is reproducible bit for bit.
    const entries: LedgerEntry[] = allocation.lines
      .filter((l) => l.amount > 0n)
      .map((l) => ({
        id: `s${season}:${l.lineId}`,
        season,
        account: l.account,
        kind: l.kind,
        amountUnits: l.amount.toString(),
        sourceRef: l.sourceRef,
        ...(l.sourceAccount ? { sourceAccount: l.sourceAccount } : {}),
        calculationId,
        createdAt: record.endsAt,
      }));
    const summary: AllocationSummary = {
      poolUnits: this.pool.toString(),
      denominator: allocation.denominator.toString(),
      allocatedUnits: allocation.allocatedUnits.toString(),
      commissionUnits: allocation.commissionUnits.toString(),
      residualUnits: (lines.length ? allocation.residualUnits : 0n).toString(),
      undistributedUnits: allocation.residualUnits.toString(),
      accounts: new Set(entries.map((e) => e.account)).size,
      lines: lines.length,
    };
    const resultHash = digest({
      season,
      inputHash,
      policyHash,
      entries,
      summary,
    });
    return {
      season,
      inputHash,
      policyVersion: record.policyVersion,
      policyHash,
      calculationId,
      resultHash,
      summary,
      entries,
      lines: allocation.lines,
      explain,
    };
  }

  /** Admin-only projection; never persisted, never awards anything. Allowed for the live season. */
  preview(season: number) {
    return this.compute(season);
  }

  private async lock<T>(
    season: number,
    fn: (token: number, name: string) => Promise<T>,
  ) {
    const name = `points:settlement:${season}`;
    const token = await this.store.acquireLock(
      name,
      randomUUID(),
      LOCK_TTL_MS,
      this.engine.now(),
    );
    if (token === null) throw new PointsError("SETTLEMENT_LOCKED", 409);
    try {
      return await fn(token, name);
    } finally {
      await this.store.releaseLock(name, token);
    }
  }
  private readyAt(record: SeasonRecord, graceSeconds: number) {
    return Date.parse(record.endsAt) + graceSeconds * 1000;
  }

  async calculate(
    season: number,
    actor: string,
  ): Promise<{ calculation: CalculationRecord; idempotent: boolean }> {
    this.engine.assertOperational();
    const { policy, record } = await this.engine.seasonPolicy(season);
    if (
      this.engine.now().getTime() <
      this.readyAt(record, policy.finality.graceSeconds)
    )
      throw new PointsError("SEASON_NOT_CLOSED", 409);
    if (record.calculation && ["FINALIZED", "PUBLISHED"].includes(record.state))
      return { calculation: record.calculation, idempotent: true };
    if (record.state === "REVIEW_PENDING" && record.calculation) {
      const { inputHash } = await this.inputs(season);
      if (inputHash === record.calculation.inputHash)
        return { calculation: record.calculation, idempotent: true };
      throw new PointsError("CALCULATION_STALE", 409);
    }
    return this.lock(season, async (token, name) => {
      const current = (await this.store.getSeason(season))!;
      const abandoned =
        current.state === "CALCULATING" &&
        Date.parse(current.calculationStartedAt ?? "1970-01-01T00:00:00Z") +
          LOCK_TTL_MS <=
          this.engine.now().getTime();
      if (current.state !== "OPEN" && !abandoned) {
        if (current.state === "CALCULATING")
          throw new PointsError("SETTLEMENT_LOCKED", 409);
        return this.calculate(season, actor);
      }
      const started: SeasonRecord = {
        ...current,
        state: "CALCULATING",
        version: current.version + 1,
        fence: token,
        calculationStartedAt: this.engine.iso(),
      };
      if (!(await this.store.updateSeason(season, current.version, started)))
        throw new PointsError("SETTLEMENT_CONFLICT", 409);
      try {
        const c = await this.compute(season);
        const fresh = (await this.store.getSeason(season))!;
        if (
          !(await this.store.checkLock(name, token, this.engine.now())) ||
          fresh.fence !== token ||
          fresh.state !== "CALCULATING"
        )
          throw new PointsError("LOCK_LOST", 409);
        const calculation: CalculationRecord = {
          id: c.calculationId,
          season,
          inputHash: c.inputHash,
          policyVersion: c.policyVersion,
          policyHash: c.policyHash,
          resultHash: c.resultHash,
          calculatedBy: actor,
          calculatedAt: this.engine.iso(),
          summary: c.summary,
          entries: c.entries,
        };
        const next: SeasonRecord = {
          ...fresh,
          state: "REVIEW_PENDING",
          version: fresh.version + 1,
          calculation,
          undistributed: {
            units: c.summary.undistributedUnits,
            decision: "PENDING_OWNER_DECISION",
          },
        };
        if (!(await this.store.updateSeason(season, fresh.version, next)))
          throw new PointsError("SETTLEMENT_CONFLICT", 409);
        await this.engine.audit(
          actor,
          "SETTLEMENT_CALCULATED",
          `season:${season}`,
          {
            calculationId: calculation.id,
            inputHash: calculation.inputHash,
            resultHash: calculation.resultHash,
            policyVersion: calculation.policyVersion,
            summary: calculation.summary,
          },
        );
        return { calculation, idempotent: false };
      } catch (error) {
        const fresh = await this.store.getSeason(season);
        if (fresh?.state === "CALCULATING" && fresh.fence === token)
          await this.store.updateSeason(season, fresh.version, {
            ...fresh,
            state: "OPEN",
            version: fresh.version + 1,
          });
        throw error;
      }
    });
  }

  async reject(season: number, actor: string, reason: string) {
    this.engine.assertOperational();
    const record = await this.store.getSeason(season);
    if (!record || record.state !== "REVIEW_PENDING" || !record.calculation)
      throw new PointsError("SEASON_STATE_INVALID", 409);
    const next: SeasonRecord = {
      ...record,
      state: "OPEN",
      version: record.version + 1,
      calculation: undefined,
      undistributed: undefined,
      rejectedCalculations: [
        ...record.rejectedCalculations,
        record.calculation.id,
      ],
    };
    if (!(await this.store.updateSeason(season, record.version, next)))
      throw new PointsError("SETTLEMENT_CONFLICT", 409);
    await this.engine.audit(actor, "SETTLEMENT_REJECTED", `season:${season}`, {
      calculationId: record.calculation.id,
      reason: reason.slice(0, 200),
    });
    return next;
  }

  async finalize(
    season: number,
    actor: string,
    calculationId: string,
  ): Promise<{ season: SeasonRecord; idempotent: boolean }> {
    this.engine.assertOperational();
    const record = await this.store.getSeason(season);
    if (!record?.calculation)
      throw new PointsError("SEASON_STATE_INVALID", 409);
    if (["FINALIZED", "PUBLISHED"].includes(record.state)) {
      if (record.calculation.id === calculationId)
        return { season: record, idempotent: true };
      throw new PointsError("CALCULATION_MISMATCH", 409);
    }
    if (record.state !== "REVIEW_PENDING")
      throw new PointsError("SEASON_STATE_INVALID", 409);
    if (record.calculation.id !== calculationId)
      throw new PointsError("CALCULATION_MISMATCH", 409);
    if (record.calculation.calculatedBy === actor)
      throw new PointsError("FOUR_EYES_REQUIRED", 403);
    return this.lock(
      season,
      async (): Promise<{ season: SeasonRecord; idempotent: boolean }> => {
        const current = (await this.store.getSeason(season))!;
        if (
          current.state !== "REVIEW_PENDING" ||
          current.calculation?.id !== calculationId
        )
          return this.finalize(season, actor, calculationId);
        const calc = current.calculation;
        const fresh = await this.compute(season);
        if (fresh.inputHash !== calc.inputHash)
          throw new PointsError("CALCULATION_STALE", 409);
        if (fresh.resultHash !== calc.resultHash)
          throw new PointsError("RESULT_NOT_REPRODUCIBLE", 500);
        const next: SeasonRecord = {
          ...current,
          state: "FINALIZED",
          version: current.version + 1,
          finalizedAt: this.engine.iso(),
          finalizedBy: actor,
        };
        const result = await this.store.commitFinalization(
          season,
          current.version,
          next,
          calc.entries,
          this.pool,
        );
        if (result !== "COMMITTED") {
          await this.engine.audit(
            actor,
            "SETTLEMENT_FINALIZE_REFUSED",
            `season:${season}`,
            { result },
          );
          if (result === "VERSION_CONFLICT")
            return this.finalize(season, actor, calculationId);
          throw new PointsError(
            result,
            result === "BUDGET_EXCEEDED" ? 500 : 409,
          );
        }
        await this.engine.audit(
          actor,
          "SETTLEMENT_FINALIZED",
          `season:${season}`,
          {
            calculationId,
            calculatedBy: calc.calculatedBy,
            approvedBy: actor,
            resultHash: calc.resultHash,
            ledgerEntries: calc.entries.length,
            allocatedUnits: calc.summary.allocatedUnits,
            undistributedUnits: calc.summary.undistributedUnits,
          },
        );
        return { season: next, idempotent: false };
      },
    );
  }

  async publish(
    season: number,
    actor: string,
  ): Promise<{ season: SeasonRecord; idempotent: boolean }> {
    this.engine.assertOperational();
    const record = await this.store.getSeason(season);
    if (record?.state === "PUBLISHED")
      return { season: record, idempotent: true };
    if (record?.state !== "FINALIZED")
      throw new PointsError("SEASON_STATE_INVALID", 409);
    const next: SeasonRecord = {
      ...record,
      state: "PUBLISHED",
      version: record.version + 1,
      publishedAt: this.engine.iso(),
      publishedBy: actor,
    };
    if (!(await this.store.updateSeason(season, record.version, next)))
      return this.publish(season, actor);
    await this.engine.audit(actor, "SEASON_PUBLISHED", `season:${season}`, {
      calculationId: record.calculation?.id,
      resultHash: record.calculation?.resultHash,
    });
    return { season: next, idempotent: false };
  }

  /** The only decision available: keep it unallocated. Undistributed points never enlarge another week. */
  async retainUndistributed(season: number, actor: string, note: string) {
    this.engine.assertOperational();
    const record = await this.store.getSeason(season);
    if (
      !record ||
      !["FINALIZED", "PUBLISHED"].includes(record.state) ||
      !record.undistributed
    )
      throw new PointsError("SEASON_STATE_INVALID", 409);
    if (record.undistributed.decision !== "PENDING_OWNER_DECISION")
      return record;
    const next: SeasonRecord = {
      ...record,
      version: record.version + 1,
      undistributed: {
        ...record.undistributed,
        decision: "RETAINED_UNALLOCATED",
        decidedBy: actor,
        decidedAt: this.engine.iso(),
        note: note.slice(0, 200),
      },
    };
    if (!(await this.store.updateSeason(season, record.version, next)))
      throw new PointsError("SETTLEMENT_CONFLICT", 409);
    await this.engine.audit(
      actor,
      "UNDISTRIBUTED_RETAINED",
      `season:${season}`,
      {
        units: record.undistributed.units,
        note: note.slice(0, 200),
      },
    );
    return next;
  }

  // ---------- post-finalization reversals ----------
  async proposeCorrection(season: number, eventId: string, actor: string) {
    this.engine.assertOperational();
    const record = await this.store.getSeason(season);
    if (!record || !["FINALIZED", "PUBLISHED"].includes(record.state))
      throw new PointsError("SEASON_STATE_INVALID", 409);
    const activity = await this.store.getActivity(eventId);
    if (
      !activity ||
      activity.season !== season ||
      activity.status !== "REVERSED" ||
      !activity.afterFinalization
    )
      throw new PointsError("CORRECTION_NOT_APPLICABLE", 409);
    const id = `corr-${season}-${digest(eventId).slice(0, 16)}`;
    const existing = await this.store.getCorrection(id);
    if (existing) return existing;
    const ledger = await this.store.listLedger({ season });
    const corrected = new Set(
      ledger.filter((e) => e.kind === "CORRECTION").map((e) => e.sourceRef),
    );
    const completions = (await this.store.listCompletions({ season })).filter(
      (c) => c.eventIds.includes(eventId),
    );
    const targets = new Set([
      `s${season}:a:${eventId}`,
      `s${season}:c:a:${eventId}`,
      ...completions.flatMap((c) => [
        `s${season}:t:${c.id}`,
        `s${season}:c:t:${c.id}`,
      ]),
    ]);
    const entries: LedgerEntry[] = ledger
      .filter(
        (e) =>
          targets.has(e.id) &&
          !corrected.has(e.id) &&
          BigInt(e.amountUnits) > 0n,
      )
      .map((e) => ({
        id: `s${season}:x:${e.id.slice(`s${season}:`.length)}`,
        season,
        account: e.account,
        kind: "CORRECTION",
        amountUnits: (-BigInt(e.amountUnits)).toString(),
        sourceRef: e.id,
        correctionId: id,
        createdAt: this.engine.iso(),
      }));
    if (!entries.length) throw new PointsError("NOTHING_TO_CORRECT", 409);
    const correction: CorrectionRecord = {
      id,
      season,
      eventId,
      reason: activity.reason ?? "REVERSED",
      entries,
      status: "PROPOSED",
      proposedBy: actor,
      proposedAt: this.engine.iso(),
    };
    if (!(await this.store.insertCorrection(correction)))
      return (await this.store.getCorrection(id))!;
    await this.engine.audit(actor, "CORRECTION_PROPOSED", id, {
      season,
      eventId,
      clawbackUnits: entries
        .reduce((s, e) => s - BigInt(e.amountUnits), 0n)
        .toString(),
    });
    return correction;
  }

  async decideCorrection(
    id: string,
    actor: string,
    apply: boolean,
  ): Promise<CorrectionRecord> {
    this.engine.assertOperational();
    const correction = await this.store.getCorrection(id);
    if (!correction) throw new PointsError("CORRECTION_NOT_FOUND", 404);
    if (correction.status !== "PROPOSED") {
      if (correction.status === (apply ? "APPLIED" : "REJECTED"))
        return correction;
      throw new PointsError("CORRECTION_STATE_INVALID", 409);
    }
    if (correction.proposedBy === actor)
      throw new PointsError("FOUR_EYES_REQUIRED", 403);
    const decided: CorrectionRecord = {
      ...correction,
      status: apply ? "APPLIED" : "REJECTED",
      decidedBy: actor,
      decidedAt: this.engine.iso(),
    };
    if (!apply) {
      if (!(await this.store.updateCorrection(id, "PROPOSED", decided)))
        return this.decideCorrection(id, actor, apply);
      await this.engine.audit(actor, "CORRECTION_REJECTED", id, {});
      return decided;
    }
    const record = (await this.store.getSeason(correction.season))!;
    const clawback = correction.entries.reduce(
      (s, e) => s - BigInt(e.amountUnits),
      0n,
    );
    const next: SeasonRecord = {
      ...record,
      version: record.version + 1,
      corrections: [...record.corrections, id],
      undistributed: {
        units: (
          BigInt(record.undistributed?.units ?? "0") + clawback
        ).toString(),
        decision: "PENDING_OWNER_DECISION",
      },
    };
    const result = await this.store.applyCorrection(
      decided,
      { expectedVersion: record.version, next },
      correction.entries,
      this.pool,
    );
    if (result === "VERSION_CONFLICT")
      return this.decideCorrection(id, actor, apply);
    if (result !== "COMMITTED") throw new PointsError(result, 409);
    await this.engine.audit(actor, "CORRECTION_APPLIED", id, {
      season: correction.season,
      proposedBy: correction.proposedBy,
      clawbackUnits: clawback.toString(),
    });
    return decided;
  }
}
