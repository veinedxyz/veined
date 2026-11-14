import { digest } from "./hash";
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
// In-process store for tests and the isolated owner playtest. Every method body is synchronous after entry, so
// each call is a critical section on the event loop; records are cloned in and out so callers can never mutate
// stored state. Locks here are process-local; the Postgres store provides the distributed equivalent.

const clone = <T>(value: T): T => structuredClone(value);
const live = (r: ActivityRecord) =>
  r.status !== "REJECTED" && r.status !== "REVERSED";

export class MemoryPointsStore implements PointsStore {
  readonly kind = "memory" as const;
  private activities = new Map<string, ActivityRecord>();
  private codes = new Map<string, ReferralCode>();
  private bindings = new Map<string, ReferralBinding>();
  private flags = new Map<string, AccountFlag>();
  private tasks = new Map<string, TaskRecord>();
  private completions = new Map<string, TaskCompletion>();
  private seasons = new Map<number, SeasonRecord>();
  private ledger = new Map<string, LedgerEntry>();
  private corrections = new Map<string, CorrectionRecord>();
  private audit: AuditRecord[] = [];
  private locks = new Map<
    string,
    { owner: string; token: number; expiresAt: number }
  >();
  private fence = 0;

  async getActivity(eventId: string) {
    const r = this.activities.get(eventId);
    return r ? clone(r) : null;
  }
  async insertActivity(record: ActivityRecord): Promise<InsertActivityResult> {
    if (this.activities.has(record.event.eventId)) return "EVENT_EXISTS";
    if (
      live(record) &&
      [...this.activities.values()].some(
        (r) => live(r) && r.event.operationKey === record.event.operationKey,
      )
    )
      return "OPERATION_EXISTS";
    this.activities.set(record.event.eventId, clone(record));
    return "INSERTED";
  }
  async updateActivity(
    eventId: string,
    expectedRevision: number,
    next: ActivityRecord,
  ) {
    const current = this.activities.get(eventId);
    if (!current || current.revision !== expectedRevision) return false;
    if (
      live(next) &&
      !live(current) &&
      [...this.activities.values()].some(
        (r) =>
          r !== current &&
          live(r) &&
          r.event.operationKey === next.event.operationKey,
      )
    )
      return false;
    this.activities.set(eventId, clone(next));
    return true;
  }
  async listActivities(filter: { season?: number; account?: string }) {
    return [...this.activities.values()]
      .filter(
        (r) =>
          (filter.season === undefined || r.season === filter.season) &&
          (filter.account === undefined || r.event.account === filter.account),
      )
      .map(clone);
  }

  async getReferralCodeByAccount(account: string) {
    const r = [...this.codes.values()].find((c) => c.account === account);
    return r ? clone(r) : null;
  }
  async getReferralCode(code: string) {
    const r = this.codes.get(code);
    return r ? clone(r) : null;
  }
  async insertReferralCode(code: ReferralCode) {
    if ([...this.codes.values()].some((c) => c.account === code.account))
      return "ACCOUNT_HAS_CODE" as const;
    if (this.codes.has(code.code)) return "CODE_TAKEN" as const;
    this.codes.set(code.code, clone(code));
    return "INSERTED" as const;
  }
  async getBinding(child: string) {
    const r = this.bindings.get(child);
    return r ? clone(r) : null;
  }
  async insertBinding(binding: ReferralBinding) {
    if (this.bindings.has(binding.child)) return "ALREADY_BOUND" as const;
    this.bindings.set(binding.child, clone(binding));
    return "INSERTED" as const;
  }
  async listBindings(filter: { parent?: string } = {}) {
    return [...this.bindings.values()]
      .filter((b) => filter.parent === undefined || b.parent === filter.parent)
      .map(clone);
  }

  async putFlag(flag: AccountFlag) {
    this.flags.set(`${flag.account}|${flag.kind}`, clone(flag));
  }
  async listFlags() {
    return [...this.flags.values()].map(clone);
  }

  async insertTask(task: TaskRecord) {
    if (this.tasks.has(task.id)) return "EXISTS" as const;
    this.tasks.set(task.id, clone(task));
    return "INSERTED" as const;
  }
  async updateTask(id: string, expectedVersion: number, next: TaskRecord) {
    const current = this.tasks.get(id);
    if (!current || current.version !== expectedVersion) return false;
    this.tasks.set(id, clone(next));
    return true;
  }
  async getTask(id: string) {
    const r = this.tasks.get(id);
    return r ? clone(r) : null;
  }
  async listTasks() {
    return [...this.tasks.values()].map(clone);
  }
  async insertCompletion(
    completion: TaskCompletion,
    limits: { perUser: number; global: number },
  ): Promise<InsertCompletionResult> {
    if (this.completions.has(completion.id)) return "DUPLICATE";
    const counted = [...this.completions.values()].filter(
      (c) =>
        c.taskId === completion.taskId &&
        c.status !== "REJECTED" &&
        c.status !== "VOIDED",
    );
    if (
      counted.some((c) =>
        c.eventIds.some((e) => completion.eventIds.includes(e)),
      )
    )
      return "EVENT_USED";
    if (
      counted.filter((c) => c.account === completion.account).length >=
      limits.perUser
    )
      return "USER_LIMIT";
    if (counted.length >= limits.global) return "GLOBAL_LIMIT";
    this.completions.set(completion.id, clone(completion));
    return "INSERTED";
  }
  async updateCompletion(
    id: string,
    expectedRevision: number,
    next: TaskCompletion,
  ) {
    const current = this.completions.get(id);
    if (!current || current.revision !== expectedRevision) return false;
    this.completions.set(id, clone(next));
    return true;
  }
  async listCompletions(filter: {
    season?: number;
    taskId?: string;
    account?: string;
  }) {
    return [...this.completions.values()]
      .filter(
        (c) =>
          (filter.season === undefined || c.season === filter.season) &&
          (filter.taskId === undefined || c.taskId === filter.taskId) &&
          (filter.account === undefined || c.account === filter.account),
      )
      .map(clone);
  }

