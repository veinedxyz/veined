import postgres, { type Sql } from "postgres";
import { digest } from "./hash";
import { POINTS_SCHEMA_VERSION, pointsSchemaVersion } from "./schema-version";
import type {
  AccountFlag,
  ActivityRecord,
  AuditRecord,
  CorrectionRecord,
  LedgerEntry,
  ReferralBinding,
  ReferralCode,
  SeasonRecord,
  TaskCompletion,
  TaskRecord,
} from "./model";
import type {
  AuditInput,
  CommitResult,
  InsertActivityResult,
  InsertCompletionResult,
  PointsStore,
} from "./store";
// Durable, multi-process store (schema: migrations/0001_weekly_points.sql). Every statement is a parameterized
// tagged template. Atomic contracts map to single transactions; uniqueness, immutability and the weekly budget are
// also enforced by the schema itself. Connecting never migrates: an unmigrated database is refused.

class Abort extends Error {
  constructor(readonly result: CommitResult) {
    super(result);
  }
}
type Row = { record: unknown };
const records = <T>(rows: readonly Row[]) => rows.map((r) => r.record as T);
const uniqueViolation = (error: unknown, constraint?: string) =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: string }).code === "23505" &&
  (!constraint ||
    (error as { constraint_name?: string }).constraint_name === constraint);
const budgetViolation = (error: unknown) =>
  String((error as Error)?.message ?? "").includes(
    "VEINED_POINTS_BUDGET_EXCEEDED",
  );
const json = (sql: Pick<Sql, "json">, value: unknown) =>
  sql.json(value as Parameters<Sql["json"]>[0]);

export class PostgresPointsStore implements PointsStore {
  readonly kind = "postgres" as const;
  constructor(readonly sql: Sql) {}

  static async connect(url: string, options: { max?: number } = {}) {
    const parsed = new URL(url);
    if (!/^postgres(ql)?:$/.test(parsed.protocol))
      throw Error("DATABASE_URL_INVALID");
    const sql = postgres(url, {
      max: options.max ?? 5,
      idle_timeout: 30,
      connect_timeout: 8,
      onnotice: () => {},
      connection: { application_name: "veined-points" },
    });
    if ((await pointsSchemaVersion(sql)) !== POINTS_SCHEMA_VERSION) {
      await sql.end({ timeout: 5 });
      throw Error("POINTS_SCHEMA_NOT_MIGRATED");
    }
    return new PostgresPointsStore(sql);
  }
  close() {
    return this.sql.end({ timeout: 5 });
  }

  // ---------- activity ----------
  async getActivity(eventId: string) {
    const [row] = await this.sql<
      Row[]
    >`SELECT record FROM veined_points.activity WHERE event_id = ${eventId}`;
    return row ? (row.record as ActivityRecord) : null;
  }
  async insertActivity(record: ActivityRecord): Promise<InsertActivityResult> {
    try {
      const rows = await this.sql`
        INSERT INTO veined_points.activity (event_id, operation_key, account, season, status, revision, content_hash, record)
        VALUES (${record.event.eventId}, ${record.event.operationKey}, ${record.event.account}, ${record.season},
                ${record.status}, ${record.revision}, ${record.contentHash}, ${json(this.sql, record)})
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`;
      return rows.length ? "INSERTED" : "EVENT_EXISTS";
    } catch (error) {
      if (uniqueViolation(error, "activity_live_operation"))
        return "OPERATION_EXISTS";
      throw error;
    }
  }
  async updateActivity(
    eventId: string,
    expectedRevision: number,
    next: ActivityRecord,
  ) {
    try {
      const rows = await this.sql`
        UPDATE veined_points.activity
        SET status = ${next.status}, revision = ${next.revision}, record = ${json(this.sql, next)}, updated_at = now()
        WHERE event_id = ${eventId} AND revision = ${expectedRevision}
        RETURNING event_id`;
      return rows.length === 1;
    } catch (error) {
      if (uniqueViolation(error, "activity_live_operation")) return false;
      throw error;
    }
  }
  async listActivities(filter: { season?: number; account?: string }) {
    const sql = this.sql;
    return records<ActivityRecord>(
      await sql<Row[]>`SELECT record FROM veined_points.activity WHERE true
        ${filter.season !== undefined ? sql`AND season = ${filter.season}` : sql``}
        ${filter.account !== undefined ? sql`AND account = ${filter.account}` : sql``}
        ORDER BY event_id`,
    );
  }

