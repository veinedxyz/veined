// G14 closure (H3 + single use): the canary's DURABLE local store. Server only. NEW protected-inventory file.
// One directory holds one append-only, hash-chained journal (journal.ndjson) and the writer lock (writer.lock).
// Every fact the canary may not forget across a restart is one journal line: consumed authorization nonces, single-use
// lines, audit anchors, lifecycle events, prepared steps, the state of every attempt, and the tracker's observations.
// What "durable" means here, exactly:
//   - a line counts — in memory and for every caller — only AFTER it was written AND fsync returned for it. An append
//     that fails (disk full, permission, a short write, a failed fsync) throws and POISONS this store instance: it
//     accepts no further write, because what reached the disk is not known. Nothing is retried.
//   - ONE writer. The lock file is created with the OS's atomic exclusive create (open "wx"). A second process that
//     finds it is refused (STORE_LOCKED) while the owning process is alive. A lock whose process is gone is taken over
//     by an atomic rename (only one contender can win it) and the take-over is itself journaled — everything that was
//     in flight before it is then treated as UNKNOWN by the recovery code, never as "did not happen".
//   - on open the whole journal is re-read and verified: every line must parse, carry the next sequence number and
//     the hash of its predecessor. A journal whose last line is cut short (an interrupted write) reads TORN_TAIL, a
//     bad line in the middle reads CORRUPT; either way the store opens READ-ONLY (NEEDS_ATTENTION): its verified
//     prefix can be shown, nothing can be written, and the canary stays closed until the owner has looked.
//   - batch(): the lines of one logical step are written with ONE write and ONE fsync, so a step is never half
//     recorded by this process; if the commit fails the store is poisoned (memory may be ahead of the disk: closed).
// What it does NOT claim: an fsync that the operating system or the drive acknowledges without persisting (a lying
// write cache, power loss inside the drive) is outside what software can prove; and the journal head is kept by the
// same writer that can rewrite the file — it is tamper-EVIDENT only against the copy of the head the owner keeps
// outside (ownerHeadProblem below), not immutable by itself.
// Nothing here signs, holds a key, reaches a network or reads the environment.
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  linkSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import { isMainThread, threadId } from "node:worker_threads";
import { join } from "node:path";
import { digest } from "../../canonical";

export class StoreError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "StoreError";
  }
}
/** A take-over race lost to another contender (internal: decides the one bounded retry of open()). */
class RaceLost extends Error {}
/**
 * The token the lock file names. A contender's take-over (rename -> read back -> link back) can leave the name empty
 * for microseconds, so a missing or unreadable lock is read again a few times before it counts as lost (review 2 N5).
 */
function readLockToken(io: StoreIo, lock: string, tries = 5): unknown {
  for (let i = 0; i < tries; i++) {
    try {
      return (
        JSON.parse(io.readFileSync(lock).toString("utf8")) as {
          token?: unknown;
        }
      ).token;
    } catch {
      if (i < tries - 1) pause(10);
    }
  }
  return null;
}
export interface StoreEntry {
  seq: number;
  type: string;
  data: unknown;
  prev: string;
  /** For a line of a multi-line batch: [its index, the batch's line count] (an incomplete batch is never read). */
  n?: [number, number];
  hash: string;
}
export type StoreStatus = "READY" | "TORN_TAIL" | "CORRUPT" | "FAILED";
/** The file operations the store uses. The product passes none (node:fs); failure tests pass a faulty one. */
export interface StoreIo {
  openSync: typeof openSync;
  writeSync: (fd: number, data: Uint8Array) => number;
  fsyncSync: (fd: number) => void;
  closeSync: (fd: number) => void;
  readFileSync: (path: string) => Buffer;
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string) => void;
  renameSync: (from: string, to: string) => void;
  linkSync: (existing: string, created: string) => void;
  unlinkSync: (path: string) => void;
}
const NODE_IO: StoreIo = {
  openSync,
  writeSync: (fd, data) => writeSync(fd, data),
  fsyncSync,
  closeSync,
  readFileSync: (path) => readFileSync(path),
  existsSync,
  mkdirSync: (path) => void mkdirSync(path, { recursive: true }),
  renameSync,
  linkSync,
  unlinkSync,
};
const GENESIS = "0".repeat(64);
// v2 (review 2 N6): the hash input carries the batch marker `n`; a v1 journal reads CORRUPT at line 0 (none deployed).
const VERSION = "veined.canary.store.v2";
/** Lock tokens of the stores this PROCESS holds open (a lock naming our pid with another token is our own stale one). */
const LIVE_TOKENS: Set<string> = ((
  globalThis as unknown as Record<symbol, Set<string> | undefined>
)[Symbol.for("veined.canary.store.live-tokens")] ??= new Set<string>());
/**
 * Who writes a lock (review 4 R4-2): the pid, when THIS process started (ms) and the thread. A lock of this pid with
 * another start time is an EARLIER process's (dead: a container restarts with the same pid); with this start time and
 * this thread, the per-process registry above says whether an open store holds it; another thread's counts as live.
 */
