import { z } from "zod";
// VEINED weekly points domain model. Records are stored with bigint amounts encoded as decimal strings so the same
// shape round-trips through memory, Postgres JSON and API responses without precision loss.

export const CATEGORIES = ["SWAP", "TRADE", "BRIDGE"] as const;
export type Category = (typeof CATEGORIES)[number];

export const SEASON_STATES = [
  "OPEN",
  "CALCULATING",
  "REVIEW_PENDING",
  "FINALIZED",
  "PUBLISHED",
] as const;
export type SeasonState = (typeof SEASON_STATES)[number];

const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((v) => !Number.isNaN(Date.parse(v)), "INSTANT_INVALID");
export const unitString = z.string().regex(/^(0|[1-9]\d{0,38})$/);
const safeId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/);

// Accounts are wallet addresses: EVM lowercased, Solana base58 kept exact. One canonical string per account.
const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function normalizeAccount(raw: string): string {
  const value = raw.trim();
  if (EVM.test(value)) return value.toLowerCase();
  if (SOLANA.test(value)) return value;
  throw Error("ACCOUNT_INVALID");
}
export const accountSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    try {
      return normalizeAccount(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "ACCOUNT_INVALID" });
      return z.NEVER;
    }
  });

// Outcomes a verifier can report. Only SETTLED (swap/trade) and COMPLETED (bridge destination) can ever earn weight;
// quotes, unsigned intents, pending, failed, reverted and cancelled operations are recorded and rejected.
export const OUTCOMES = [
  "SETTLED",
  "COMPLETED",
  "PENDING",
  "FAILED",
  "REVERTED",
  "CANCELLED",
  "QUOTE",
  "UNSIGNED_INTENT",
] as const;
export const verifiedActivitySchema = z
  .object({
    eventId: safeId,
    verifier: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/),
    category: z.enum(CATEGORIES),
    // Canonical operation identity shared by every category (e.g. "evm:56:0x<tx>"), so one settlement can never
    // be counted twice as a swap and as a trade.
    operationKey: z
      .string()
      .regex(/^[a-z0-9]{2,16}:[A-Za-z0-9]{1,24}:[A-Za-z0-9:_-]{8,140}$/),
    account: accountSchema,
    outcome: z.enum(OUTCOMES),
    occurredAt: isoInstant,
    chainId: z.string().regex(/^[A-Za-z0-9-]{1,24}$/),
    volumeUsdMicros: unitString,
    finality: z
      .object({
        blockNumber: z.string().regex(/^\d{1,20}$/),
        blockHash: z.string().regex(/^[A-Za-z0-9]{8,128}$/),
        confirmations: z.number().int().min(0).max(1_000_000),
        finalized: z.boolean(),
      })
      .strict(),
    bridge: z
      .object({
        destinationChainId: z.string().regex(/^[A-Za-z0-9-]{1,24}$/),
        destinationTx: z.string().regex(/^[A-Za-z0-9]{8,128}$/),
        destinationVerified: z.boolean(),
      })
      .strict()
      .optional(),
    attribution: z
      .object({ referralCode: z.string().max(32).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type VerifiedActivity = z.output<typeof verifiedActivitySchema>;

export type ActivityStatus =
  "PENDING_FINALITY" | "ELIGIBLE" | "REJECTED" | "REVERSED";
export interface ActivityRecord {
  event: VerifiedActivity;
  contentHash: string;
  season: number;
  status: ActivityStatus;
  reason?: string;
  receivedAt: string;
  updatedAt: string;
  revision: number;
  attributionResult?: string;
  // Set when the event changed after its season was finalized; the published result is never recalculated.
  afterFinalization?: boolean;
}

export interface ReferralCode {
  code: string;
  account: string;
  createdAt: string;
}
export interface ReferralBinding {
  child: string;
  parent: string;
  code: string;
  // The first verified activity whose attribution carried the code; commissions apply from its occurrence.
  bindingEventId: string;
  effectiveAt: string;
  createdAt: string;
}

export type FlagKind = "EXCLUDED" | "REVIEW";
export interface AccountFlag {
  account: string;
  kind: FlagKind;
  reason: string;
  createdBy: string;
  createdAt: string;
  active: boolean;
}

// Periodic tasks: every criterion is a server-side verified-activity predicate, so login, signup, wallet-connect
// or browsing tasks cannot be expressed.
export const taskCriteriaSchema = z
  .object({
    category: z.enum(CATEGORIES).optional(),
    chainIds: z
      .array(z.string().regex(/^[A-Za-z0-9-]{1,24}$/))
      .max(20)
      .optional(),
    minEventVolumeUsdMicros: unitString.optional(),
    minCount: z.number().int().min(1).max(100),
  })
  .strict();
export const taskInputSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,47}$/),
    title: z.string().trim().min(3).max(80),
    description: z.string().trim().max(400),
    criteria: taskCriteriaSchema,
    weight: unitString,
    perUserLimit: z.number().int().min(1).max(10),
    globalLimit: z.number().int().min(1).max(1_000_000),
    startsAt: isoInstant,
    endsAt: isoInstant,
    requiresReview: z.boolean(),
  })
  .strict()
  .refine((t) => Date.parse(t.endsAt) > Date.parse(t.startsAt), "TASK_WINDOW");
