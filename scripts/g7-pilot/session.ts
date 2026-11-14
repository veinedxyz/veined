// G7 pilot one-shot session. The send capability exists at most once per owner approval: it is consumed and
// PERSISTED (exclusive-create lock file) before the transaction parameters ever leave the server, it is never
// re-issued (not after a reload, a rejection, an error, a restart or a second session), and a run that finds an
// existing lock can only observe (read-only tracking). Nothing here talks to a wallet or holds key material.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ExecutionEvidence,
  noWriteReasons,
  type ExecutionSnapshot,
} from "../../src/g7/write-evidence";
import { dirname } from "node:path";
import { decodeBridgeTokenIndependent } from "../../src/g7/decoder";
import { pilotIntentDigest, type WalletTx } from "./intent";
import type { PreflightOutcome, PreflightSource } from "./preflight";
import type { DetectResult, TrackSnapshot, TrackerSource } from "./tracker";
import {
  ARM_MAX_QUOTE_AGE_MS,
  BUTTON_LABEL,
  CONFIRMATION_CHECKS,
  CONFIRMATION_PHRASE,
  MOCK_WALLET_RDNS,
  PILOT_BOUNDS,
  PILOT_SCOPE,
  QUOTE_MAX_AGE_AT_WALLET_MS,
  SESSION_TTL_MS,
  TERMINAL_STATES,
  TRUST_ACCEPTANCE_SENTENCE,
  TRUST_STATEMENT,
  type PilotMode,
  type SessionState,
} from "./policy";

export class PilotError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
  ) {
    super(code);
  }
}

// ------------------------------------------------------------------ persistent one-shot lock
export type LockState =
  | "ARMED"
  | "SENT"
  | "USER_REJECTED"
  | "MANUAL_REVIEW_REQUIRED"
  | "ABORTED_BEFORE_WALLET_REQUEST"
  | "G7_PASS";
export interface LockRecord {
  execution?: ExecutionSnapshot;
  schema: "otherbridge.g7.pilot-lock.v1";
  note: string;
  state: LockState;
  sessionId: string;
  armedAt: string;
  intentDigest: string;
  tx: WalletTx;
  quoteObservedAt: string;
  quoteAgeAtArmMs: number;
  sourceBlock: number;
  nonceAtPreflight: string;
  txHash: string | null;
  hashSource: "wallet" | "chain-detected" | null;
  walletResult: WalletResultRecord | null;
  history: { at: string; state: string; note?: string }[];
}
export interface LockStore {
  readonly path: string;
  read(): LockRecord | null;
  createExclusive(record: LockRecord): boolean;
  replace(record: LockRecord): void;
}
export function fileLockStore(path: string): LockStore {
  const writeDurable = (fd: number, text: string) => {
    writeSync(fd, text);
    fsyncSync(fd);
    closeSync(fd);
  };
  return {
    path,
    read: () =>
      existsSync(path)
        ? (JSON.parse(readFileSync(path, "utf8")) as LockRecord)
        : null,
    // O_CREAT|O_EXCL: of any number of concurrent sessions/processes exactly one can ever arm.
    createExclusive(record) {
      mkdirSync(dirname(path), { recursive: true });
      let fd: number;
      try {
        fd = openSync(path, "wx");
      } catch (e) {
        if ((e as { code?: string }).code === "EEXIST") return false;
        throw e;
      }
      writeDurable(fd, JSON.stringify(record, null, 1) + "\n");
      return true;
    },
    replace(record) {
      const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      writeDurable(openSync(tmp, "wx"), JSON.stringify(record, null, 1) + "\n");
      renameSync(tmp, path);
    },
  };
}

