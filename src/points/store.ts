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
// Storage contract for the points engine. Every method that must be atomic is ONE store call (a single
// transaction in Postgres, a synchronous critical section in memory): uniqueness, compare-and-set versions,
// completion limits, budget-checked ledger commits and the hash-chained audit log.

export type InsertActivityResult =
  "INSERTED" | "EVENT_EXISTS" | "OPERATION_EXISTS";
export type InsertCompletionResult =
  "INSERTED" | "DUPLICATE" | "USER_LIMIT" | "GLOBAL_LIMIT" | "EVENT_USED";
export type CommitResult =
  "COMMITTED" | "VERSION_CONFLICT" | "BUDGET_EXCEEDED" | "DUPLICATE_ENTRY";
export type AuditInput = Pick<
  AuditRecord,
  "at" | "actor" | "action" | "target" | "details"
>;

export interface PointsStore {
  readonly kind: "memory" | "postgres";

  getActivity(eventId: string): Promise<ActivityRecord | null>;
  /** Unique on eventId, and on operationKey among records that are neither REJECTED nor REVERSED. */
  insertActivity(record: ActivityRecord): Promise<InsertActivityResult>;
  updateActivity(
    eventId: string,
    expectedRevision: number,
    next: ActivityRecord,
  ): Promise<boolean>;
  listActivities(filter: {
    season?: number;
    account?: string;
  }): Promise<ActivityRecord[]>;

  getReferralCodeByAccount(account: string): Promise<ReferralCode | null>;
  getReferralCode(code: string): Promise<ReferralCode | null>;
  insertReferralCode(
    code: ReferralCode,
  ): Promise<"INSERTED" | "ACCOUNT_HAS_CODE" | "CODE_TAKEN">;
  getBinding(child: string): Promise<ReferralBinding | null>;
  /** One parent per account: the first binding wins, forever. */
  insertBinding(
    binding: ReferralBinding,
  ): Promise<"INSERTED" | "ALREADY_BOUND">;
  listBindings(filter?: { parent?: string }): Promise<ReferralBinding[]>;

  putFlag(flag: AccountFlag): Promise<void>;
  listFlags(): Promise<AccountFlag[]>;

  insertTask(task: TaskRecord): Promise<"INSERTED" | "EXISTS">;
  updateTask(
    id: string,
    expectedVersion: number,
    next: TaskRecord,
  ): Promise<boolean>;
  getTask(id: string): Promise<TaskRecord | null>;
  listTasks(): Promise<TaskRecord[]>;
  /** Enforces per-user and global limits and single use of each event per task, atomically. */
  insertCompletion(
    completion: TaskCompletion,
    limits: { perUser: number; global: number },
  ): Promise<InsertCompletionResult>;
  updateCompletion(
    id: string,
    expectedRevision: number,
    next: TaskCompletion,
  ): Promise<boolean>;
  listCompletions(filter: {
    season?: number;
    taskId?: string;
    account?: string;
  }): Promise<TaskCompletion[]>;

  getSeason(season: number): Promise<SeasonRecord | null>;
  listSeasons(): Promise<SeasonRecord[]>;
  insertSeason(record: SeasonRecord): Promise<boolean>;
  updateSeason(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
  ): Promise<boolean>;
  /** Season CAS + ledger insert + weekly budget check (sum of the season's ledger ≤ pool) in one unit. */
  commitFinalization(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
    entries: LedgerEntry[],
    poolUnits: bigint,
  ): Promise<CommitResult>;
  listLedger(filter: {
    season?: number;
    account?: string;
  }): Promise<LedgerEntry[]>;

  insertCorrection(correction: CorrectionRecord): Promise<boolean>;
  getCorrection(id: string): Promise<CorrectionRecord | null>;
  listCorrections(filter: { season?: number }): Promise<CorrectionRecord[]>;
  updateCorrection(
    id: string,
    expectedStatus: CorrectionRecord["status"],
    next: CorrectionRecord,
  ): Promise<boolean>;
  /** Correction status CAS + season CAS + ledger insert with the same budget check, in one unit. */
  applyCorrection(
    next: CorrectionRecord,
    season: { expectedVersion: number; next: SeasonRecord },
    entries: LedgerEntry[],
    poolUnits: bigint,
  ): Promise<CommitResult>;

  /** Append-only, hash-chained (each record commits to its predecessor). */
  appendAudit(input: AuditInput): Promise<AuditRecord>;
  listAudit(limit?: number): Promise<AuditRecord[]>;

  /** Lease lock with a monotonically increasing fencing token; null when held by another owner. */
  acquireLock(
    name: string,
    owner: string,
    ttlMs: number,
    now: Date,
  ): Promise<number | null>;
  releaseLock(name: string, token: number): Promise<void>;
  /** True only while `token` is the current, unexpired holder. */
  checkLock(name: string, token: number, now: Date): Promise<boolean>;
}