export type TaskInput = z.output<typeof taskInputSchema>;
export type TaskStatus = "DRAFT" | "APPROVED" | "CANCELLED";
export interface TaskRecord extends TaskInput {
  status: TaskStatus;
  version: number;
  createdBy: string;
  createdAt: string;
  approvedBy?: string;
  approvedAt?: string;
  cancelledBy?: string;
  cancelledAt?: string;
}
export type CompletionStatus =
  "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "VOIDED";
export interface TaskCompletion {
  id: string;
  taskId: string;
  account: string;
  ordinal: number;
  season: number;
  completedAt: string;
  eventIds: string[];
  weight: string;
  status: CompletionStatus;
  revision: number;
  reviewedBy?: string;
  reason?: string;
}

export type LineKind = "ACTIVITY" | "TASK" | "REFERRAL_COMMISSION";
export type LedgerKind = LineKind | "CORRECTION";
export interface LedgerEntry {
  id: string;
  season: number;
  account: string;
  kind: LedgerKind;
  amountUnits: string; // negative only for CORRECTION
  sourceRef: string;
  sourceAccount?: string;
  calculationId?: string;
  correctionId?: string;
  createdAt: string;
}

export interface AllocationSummary {
  poolUnits: string;
  denominator: string;
  allocatedUnits: string;
  commissionUnits: string;
  residualUnits: string;
  undistributedUnits: string;
  accounts: number;
  lines: number;
}
export interface CalculationRecord {
  id: string;
  season: number;
  inputHash: string;
  policyVersion: string;
  policyHash: string;
  resultHash: string;
  calculatedBy: string;
  calculatedAt: string;
  summary: AllocationSummary;
  entries: LedgerEntry[];
}
export interface UndistributedRecord {
  units: string;
  decision: "PENDING_OWNER_DECISION" | "RETAINED_UNALLOCATED";
  decidedBy?: string;
  decidedAt?: string;
  note?: string;
}
export interface SeasonRecord {
  season: number;
  startsAt: string;
  endsAt: string;
  state: SeasonState;
  version: number;
  configHash: string;
  policyVersion: string;
  policyHash: string;
  calculation?: CalculationRecord;
  calculationStartedAt?: string;
  fence?: number;
  rejectedCalculations: string[];
  finalizedAt?: string;
  finalizedBy?: string;
  publishedAt?: string;
  publishedBy?: string;
  undistributed?: UndistributedRecord;
  corrections: string[];
}

export type CorrectionStatus = "PROPOSED" | "APPLIED" | "REJECTED";
export interface CorrectionRecord {
  id: string;
  season: number;
  eventId: string;
  reason: string;
  entries: LedgerEntry[];
  status: CorrectionStatus;
  proposedBy: string;
  proposedAt: string;
  decidedBy?: string;
  decidedAt?: string;
}

export interface AuditRecord {
  seq: number;
  at: string;
  actor: string;
  action: string;
  target: string;
  details: Record<string, unknown>;
  prevHash: string;
  hash: string;
}

export class PointsError extends Error {
  constructor(
    public code: string,
    public status = 422,
  ) {
    super(code);
  }
}