const BOOT = Math.round(performance.timeOrigin);
const THREAD = threadId;
/**
 * G14 follow-up F4 (review 5 R5-2 / review 6 "lock assumptions"): the supported target is ONE local machine and ONE
 * main thread per store directory. Measured on the installed Node (v24.18.0, evidence/lock-probe): a worker thread
 * reports the SAME performance.timeOrigin as the main thread, so BOOT agrees across threads there — but that is a
 * property of one Node version, not something this lock relies on: the store is never opened from a worker thread at
 * all (STORE_THREAD_UNSUPPORTED). A store directory on a network share (UNC path) is refused
 * (STORE_SHARED_PATH_UNSUPPORTED): containers or replicas sharing one store are not supported. Every lock names its
 * host; a lock of another host is never taken over (STORE_LOCKED_FOREIGN_HOST).
 */
const HOST = (() => {
  try {
    return hostname().toLowerCase();
  } catch {
    return "";
  }
})();
/** A short synchronous pause (a contender's rename -> link-back window is microseconds long). */
const pause = (ms: number) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const TYPE = /^[A-Z][A-Z_]{1,31}$/;
const TOKEN = /^[0-9a-f]{32}$/;
const entryHash = (e: Omit<StoreEntry, "hash">) =>
  digest([VERSION, e.seq, e.type, e.data, e.prev, e.n ?? null]);
const lineOf = (e: StoreEntry) =>
  JSON.stringify(
    e.n
      ? { s: e.seq, t: e.type, d: e.data, p: e.prev, n: e.n, h: e.hash }
      : { s: e.seq, t: e.type, d: e.data, p: e.prev, h: e.hash },
  ) + "\n";

/** Parses and verifies a journal image. Never throws: returns the verified prefix and why it stopped, if it did. */
export function readJournal(bytes: Uint8Array): {
  entries: StoreEntry[];
  status: Exclude<StoreStatus, "FAILED">;
  problem: string | null;
} {
  const text = Buffer.from(bytes).toString("utf8");
  const entries: StoreEntry[] = [];
  if (text.length === 0) return { entries, status: "READY", problem: null };
  const complete = text.endsWith("\n");
  const lines = text.split("\n");
  // After the final "\n" split() leaves one empty string; anything else there is a line cut short.
  const tail = lines.pop() ?? "";
  let prev = GENESIS;
  /** The open multi-line batch: where it started and how many lines it has. */
  let batch: { start: number; count: number } | null = null;
  for (const [i, raw] of lines.entries()) {
    let ok = false;
    try {
      const x = JSON.parse(raw) as Record<string, unknown>;
      const n = x.n as [number, number] | undefined;
      const e: StoreEntry = {
        seq: x.s as number,
        type: x.t as string,
        data: x.d,
        prev: x.p as string,
        ...(n !== undefined ? { n } : {}),
        hash: x.h as string,
      };
      const open = batch as { start: number; count: number } | null;
      const nOk =
        n === undefined
          ? open === null
          : Array.isArray(n) &&
            n.length === 2 &&
            Number.isSafeInteger(n[0]) &&
            Number.isSafeInteger(n[1]) &&
            n[1] >= 2 &&
            (open === null
              ? n[0] === 0
              : n[1] === open.count && n[0] === i - open.start);
      ok =
        Object.keys(x).length === (n === undefined ? 5 : 6) &&
        nOk &&
        e.seq === i &&
        typeof e.type === "string" &&
        TYPE.test(e.type) &&
        e.prev === prev &&
        typeof e.hash === "string" &&
        e.hash ===
          entryHash({ seq: e.seq, type: e.type, data: e.data, prev, n });
      if (ok) {
        entries.push(Object.freeze(e));
        prev = e.hash;
        if (n !== undefined) {
          if (n[0] === 0) batch = { start: i, count: n[1] };
          if (n[0] === n[1] - 1) batch = null;
        }
      }
    } catch {
      ok = false;
    }
    if (!ok) {
      // Review 2 N6: a batch that was open when the damage starts is not part of the verified prefix either.
      const open = batch as { start: number; count: number } | null;
      return {
        entries: open === null ? entries : entries.slice(0, open.start),
        status: "CORRUPT",
        problem: `LINE_${i}_INVALID`,
      };
    }
  }
  // A batch whose lines did not all reach the file is not part of the journal (a step is never half recorded).
  const unfinished = batch as { start: number; count: number } | null;
  if (unfinished !== null)
    return {
      entries: entries.slice(0, unfinished.start),
      status: "TORN_TAIL",
      problem: "INCOMPLETE_BATCH",
    };
  if (!complete || tail.length > 0)
    return { entries, status: "TORN_TAIL", problem: "LAST_LINE_INCOMPLETE" };
  return { entries, status: "READY", problem: null };
}
/**
 * Compares a journal with the head the OWNER holds outside the system (a length and the hash of the entry at that
 * position). Null when the journal still contains exactly that head at that position — entries appended since then
 * are an honest extension. A journal that was rewritten, or cut below the owner's head, is reported.
 */
