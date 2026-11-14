import {
  normalizeAccount,
  type Category,
  type ReferralBinding,
  type VerifiedActivity,
} from "../points/model";
import {
  LIFETIME_REFERRAL_BPS,
  activation,
  lifetimePolicySchema,
  type LifetimePolicy,
} from "./policy";
// gf1 G06: deterministic lifetime-points ledger over verified inputs. Pure and order-independent (inputs are sorted
// before use); exact bigint units (1 point = 1,000,000 units); a referral commission is floor(activity units × 10%).
// Every input produces exactly one line with its status, so an admin can see why an account has what it has; a
// reversal keeps the original line (status REVERSED) and its commission (REVERSED) for the audit trail. Under a
// PENDING_OWNER_POLICY nothing is computed at all: points are never invented from a missing decision. An activity is
// priced by the policy version in effect when it happened (each priced line names it), and an exclusion applies only
// within its own decided period.

export interface TaskAward {
  awardId: string;
  taskId: string;
  account: string;
  occurredAt: string;
  /** Approved by an admin review; anything else earns nothing. */
  approved: boolean;
}
export interface Reversal {
  reversalId: string;
  /** The activity eventId or task awardId being reversed (reorg, refund, abuse finding). */
  ref: string;
  at: string;
  reason: string;
}
/** An exclusion as decided, with its own period (review-2 MJ1). It must come from an append-only record of the
 * decisions (for example the audit trail's ACCOUNT_FLAGGED / ACCOUNT_UNFLAGGED entries), never from the weekly store's
 * AccountFlag, whose createdAt is rewritten on every flag write. */
export interface ExclusionPeriod {
  account: string;
  /** Inclusive start. */
  from: string;
  /** Exclusive end, when the exclusion was lifted; absent or null while it holds. */
  until?: string | null;
}
export interface LedgerInputs {
  /** The current (latest) policy version. */
  policy: LifetimePolicy;
  /** Every earlier policy version, each with an earlier effectiveFrom: an activity is priced by the version in effect
   * when it happened, so a later rate change never re-prices history (review M1). The version registry is append-only
   * and is always passed whole: a version left out makes its period earn nothing. */
  history?: readonly LifetimePolicy[];
  activities: readonly VerifiedActivity[];
  taskAwards?: readonly TaskAward[];
  bindings?: readonly ReferralBinding[];
  reversals?: readonly Reversal[];
  exclusions?: readonly ExclusionPeriod[];
  /** The computation's clock: anything dated more than 5 minutes after it earns nothing (FUTURE_TIMESTAMP, as the
   * weekly engine). Required with an approved policy; fixture runs may omit it. */
  asOf?: string;
}
export type LineStatus = "EARNED" | "PENDING" | "REVERSED" | "REJECTED";
export interface Line {
  ref: string;
  account: string;
  /** REVERSAL: a reversal that could not be applied, reported for the audit (never counted). */
  kind: "ACTIVITY" | "TASK" | "REFERRAL_COMMISSION" | "REVERSAL";
  category?: Category;
  occurredAt: string;
  units: string;
  status: LineStatus;
  reason?: string;
  /** For a commission: the invited account's activity it comes from. */
  source?: string;
  /** The policy version that priced the line (earned, pending or reversed lines). */
  version?: string;
}
export interface AccountTotals {
  activityUnits: string;
  taskUnits: string;
  referralUnits: string;
  totalUnits: string;
  pendingUnits: string;
  reversedUnits: string;
}
export type LedgerResult =
  | { state: "PENDING_OWNER_POLICY"; version: string; missing: string[] }
  | {
      state: "COMPUTED";
      version: string;
      fixture: boolean;
      lines: Line[];
      accounts: Record<string, AccountTotals>;
    };

