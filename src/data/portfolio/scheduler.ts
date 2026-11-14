import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { keyedTag } from "../core/privacy";
import type { ReadSlots } from "./chain-cache";
// Deadline-aware bounded scheduler. No fixed chain cap: every planned chain ends as done, failed or
// explicitly pending (with a continuation cursor). Pending is never reported as empty.
export interface ScheduleOptions<T = unknown> {
  concurrency: number;
  deadlineMs: number;
  perTaskMs: number;
  maxTasks: number;
  signal?: AbortSignal;
  now?: () => number;
  /**
   * V1.14.2 adaptive bound (hard maximum). The scheduler starts at `concurrency` and adds parallelism only while
   * tasks settle healthy; a stressed failure (rate limit, timeout, HTTP / DNS failure) drops it back to
   * `concurrency` at once. Absent → exactly `concurrency` (the V1.11 behaviour).
   */
  maxConcurrency?: number;
  /** Concurrency group of a task (provider operator group); at most `perGroup` tasks of one group run at once. */
  groupOf?: (id: string) => string;
  perGroup?: number;
  /** Process-wide read slots (hard maximum across scans), granted by `priorityOf` class (0 first). */
  slots?: ReadSlots;
  priorityOf?: (id: string) => number;
  /** No parallelism increase while the host is under pressure (e.g. resident memory above a bound). */
  loadOk?: () => boolean;
  onStart?: (id: string, at: number) => void;
  onSettle?: (
    id: string,
    outcome: { ok: true; value: T } | { ok: false; code: string },
    at: number,
    durationMs: number,
  ) => void;
}
export interface ScheduleResult<T> {
  done: Map<string, T>;
  failed: Map<string, string>;
  pending: string[];
  started: number;
  elapsedMs: number;
  maxInFlight: number;
  /** V1.14.2 adaptive receipt: final bound, increases, stress back-offs, group deferrals. */
  adaptive?: {
    base: number;
    max: number;
    final: number;
    increases: number;
    backoffs: number;
    groupWaits: number;
  };
}
class DeadlineReached extends Error {}
const STRESS = /^(TIMEOUT|RATE_LIMITED|HTTP_ERROR|DNS_FAILED|NO_HEALTHY)/;
const HEALTHY_STREAK = 4;
const SLOW_TASK_MS = 2500;
export async function runScheduled<T>(
  ids: string[],
  task: (id: string, signal: AbortSignal) => Promise<T>,
  options: ScheduleOptions<T>,
): Promise<ScheduleResult<T>> {
  const now = options.now ?? Date.now;
  const started = now();
  const unique = [...new Set(ids)];
  const admitted = unique.slice(0, Math.max(0, options.maxTasks));
  const done = new Map<string, T>(),
    failed = new Map<string, string>(),
    unfinished = new Set(admitted);
  const deadline = new AbortController();
  const timer = setTimeout(
    () => deadline.abort(new DeadlineReached()),
    Math.max(0, options.deadlineMs),
  );
  const stop = AbortSignal.any([
    deadline.signal,
    ...(options.signal ? [options.signal] : []),
  ]);
  const base = Math.max(1, options.concurrency);
  const hardMax = Math.max(base, options.maxConcurrency ?? base);
  const perGroup = Math.max(1, options.perGroup ?? hardMax);
  const groupOf = options.groupOf ?? (() => "");
  let limit = base,
    inFlight = 0,
    maxInFlight = 0,
    streak = 0,
    increases = 0,
    backoffs = 0,
    groupWaits = 0;
  const queue = [...admitted];
  const groups = new Map<string, number>();
  const run = async (id: string) => {
    const group = groupOf(id);
    let release: (() => void) | undefined;
    try {
      // A process-wide slot is acquired before the chain's own timer starts: waiting for local capacity is never
      // a provider failure. The scan deadline still applies (an unserved chain stays pending).
      if (options.slots)
        release = await options.slots.acquire(
          options.priorityOf?.(id) ?? 2,
          stop,
        );
      if (stop.aborted) return;
      const perTask = AbortSignal.any([
        stop,
        AbortSignal.timeout(Math.max(1, options.perTaskMs)),
      ]);
      const begin = now();
      options.onStart?.(id, begin);
      try {
        const value = await Promise.race([
          task(id, perTask),
          new Promise<never>((_, reject) => {
            if (perTask.aborted) reject(perTask.reason);
            perTask.addEventListener("abort", () => reject(perTask.reason), {
              once: true,
            });
          }),
        ]);
        done.set(id, value);
        unfinished.delete(id);
        const ms = now() - begin;
        if (ms <= SLOW_TASK_MS) streak++;
        options.onSettle?.(id, { ok: true, value }, now(), ms);
      } catch (error) {
        // Global deadline or caller cancellation leaves the chain pending; its own timeout/failure fails it.
        if (!stop.aborted) {
          const code =
            error instanceof Error && error.name === "TimeoutError"
              ? "TIMEOUT"
              : codeOf(error);
          failed.set(id, code);
          unfinished.delete(id);
          if (STRESS.test(code)) {
            if (limit > base) backoffs++;
            limit = base;
            streak = 0;
          }
          options.onSettle?.(id, { ok: false, code }, now(), now() - begin);
        }
      }
    } catch {
      /* Slot wait aborted by the deadline or the caller: the chain stays pending. */
    } finally {
      release?.();
      inFlight--;
      groups.set(group, (groups.get(group) ?? 1) - 1);
      if (
        streak >= HEALTHY_STREAK &&
        limit < hardMax &&
        (options.loadOk?.() ?? true)
      ) {
        limit = Math.min(hardMax, limit + 2);
        increases++;
        streak = 0;
      }
      pump();
    }
  };
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => (finish = resolve));
  const pump = () => {
    if (!stop.aborted)
      while (inFlight < limit && queue.length) {
        // Strict priority order, except that a task whose operator group is at its cap waits for the next free
        // slot while the next eligible task starts.
        const i = queue.findIndex(
          (id) => (groups.get(groupOf(id)) ?? 0) < perGroup,
        );
        if (i < 0) break;
        if (i > 0) groupWaits++;
        const id = queue.splice(i, 1)[0];
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        groups.set(groupOf(id), (groups.get(groupOf(id)) ?? 0) + 1);
        void run(id);
      }
    if (inFlight === 0 && (stop.aborted || !queue.length)) finish();
  };
  try {
    pump();
    await finished;
  } finally {
    clearTimeout(timer);
  }
  const pending = [...unfinished, ...unique.slice(admitted.length)];
  return {
    done,
    failed,
    pending,
    started,
    elapsedMs: now() - started,
    maxInFlight,
    ...(options.maxConcurrency !== undefined || options.groupOf
      ? {
          adaptive: {
            base,
            max: hardMax,
            final: limit,
            increases,
            backoffs,
            groupWaits,
          },
        }
      : {}),
  };
}
function codeOf(error: unknown): string {
  const e = error as { code?: unknown; detail?: unknown; message?: unknown };
  const code =
    typeof e?.code === "string"
      ? e.code
      : typeof e?.message === "string"
        ? e.message
        : "FAILED";
  return code.replace(/[^A-Z0-9_:]/gi, "").slice(0, 60) || "FAILED";
}
const continuationSchema = z
  .object({
    v: z.literal(1),
    scope: z.string().regex(/^[0-9a-f]{16}$/),
    pending: z
      .array(z.string().regex(/^\d{1,18}$/))
      .min(1)
      .max(2000),
  })
  .strict();
