// VEINED-MC1 (lanes review R2 NEW-1, the MAJOR-1 concurrency residue): the ONE dispatch lock of this process, shared by
// the swap lane engine and the bridge lane engine and by nothing else (verify-safety rule 13 pins its two importers and
// its four call sites). The signer is shared by both lanes, so every span that can spend a single-use step runs ALONE:
//
//   single-use / replay / expiry checks -> signer preflight (sync + status) -> the NONCE + USE + PREPARED batch ->
//   the adapter hand-off -> the recorded outcome          (each lane's dispatch, and each lane's CLEANUP revoke)
//
// Spans run one at a time, in arrival order: a swap dispatch and a bridge dispatch serialize, so the later one's
// preflight sees the earlier one's signature in flight and refuses WITHOUT spending. A second span for the SAME record
// while one is running or queued (a double click, a client retry, a second revoke) is refused at once with the
// engine's DISPATCH_IN_PROGRESS: it never waits, never reaches the signer and never records an outcome.
//
// PER PROCESS ONLY. The state lives on the global object, so every copy of this module the framework loads (one per
// route bundle, or a re-evaluation in development) shares it. It cannot serialize two processes: an ARMED server must
// run as ONE Node process (one `next start`; no cluster, no second instance, no serverless fan-out). The lane
// journals' single-writer lock refuses a second process on the same journal, and the signer (one request at a time,
// one signature per route and step) stays the backstop.
//
// Lanes review R3 (NIT): the state is defined ONCE, under a registry symbol (one key for every module copy), as a
// non-writable, non-configurable, non-enumerable property of the global object: no later module can replace or delete
// it, and an existing property that is not exactly that (an accessor, writable, configurable, or not this state's
// shape) is refused before any span runs. verify-safety rule 13 (l) refuses the key, its text and these internals
// anywhere in src outside this file. Code running inside this process could still patch built-ins (Set, Promise);
// that residual, and the reason the lock has no time bound, are in docs/SPEC_BRIDGE_LANE.md.
const LANE_DISPATCH_LOCK_KEY: unique symbol = Symbol.for(
  "veined.laneDispatchLock",
);
const globals = globalThis as typeof globalThis & {
  readonly [LANE_DISPATCH_LOCK_KEY]?: LaneDispatchLockState;
};
interface LaneDispatchLockState {
  /** Settles when the span queued last has finished (never rejects). */
  tail: Promise<void>;
  /** The records with a span running or queued. */
  readonly keys: Set<string>;
}
function lockState(): LaneDispatchLockState {
  if (
    Object.getOwnPropertyDescriptor(globals, LANE_DISPATCH_LOCK_KEY) ===
    undefined
  )
    Object.defineProperty(globals, LANE_DISPATCH_LOCK_KEY, {
      value: Object.seal({
        tail: Promise.resolve(),
        keys: new Set<string>(),
      }),
      writable: false,
      configurable: false,
      enumerable: false,
    });
  const held = Object.getOwnPropertyDescriptor(globals, LANE_DISPATCH_LOCK_KEY);
  const s = held?.value as LaneDispatchLockState | undefined;
  if (
    !held ||
    held.writable !== false ||
    held.configurable !== false ||
    !s ||
    typeof s !== "object" ||
    !Object.isSealed(s) ||
    Object.keys(s).sort().join(",") !== "keys,tail" ||
    !(s.keys instanceof Set) ||
    !(s.tail instanceof Promise)
  )
    throw new Error("LANE_DISPATCH_LOCK_STATE_INVALID");
  return s;
}
/** Is a span of this record running or queued? Read only (status and tests). */
export function laneDispatchPending(key: string): boolean {
  return lockState().keys.has(key);
}
/**
 * Runs `span` alone in this process, after every span queued before it. `key` names the record: while a span of the
 * same record is running or queued, `busy()` is thrown at once (nothing waits, nothing runs). The lock is released
 * however `span` ends.
 */
export async function withLaneDispatchLock<T>(
  key: string,
  busy: () => Error,
  span: () => Promise<T>,
): Promise<T> {
  const s = lockState();
  if (s.keys.has(key)) throw busy();
  s.keys.add(key);
  const before = s.tail;
  let release: () => void = () => undefined;
  s.tail = new Promise<void>((done) => {
    release = done;
  });
  try {
    await before;
    return await span();
  } finally {
    s.keys.delete(key);
    release();
  }
}