const BPS = 10_000n;
const FUTURE_SKEW_MS = 5 * 60_000;
/** An exact UTC instant (as the store's records): never a local time that would depend on the machine's zone. */
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const instant = (v: unknown, code: string) => {
  const t = typeof v === "string" && INSTANT.test(v) ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw Error(code);
  return t;
};
const byTimeThenId =
  <T>(time: (x: T) => string, id: (x: T) => string) =>
  (a: T, b: T) => {
    const d = Date.parse(time(a)) - Date.parse(time(b));
    return d || (id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
  };
/** Canonical content of an event (key order independent) for duplicate detection. */
const content = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(content).join(",")}]`
      : `{${Object.keys(v as object)
          .sort()
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .map(
            (k) =>
              `${JSON.stringify(k)}:${content((v as Record<string, unknown>)[k])}`,
          )
          .join(",")}}`;

/** An event's identity: everything except the mutable confirmation count and finalized flag (as the weekly engine). */
const identity = (e: VerifiedActivity) =>
  content({
    ...e,
    finality: {
      blockNumber: e.finality.blockNumber,
      blockHash: e.finality.blockHash,
    },
  });
/** The most final record first (finalized, then more confirmations), then canonical content: one deterministic pick. */
const mostFinal = (a: VerifiedActivity, b: VerifiedActivity) =>
  Number(b.finality.finalized) - Number(a.finality.finalized) ||
  b.finality.confirmations - a.finality.confirmations ||
  (content(a) < content(b) ? -1 : content(a) > content(b) ? 1 : 0);

function eligibility(e: VerifiedActivity): "EARNED" | "PENDING" | string {
  // The outcome is decided first: a quote, an unsigned intent or a failed, reverted or cancelled operation never shows
  // as pending points (review M3), whatever its finality flag says.
  if (e.outcome === "PENDING") return "PENDING";
  const done =
    e.category === "BRIDGE"
      ? e.outcome === "COMPLETED"
      : e.outcome === "SETTLED";
  if (!done) return `OUTCOME_${e.outcome}`;
  // A completed bridge needs its destination record before anything else (review-2 n6).
  if (e.category === "BRIDGE" && !e.bridge) return "BRIDGE_DESTINATION_MISSING";
  if (!e.finality.finalized) return "PENDING";
  if (e.category === "BRIDGE" && !e.bridge!.destinationVerified)
    return "PENDING";
  return "EARNED";
}

export function computeLedger(input: LedgerInputs): LedgerResult {
  // Any policy object is validated: an unchecked object cannot carry another referral rate, depth or signup points.
  const policy = lifetimePolicySchema.parse(input.policy);
  const history = (input.history ?? []).map((p) =>
    lifetimePolicySchema.parse(p),
  );
  const act = activation(policy);
  if (act.state === "PENDING_OWNER_POLICY")
    return {
      state: "PENDING_OWNER_POLICY",
      version: policy.version,
      missing: act.missing,
    };
  // Real (approved) computations always run against a clock.
  if (policy.status === "OWNER_APPROVED" && input.asOf === undefined)
    throw Error("LEDGER_AS_OF_REQUIRED");
  const asOf =
    input.asOf === undefined
      ? null
      : instant(input.asOf, "LEDGER_AS_OF_INVALID");
  const future = (iso: string) =>
    asOf !== null && Date.parse(iso) > asOf + FUTURE_SKEW_MS;
  // Versions in effect, newest first: an activity is priced by the version whose start it is at or after.
  // History belongs to the same kind of policy (sample numbers never mix with approved ones), each version is distinct
  // and starts at its own instant (compared as instants, not strings: review-2 mn3), and the current policy is the
  // latest, so the version in effect at any instant is unambiguous whichever way the versions are passed.
  const all = [policy, ...history];
  if (all.some((v) => v.status !== policy.status))
    throw Error("LIFETIME_HISTORY_STATUS_MISMATCH");
  const starts = all.map((v) =>
    v.effectiveFrom === null ? null : Date.parse(v.effectiveFrom),
  );
  if (
    new Set(all.map((v) => v.version)).size !== all.length ||
    new Set(starts).size !== starts.length
  )
    throw Error("LIFETIME_HISTORY_AMBIGUOUS");
  if (
    history.length &&
    (starts[0] === null ||
      starts.slice(1).some((t) => t === null || t >= starts[0]!))
  )
    throw Error("LIFETIME_HISTORY_NOT_LATEST");
  const versions = all
    .filter((v) => v.effectiveFrom !== null)
    .sort(
      (a, b) => Date.parse(b.effectiveFrom!) - Date.parse(a.effectiveFrom!),
    );
  const versionAt = (iso: string) =>
    versions.find((v) => Date.parse(v.effectiveFrom!) <= Date.parse(iso));
  // An exclusion applies only within its decided period; earlier activity is only removed by explicit reversals,
  // which stay in the audit trail (no silent clawback; review M1, review-2 MJ1).
  // Each period is validated (review-3 MN3): a canonical account, exact instants and a start before its end.
  const periods = (input.exclusions ?? []).map((x) => {
    let account: string;
    try {
      account = normalizeAccount(x.account);
    } catch {
      throw Error("LEDGER_EXCLUSION_INVALID");
    }
    const from = instant(x.from, "LEDGER_EXCLUSION_INVALID");
    const until =
      x.until === undefined || x.until === null
        ? Infinity
        : instant(x.until, "LEDGER_EXCLUSION_INVALID");
    if (until <= from) throw Error("LEDGER_EXCLUSION_INVALID");
    return { account, from, until };
  });
  const excludedAt = (account: string, iso: string) => {
    const t = Date.parse(iso);
    return periods.some(
      (x) => x.account === account && x.from <= t && t < x.until,
    );
  };
  const perDay = new Map<string, number>();
  const reversed = new Map<string, Reversal>();
  for (const r of [...(input.reversals ?? [])].sort(
    byTimeThenId(
      (x) => x.at,
      (x) => x.reversalId,
    ),
  ))
    if (!reversed.has(r.ref)) reversed.set(r.ref, r); // a repeated reversal changes nothing
  const lines: Line[] = [];

  // Activities: one line per distinct eventId; a repeated event is the same event (idempotent; a later confirmation
  // count or finalized flag is the same event, and its most final record is used), the same eventId with other
  // content is a conflict and every variant of it earns nothing (whatever the input order), and one operation is
  // counted once whatever its eventId or category (an earned record of it wins over a pending one).
  const variants = new Map<string, Set<string>>();
  const record = new Map<string, VerifiedActivity>();
  for (const e of input.activities) {
    (
      variants.get(e.eventId) ??
      variants.set(e.eventId, new Set()).get(e.eventId)!
    ).add(identity(e));
    const had = record.get(e.eventId);
    if (!had || mostFinal(e, had) < 0) record.set(e.eventId, e);
  }
  // Per operation, the accounts with an earnable record of it: an earned record wins over a pending one of the same
  // account (review m5); across accounts the first record owns the operation (review-3 NT1).
  const earnable = new Map<string, Set<string>>();
  for (const e of record.values())
    if (variants.get(e.eventId)!.size === 1 && eligibility(e) === "EARNED")
      (
        earnable.get(e.operationKey) ??
        earnable.set(e.operationKey, new Set()).get(e.operationKey)!
      ).add(e.account);
  const awardIds = new Set((input.taskAwards ?? []).map((a) => a.awardId));
  // One reversal ref must name one thing: an id used by both an activity and a task award is not applied (m3).
  const ambiguous = new Set([...record.keys()].filter((k) => awardIds.has(k)));
  const reversalOf = (ref: string) =>
    ambiguous.has(ref) ? undefined : reversed.get(ref);
  const seenOperation = new Set<string>();
  const earnedActivity: Line[] = [];
  for (const e of [...record.values()].sort(
    byTimeThenId(
      (x) => x.occurredAt,
      (x) => x.eventId,
    ),
  )) {
    if (variants.get(e.eventId)!.size > 1) {
      lines.push({
        ref: e.eventId,
        account: e.account,
        kind: "ACTIVITY",
        category: e.category,
        occurredAt: e.occurredAt,
        units: "0",
        status: "REJECTED",
        reason: "EVENT_CONFLICT",
      });
      continue;
    }
    const line: Line = {
      ref: e.eventId,
      account: e.account,
      kind: "ACTIVITY",
      category: e.category,
      occurredAt: e.occurredAt,
      units: "0",
      status: "REJECTED",
    };
    const version = versionAt(e.occurredAt);
    const rate = version ? version.rates[e.category] : null;
    const minVolume = version?.eligibility.minVolumeUsdMicros ?? null;
    const dailyCap = version?.eligibility.maxActivitiesPerAccountPerDay ?? null;
    const dayKey = `${e.account}\u0000${e.occurredAt.slice(0, 10)}`;
    const state = eligibility(e);
    const outcomeOk = state === "PENDING" || state === "EARNED";
    const duplicate =
      seenOperation.has(e.operationKey) ||
      (state === "PENDING" && !!earnable.get(e.operationKey)?.has(e.account));
    if (duplicate) line.reason = "OPERATION_DUPLICATE";
    else if (future(e.occurredAt)) line.reason = "FUTURE_TIMESTAMP";
    else if (excludedAt(e.account, e.occurredAt))
      line.reason = "ACCOUNT_EXCLUDED";
    else if (!version) line.reason = "BEFORE_EFFECTIVE_FROM";
    else if (rate === null) line.reason = "RATE_NOT_SET";
    else if (!outcomeOk) line.reason = state;
    // Eligibility decided by the owner (review M2): a minimum volume per activity and a daily cap per account (UTC
    // day, in time order; an earned or pending activity holds a place, a reversed or rejected one does not).
    else if (
      minVolume !== null &&
      BigInt(e.volumeUsdMicros) < BigInt(minVolume)
    )
      line.reason = "BELOW_MIN_VOLUME";
    else if (dailyCap !== null && (perDay.get(dayKey) ?? 0) >= dailyCap)
      line.reason = "DAILY_CAP";
    else if (state === "PENDING") {
      line.status = "PENDING";
      line.units = rate;
    } else {
      line.units = rate;
      const r = reversalOf(e.eventId);
      line.status = r ? "REVERSED" : "EARNED";
      if (r) line.reason = r.reason;
      earnedActivity.push(line);
    }
    // The first record whose outcome is a success (or still pending) owns its operation, whatever else rejects it:
    // another record of the same operation under another eventId or account never earns instead (review-2 n5). The
    // decision is a flag, never the line's reason text (a reversal's free text could read "OPERATION_DUPLICATE";
    // review-3 MN2).
    if (outcomeOk && !duplicate) seenOperation.add(e.operationKey);
    if (line.status === "EARNED" || line.status === "PENDING")
      perDay.set(dayKey, (perDay.get(dayKey) ?? 0) + 1);
    if (line.status !== "REJECTED") line.version = version!.version;
    lines.push(line);
  }

  // Tasks: approved completions of owner-defined tasks, at most maxPerAccount per account and task. As for
  // activities, a repeated identical award is one award, and two different records under one awardId are a conflict
  // that earns nothing and is reported (review-2 mn2). Approval is one-way: a later approved record of the same award
  // is the same award, and the approved record is used; a revocation is a reversal, never a changed record
  // (review-3 NT4).
  const taskDefAt = (iso: string, taskId: string) =>
    versionAt(iso)?.tasks.find((t) => t.taskId === taskId);
  const awardVariants = new Map<string, Set<string>>();
  const award = new Map<string, TaskAward>();
  for (const a of input.taskAwards ?? []) {
    (
      awardVariants.get(a.awardId) ??
      awardVariants.set(a.awardId, new Set()).get(a.awardId)!
    ).add(content({ ...a, approved: undefined }));
    const had = award.get(a.awardId);
    if (
      !had ||
      Number(a.approved) - Number(had.approved) > 0 ||
      (a.approved === had.approved && content(a) < content(had))
    )
      award.set(a.awardId, a);
  }
  const perAccountTask = new Map<string, number>();
  for (const a of [...award.values()].sort(
    byTimeThenId(
      (x) => x.occurredAt,
      (x) => x.awardId,
    ),
  )) {
    if (awardVariants.get(a.awardId)!.size > 1) {
      lines.push({
        ref: a.awardId,
        account: a.account,
        kind: "TASK",
        occurredAt: a.occurredAt,
        units: "0",
        status: "REJECTED",
        reason: "AWARD_CONFLICT",
      });
      continue;
    }
    const version = versionAt(a.occurredAt);
    const def = taskDefAt(a.occurredAt, a.taskId);
    const line: Line = {
      ref: a.awardId,
      account: a.account,
      kind: "TASK",
      occurredAt: a.occurredAt,
      units: "0",
      status: "REJECTED",
    };
    const key = `${a.account}\u0000${a.taskId}`;
    const count = perAccountTask.get(key) ?? 0;
    if (future(a.occurredAt)) line.reason = "FUTURE_TIMESTAMP";
    else if (!version) line.reason = "BEFORE_EFFECTIVE_FROM";
    else if (!def) line.reason = "TASK_UNKNOWN";
    else if (excludedAt(a.account, a.occurredAt))
      line.reason = "ACCOUNT_EXCLUDED";
    else if (!a.approved) line.reason = "TASK_NOT_APPROVED";
    else if (count >= def.maxPerAccount) line.reason = "TASK_LIMIT";
    else {
      perAccountTask.set(key, count + 1);
      line.units = def.units;
      const r = reversalOf(a.awardId);
      line.status = r ? "REVERSED" : "EARNED";
      if (r) line.reason = r.reason;
      line.version = version!.version;
    }
    lines.push(line);
  }

  // Referral: one binding per invited account (the earliest), never to itself and never back to its own invitee (a
  // two-way pair is refused); 10% of each earned activity line from the binding's effective time on. Commission lines
  // are never a base for another commission (one level), so a longer cycle amplifies nothing: each member earns 10% of
  // one other member's activity, exactly as with any binding (review-2 n4).
  const parentOf = new Map<string, ReferralBinding>();
  for (const b of [...(input.bindings ?? [])].sort(
    (x, y) =>
      byTimeThenId<ReferralBinding>(
        (v) => v.effectiveAt,
        (v) => v.child,
      )(x, y) ||
      (content(x) < content(y) ? -1 : content(x) > content(y) ? 1 : 0),
  ))
    if (
      !parentOf.has(b.child) &&
      b.child !== b.parent &&
      parentOf.get(b.parent)?.parent !== b.child
    )
      parentOf.set(b.child, b);
  for (const l of earnedActivity) {
    const b = parentOf.get(l.account);
    if (!b || Date.parse(l.occurredAt) < Date.parse(b.effectiveAt)) continue;
    // The referral rule is fixed (10%, one level) in every valid version.
    const units = (BigInt(l.units) * BigInt(LIFETIME_REFERRAL_BPS)) / BPS;
    const line: Line = {
      // "/" is not allowed in an event id, so a commission ref never collides with an activity or award id.
      ref: `commission/${l.ref}`,
      account: b.parent,
      kind: "REFERRAL_COMMISSION",
      occurredAt: l.occurredAt,
      units: units.toString(),
      status: l.status,
      source: l.ref,
      version: l.version,
    };
    if (l.status === "REVERSED") line.reason = l.reason;
    if (excludedAt(b.parent, l.occurredAt)) {
      line.status = "REJECTED";
      line.units = "0";
      line.reason = "ACCOUNT_EXCLUDED";
    }
    lines.push(line);
  }
  // A reversal that could not be applied is reported, never applied elsewhere: it names nothing, names two things,
  // names a commission (a commission follows its activity) or a line that was not earned (pending or rejected).
  const target = new Map(
    lines
      .filter((l) => l.kind === "ACTIVITY" || l.kind === "TASK")
      .map((l) => [l.ref, l]),
  );
  for (const r of reversed.values()) {
    const t = target.get(r.ref);
    const reason = ambiguous.has(r.ref)
      ? "REVERSAL_AMBIGUOUS_REF"
      : !t
        ? r.ref.startsWith("commission/")
          ? "REVERSAL_NOT_APPLICABLE"
          : "REVERSAL_UNKNOWN_REF"
        : t.status !== "REVERSED"
          ? "REVERSAL_NOT_APPLICABLE"
          : null;
    if (reason)
      lines.push({
        ref: r.reversalId,
        account: "",
        kind: "REVERSAL",
        occurredAt: r.at,
        units: "0",
        status: "REJECTED",
        reason,
      });
  }

  const accounts: Record<string, AccountTotals> = {};
  const add = (account: string, field: keyof AccountTotals, units: bigint) => {
    const t = (accounts[account] ??= {
      activityUnits: "0",
      taskUnits: "0",
      referralUnits: "0",
      totalUnits: "0",
      pendingUnits: "0",
      reversedUnits: "0",
    });
    t[field] = (BigInt(t[field]) + units).toString();
  };
  for (const l of lines) {
    if (!l.account || l.status === "REJECTED") continue;
    const u = BigInt(l.units);
    if (l.status === "PENDING") add(l.account, "pendingUnits", u);
    else if (l.status === "REVERSED") add(l.account, "reversedUnits", u);
    else {
      add(
        l.account,
        l.kind === "ACTIVITY"
          ? "activityUnits"
          : l.kind === "TASK"
            ? "taskUnits"
            : "referralUnits",
        u,
      );
      add(l.account, "totalUnits", u);
    }
  }
  return {
    state: "COMPUTED",
    version: policy.version,
    fixture: policy.status === "FIXTURE_ONLY",
    lines,
    accounts,
  };
}

/** Only the requesting account's own totals and lines: no other account, no rank, no global sum. Referral commissions
 * appear only inside the totals (one sum, review M4): no per-event commission line, so neither the invited user's
 * events nor their timing are visible to the referrer, and the reversed total counts only the account's own reversed
 * lines (an invitee's reversal is not visible either; review-2 mn5). A reversal shows a code, never the internal
 * review note. */
export function ownView(result: LedgerResult, requested: string) {
  if (result.state !== "COMPUTED")
    return { state: result.state, version: result.version } as const;
  // Accounts are canonical (EVM lowercased), as the store keeps them.
  const account = /^0x[0-9a-fA-F]{40}$/.test(requested)
    ? requested.toLowerCase()
    : requested;
  const own = result.lines.filter(
    (l) => l.account === account && l.kind !== "REFERRAL_COMMISSION",
  );
  return {
    state: result.state,
    version: result.version,
    fixture: result.fixture,
    totals: {
      ...(result.accounts[account] ?? {
        activityUnits: "0",
        taskUnits: "0",
        referralUnits: "0",
        totalUnits: "0",
        pendingUnits: "0",
      }),
      reversedUnits: own
        .filter((l) => l.status === "REVERSED")
        .reduce((sum, l) => sum + BigInt(l.units), 0n)
        .toString(),
    },
    lines: own.map((l): Omit<Line, "source"> => {
      const view: Omit<Line, "source"> & { source?: string } = { ...l };
      delete view.source;
      if (l.status === "REVERSED") view.reason = "REVERSED";
      return view;
    }),
  } as const;
}