export function encodeContinuation(
  scope: string,
  pending: string[],
): string | null {
  if (!pending.length) return null;
  return Buffer.from(
    JSON.stringify({ v: 1, scope: scope.slice(0, 16), pending }),
  ).toString("base64url");
}
// The cursor is untrusted: it can only narrow the server-computed plan for the same identity scope.
export function decodeContinuation(
  value: string,
  scope: string,
  planned: string[],
): string[] {
  if (value.length > 40000 || !/^[A-Za-z0-9_-]+$/.test(value))
    throw Error("INVALID_CONTINUATION");
  let parsed: z.infer<typeof continuationSchema>;
  try {
    parsed = continuationSchema.parse(
      JSON.parse(Buffer.from(value, "base64url").toString("utf8")),
    );
  } catch {
    throw Error("INVALID_CONTINUATION");
  }
  if (parsed.scope !== scope.slice(0, 16))
    throw Error("CONTINUATION_SCOPE_MISMATCH");
  const allowed = new Set(planned);
  return [...new Set(parsed.pending)].filter((id) => allowed.has(id));
}
// ---------------------------------------------------------------------------------------------------------------
// V1.14.2 bound continuation (v2). The cursor binds the wallet identity scope, the scan generation (one random scan
// id for every round of one scan), the catalog version and planned-chain set (one digest of the scannable network
// set), the progress position (round) and an expiry, under a keyed integrity tag. It still only narrows the
// server-computed plan; it can never add a network, select an RPC or move to another wallet.
export const CONTINUATION_TTL_MS = 10 * 60_000;
const boundSchema = z
  .object({
    v: z.literal(2),
    s: z.string().regex(/^[0-9a-f]{16}$/),
    g: z.string().regex(/^[0-9a-f]{16}$/),
    p: z.string().regex(/^[0-9a-f]{16}$/),
    r: z.number().int().min(1).max(64),
    e: z.number().int().positive(),
    pending: z
      .array(z.string().regex(/^\d{1,18}$/))
      .min(1)
      .max(2000),
  })
  .strict();