  async getSeason(season: number) {
    const r = this.seasons.get(season);
    return r ? clone(r) : null;
  }
  async listSeasons() {
    return [...this.seasons.values()]
      .sort((a, b) => a.season - b.season)
      .map(clone);
  }
  async insertSeason(record: SeasonRecord) {
    if (this.seasons.has(record.season)) return false;
    this.seasons.set(record.season, clone(record));
    return true;
  }
  async updateSeason(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
  ) {
    const current = this.seasons.get(season);
    if (
      !current ||
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1
    )
      return false;
    this.seasons.set(season, clone(next));
    return true;
  }
  private budgetCheck(
    season: number,
    entries: LedgerEntry[],
    poolUnits: bigint,
  ): CommitResult | null {
    if (entries.some((e) => this.ledger.has(e.id))) return "DUPLICATE_ENTRY";
    if (new Set(entries.map((e) => e.id)).size !== entries.length)
      return "DUPLICATE_ENTRY";
    let total = 0n;
    for (const e of this.ledger.values())
      if (e.season === season) total += BigInt(e.amountUnits);
    for (const e of entries) {
      if (e.season !== season) return "BUDGET_EXCEEDED";
      total += BigInt(e.amountUnits);
    }
    return total > poolUnits ? "BUDGET_EXCEEDED" : null;
  }
  async commitFinalization(
    season: number,
    expectedVersion: number,
    next: SeasonRecord,
    entries: LedgerEntry[],
    poolUnits: bigint,
  ): Promise<CommitResult> {
    const current = this.seasons.get(season);
    if (
      !current ||
      current.version !== expectedVersion ||
      next.version !== expectedVersion + 1
    )
      return "VERSION_CONFLICT";
    const failure = this.budgetCheck(season, entries, poolUnits);
    if (failure) return failure;
    for (const e of entries) this.ledger.set(e.id, clone(e));
    this.seasons.set(season, clone(next));
    return "COMMITTED";
  }
  async listLedger(filter: { season?: number; account?: string }) {
    return [...this.ledger.values()]
      .filter(
        (e) =>
          (filter.season === undefined || e.season === filter.season) &&
          (filter.account === undefined || e.account === filter.account),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map(clone);
  }

  async insertCorrection(correction: CorrectionRecord) {
    if (this.corrections.has(correction.id)) return false;
    this.corrections.set(correction.id, clone(correction));
    return true;
  }
  async getCorrection(id: string) {
    const r = this.corrections.get(id);
    return r ? clone(r) : null;
  }
  async listCorrections(filter: { season?: number }) {
    return [...this.corrections.values()]
      .filter((c) => filter.season === undefined || c.season === filter.season)
      .map(clone);
  }
  async updateCorrection(
    id: string,
    expectedStatus: CorrectionRecord["status"],
    next: CorrectionRecord,
  ) {
    const current = this.corrections.get(id);
    if (!current || current.status !== expectedStatus) return false;
    this.corrections.set(id, clone(next));
    return true;
  }
  async applyCorrection(
    next: CorrectionRecord,
    season: { expectedVersion: number; next: SeasonRecord },
    entries: LedgerEntry[],
    poolUnits: bigint,
  ): Promise<CommitResult> {
    const current = this.corrections.get(next.id);
    const record = this.seasons.get(next.season);
    if (
      !current ||
      current.status !== "PROPOSED" ||
      !record ||
      record.version !== season.expectedVersion ||
      season.next.version !== season.expectedVersion + 1
    )
      return "VERSION_CONFLICT";
    const failure = this.budgetCheck(next.season, entries, poolUnits);
    if (failure) return failure;
    for (const e of entries) this.ledger.set(e.id, clone(e));
    this.corrections.set(next.id, clone(next));
    this.seasons.set(next.season, clone(season.next));
    return "COMMITTED";
  }

  async appendAudit(input: AuditInput) {
    const prevHash = this.audit.at(-1)?.hash ?? "0".repeat(64);
    const seq = this.audit.length + 1;
    const body = { seq, ...clone(input), prevHash };
    const record: AuditRecord = { ...body, hash: digest(body) };
    this.audit.push(record);
    return clone(record);
  }
  async listAudit(limit = 200) {
    return this.audit.slice(-limit).map(clone);
  }

  async acquireLock(name: string, owner: string, ttlMs: number, now: Date) {
    const held = this.locks.get(name);
    if (held && held.expiresAt > now.getTime() && held.owner !== owner)
      return null;
    const token = ++this.fence;
    this.locks.set(name, { owner, token, expiresAt: now.getTime() + ttlMs });
    return token;
  }
  async releaseLock(name: string, token: number) {
    if (this.locks.get(name)?.token === token) this.locks.delete(name);
  }
  async checkLock(name: string, token: number, now: Date) {
    const held = this.locks.get(name);
    return !!held && held.token === token && held.expiresAt > now.getTime();
  }
}
