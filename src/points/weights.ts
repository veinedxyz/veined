import type {
  ActivityRecord,
  ReferralBinding,
  TaskCompletion,
  TaskRecord,
} from "./model";
import { activityWeight, categoryEnabled, type WeightPolicy } from "./policy";
import type { WeightLine } from "./allocation";
import { minBig, parseUnits } from "./units";
// Turns a season's verified inputs into weight lines, with a per-line explanation so an admin can see exactly why
// an account receives what it receives. Order-independent: inputs are sorted before any cap is applied.

export interface ExplainLine {
  lineId: string;
  account: string;
  kind: "ACTIVITY" | "TASK";
  sourceRef: string;
  category?: string;
  occurredAt: string;
  volumeUsdMicros?: string;
  boundedVolumeUsdMicros?: string;
  rawWeight: string;
  effectiveWeight: string;
  referralParent: string | null;
  notes: string[];
}
export interface SeasonInputs {
  policy: WeightPolicy;
  activities: readonly ActivityRecord[];
  completions: readonly TaskCompletion[];
  tasks: ReadonlyMap<string, TaskRecord>;
  bindings: ReadonlyMap<string, ReferralBinding>;
  excluded: ReadonlySet<string>;
}

const byTime =
  <T>(time: (x: T) => string, id: (x: T) => string) =>
  (a: T, b: T) => {
    const ta = Date.parse(time(a)),
      tb = Date.parse(time(b));
    if (ta !== tb) return ta - tb;
    return id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0;
  };

function parentFor(
  inputs: SeasonInputs,
  account: string,
  at: string,
  notes: string[],
) {
  const binding = inputs.bindings.get(account);
  if (!binding) return null;
  if (Date.parse(binding.effectiveAt) > Date.parse(at)) {
    notes.push("BEFORE_REFERRAL_BINDING");
    return null;
  }
  if (binding.parent === account) return null;
  if (inputs.excluded.has(binding.parent)) {
    notes.push("REFERRER_EXCLUDED");
    return null;
  }
  return binding.parent;
}

export function buildLines(inputs: SeasonInputs) {
  const { policy } = inputs;
  const lines: WeightLine[] = [];
  const explain: ExplainLine[] = [];
  const activityCap = parseUnits(policy.limits.accountSeasonActivityWeightCap);
  const taskCap = parseUnits(policy.limits.accountSeasonTaskWeightCap);
  const used = new Map<string, bigint>(),
    count = new Map<string, number>(),
    taskUsed = new Map<string, bigint>();

  const eligible = inputs.activities
    .filter((r) => r.status === "ELIGIBLE")
    .sort(
      byTime(
        (r) => r.event.occurredAt,
        (r) => r.event.eventId,
      ),
    );
  for (const record of eligible) {
    const e = record.event;
    const notes: string[] = [];
    const { weight: raw, boundedVolumeUsdMicros } = activityWeight(policy, e);
    let effective = raw;
    if (boundedVolumeUsdMicros < parseUnits(e.volumeUsdMicros))
      notes.push("VOLUME_CAPPED");
    if (inputs.excluded.has(e.account)) {
      notes.push("ACCOUNT_EXCLUDED");
      effective = 0n;
    } else if (!categoryEnabled(policy, e.category)) {
      notes.push("CATEGORY_DISABLED");
      effective = 0n;
    } else {
      const n = (count.get(e.account) ?? 0) + 1;
      count.set(e.account, n);
      if (n > policy.limits.maxActivitiesPerAccountPerSeason) {
        notes.push("ACTIVITY_LIMIT");
        effective = 0n;
      } else {
        const before = used.get(e.account) ?? 0n;
        effective = minBig(raw, activityCap - minBig(before, activityCap));
        if (effective < raw) notes.push("ACCOUNT_CAP");
        used.set(e.account, before + effective);
      }
    }
    const parent =
      effective > 0n ? parentFor(inputs, e.account, e.occurredAt, notes) : null;
    const lineId = `a:${e.eventId}`;
    explain.push({
      lineId,
      account: e.account,
      kind: "ACTIVITY",
      sourceRef: e.eventId,
      category: e.category,
      occurredAt: e.occurredAt,
      volumeUsdMicros: e.volumeUsdMicros,
      boundedVolumeUsdMicros: boundedVolumeUsdMicros.toString(),
      rawWeight: raw.toString(),
      effectiveWeight: effective.toString(),
      referralParent: parent,
      notes,
    });
    if (effective > 0n)
      lines.push({
        lineId,
        account: e.account,
        kind: "ACTIVITY",
        sourceRef: e.eventId,
        weight: effective,
        referralParent: parent,
      });
  }

  const approved = inputs.completions
    .filter((c) => c.status === "APPROVED")
    .sort(
      byTime(
        (c) => c.completedAt,
        (c) => c.id,
      ),
    );
  for (const completion of approved) {
    const notes: string[] = [];
    const task = inputs.tasks.get(completion.taskId);
    const raw = parseUnits(completion.weight);
    let effective = raw;
    if (!task || task.status !== "APPROVED") {
      notes.push("TASK_NOT_APPROVED");
      effective = 0n;
    } else if (inputs.excluded.has(completion.account)) {
      notes.push("ACCOUNT_EXCLUDED");
      effective = 0n;
    } else {
      const before = taskUsed.get(completion.account) ?? 0n;
      effective = minBig(raw, taskCap - minBig(before, taskCap));
      if (effective < raw) notes.push("TASK_CAP");
      taskUsed.set(completion.account, before + effective);
    }
    const parent =
      effective > 0n && policy.referral.includeTasks
        ? parentFor(inputs, completion.account, completion.completedAt, notes)
        : null;
    const lineId = `t:${completion.id}`;
    explain.push({
      lineId,
      account: completion.account,
      kind: "TASK",
      sourceRef: completion.id,
      occurredAt: completion.completedAt,
      rawWeight: raw.toString(),
      effectiveWeight: effective.toString(),
      referralParent: parent,
      notes,
    });
    if (effective > 0n)
      lines.push({
        lineId,
        account: completion.account,
        kind: "TASK",
        sourceRef: completion.id,
        weight: effective,
        referralParent: parent,
      });
  }
  return { lines, explain };
}