export interface ContinuationBinding {
  scope: string;
  /** Scan generation: a random id shared by every round of one scan. */
  generation: string;
  /** Digest of the catalog version and the full planned (scannable) network set. */
  plan: string;
  /** Number of rounds already served for this generation. */
  round: number;
}
export const planDigest = (catalogVersion: string, scannable: string[]) =>
  createHash("sha256")
    .update(JSON.stringify([catalogVersion, [...new Set(scannable)].sort()]))
    .digest("hex")
    .slice(0, 16);
export function encodeBoundContinuation(
  b: ContinuationBinding,
  pending: string[],
  now = Date.now(),
): string | null {
  if (!pending.length) return null;
  const body = Buffer.from(
    JSON.stringify({
      v: 2,
      s: b.scope.slice(0, 16),
      g: b.generation,
      p: b.plan,
      r: Math.min(64, b.round),
      e: now + CONTINUATION_TTL_MS,
      pending,
    }),
  ).toString("base64url");
  return `${body}.${keyedTag("wallet-continuation", body)}`;
}
/** Verifies and narrows a v2 cursor. Errors: INVALID_CONTINUATION (shape, tag, expiry, plan or catalog change),
 * CONTINUATION_SCOPE_MISMATCH (an authentic cursor presented for another identity). */
export function decodeBoundContinuation(
  value: string,
  scope: string,
  plan: string,
  planned: string[],
  now = Date.now(),
): { pending: string[]; generation: string; round: number } {
  if (
    value.length > 40000 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(value)
  )
    throw Error("INVALID_CONTINUATION");
  const [body, tag] = value.split(".");
  const expected = Buffer.from(keyedTag("wallet-continuation", body));
  const given = Buffer.from(tag);
  if (expected.length !== given.length || !timingSafeEqual(expected, given))
    throw Error("INVALID_CONTINUATION");
  let parsed: z.infer<typeof boundSchema>;
  try {
    parsed = boundSchema.parse(
      JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
    );
  } catch {
    throw Error("INVALID_CONTINUATION");
  }
  if (parsed.e <= now) throw Error("INVALID_CONTINUATION");
  if (parsed.s !== scope.slice(0, 16))
    throw Error("CONTINUATION_SCOPE_MISMATCH");
  if (parsed.p !== plan) throw Error("INVALID_CONTINUATION");
  const allowed = new Set(planned);
  return {
    pending: [...new Set(parsed.pending)].filter((id) => allowed.has(id)),
    generation: parsed.g,
    round: parsed.r,
  };
}
