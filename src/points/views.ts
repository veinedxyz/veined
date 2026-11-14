import type { PointsEngine } from "./engine";
import type { LedgerEntry, SeasonRecord, TaskRecord } from "./model";
import { leaderboard, type Settlement } from "./settlement";
import { DISPLAY_TIME_ZONE, seasonWindow } from "./season";
// Projections. THE PRIVACY BOUNDARY: public views read only published season snapshots, the schedule, referral
// relations and task status. They never call preview/compute and never read the ledger or calculation of a season
// that is not PUBLISHED, so live-season points, weights and ranks cannot leak through any public response.

export const maskAccount = (account: string) =>
  account.length > 12 ? `${account.slice(0, 6)}…${account.slice(-4)}` : account;
const published = (s: SeasonRecord) => s.state === "PUBLISHED";

export type ProgramStatus = "CLOSED" | "NOT_STARTED" | "LIVE";
type SeasonWindow = { season: number; startsAt: string; endsAt: string };
/** The whole public overview contract: schedule and publication facts only, never a live-season figure. */
export interface PublicOverview {
  program: { status: ProgramStatus; timeZone: string; serverTime: string };
  upcoming?: SeasonWindow | null;
  current?: (SeasonWindow & { resultsHidden: boolean }) | null;
  archive?: (SeasonWindow & { publishedAt: string })[];
  latestPublished?: number | null;
  awaitingResults?: number[];
  account?: Record<string, unknown>;
}

export class PointsViews {
  constructor(
    private engine: PointsEngine,
    private settlement: Settlement,
  ) {}
  private get store() {
    return this.engine.store;
  }

  private async publishedSeasons() {
    return (await this.store.listSeasons()).filter(published);
  }
  private async display() {
    return (
      await this.engine.seasonPolicy(Math.max(1, this.engine.currentSeason()))
    ).policy.display;
  }

  // ---------- public ----------
  async overview(account?: string): Promise<PublicOverview> {
    const now = this.engine.now();
    const config = this.engine.config;
    if (!config.operational)
      return {
        program: {
          status: "CLOSED" as ProgramStatus,
          timeZone: DISPLAY_TIME_ZONE,
          serverTime: now.toISOString(),
        },
      };
    const current = this.engine.currentSeason();
    const seasons = await this.store.listSeasons();
    const archive = seasons.filter(published).map((s) => ({
      season: s.season,
      startsAt: s.startsAt,
      endsAt: s.endsAt,
      publishedAt: s.publishedAt!,
    }));
    const awaiting = [];
    for (let n = 1; n < current; n++)
      if (!seasons.find((s) => s.season === n && published(s)))
        awaiting.push(n);
    const body = {
      program: {
        status: (current < 1 ? "NOT_STARTED" : "LIVE") as ProgramStatus,
        timeZone: DISPLAY_TIME_ZONE,
        serverTime: now.toISOString(),
      },
      upcoming:
        current < 1 ? { season: 1, ...seasonWindow(config.schedule, 1) } : null,
      // The live season: its schedule only. Results for it do not exist outside the admin surface.
      current:
        current >= 1
          ? {
              season: current,
              ...seasonWindow(config.schedule, current),
              resultsHidden: true,
            }
          : null,
      archive,
      latestPublished: archive.at(-1)?.season ?? null,
      awaitingResults: awaiting,
    };
    if (!account) return body;
    return { ...body, account: await this.accountSummary(account, current) };
  }

  private async accountSummary(account: string, current: number) {
    const code = await this.store.getReferralCodeByAccount(account);
    const binding = await this.store.getBinding(account);
    const children = await this.store.listBindings({ parent: account });
    const display = await this.display();
    const summary: Record<string, unknown> = {
      account,
      referral: {
        code: code?.code ?? null,
        codeAvailable: !code && (await this.engine.codeEligible(account)),
        invitedBy: binding ? maskAccount(binding.parent) : null,
        boundAt: binding?.effectiveAt ?? null,
        referrals: children
          .sort((a, b) => Date.parse(a.effectiveAt) - Date.parse(b.effectiveAt))
          .map((b) => ({
            account: maskAccount(b.child),
            boundAt: b.effectiveAt,
          })),
      },
    };
    if (display.showParticipationStatus && current >= 1)
      summary.participation = (
        await this.store.listActivities({ season: current, account })
      ).some((r) => r.status === "ELIGIBLE")
        ? "RECORDED"
        : "NONE";
    return summary;
  }