  // ---------- referral ----------
  async getReferralCodeByAccount(account: string) {
    const [row] = await this.sql<
      { code: string; account: string; created_at: Date }[]
    >`
      SELECT code, account, created_at FROM veined_points.referral_code WHERE account = ${account}`;
    return row
      ? {
          code: row.code,
          account: row.account,
          createdAt: new Date(row.created_at).toISOString(),
        }
      : null;
  }
  async getReferralCode(code: string) {
    const [row] = await this.sql<
      { code: string; account: string; created_at: Date }[]
    >`
      SELECT code, account, created_at FROM veined_points.referral_code WHERE code = ${code}`;
    return row
      ? {
          code: row.code,
          account: row.account,
          createdAt: new Date(row.created_at).toISOString(),
        }
      : null;
  }
  async insertReferralCode(code: ReferralCode) {
    try {
      await this
        .sql`INSERT INTO veined_points.referral_code (code, account, created_at)
        VALUES (${code.code}, ${code.account}, ${new Date(code.createdAt)})`;
      return "INSERTED" as const;
    } catch (error) {
      if (uniqueViolation(error, "referral_code_account_key"))
        return "ACCOUNT_HAS_CODE" as const;
      if (uniqueViolation(error)) return "CODE_TAKEN" as const;
      throw error;
    }
  }
  async getBinding(child: string) {
    const [row] = await this.sql<
      Row[]
    >`SELECT record FROM veined_points.referral_binding WHERE child = ${child}`;
    return row ? (row.record as ReferralBinding) : null;
  }
  async insertBinding(binding: ReferralBinding) {
    const rows = await this.sql`
      INSERT INTO veined_points.referral_binding (child, parent, record)
      VALUES (${binding.child}, ${binding.parent}, ${json(this.sql, binding)})
      ON CONFLICT (child) DO NOTHING RETURNING child`;
    return rows.length ? ("INSERTED" as const) : ("ALREADY_BOUND" as const);
  }
  async listBindings(filter: { parent?: string } = {}) {
    const sql = this.sql;
    return records<ReferralBinding>(
      await sql<
        Row[]
      >`SELECT record FROM veined_points.referral_binding WHERE true
        ${filter.parent !== undefined ? sql`AND parent = ${filter.parent}` : sql``} ORDER BY child`,
    );
  }

  // ---------- flags ----------
  async putFlag(flag: AccountFlag) {
    await this
      .sql`INSERT INTO veined_points.account_flag (account, kind, record)
      VALUES (${flag.account}, ${flag.kind}, ${json(this.sql, flag)})
      ON CONFLICT (account, kind) DO UPDATE SET record = EXCLUDED.record`;
  }
  async listFlags() {
    return records<AccountFlag>(
      await this.sql<
        Row[]
      >`SELECT record FROM veined_points.account_flag ORDER BY account, kind`,
    );
  }

