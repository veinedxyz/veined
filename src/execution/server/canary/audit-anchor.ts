// G14 Track A (closes G13 limit §5-5 / review F07 for the canary path): EXTERNALLY ANCHORED audit integrity.
// The record's hash chain (lifecycle.ts) is tamper-evident but its writer could rebuild it from scratch. Here every
// state change appends the record's audit head to a SEPARATE append-only anchor log whose own entries are hash-chained;
// the anchor log's head is the value the owner keeps OUTSIDE the system (copied from the review screen / the report,
// or written to an append-only file the server can only append to). Then:
//   - a record cut short or rewritten no longer matches its anchors                 -> RECORD_NOT_ANCHORED
//   - an anchor log rewritten to match a rewritten record no longer contains the head
//     the owner holds (at its position)                                            -> ANCHOR_LOG_NOT_OWNER_HEAD
//   - an anchor log with a broken or reordered chain                                -> ANCHOR_CHAIN_BROKEN
// An OLDER owner-held head is valid when the log still contains it at its position (prefix semantics, round-1 review
// F10): honest appends since then are returned as `extension` for the owner to look at. Without any owner-held head,
// only the first and third are detectable (stated, not hidden). The sink is written BEFORE memory (F10).
import { digest } from "../../canonical";
import { auditHead, verifyAudit, type ExecutionRecord } from "../../lifecycle";

export interface AnchorEntry {
  seq: number;
  at: number;
  record: string;
  length: number;
  head: string;
  prev: string;
  hash: string;
}
const GENESIS = "0".repeat(64);
const entryHash = (e: Omit<AnchorEntry, "hash">) =>
  digest([
    "veined.canary.anchor.v1",
    e.seq,
    e.at,
    e.record,
    e.length,
    e.head,
    e.prev,
  ]);
/** Append-only sink for anchor lines (a file opened for append in production; memory in tests). */
export interface AnchorSink {
  append(entry: AnchorEntry): void;
}
export class AuditAnchorLog {
  readonly #entries: AnchorEntry[] = [];
  readonly #sink: AnchorSink | null;
  constructor(
    sink: AnchorSink | null = null,
    /** G14 closure (restart): entries read back from the durable store; the chain must verify or nothing loads. */
    restored: readonly AnchorEntry[] = [],
  ) {
    this.#sink = sink;
    let prev = GENESIS;
    for (const [i, a] of restored.entries()) {
      const { hash, ...body } = a;
      if (
        a.seq !== i ||
        a.prev !== prev ||
        hash !== entryHash(body) ||
        (i > 0 && a.at < restored[i - 1].at)
      )
        throw new Error("ANCHOR_CHAIN_BROKEN");
      prev = hash;
      this.#entries.push(Object.freeze({ ...a }));
    }
  }
  /** The entry that anchoring `r` at `at` would append (nothing is written). Throws if time went back. */
  next(r: Pick<ExecutionRecord, "id" | "audit">, at: number): AnchorEntry {
    const h = auditHead(r);
    const last = this.#entries.at(-1);
    if (!Number.isSafeInteger(at) || (last && at < last.at))
      throw new Error("ANCHOR_CLOCK_WENT_BACK");
    const body = {
      seq: this.#entries.length,
      at,
      record: r.id,
      length: h.length,
      head: h.hash,
      prev: last?.hash ?? GENESIS,
    };
    return Object.freeze({ ...body, hash: entryHash(body) });
  }
  /** Appends an entry produced by next() for the current tail: the sink first, then memory. */
  commit(entry: AnchorEntry): void {
    const last = this.#entries.at(-1);
    if (
      entry.seq !== this.#entries.length ||
      entry.prev !== (last?.hash ?? GENESIS)
    )
      throw new Error("ANCHOR_NOT_AT_TAIL");
    this.#sink?.append(entry);
    this.#entries.push(entry);
  }
  anchor(r: Pick<ExecutionRecord, "id" | "audit">, at: number): AnchorEntry {
    const e = this.next(r, at);
    this.commit(e);
    return e;
  }
  /** The value the owner keeps outside the system. */
  head(): { length: number; hash: string } {
    return {
      length: this.#entries.length,
      hash: this.#entries.at(-1)?.hash ?? GENESIS,
    };
  }
  entries(): readonly AnchorEntry[] {
    return [...this.#entries];
  }
}
export type AnchorVerdict =
  | { ok: true; extension: number }
  | {
      ok: false;
      code:
        | "RECORD_CHAIN_INVALID"
        | "RECORD_NOT_ANCHORED"
        | "ANCHOR_CHAIN_BROKEN"
        | "ANCHOR_LOG_NOT_OWNER_HEAD"
        | "NO_ANCHOR";
    };

export function verifyAnchored(
  record: Pick<ExecutionRecord, "id" | "audit">,
  anchors: readonly AnchorEntry[],
  ownerHead?: { length: number; hash: string },
): AnchorVerdict {
  if (!verifyAudit(record.id, record.audit).ok)
    return { ok: false, code: "RECORD_CHAIN_INVALID" };
  let prev = GENESIS;
  for (const [i, a] of anchors.entries()) {
    const { hash, ...body } = a;
    if (
      a.seq !== i ||
      a.prev !== prev ||
      hash !== entryHash(body) ||
      (i > 0 && a.at < anchors[i - 1].at)
    )
      return { ok: false, code: "ANCHOR_CHAIN_BROKEN" };
    prev = hash;
  }
  let extension = 0;
  if (ownerHead) {
    const at =
      ownerHead.length === 0 ? GENESIS : anchors[ownerHead.length - 1]?.hash;
    if (
      !Number.isSafeInteger(ownerHead.length) ||
      ownerHead.length < 0 ||
      ownerHead.length > anchors.length ||
      at !== ownerHead.hash
    )
      return { ok: false, code: "ANCHOR_LOG_NOT_OWNER_HEAD" };
    extension = anchors.length - ownerHead.length;
  }
  const mine = anchors.filter((a) => a.record === record.id);
  const latest = mine.at(-1);
  if (!latest) return { ok: false, code: "NO_ANCHOR" };
  const h = auditHead(record);
  if (latest.length !== h.length || latest.head !== h.hash)
    return { ok: false, code: "RECORD_NOT_ANCHORED" };
  // Every earlier anchor must be a prefix of today's chain (a rewritten middle is caught even if the tail matches).
  for (const a of mine) {
    const entry = record.audit[a.length - 1];
    if (
      a.length > record.audit.length ||
      (a.length > 0 ? entry?.hash !== a.head : a.head !== GENESIS)
    )
      return { ok: false, code: "RECORD_NOT_ANCHORED" };
  }
  return { ok: true, extension };
}