  private rows(entries: readonly LedgerEntry[], mask: boolean) {
    const corrections = new Map<string, bigint>();
    for (const e of entries)
      if (e.kind === "CORRECTION")
        corrections.set(
          e.account,
          (corrections.get(e.account) ?? 0n) + BigInt(e.amountUnits),
        );
    return leaderboard(entries).map((row) => {
      const correction = corrections.get(row.account) ?? 0n;
      return {
        key: row.account,
        row: {
          ...row,
          account: mask ? maskAccount(row.account) : row.account,
          correctionUnits: correction.toString(),
          netUnits: (BigInt(row.totalUnits) + correction).toString(),
        },
      };
    });
  }

  /** Published seasons only; any other season answers exactly like a season that does not exist. */
  async leaderboard(season: number, account?: string) {
    const record = await this.store.getSeason(season);
    if (!record || !published(record) || !record.calculation) return null;
    const display = await this.display();
    const entries = await this.store.listLedger({ season });
    const all = this.rows(entries, display.maskAccounts);
    const own = account ? all.find((r) => r.key === account)?.row : undefined;
    return {
      season,
      startsAt: record.startsAt,
      endsAt: record.endsAt,
      publishedAt: record.publishedAt!,
      poolUnits: record.calculation.summary.poolUnits,
      allocatedUnits: record.calculation.summary.allocatedUnits,
      undistributedUnits:
        record.undistributed?.units ??
        record.calculation.summary.undistributedUnits,
      participants: all.length,
      amended: record.corrections.length > 0,
      rows: all.slice(0, display.leaderboardSize).map((r) => r.row),
      you: own ?? null,
    };
  }

  /** Finalized and published rewards of one account, per published season. */
  async history(account: string) {
    const out = [];
    for (const record of await this.publishedSeasons()) {
      const entries = await this.store.listLedger({ season: record.season });
      const row = this.rows(entries, false).find((r) => r.key === account)?.row;
      if (row)
        out.push({
          season: record.season,
          endsAt: record.endsAt,
          publishedAt: record.publishedAt!,
          ...row,
        });
    }
    return out;
  }