// ------------------------------------------------------------------ session
export interface WalletIdentity {
  account: string;
  chainId: string;
}
export interface FinalInput {
  intentDigest: string;
  confirmations: { scope: boolean; trust: boolean; phrase: string };
  wallet: WalletIdentity;
}
export interface ArmInput {
  candidateId: string;
  intentDigest: string;
  wallet: WalletIdentity;
}
export const WALLET_OUTCOMES = [
  "TX_HASH",
  "USER_REJECTED",
  "PROVIDER_ERROR",
  "ABORTED_BEFORE_WALLET_REQUEST",
] as const;
export interface WalletResultInput {
  armId: string;
  outcome: (typeof WALLET_OUTCOMES)[number];
  txHash?: string;
  errorCode?: number | string | null;
  errorMessage?: string | null;
  quoteAgeAtWalletRequestMs?: number | null;
  walletRequestAt?: number | null;
}
export interface WalletResultRecord extends WalletResultInput {
  receivedAt: string;
}
export interface SessionDeps {
  execution?: ExecutionEvidence;
  mode: PilotMode;
  fixture: boolean;
  preflight: PreflightSource;
  tracker: TrackerSource;
  lock: LockStore | null;
  journal: (event: string, data?: Record<string, unknown>) => void;
  now?: () => number;
  ttlMs?: number;
  trackIntervalMs?: number;
  detectIntervalMs?: number;
}

const HASH = /^0x[0-9a-fA-F]{64}$/;
const lc = (s: string) => s.toLowerCase();
const secretEquals = (a: string, b: string) => {
  const x = Buffer.from(a, "utf8"),
    y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
};
const iso = (ms: number) => new Date(ms).toISOString();