  // ---------- tasks ----------
  async insertTask(task: TaskRecord) {
    const rows = await this
      .sql`INSERT INTO veined_points.task (id, version, status, record)
      VALUES (${task.id}, ${task.version}, ${task.status}, ${json(this.sql, task)})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    return rows.length ? ("INSERTED" as const) : ("EXISTS" as const);
  }
  async updateTask(id: string, expectedVersion: number, next: TaskRecord) {
    const rows = await this.sql`UPDATE veined_points.task
      SET version = ${next.version}, status = ${next.status}, record = ${json(this.sql, next)}
      WHERE id = ${id} AND version = ${expectedVersion} RETURNING id`;
    return rows.length === 1;
  }
  async getTask(id: string) {
    const [row] = await this.sql<
      Row[]
    >`SELECT record FROM veined_points.task WHERE id = ${id}`;
    return row ? (row.record as TaskRecord) : null;
  }
  async listTasks() {
    return records<TaskRecord>(
      await this.sql<Row[]>`SELECT record FROM veined_points.task ORDER BY id`,
    );
  }
  async insertCompletion(
    completion: TaskCompletion,
    limits: { perUser: number; global: number },
  ) {
    return this.sql.begin(async (tx) => {
      // Serializes every completion of one task: limits and single event use are checked and written together.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`veined-points-task:${completion.taskId}`}))`;
      const [exists] =
        await tx`SELECT 1 FROM veined_points.task_completion WHERE id = ${completion.id}`;
      if (exists) return "DUPLICATE" as InsertCompletionResult;
      const [used] = await tx`SELECT 1 FROM veined_points.task_completion
        WHERE task_id = ${completion.taskId} AND status NOT IN ('REJECTED', 'VOIDED')
          AND event_ids && ${tx.array(completion.eventIds)}::text[] LIMIT 1`;
      if (used) return "EVENT_USED" as InsertCompletionResult;
      const [counts] = await tx<{ mine: string; total: string }[]>`
        SELECT count(*) FILTER (WHERE account = ${completion.account})::text AS mine, count(*)::text AS total
        FROM veined_points.task_completion
        WHERE task_id = ${completion.taskId} AND status NOT IN ('REJECTED', 'VOIDED')`;
      if (Number(counts.mine) >= limits.perUser)
        return "USER_LIMIT" as InsertCompletionResult;
      if (Number(counts.total) >= limits.global)
        return "GLOBAL_LIMIT" as InsertCompletionResult;
      await tx`INSERT INTO veined_points.task_completion (id, task_id, account, season, status, revision, event_ids, record)
        VALUES (${completion.id}, ${completion.taskId}, ${completion.account}, ${completion.season}, ${completion.status},
                ${completion.revision}, ${tx.array(completion.eventIds)}::text[], ${json(tx, completion)})`;
      return "INSERTED" as InsertCompletionResult;
    }) as Promise<InsertCompletionResult>;
  }
  async updateCompletion(
    id: string,
    expectedRevision: number,
    next: TaskCompletion,
  ) {
    const rows = await this.sql`UPDATE veined_points.task_completion
      SET status = ${next.status}, revision = ${next.revision}, record = ${json(this.sql, next)}
      WHERE id = ${id} AND revision = ${expectedRevision} RETURNING id`;
    return rows.length === 1;
  }
  async listCompletions(filter: {
    season?: number;
    taskId?: string;
    account?: string;
  }) {
    const sql = this.sql;
    return records<TaskCompletion>(
      await sql<
        Row[]
      >`SELECT record FROM veined_points.task_completion WHERE true
        ${filter.season !== undefined ? sql`AND season = ${filter.season}` : sql``}
        ${filter.taskId !== undefined ? sql`AND task_id = ${filter.taskId}` : sql``}
        ${filter.account !== undefined ? sql`AND account = ${filter.account}` : sql``}
        ORDER BY id`,
    );
  }

  // ---------- seasons and ledger ----------
  async getSeason(season: number) {
    const [row] = await this.sql<
      Row[]
    >`SELECT record FROM veined_points.season WHERE season = ${season}`;
    return row ? (row.record as SeasonRecord) : null;
  }
  async listSeasons() {
    return records<SeasonRecord>(
      await this.sql<
        Row[]
      >`SELECT record FROM veined_points.season ORDER BY season`,
    );
  }
  async insertSeason(record: SeasonRecord) {
    const rows = await this
      .sql`INSERT INTO veined_points.season (season, state, version, policy_hash, record)
      VALUES (${record.season}, ${record.state}, ${record.version}, ${record.policyHash}, ${json(this.sql, record)})
      ON CONFLICT (season) DO NOTHING RETURNING season`;
    return rows.length === 1;
  }
  private async casSeason(
    tx: Sql,
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
  ) {
    if (next.version !== expectedVersion + 1 || next.season !== season)
      return false;
    const rows = await tx`UPDATE veined_points.season
      SET state = ${next.state}, version = ${next.version}, record = ${json(tx, next)}
      WHERE season = ${season} AND version = ${expectedVersion} RETURNING season`;
    return rows.length === 1;
  }
  async updateSeason(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
  ) {
    return this.casSeason(this.sql, season, expectedVersion, next);
  }
  private async insertEntries(
    tx: Sql,
    season: number,
    entries: LedgerEntry[],
    poolUnits: bigint,
  ) {
    for (const e of entries) {
      if (e.season !== season) throw new Abort("BUDGET_EXCEEDED");
      const rows = await tx`INSERT INTO veined_points.ledger_entry
        (id, season, account, kind, amount_units, source_ref, record, created_at)
        VALUES (${e.id}, ${e.season}, ${e.account}, ${e.kind}, ${e.amountUnits}, ${e.sourceRef}, ${json(tx, e)}, ${new Date(e.createdAt)})
        ON CONFLICT (id) DO NOTHING RETURNING id`;
      if (!rows.length) throw new Abort("DUPLICATE_ENTRY");
    }
    const [sum] = await tx<{ total: string }[]>`
      SELECT COALESCE(SUM(amount_units), 0)::text AS total FROM veined_points.ledger_entry WHERE season = ${season}`;
    if (BigInt(sum.total) > poolUnits) throw new Abort("BUDGET_EXCEEDED");
  }
  private async unit(fn: (tx: Sql) => Promise<void>): Promise<CommitResult> {
    try {
      await this.sql.begin(async (tx) => fn(tx as unknown as Sql));
      return "COMMITTED";
    } catch (error) {
      if (error instanceof Abort) return error.result;
      if (budgetViolation(error)) return "BUDGET_EXCEEDED";
      if (uniqueViolation(error)) return "DUPLICATE_ENTRY";
      throw error;
    }
  }
  async commitFinalization(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
    entries: LedgerEntry[],
    poolUnits: bigint,
  ) {
    return this.unit(async (tx) => {
      if (!(await this.casSeason(tx, season, expectedVersion, next)))
        throw new Abort("VERSION_CONFLICT");
      await this.insertEntries(tx, season, entries, poolUnits);
    });
  }
  async listLedger(filter: { season?: number; account?: string }) {
    const sql = this.sql;
    return records<LedgerEntry>(
      await sql<Row[]>`SELECT record FROM veined_points.ledger_entry WHERE true
        ${filter.season !== undefined ? sql`AND season = ${filter.season}` : sql``}
        ${filter.account !== undefined ? sql`AND account = ${filter.account}` : sql``}
        ORDER BY id`,
    );
  }

  // ---------- corrections ----------
  async insertCorrection(correction: CorrectionRecord) {
    const rows = await this
      .sql`INSERT INTO veined_points.correction (id, season, status, record)
      VALUES (${correction.id}, ${correction.season}, ${correction.status}, ${json(this.sql, correction)})
      ON CONFLICT (id) DO NOTHING RETURNING id`;
    return rows.length === 1;
  }
  async getCorrection(id: string) {
    const [row] = await this.sql<
      Row[]
    >`SELECT record FROM veined_points.correction WHERE id = ${id}`;
    return row ? (row.record as CorrectionRecord) : null;
  }
  async listCorrections(filter: { season?: number }) {
    const sql = this.sql;
    return records<CorrectionRecord>(
      await sql<Row[]>`SELECT record FROM veined_points.correction WHERE true
        ${filter.season !== undefined ? sql`AND season = ${filter.season}` : sql``} ORDER BY id`,
    );
  }
  async updateCorrection(
    id: string,
    expectedStatus: CorrectionRecord["status"],
    next: CorrectionRecord,
  ) {
    const rows = await this
      .sql`UPDATE veined_points.correction SET status = ${next.status}, record = ${json(this.sql, next)}
      WHERE id = ${id} AND status = ${expectedStatus} RETURNING id`;
    return rows.length === 1;
  }
  async applyCorrection(
    next: CorrectionRecord,
    season: { expectedVersion: number; next: SeasonRecord },
    entries: LedgerEntry[],
    poolUnits: bigint,
  ) {
    return this.unit(async (tx) => {
      const rows =
        await tx`UPDATE veined_points.correction SET status = ${next.status}, record = ${json(tx, next)}
        WHERE id = ${next.id} AND status = 'PROPOSED' RETURNING id`;
      if (rows.length !== 1) throw new Abort("VERSION_CONFLICT");
      if (
        !(await this.casSeason(
          tx,
          next.season,
          season.expectedVersion,
          season.next,
        ))
      )
        throw new Abort("VERSION_CONFLICT");
      await this.insertEntries(tx, next.season, entries, poolUnits);
    });
  }

  // ---------- audit ----------
  async appendAudit(input: AuditInput): Promise<AuditRecord> {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('veined-points-audit'))`;
      // Order by the bigint column, never the text alias (text order would put "9" after "10").
      const [last] = await tx<{ last_seq: string; hash: string }[]>`
        SELECT a.seq::text AS last_seq, a.hash FROM veined_points.audit_log a ORDER BY a.seq DESC LIMIT 1`;
      const body = {
        seq: last ? Number(last.last_seq) + 1 : 1,
        ...input,
        prevHash: last?.hash ?? "0".repeat(64),
      };
      const record: AuditRecord = { ...body, hash: digest(body) };
      await tx`INSERT INTO veined_points.audit_log (seq, at, actor, action, target, prev_hash, hash, record)
        VALUES (${record.seq}, ${new Date(record.at)}, ${record.actor}, ${record.action}, ${record.target},
                ${record.prevHash}, ${record.hash}, ${json(tx, record)})`;
      return record;
    }) as Promise<AuditRecord>;
  }
  async listAudit(limit = 200) {
    return records<AuditRecord>(
      await this.sql<
        Row[]
      >`SELECT record FROM veined_points.audit_log ORDER BY seq DESC LIMIT ${limit}`,
    ).reverse();
  }

  // ---------- distributed lease locks ----------
  async acquireLock(name: string, owner: string, ttlMs: number, now: Date) {
    const rows = await this.sql<{ token: string }[]>`
      INSERT INTO veined_points.lease_lock AS l (name, owner, token, expires_at)
      VALUES (${name}, ${owner}, nextval('veined_points.lock_fence'), ${new Date(now.getTime() + ttlMs)})
      ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
      WHERE l.expires_at <= ${now} OR l.owner = EXCLUDED.owner
      RETURNING token::text AS token`;
    return rows.length ? Number(rows[0].token) : null;
  }
  async releaseLock(name: string, token: number) {
    await this.sql`UPDATE veined_points.lease_lock SET expires_at = 'epoch'
      WHERE name = ${name} AND token = ${token}`;
  }
  async checkLock(name: string, token: number, now: Date) {
    const rows = await this.sql`SELECT 1 FROM veined_points.lease_lock
      WHERE name = ${name} AND token = ${token} AND expires_at > ${now}`;
    return rows.length === 1;
  }
}