  /** Task center. Approved campaigns and the account's completion states; reward weights are not exposed. */
  async tasks(account?: string) {
    const now = this.engine.now().getTime();
    const tasks = (await this.store.listTasks()).filter(
      (t) =>
        t.status === "APPROVED" || (t.status === "CANCELLED" && !!t.approvedAt),
    );
    const visible = (t: TaskRecord) =>
      t.status === "APPROVED" || Date.parse(t.endsAt) > now;
    const out = [];
    for (const task of tasks
      .filter(visible)
      .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))) {
      const state =
        task.status === "CANCELLED"
          ? "CANCELLED"
          : now < Date.parse(task.startsAt)
            ? "UPCOMING"
            : now >= Date.parse(task.endsAt)
              ? "ENDED"
              : "ACTIVE";
      const completions = account
        ? (await this.store.listCompletions({ taskId: task.id, account })).map(
            (c) => ({
              ordinal: c.ordinal,
              status: c.status,
              completedAt: c.completedAt,
            }),
          )
        : undefined;
      out.push({
        id: task.id,
        title: task.title,
        description: task.description,
        state,
        startsAt: task.startsAt,
        endsAt: task.endsAt,
        criteria: task.criteria,
        perUserLimit: task.perUserLimit,
        requiresReview: task.requiresReview,
        ...(completions ? { completions } : {}),
      });
    }
    return out;
  }

  // ---------- admin (authenticated callers only) ----------
  async adminDashboard(season?: number) {
    const current = this.engine.currentSeason();
    const selected = season ?? Math.max(1, current);
    const preview = await this.settlement.preview(selected);
    const record = (await this.store.getSeason(selected))!;
    const activities = await this.store.listActivities({ season: selected });
    const flags = await this.store.listFlags();
    const bindings = await this.store.listBindings();
    // Settled seasons are read from the immutable ledger (the final allocation, corrections listed separately);
    // open seasons from the never-persisted preview.
    const settled =
      record.state === "FINALIZED" || record.state === "PUBLISHED";
    const ledger = settled
      ? await this.store.listLedger({ season: selected })
      : [];
    const board = leaderboard(settled ? ledger : preview.entries);
    const corrections = new Map<string, bigint>();
    for (const e of ledger)
      if (e.kind === "CORRECTION")
        corrections.set(
          e.account,
          (corrections.get(e.account) ?? 0n) + BigInt(e.amountUnits),
        );
    const perAccount = new Map<
      string,
      { activities: number; activityWeight: bigint; taskWeight: bigint }
    >();
    for (const line of preview.explain) {
      const row = perAccount.get(line.account) ?? {
        activities: 0,
        activityWeight: 0n,
        taskWeight: 0n,
      };
      if (line.kind === "ACTIVITY") {
        row.activities++;
        row.activityWeight += BigInt(line.effectiveWeight);
      } else row.taskWeight += BigInt(line.effectiveWeight);
      perAccount.set(line.account, row);
    }
    const accounts = [
      ...new Set([...perAccount.keys(), ...board.map((r) => r.account)]),
    ].map((account) => {
      const w = perAccount.get(account) ?? {
        activities: 0,
        activityWeight: 0n,
        taskWeight: 0n,
      };
      const rank = board.find((r) => r.account === account);
      return {
        account,
        activities: w.activities,
        activityWeight: w.activityWeight.toString(),
        taskWeight: w.taskWeight.toString(),
        referrer: bindings.find((b) => b.child === account)?.parent ?? null,
        rank: rank?.rank ?? null,
        activityUnits: rank?.activityUnits ?? "0",
        taskUnits: rank?.taskUnits ?? "0",
        referralUnits: rank?.referralUnits ?? "0",
        totalUnits: rank?.totalUnits ?? "0",
        correctionUnits: (corrections.get(account) ?? 0n).toString(),
        flags: flags
          .filter((f) => f.account === account && f.active)
          .map((f) => f.kind),
      };
    });
    accounts.sort(
      (a, b) =>
        (a.rank ?? 1e9) - (b.rank ?? 1e9) || (a.account < b.account ? -1 : 1),
    );
    const rejected = activities.filter(
      (r) => r.status === "REJECTED" || r.status === "REVERSED",
    );
    // Automated signals for review; they never exclude anyone by themselves.
    const signals = [
      ...preview.explain
        .filter((l) =>
          l.notes.some((n) =>
            ["ACTIVITY_LIMIT", "ACCOUNT_CAP", "TASK_CAP"].includes(n),
          ),
        )
        .map((l) => ({
          account: l.account,
          signal: l.notes.find(
            (n) => n.endsWith("_LIMIT") || n.endsWith("_CAP"),
          )!,
        })),
      ...[...new Set(bindings.map((b) => b.parent))]
        .map((parent) => ({
          parent,
          n: bindings.filter(
            (b) =>
              b.parent === parent &&
              Date.parse(b.effectiveAt) >= Date.parse(record.startsAt),
          ).length,
        }))
        .filter((x) => x.n >= 20)
        .map((x) => ({ account: x.parent, signal: "REFERRAL_BURST" })),
      ...[...new Set(rejected.map((r) => r.event.account))]
        .filter(
          (a) => rejected.filter((r) => r.event.account === a).length >= 10,
        )
        .map((account) => ({ account, signal: "REJECTION_PATTERN" })),
    ];
    const uniqueSignals = [
      ...new Map(signals.map((s) => [`${s.account}|${s.signal}`, s])).values(),
    ];
    const tasks = await this.store.listTasks();
    const completions = await this.store.listCompletions({});
    const seasons = await this.store.listSeasons();
    return {
      config: {
        programId: this.engine.config.programId,
        operational: this.engine.config.operational,
        errors: this.engine.config.errors,
        simulation: this.engine.config.simulation,
        configHash: this.engine.config.configHash,
        policyVersion: this.engine.config.policyVersion,
        policyHash: this.engine.config.policyHash,
        schedule: this.engine.config.schedule,
        store: this.engine.store.kind,
        timeZone: DISPLAY_TIME_ZONE,
        trustedVerifiers: this.engine.config.trustedVerifiers,
      },
      now: this.engine.iso(),
      currentSeason: current,
      selectedSeason: selected,
      season: {
        ...record,
        calculation: record.calculation
          ? { ...record.calculation, entries: undefined }
          : undefined,
      },
      basis: settled ? "SETTLED" : "PROVISIONAL",
      provisional: {
        calculationId: preview.calculationId,
        inputHash: preview.inputHash,
        resultHash: preview.resultHash,
        summary: preview.summary,
        persisted: false,
      },
      accounts,
      activity: {
        eligible: activities.filter((r) => r.status === "ELIGIBLE").length,
        pendingFinality: activities.filter(
          (r) => r.status === "PENDING_FINALITY",
        ).length,
        rejected: activities.filter((r) => r.status === "REJECTED").length,
        reversed: activities.filter((r) => r.status === "REVERSED").length,
        recentIneligible: rejected.slice(-50).map((r) => ({
          eventId: r.event.eventId,
          account: r.event.account,
          category: r.event.category,
          status: r.status,
          reason: r.reason,
          afterFinalization: !!r.afterFinalization,
        })),
      },
      referrals: {
        bindings: bindings.length,
        commissionLines: preview.entries
          .filter((e) => e.kind === "REFERRAL_COMMISSION")
          .map((e) => ({
            parent: e.account,
            child: e.sourceAccount,
            sourceRef: e.sourceRef,
            amountUnits: e.amountUnits,
          })),
      },
      tasks: tasks.map((t) => ({
        ...t,
        completions: completions.filter((c) => c.taskId === t.id).length,
      })),
      pendingReview: completions.filter((c) => c.status === "PENDING_REVIEW"),
      flags,
      signals: uniqueSignals,
      seasons: seasons.map((s) => ({
        season: s.season,
        state: s.state,
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        policyVersion: s.policyVersion,
        calculationId: s.calculation?.id ?? null,
        calculatedBy: s.calculation?.calculatedBy ?? null,
        finalizedBy: s.finalizedBy ?? null,
        publishedAt: s.publishedAt ?? null,
        allocatedUnits: s.calculation?.summary.allocatedUnits ?? null,
        undistributed: s.undistributed ?? null,
        corrections: s.corrections.length,
      })),
      corrections: await this.store.listCorrections({}),
      audit: (await this.store.listAudit(100)).reverse(),
    };
  }

  /** Why an account receives what it receives: every line, cap, referral reserve and commission source. */
  async adminExplain(account: string, season: number) {
    const preview = await this.settlement.preview(season);
    const record = await this.store.getSeason(season);
    return {
      season,
      state: record?.state ?? "OPEN",
      denominator: preview.summary.denominator,
      poolUnits: preview.summary.poolUnits,
      lines: preview.explain.filter(
        (l) => l.account === account || l.referralParent === account,
      ),
      provisionalEntries: preview.entries.filter(
        (e) => e.account === account || e.sourceAccount === account,
      ),
      ledger: await this.store.listLedger({ season, account }),
      binding: await this.store.getBinding(account),
      activities: (await this.store.listActivities({ season, account })).map(
        (r) => ({
          eventId: r.event.eventId,
          category: r.event.category,
          status: r.status,
          reason: r.reason,
          occurredAt: r.event.occurredAt,
          volumeUsdMicros: r.event.volumeUsdMicros,
          attributionResult: r.attributionResult,
        }),
      ),
    };
  }
}