export class PilotSession {
  readonly execution: ExecutionEvidence;
  readonly id = `g7p-${randomBytes(6).toString("hex")}`;
  readonly token = randomBytes(32).toString("base64url");
  private csrf: string | null = null;
  readonly startedAt: number;
  readonly expiresAt: number;
  state: SessionState = "PREFLIGHT_RUNNING";
  latest: PreflightOutcome | null = null;
  private candidate: {
    id: string;
    outcome: PreflightOutcome;
    digest: string;
  } | null = null;
  private armed: {
    id: string;
    at: number;
    tx: WalletTx;
    digest: string;
    quoteAgeMs: number;
    sourceBlock: number;
  } | null = null;
  private sendCapability: boolean;
  private busy = false;
  private startFlight: Promise<void> | null = null;
  private refreshFlight: Promise<ReturnType<PilotSession["snapshot"]>> | null =
    null;
  private walletResult: WalletResultRecord | null = null;
  private txHash: string | null = null;
  private hashSource: "wallet" | "chain-detected" | null = null;
  private tracking: TrackSnapshot | null = null;
  private trackingError: string | null = null;
  private detection: DetectResult | null = null;
  private lockRecord: LockRecord | null = null;
  private dryRunArms = 0;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly deps: SessionDeps) {
    if (
      deps.mode === "real" &&
      !deps.fixture &&
      deps.preflight.baselineScope !== "accepted"
    )
      throw new Error("REAL_MODE_REQUIRES_ACCEPTED_BASELINE_SOURCE");
    this.execution =
      deps.execution ?? deps.preflight.execution ?? new ExecutionEvidence();
    this.now = deps.now ?? Date.now;
    this.startedAt = this.now();
    this.expiresAt = this.startedAt + (deps.ttlMs ?? SESSION_TTL_MS);
    if (deps.mode === "real" && !deps.lock)
      throw new Error("REAL_MODE_REQUIRES_LOCK_STORE");
    const existing = deps.lock?.read() ?? null;
    // An existing lock means this owner approval was already used: observe only, never arm again.
    this.sendCapability = existing === null;
    if (existing) {
      if (existing.execution) this.execution.restore(existing.execution);
      else if (
        existing.walletResult &&
        existing.walletResult.outcome !== "ABORTED_BEFORE_WALLET_REQUEST"
      ) {
        this.execution.record("walletRequestAttempts");
        this.execution.record("walletRequestsIssued");
      }
      this.lockRecord = existing;
      this.txHash = existing.txHash;
      this.hashSource = existing.hashSource;
      this.walletResult = existing.walletResult;
      this.armed = {
        id: "previous-run",
        at: Date.parse(existing.armedAt),
        tx: existing.tx,
        digest: existing.intentDigest,
        quoteAgeMs: existing.quoteAgeAtArmMs,
        sourceBlock: existing.sourceBlock,
      };
      this.state = existing.state === "G7_PASS" ? "G7_PASS" : "LOCKED";
    }
    deps.journal("SESSION_CREATED", {
      sessionId: this.id,
      mode: deps.mode,
      fixture: deps.fixture,
      expiresAt: iso(this.expiresAt),
      lockPath: deps.lock?.path ?? null,
      existingLock: existing ? existing.state : null,
    });
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.startFlight ??= this.performStart();
    return this.startFlight;
  }
  private async performStart() {
    if (this.state === "LOCKED" || this.state === "G7_PASS") {
      if (this.txHash) this.startTracking();
      else this.startDetection();
      return;
    }
    await this.deps.preflight
      .baseline()
      .catch((e) => this.deps.journal("BASELINE_ERROR", { error: String(e) }));
    await this.runPreflight("initial");
  }
  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
  }
  // Launcher expiry monitor: a session past its lifetime that never armed becomes EXPIRED (no send capability).
  // An armed run keeps observing (tracking/detection have their own windows).
  expireIfDue() {
    if (
      this.expired() &&
      !this.busy &&
      this.armed === null &&
      this.state !== "EXPIRED"
    )
      this.expire();
    return this.state === "EXPIRED";
  }
  private expired() {
    return this.now() >= this.expiresAt;
  }
  private async runPreflight(kind: "initial" | "refresh") {
    this.busy = true;
    this.state = "PREFLIGHT_RUNNING";
    try {
      const outcome = await this.deps.preflight.run(kind);
      this.latest = outcome;
      this.applyPreflight(outcome);
      this.deps.journal("PREFLIGHT", this.preflightJournal(outcome));
    } finally {
      this.busy = false;
    }
  }
  private applyPreflight(o: PreflightOutcome) {
    if (o.status === "OWNER_REAPPROVAL_REQUIRED") {
      this.state = "OWNER_REAPPROVAL_REQUIRED";
      this.sendCapability = false;
    } else this.state = o.status === "READY" ? "READY" : "BLOCKED";
  }
  private preflightJournal(o: PreflightOutcome) {
    return {
      id: o.id,
      kind: o.kind,
      status: o.status,
      blockedReasons: o.blockedReasons,
      reapprovalReasons: o.reapprovalReasons,
      intentDigest: o.review?.intentDigest ?? null,
      quoteObservedAt: o.review ? iso(o.review.quote.observedAt) : null,
      quoteAgeAtDecisionMs: o.review
        ? o.decisionAt - o.review.quote.observedAt
        : null,
    };
  }

  // ---------------------------------------------------------------- authentication (bearer token + CSRF)
  checkToken(token: string | null) {
    return token !== null && secretEquals(token, this.token);
  }
  checkCsrf(csrf: string | null) {
    return this.csrf !== null && csrf !== null && secretEquals(csrf, this.csrf);
  }
  // Every claim rotates the CSRF token: only the most recently claimed tab can act.
  claim() {
    this.csrf = randomBytes(32).toString("base64url");
    this.deps.journal("CLAIMED", {});
    return { csrf: this.csrf, ...this.snapshot() };
  }

  // ---------------------------------------------------------------- owner actions
  async refresh() {
    if (this.refreshFlight) return this.refreshFlight;
    if (this.busy) throw new PilotError("BUSY");
    if (
      !["READY", "BLOCKED", "ARMABLE", "DRY_RUN_COMPLETE"].includes(this.state)
    )
      throw new PilotError(`REFRESH_NOT_ALLOWED_IN_${this.state}`);
    if (this.expired()) return this.expire();
    this.candidate = null;
    this.refreshFlight = this.runPreflight("refresh")
      .then(() => this.snapshot())
      .finally(() => {
        this.refreshFlight = null;
      });
    return this.refreshFlight;
  }

  async final(input: FinalInput) {
    if (this.busy) throw new PilotError("BUSY");
    if (this.state !== "READY")
      throw new PilotError(`FINAL_NOT_ALLOWED_IN_${this.state}`);
    if (!this.sendCapability) throw new PilotError("SEND_CAPABILITY_CONSUMED");
    if (this.expired()) return this.expire();
    this.assertConfirmations(input.confirmations);
    this.assertWallet(input.wallet);
    if (
      !this.latest?.review ||
      input.intentDigest !== this.latest.review.intentDigest
    )
      throw new PilotError("CLIENT_INTENT_NOT_LATEST_REVIEW");
    this.busy = true;
    this.state = "FINAL_PREFLIGHT_RUNNING";
    let outcome: PreflightOutcome;
    try {
      outcome = await this.deps.preflight.run("final");
    } finally {
      this.busy = false;
    }
    this.latest = outcome;
    this.applyPreflight(outcome);
    const journal = this.preflightJournal(outcome);
    if (outcome.status !== "READY" || !outcome.review) {
      this.deps.journal("FINAL_PREFLIGHT_NOT_READY", journal);
      return { outcome: outcome.status, ...this.snapshot() };
    }
    // The server recomputes the intent digest from the fresh transaction; it must equal the reviewed one exactly.
    const recomputed = pilotIntentDigest(outcome.review.intent);
    if (
      recomputed !== outcome.review.intentDigest ||
      recomputed !== input.intentDigest
    ) {
      this.state = "READY";
      this.deps.journal("FINAL_INTENT_CHANGED", {
        ...journal,
        clientDigest: input.intentDigest,
      });
      return { outcome: "INTENT_CHANGED", ...this.snapshot() };
    }
    const age = this.now() - outcome.review.quote.observedAt;
    if (age > ARM_MAX_QUOTE_AGE_MS || age < 0) {
      this.state = "READY";
      this.deps.journal("FINAL_QUOTE_TOO_OLD", { ...journal, ageMs: age });
      return { outcome: "QUOTE_TOO_OLD", quoteAgeMs: age, ...this.snapshot() };
    }
    this.candidate = {
      id: `cand-${randomBytes(8).toString("hex")}`,
      outcome,
      digest: recomputed,
    };
    this.state = "ARMABLE";
    this.deps.journal("ARMABLE", {
      ...journal,
      candidateId: this.candidate.id,
      quoteAgeMs: age,
    });
    return {
      outcome: "ARMABLE",
      candidateId: this.candidate.id,
      quoteAgeMs: age,
      ...this.snapshot(),
    };
  }

  arm(input: ArmInput) {
    if (noWriteReasons(this.execution.snapshot()).length)
      throw new PilotError("WRITE_EXECUTION_ALREADY_OBSERVED");
    const c = this.candidate;
    if (this.state !== "ARMABLE" || !c)
      throw new PilotError(`ARM_NOT_ALLOWED_IN_${this.state}`);
    if (input.candidateId !== c.id || input.intentDigest !== c.digest)
      throw new PilotError("CANDIDATE_MISMATCH");
    if (!this.sendCapability) throw new PilotError("SEND_CAPABILITY_CONSUMED");
    this.assertWallet(input.wallet);
    const review = c.outcome.review!;
    const age = this.now() - review.quote.observedAt;
    if (age > ARM_MAX_QUOTE_AGE_MS || age < 0 || this.expired()) {
      this.candidate = null;
      this.state = this.expired() ? "EXPIRED" : "READY";
      this.deps.journal("ARM_REFUSED_STALE", { candidateId: c.id, ageMs: age });
      throw new PilotError(
        this.expired() ? "SESSION_EXPIRED" : "QUOTE_TOO_OLD",
      );
    }
    // Server-side recomputation right before release: the digest of the stored intent and the transaction
    // bytes must still describe each other exactly (no mutation between the final preflight and the arm).
    assertReviewConsistent(review);
    if (pilotIntentDigest(review.intent) !== c.digest)
      throw new PilotError("INTENT_MUTATED");
    this.candidate = null;
    if (this.deps.mode === "dry-run") {
      this.dryRunArms++;
      this.state = "DRY_RUN_COMPLETE";
      this.deps.journal("DRY_RUN_ARM_SUPPRESSED", {
        intentDigest: c.digest,
        quoteAgeMs: age,
        tx: review.tx,
      });
      return {
        dryRun: true as const,
        wouldSend: review.tx,
        intentDigest: c.digest,
        quoteAgeMs: age,
        ...this.snapshot(),
      };
    }
    const armId = `arm-${randomBytes(8).toString("hex")}`;
    const record: LockRecord = {
      schema: "otherbridge.g7.pilot-lock.v1",
      note: "One-shot G7 pilot send capability CONSUMED. Never deleted or reset by the harness; a new attempt needs a new explicit owner approval.",
      state: "ARMED",
      sessionId: this.id,
      armedAt: iso(this.now()),
      intentDigest: c.digest,
      tx: review.tx,
      quoteObservedAt: iso(review.quote.observedAt),
      quoteAgeAtArmMs: age,
      sourceBlock: review.quote.sourceBlock,
      nonceAtPreflight: c.outcome.summary?.nonce ?? "",
      txHash: null,
      hashSource: null,
      walletResult: null,
      history: [{ at: iso(this.now()), state: "ARMED" }],
    };
    // Consume first, durably; only then release the transaction parameters.
    this.sendCapability = false;
    if (!this.deps.lock!.createExclusive(record)) {
      this.state = "LOCKED";
      this.lockRecord = this.deps.lock!.read();
      this.deps.journal("ARM_REFUSED_LOCK_EXISTS", {});
      throw new PilotError("ALREADY_ARMED_LOCK_EXISTS");
    }
    this.lockRecord = record;
    this.armed = {
      id: armId,
      at: this.now(),
      tx: review.tx,
      digest: c.digest,
      quoteAgeMs: age,
      sourceBlock: review.quote.sourceBlock,
    };
    this.state = "ARMED";
    this.deps.journal("ARMED", {
      armId,
      intentDigest: c.digest,
      quoteAgeMs: age,
      tx: review.tx,
    });
    this.startDetection();
    return {
      dryRun: false as const,
      armId,
      tx: review.tx,
      intent: review.intent,
      intentDigest: c.digest,
      quoteAgeMs: age,
      quoteMaxAgeAtWalletMs: QUOTE_MAX_AGE_AT_WALLET_MS,
      ...this.snapshot(),
    };
  }

  // A dispatched attempt is separate from consuming the one-shot capability at arm.
  walletAttempt(armId: string) {
    if (this.deps.mode === "dry-run") {
      this.execution.record("walletRequestAttempts");
      if (this.latest) {
        const p20 = this.latest.gates.find((g) => g.id === "P20");
        if (p20) {
          p20.status = "FAIL";
          p20.reasons = noWriteReasons(this.execution.snapshot());
        } else
          this.latest.gates.push({
            id: "P20",
            name: "NO_WRITE_PATH_EXECUTED",
            status: "FAIL",
            reasons: noWriteReasons(this.execution.snapshot()),
          });
        this.latest.status = "BLOCKED";
        this.latest.blockedReasons.push("BLOCKED_NO_WRITE_PATH_EXECUTED");
      }
      this.state = "BLOCKED";
      this.deps.journal("DRY_WALLET_ATTEMPT_REFUSED", {});
      throw new PilotError("DRY_WALLET_ATTEMPT_FORBIDDEN");
    }
    if (this.state !== "ARMED" || !this.armed || armId !== this.armed.id)
      throw new PilotError("WALLET_ATTEMPT_NOT_ARMED");
    if (this.execution.snapshot().walletRequestAttempts)
      throw new PilotError("SECOND_WALLET_ATTEMPT_REFUSED");
    if (
      this.now() - this.armed.at + this.armed.quoteAgeMs >
      QUOTE_MAX_AGE_AT_WALLET_MS
    )
      throw new PilotError("QUOTE_TOO_OLD");
    this.execution.record("walletRequestAttempts");
    this.deps.journal("WALLET_REQUEST_ATTEMPT", { armId });
    this.persist("ARMED", "WALLET_REQUEST_ATTEMPT");
    return { recorded: true, ...this.snapshot() };
  }
  // Exactly one wallet result is accepted, and only for the armed request.
  walletOutcome(input: WalletResultInput) {
    if (this.state !== "ARMED" || !this.armed || input.armId !== this.armed.id)
      throw new PilotError(`WALLET_RESULT_NOT_ACCEPTED_IN_${this.state}`);
    const record: WalletResultRecord = {
      ...input,
      receivedAt: iso(this.now()),
    };
    this.walletResult = record;
    if (input.outcome !== "ABORTED_BEFORE_WALLET_REQUEST") {
      if (!this.execution.snapshot().walletRequestAttempts)
        this.execution.record("walletRequestAttempts");
      this.execution.record("walletRequestsIssued");
    }
    let next: LockState;
    if (input.outcome === "TX_HASH") {
      if (!input.txHash || !HASH.test(input.txHash)) {
        next = "MANUAL_REVIEW_REQUIRED";
        record.errorMessage = `INVALID_HASH_FROM_WALLET:${String(input.txHash).slice(0, 80)}`;
      } else {
        next = "SENT";
        this.txHash = lc(input.txHash);
        this.hashSource = "wallet";
      }
    } else if (input.outcome === "USER_REJECTED") next = "USER_REJECTED";
    else if (input.outcome === "ABORTED_BEFORE_WALLET_REQUEST")
      next = "ABORTED_BEFORE_WALLET_REQUEST";
    else next = "MANUAL_REVIEW_REQUIRED";
    this.state = next;
    this.persist(next, input.outcome);
    this.deps.journal("WALLET_RESULT", { ...record, state: next });
    if (this.txHash) this.startTracking();
    return this.snapshot();
  }
  private persist(state: LockState, note?: string) {
    if (!this.deps.lock || !this.lockRecord) return;
    this.lockRecord = {
      ...this.lockRecord,
      state,
      txHash: this.txHash,
      hashSource: this.hashSource,
      walletResult: this.walletResult,
      execution: this.execution.snapshot(),
      history: [
        ...this.lockRecord.history,
        { at: iso(this.now()), state, note },
      ],
    };
    this.deps.lock.replace(this.lockRecord);
  }
  private expire() {
    this.state = "EXPIRED";
    this.sendCapability = false;
    this.candidate = null;
    this.deps.journal("EXPIRED", {});
    return { outcome: "EXPIRED", ...this.snapshot() };
  }
  private assertConfirmations(c: FinalInput["confirmations"]) {
    if (c.scope !== true || c.trust !== true)
      throw new PilotError("CONFIRMATIONS_MISSING", 400);
    if (c.phrase !== CONFIRMATION_PHRASE)
      throw new PilotError("CONFIRMATION_PHRASE_MISMATCH", 400);
  }
  private assertWallet(w: WalletIdentity) {
    if (lc(w.account) !== lc(PILOT_SCOPE.account))
      throw new PilotError("WALLET_ACCOUNT_NOT_OWNER_EOA", 400);
    if (lc(w.chainId) !== PILOT_SCOPE.sourceChainIdHex)
      throw new PilotError("WALLET_CHAIN_NOT_612055", 400);
  }

  // ---------------------------------------------------------------- read-only observation after arming
  private schedule(fn: () => Promise<void>, ms: number) {
    if (this.stopped) return;
    const t = setTimeout(() => void fn(), ms);
    t.unref?.();
    this.timers.push(t);
  }
  private startTracking() {
    const interval = this.deps.trackIntervalMs ?? 10_000;
    const tx = this.armed?.tx ?? this.lockRecord?.tx;
    const hash = this.txHash;
    if (!tx || !hash) return;
    const startedAt = this.now();
    const tick = async () => {
      try {
        const snap = await this.deps.tracker.track({ txHash: hash, tx });
        this.tracking = snap;
        this.trackingError = null;
        this.deps.journal("TRACK", {
          status: snap.status,
          g7Pass: snap.g7Pass,
          reasons: snap.reasons,
          txCheck: snap.txCheck,
          source: snap.source,
          destination: snap.destination,
        });
        if (snap.g7Pass) {
          if (
            this.hashSource === "wallet" &&
            (this.state === "SENT" || this.state === "LOCKED")
          ) {
            this.state = "G7_PASS";
            this.persist(
              "G7_PASS",
              "tracking COMPLETED with exact on-chain evidence",
            );
          }
          return; // terminal: nothing more to observe
        }
      } catch (e) {
        this.trackingError = String((e as Error)?.message ?? e).slice(0, 300);
      }
      if (this.now() - startedAt < 3 * 3600_000) this.schedule(tick, interval);
    };
    this.schedule(tick, 0);
  }
  // No hash (yet): watch read-only for a BridgeInitiated from the owner EOA so an unreported broadcast is never
  // mistaken for "nothing happened" (which could tempt a second transaction).
  private startDetection() {
    const interval = this.deps.detectIntervalMs ?? 15_000;
    const from =
      (this.armed?.sourceBlock ?? this.lockRecord?.sourceBlock ?? 0) - 5;
    const startedAt = this.now();
    const tick = async () => {
      if (this.txHash) return;
      try {
        const d = await this.deps.tracker.detect({
          fromOneBlock: Math.max(0, from),
        });
        this.detection = d;
        if (d.transfers.length >= 1) {
          this.deps.journal("CHAIN_DETECTED_TRANSFER", { ...d });
          if (!this.txHash && d.transfers.length === 1) {
            this.txHash = lc(d.transfers[0].txHash);
            this.hashSource = "chain-detected";
            if (
              this.state === "ARMED" ||
              this.state === "USER_REJECTED" ||
              this.state === "ABORTED_BEFORE_WALLET_REQUEST"
            ) {
              this.state = "MANUAL_REVIEW_REQUIRED";
            }
            this.persist(
              "MANUAL_REVIEW_REQUIRED",
              `chain-detected ${this.txHash}`,
            );
            this.startTracking();
            return;
          }
          if (d.transfers.length > 1) {
            this.state = "MANUAL_REVIEW_REQUIRED";
            this.persist(
              "MANUAL_REVIEW_REQUIRED",
              "MORE_THAN_ONE_TRANSFER_DETECTED",
            );
            return;
          }
        }
      } catch (e) {
        this.trackingError = String((e as Error)?.message ?? e).slice(0, 300);
      }
      if (this.now() - startedAt < 3600_000) this.schedule(tick, interval);
    };
    this.schedule(tick, interval);
  }

  // ---------------------------------------------------------------- public view (no secrets)
  snapshot() {
    const o = this.latest;
    return {
      sessionId: this.id,
      mode: this.deps.mode,
      fixture: this.deps.fixture,
      state: this.state,
      terminal: TERMINAL_STATES.has(this.state),
      busy: this.busy,
      sendCapability: this.sendCapability,
      startedAt: this.startedAt,
      expiresAt: this.expiresAt,
      serverNow: this.now(),
      constants: {
        account: PILOT_SCOPE.account,
        contract: PILOT_SCOPE.contract,
        chainIdHex: PILOT_SCOPE.sourceChainIdHex,
        phrase: CONFIRMATION_PHRASE,
        buttonLabel: BUTTON_LABEL,
        checks: CONFIRMATION_CHECKS,
        quoteMaxAgeAtWalletMs: QUOTE_MAX_AGE_AT_WALLET_MS,
        armMaxQuoteAgeMs: ARM_MAX_QUOTE_AGE_MS,
        bounds: Object.fromEntries(
          Object.entries(PILOT_BOUNDS).map(([k, v]) => [k, v.toString()]),
        ),
        mockWalletRdns: this.deps.fixture ? MOCK_WALLET_RDNS : null,
        trustStatement: TRUST_STATEMENT,
        trustAcceptance: TRUST_ACCEPTANCE_SENTENCE,
      },
      preflight: o
        ? {
            id: o.id,
            kind: o.kind,
            status: o.status,
            startedAt: o.startedAt,
            decisionAt: o.decisionAt,
            gates: o.gates,
            blockedReasons: o.blockedReasons,
            reapprovalReasons: o.reapprovalReasons,
            summary: o.summary,
            review: o.review,
            error: o.error ?? null,
            diagnostics: o.diagnostics ?? null,
          }
        : null,
      candidate: this.candidate
        ? {
            id: this.candidate.id,
            armableUntil:
              this.candidate.outcome.review!.quote.observedAt +
              ARM_MAX_QUOTE_AGE_MS,
          }
        : null,
      armed: this.armed
        ? {
            at: this.armed.at,
            intentDigest: this.armed.digest,
            tx: this.armed.tx,
            quoteAgeAtArmMs: this.armed.quoteAgeMs,
          }
        : null,
      walletResult: this.walletResult,
      txHash: this.txHash,
      hashSource: this.hashSource,
      tracking: this.tracking,
      trackingError: this.trackingError,
      detection: this.detection,
      lock: this.lockRecord,
      dryRunArms: this.dryRunArms,
      counters: {
        ...this.execution.snapshot(),
        realSignatures: this.hashSource ? 1 : 0,
        broadcasts: Math.max(
          this.execution.snapshot().broadcasts,
          this.hashSource ? 1 : 0,
        ),
      },
    };
  }
}