export function ownerHeadProblem(
  entries: readonly StoreEntry[],
  ownerHead: { length: number; hash: string } | null | undefined,
): string | null {
  if (
    !ownerHead ||
    !Number.isSafeInteger(ownerHead.length) ||
    ownerHead.length < 0 ||
    typeof ownerHead.hash !== "string" ||
    !/^[0-9a-f]{64}$/.test(ownerHead.hash)
  )
    return "OWNER_HEAD_INVALID";
  if (ownerHead.length > entries.length) return "JOURNAL_TRUNCATED";
  const at =
    ownerHead.length === 0 ? GENESIS : entries[ownerHead.length - 1].hash;
  return at === ownerHead.hash ? null : "JOURNAL_REWRITTEN";
}
const alivePid = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else — it is alive.
    return (e as { code?: string }).code === "EPERM";
  }
};
export interface StoreOptions {
  io?: StoreIo;
  /** This process's id and a liveness test for another one (tests only). */
  pid?: number;
  alive?: (pid: number) => boolean;
}
export class CanaryDurableStore {
  readonly #io: StoreIo;
  readonly #dir: string;
  readonly #token: string;
  readonly #entries: StoreEntry[];
  #status: StoreStatus;
  #problem: string | null;
  #fd: number | null;
  #pending: StoreEntry[] | null = null;
  #closed = false;
  private constructor(
    io: StoreIo,
    dir: string,
    token: string,
    fd: number | null,
    loaded: ReturnType<typeof readJournal>,
  ) {
    this.#io = io;
    this.#dir = dir;
    this.#token = token;
    this.#fd = fd;
    this.#entries = [...loaded.entries];
    this.#status = loaded.status;
    this.#problem = loaded.problem;
  }
  static journalPath(dir: string) {
    return join(dir, "journal.ndjson");
  }
  static lockPath(dir: string) {
    return join(dir, "writer.lock");
  }
  /** What this process writes into its locks besides the token (see BOOT / THREAD). */
  static get lockIdentity() {
    return { pid: process.pid, boot: BOOT, thread: THREAD, host: HOST };
  }
  /** Read-only view of a store directory: no lock is taken, nothing is written (recovery display). */
  static inspect(dir: string, io: StoreIo = NODE_IO) {
    const path = CanaryDurableStore.journalPath(dir);
    return readJournal(
      io.existsSync(path) ? io.readFileSync(path) : Buffer.alloc(0),
    );
  }
  /**
   * Opens the store as THE writer. Throws StoreError: STORE_LOCKED (another live writer, an unreadable lock, or a
   * lost take-over race), STORE_UNAVAILABLE (the directory or the files cannot be used). A damaged journal does not
   * throw: the store opens read-only and says so (status / problem).
   */
  static open(dir: string, options: StoreOptions = {}): CanaryDurableStore {
    const io = options.io ?? NODE_IO;
    const pid = options.pid ?? process.pid;
    const alive = options.alive ?? alivePid;
    const lock = CanaryDurableStore.lockPath(dir);
    const token = randomBytes(16).toString("hex");
    let takeoverOf: number | null = null;
    // G14 follow-up F4: the deployment this lock supports, enforced before anything is created or locked.
    if (!isMainThread) throw new StoreError("STORE_THREAD_UNSUPPORTED");
    if (HOST === "") throw new StoreError("STORE_HOST_UNKNOWN");
    if (/^(\\\\|\/\/)/.test(dir))
      throw new StoreError("STORE_SHARED_PATH_UNSUPPORTED");
    try {
      io.mkdirSync(dir);
    } catch {
      throw new StoreError("STORE_UNAVAILABLE");
    }
    try {
      if (/^(\\\\|\/\/)/.test(realpathSync.native(dir)))
        throw new StoreError("STORE_SHARED_PATH_UNSUPPORTED");
    } catch (e) {
      if (e instanceof StoreError) throw e;
      // A path that cannot be resolved is judged by the open below.
    }
    const claim = () => {
      const fd = io.openSync(lock, "wx");
      try {
        io.writeSync(
          fd,
          Buffer.from(
            JSON.stringify({
              pid,
              boot: BOOT,
              thread: THREAD,
              host: HOST,
              token,
              at: Date.now(),
            }),
          ),
        );
        io.fsyncSync(fd);
      } finally {
        io.closeSync(fd);
      }
    };
    // Review 2 N5: one bounded retry when a take-over race was lost to a contender that did not end up holding the lock.
    for (let round = 0; ; round++) {
      try {
        takeoverOf = CanaryDurableStore.#acquire(
          io,
          lock,
          token,
          pid,
          alive,
          claim,
        );
        break;
      } catch (e) {
        if (!(e instanceof RaceLost) || round >= 1)
          throw e instanceof RaceLost ? new StoreError("STORE_LOCKED") : e;
        pause(25);
      }
    }
    // Whatever happened around us, the lock must now be ours.
    if (readLockToken(io, lock) !== token) {
      // Never leave a lock that names this writer behind a refusal: it would lock this process out (review 2 N5).
      try {
        if (readLockToken(io, lock, 1) === token) io.unlinkSync(lock);
      } catch {
        // Nothing more to do: closed.
      }
      throw new StoreError("STORE_LOCKED");
    }
    let store: CanaryDurableStore;
    try {
      const path = CanaryDurableStore.journalPath(dir);
      const loaded = readJournal(
        io.existsSync(path) ? io.readFileSync(path) : Buffer.alloc(0),
      );
      const fd = loaded.status === "READY" ? io.openSync(path, "a") : null;
      store = new CanaryDurableStore(io, dir, token, fd, loaded);
    } catch {
      try {
        io.unlinkSync(lock);
      } catch {
        // The lock stays: closed.
      }
      throw new StoreError("STORE_UNAVAILABLE");
    }
    // Every open is itself a durable fact (a restart, and whether a dead writer's lock was taken over). If it cannot
    // be written the store is closed again and its own lock removed (review 3 N14): nothing is left behind.
    if (store.#status === "READY")
      try {
        store.append("OPEN", { pid, takeoverOf, lock: token });
      } catch (e) {
        store.close();
        throw e;
      }
    LIVE_TOKENS.add(token);
    return store;
  }
  /**
   * Claims the lock, or takes over a dead writer's lock. Returns the dead writer's pid (or null); throws StoreError
   * (STORE_LOCKED / STORE_UNAVAILABLE), or RaceLost when another contender moved the lock first.
   */
  static #acquire(
    io: StoreIo,
    lock: string,
    token: string,
    pid: number,
    alive: (pid: number) => boolean,
    claim: () => void,
  ): number | null {
    try {
      claim();
      return null;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST")
        throw new StoreError("STORE_UNAVAILABLE");
      let holder: { pid?: unknown; token?: unknown };
      try {
        holder = JSON.parse(io.readFileSync(lock).toString("utf8")) as {
          pid?: unknown;
        };
      } catch {
        // A lock that cannot be read is not proof that nobody holds it.
        throw new StoreError("STORE_LOCKED");
      }
      // A lock of THIS pid (review 4 R4-2): written by an earlier process start (another `boot`) -> that process is
      // gone, the lock is stale; written by this start and this thread -> stale only when no open store of this
      // process holds its token (the per-process registry); another thread, or a lock that does not say -> live.
      // Any other pid counts as long as that process is alive.
      const h = holder as { boot?: unknown; thread?: unknown; host?: unknown };
      // G14 follow-up F4: a lock that names ANOTHER host is never judged stale here (its process cannot be seen).
      if (typeof h.host === "string" && h.host !== HOST)
        throw new StoreError("STORE_LOCKED_FOREIGN_HOST");
      const dead =
        holder.pid === pid
          ? typeof h.boot === "number" &&
            (h.boot !== BOOT ||
              (h.thread === THREAD &&
                typeof holder.token === "string" &&
                !LIVE_TOKENS.has(holder.token)))
          : !alive(holder.pid as number);
      if (
        !Number.isSafeInteger(holder.pid) ||
        (holder.pid as number) <= 0 ||
        typeof holder.token !== "string" ||
        !TOKEN.test(holder.token) ||
        !dead
      )
        throw new StoreError("STORE_LOCKED");
      // The writer is gone. The lock is moved to a name only THIS contender uses and read back: only when it is
      // still the dead holder's lock is it taken over. If another contender's fresh lock was moved instead (it took
      // over first), that lock is put back with a create-only link (which fails if a third one already holds the
      // name) and this contender is refused. Every writer also re-checks, before every commit, that the lock still
      // names it (#checkLock), so a lock lost in any way stops the writer that lost it.
      const moved = `${lock}.takeover-${token}`;
      try {
        io.renameSync(lock, moved);
      } catch {
        // Another contender moved it first: it may or may not end up holding it (one bounded retry decides).
        throw new RaceLost();
      }
      let movedToken: unknown = null;
      try {
        movedToken = (
          JSON.parse(io.readFileSync(moved).toString("utf8")) as {
            token?: unknown;
          }
        ).token;
      } catch {
        movedToken = null;
      }
      if (movedToken !== holder.token) {
        try {
          io.linkSync(moved, lock);
          io.unlinkSync(moved);
        } catch {
          // The name is taken again: the moved lock stays under its take-over name (kept, never deleted here).
        }
        throw new RaceLost();
      }
      try {
        claim();
      } catch {
        throw new StoreError("STORE_LOCKED");
      }
      try {
        io.renameSync(moved, `${lock}.stale-${holder.token}`);
      } catch {
        // Only a record of the dead holder's lock; the take-over itself is journaled below.
      }
      return holder.pid as number;
    }
  }
  get status(): StoreStatus {
    return this.#status;
  }
  get problem(): string | null {
    return this.#problem;
  }
  get writable(): boolean {
    return this.#status === "READY" && !this.#closed && this.#fd !== null;
  }
  entries(): readonly StoreEntry[] {
    return this.#entries;
  }
  /** Entries of one type, in order. */
  of(type: string): readonly StoreEntry[] {
    return this.#entries.filter((e) => e.type === type);
  }
  /** The value the owner keeps outside the system (see ownerHeadProblem). */
  head(): { length: number; hash: string } {
    return {
      length: this.#entries.length,
      hash: this.#entries.at(-1)?.hash ?? GENESIS,
    };
  }
  #fail(code: string): never {
    this.#status = "FAILED";
    this.#problem = code;
    throw new StoreError(code);
  }
  /** The lock file still names this writer (read before every commit); otherwise the store is poisoned. */
  #checkLock() {
    const owner = readLockToken(
      this.#io,
      CanaryDurableStore.lockPath(this.#dir),
    );
    if (owner !== this.#token) this.#fail("STORE_LOCK_LOST");
  }
  #commit(input: readonly StoreEntry[]) {
    if (input.length === 0) return;
    const fd = this.#fd;
    if (!this.writable || fd === null)
      throw new StoreError(
        this.#closed ? "STORE_CLOSED" : `STORE_NEEDS_ATTENTION:${this.#status}`,
      );
    this.#checkLock();
    // A multi-line batch carries [index, count] on every line (hashed), so a partly written batch is never read.
    let batch = input;
    if (input.length > 1) {
      const rebuilt: StoreEntry[] = [];
      for (const [i, e] of input.entries()) {
        const body = {
          seq: e.seq,
          type: e.type,
          data: e.data,
          prev: rebuilt.at(-1)?.hash ?? e.prev,
          n: [i, input.length] as [number, number],
        };
        rebuilt.push(Object.freeze({ ...body, hash: entryHash(body) }));
      }
      batch = rebuilt;
    }
    const bytes = Buffer.from(batch.map(lineOf).join(""), "utf8");
    try {
      let written = 0;
      while (written < bytes.length) {
        const n = this.#io.writeSync(fd, bytes.subarray(written));
        if (!Number.isSafeInteger(n) || n <= 0) throw new Error("SHORT_WRITE");
        written += n;
      }
      this.#io.fsyncSync(fd);
    } catch (e) {
      const code = (e as { code?: string }).code;
      this.#fail(
        code === "ENOSPC"
          ? "STORE_WRITE_FAILED:DISK_FULL"
          : code === "EACCES" || code === "EPERM"
            ? "STORE_WRITE_FAILED:PERMISSION"
            : "STORE_WRITE_FAILED",
      );
    }
    // G14 follow-up F4 (review 2 R7 / N6, the check-to-write gap): the lock is read AGAIN after the commit. A writer
    // that lost its lock between the check above and its write never reports that write as durable: the store is
    // poisoned and the caller gets STORE_LOCK_LOST (its lines are on disk but count for nobody; the new writer's chain
    // then reads damaged and opens read-only — fail closed). Memory is never moved for such a write.
    this.#checkLock();
    this.#entries.push(...batch);
  }
  #make(type: string, data: unknown, after: readonly StoreEntry[]) {
    if (!TYPE.test(type)) throw new StoreError("STORE_TYPE_INVALID");
    const last = after.at(-1) ?? this.#entries.at(-1);
    const body = {
      seq: (last?.seq ?? -1) + 1,
      type,
      // Stored exactly as it will be read back (JSON round trip), so the hash is the same on both sides.
      data: JSON.parse(JSON.stringify(data ?? null)) as unknown,
      prev: last?.hash ?? GENESIS,
    };
    return Object.freeze({ ...body, hash: entryHash(body) });
  }
  /**
   * Appends one line. Outside a batch it returns the committed entry, only after the line was written and fsynced.
   * Inside a batch it returns null (G14 follow-up F4, review 2 N6): the line is part of that batch's single commit and
   * its committed hash exists only after the commit (read it from entries()). Throws StoreError and changes nothing
   * when the store is not writable.
   */
  append(type: string, data: unknown): StoreEntry | null {
    if (!this.writable)
      throw new StoreError(
        this.#closed ? "STORE_CLOSED" : `STORE_NEEDS_ATTENTION:${this.#status}`,
      );
    if (this.#pending) {
      const e = this.#make(type, data, this.#pending);
      this.#pending.push(e);
      return null;
    }
    const e = this.#make(type, data, []);
    this.#commit([e]);
    return e;
  }
  /**
   * Runs `fn` and commits every line it appended with ONE write and ONE fsync. If `fn` throws nothing is written. If
   * the commit fails the store is poisoned: the caller's in-memory state may already be ahead of the disk, so nothing
   * more may be written or handed out by this process.
   */
  batch<T>(fn: () => T): T {
    if (this.#pending) return fn();
    if (!this.writable)
      throw new StoreError(
        this.#closed ? "STORE_CLOSED" : `STORE_NEEDS_ATTENTION:${this.#status}`,
      );
    this.#pending = [];
    let out: T;
    try {
      out = fn();
    } catch (e) {
      // Lines buffered by a step that then refused are dropped; if any existed, memory elsewhere may have moved.
      if (this.#pending.length > 0) {
        this.#pending = null;
        this.#fail("STORE_BATCH_ABANDONED");
      }
      this.#pending = null;
      throw e;
    }
    const lines = this.#pending;
    this.#pending = null;
    this.#commit(lines);
    return out;
  }
  /** Releases the lock (only this instance's own). The journal stays. */
  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#fd !== null) {
      try {
        this.#io.closeSync(this.#fd);
      } catch {
        // Nothing to do: the descriptor is gone with the process anyway.
      }
      this.#fd = null;
    }
    const lock = CanaryDurableStore.lockPath(this.#dir);
    try {
      const holder = JSON.parse(
        this.#io.readFileSync(lock).toString("utf8"),
      ) as {
        token?: unknown;
      };
      if (holder.token === this.#token) this.#io.unlinkSync(lock);
    } catch {
      // Not ours or not there: left alone.
    }
    LIVE_TOKENS.delete(this.#token);
  }
}