// The stored review must be internally consistent: the intent describes exactly the transaction bytes.
export function assertReviewConsistent(
  review: NonNullable<PreflightOutcome["review"]>,
) {
  const { intent, tx } = review;
  const d = decodeBridgeTokenIndependent(tx.data);
  const checks: [string, boolean][] = [
    ["from", lc(intent.from) === lc(tx.from)],
    ["to", lc(intent.to) === lc(tx.to)],
    ["calldata", lc(intent.calldata) === lc(tx.data)],
    ["value", intent.value === BigInt(tx.value).toString()],
    ["gas", intent.gasLimit === BigInt(tx.gas).toString()],
    ["maxFee", intent.maxFeePerGas === BigInt(tx.maxFeePerGas).toString()],
    [
      "priority",
      intent.maxPriorityFeePerGas ===
        BigInt(tx.maxPriorityFeePerGas).toString(),
    ],
    ["chain", intent.sourceChainId === Number(BigInt(tx.chainId))],
    ["recipient", lc(intent.recipient) === lc(d.to)],
    [
      "principal",
      intent.principal === d.value.toString() &&
        d.value === PILOT_SCOPE.principal,
    ],
    ["networkFee", intent.networkFee === d.networkFee.toString()],
    ["serviceFee", intent.serviceFee === d.exFee.toString()],
    ["destination", intent.destinationChainId === Number(d.toChainID)],
    ["digest", pilotIntentDigest(intent) === review.intentDigest],
    [
      "bounds",
      BigInt(intent.maximumWalletDebit) <= PILOT_BOUNDS.maxWalletDebit,
    ],
  ];
  const bad = checks.filter(([, ok]) => !ok).map(([k]) => k);
  if (bad.length) throw new PilotError(`REVIEW_INCONSISTENT:${bad.join(",")}`);
}
