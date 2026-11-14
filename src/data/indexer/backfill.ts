import { z } from "zod";
import { RpcError } from "../rpc/transport";
import { decodeWindow } from "./worker";
import {
  diffLogSets,
  fetchLogSet,
  TRUSTED_CONSENSUS,
  witnessWindow,
  type LogWindowWitness,
  type WitnessPolicy,
} from "./witness";
import type { ApprovedEndpoint, RpcPool } from "../rpc/pool";
import type { DataStore, StoredChain } from "../store/types";
import type { TransferRow } from "../evm/erc20";
// V1.5 historical lanes. Backward backfill extends a chain's indexed history below indexed_from_block
// with finalized, witnessed windows under its own lease; REVERIFY witnesses windows committed before
// V1.5 and proves the stored rows equal the independently agreed log set. Neither lane ever claims
// genesis completeness; current balances are always direct balance reads.
const logCapable = (e: ApprovedEndpoint) => e.supportsLogs && e.maxLogRange > 0;
// Prefer a witness-eligible (single attributable operator) primary; a routing provider is used only
// when none exists, and its windows then stay NO_INDEPENDENT_WITNESS.
const attributablePrimary = (pool: RpcPool) =>
  pool.ranked((e) => logCapable(e) && e.witnessEligible === true)[0] ??
  pool.ranked(logCapable)[0];
const headerSchema = z
  .object({
    number: z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/),
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    parentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .passthrough();
const hexTag = (b: bigint) => `0x${b.toString(16)}`;
async function header(
  pool: RpcPool,
  tag: string,
  filter?: (e: ApprovedEndpoint) => boolean,
) {
  const { value } = await pool.call(
    { method: "eth_getBlockByNumber", params: [tag, false] },
    { timeoutMs: 8000, maxBytes: 100000, filter, attempts: filter ? 1 : 3 },
  );
  return value === null ? null : headerSchema.parse(value);
}
// Conservative finalized head: min(tag, head - depth), like the live lane.
export async function finalizedHead(pool: RpcPool, chain: StoredChain) {
  const latest = await header(pool, "latest");
  if (!latest) throw new RpcError("INVALID_RESPONSE", "NO_HEAD");
  let finalized = BigInt(latest.number) - BigInt(chain.finality.depth);
  const tag =
    chain.finality.kind === "finalized-tag"
      ? "finalized"
      : chain.finality.kind === "safe-tag"
        ? "safe"
        : null;
  if (tag)
    try {
      const f = await header(pool, tag, (e) =>
        tag === "finalized" ? e.supportsFinalized : e.supportsSafe,
      );
      if (f && BigInt(f.number) < finalized) finalized = BigInt(f.number);
    } catch {
      /* depth policy applies */
    }
  return finalized < 0n ? 0n : finalized;
}
const sameRows = (a: TransferRow[], b: TransferRow[]) => {
  const key = (r: TransferRow) =>
    `${r.blockNumber}|${r.blockHash}|${r.txHash}|${r.logIndex}|${r.token}|${r.from}|${r.to}|${r.value}`;
  const x = a.map(key).sort(),
    y = b.map(key).sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};
export interface LaneReport {
  chainId: string;
  lane: "backfill" | "reverify";
  status:
    | "DONE"
    | "PARTIAL"
    | "LEASE_HELD"
    | "HALTED"
    | "NOT_INDEXED"
    | "GENESIS_REACHED"
    | "WITNESS_UNAVAILABLE"
    | "ERROR";
  windows: number;
  inserted: number;
  verified: number;
  development: number;
  historicalIndexedFrom: string | null;
  error: string | null;
  records: LogWindowWitness[];
  disputes: (LogWindowWitness & {
    diff: ReturnType<typeof diffLogSets> | null;
  })[];
}
export async function backfillOnce(
  store: DataStore,
  pool: RpcPool,
  chain: StoredChain,
  owner: string,
  options: {
    maxWindows?: number;
    range?: number;
    witness?: WitnessPolicy;
    signal?: AbortSignal;
    now?: () => number;
  } = {},
): Promise<LaneReport> {
  const now = options.now ?? Date.now;
  const report: LaneReport = {
    chainId: chain.chainId,
    lane: "backfill",
    status: "DONE",
    windows: 0,
    inserted: 0,
    verified: 0,
    development: 0,
    historicalIndexedFrom: null,
    error: null,
    records: [],
    disputes: [],
  };
  let cp = await store.getCheckpoint(chain.chainId);
  if (!cp || cp.indexedThroughBlock < cp.indexedFromBlock)
    return { ...report, status: "NOT_INDEXED" };
  if (cp.haltedReason)
    return { ...report, status: "HALTED", error: cp.haltedReason };
  if (!(await store.acquireBackfillLease(chain.chainId, owner, 60000)))
    return { ...report, status: "LEASE_HELD" };
  try {
    const finalized = await finalizedHead(pool, chain);
    const verified = new Set<string>();
    const size = BigInt(Math.max(1, options.range ?? 200));
    while (report.windows < (options.maxWindows ?? 10)) {
      if (options.signal?.aborted) break;
      cp = (await store.getCheckpoint(chain.chainId))!;
      if (cp.indexedFromBlock === 0n) {
        report.status = "GENESIS_REACHED";
        break;
      }
      const to = cp.indexedFromBlock - 1n;
      const from = to - size + 1n < 0n ? 0n : to - size + 1n;
      if (to > finalized)
        throw new RpcError("INVALID_RESPONSE", "BACKFILL_NOT_FINALIZED");
      const primaryEndpoint = attributablePrimary(pool);
      if (!primaryEndpoint) throw new RpcError("HTTP_ERROR", "NO_LOG_ENDPOINT");
      const pinned = (e: ApprovedEndpoint) => e.id === primaryEndpoint.id;
      const primary = await fetchLogSet(
        pool,
        primaryEndpoint,
        chain.chainId,
        from,
        to,
        {
          signal: options.signal,
          chainVerified: verified,
        },
      );
      // Continuity: the already-indexed first block must build on this window's last block.
      const anchor = await header(pool, hexTag(cp.indexedFromBlock), pinned);
      if (!anchor || anchor.parentHash.toLowerCase() !== primary.blockEndHash)
        throw new RpcError("INVALID_RESPONSE", "BACKFILL_ANCHOR_MISMATCH");
      const outcome = await witnessWindow({
        pool,
        chainId: chain.chainId,
        from,
        to,
        primary,
        mode: "BACKFILL",
        signal: options.signal,
        now,
        chainVerified: verified,
      });
      for (const id of outcome.quarantine)
        pool.markFailure(id, "LOG_SET_MISMATCH");
      const rec = outcome.record;
      const evidence =
        outcome.commit === "WITNESS" ? outcome.witness! : primary;
      const commitAllowed =
        outcome.commit !== null ||
        (rec.consensus === "NO_INDEPENDENT_WITNESS" &&
          (options.witness ?? "best-effort") === "best-effort");
      if (!commitAllowed) {
        await store.recordWitness({ ...rec, committed: false });
        report.records.push({ ...rec, committed: false });
        if (rec.consensus !== "NO_INDEPENDENT_WITNESS")
          report.disputes.push({
            ...rec,
            committed: false,
            diff: outcome.witness
              ? diffLogSets(primary.logs, outcome.witness.logs)
              : null,
          });
        if (rec.consensus === "UNRESOLVED") {
          await store.haltChain(
            chain.chainId,
            `LOG_CONSENSUS_UNRESOLVED:${from}-${to}`,
          );
          report.status = "HALTED";
          report.error = `LOG_CONSENSUS_UNRESOLVED:${from}-${to}`;
        } else if (rec.consensus === "MISMATCH") {
          report.status = "ERROR";
          report.error = "LOG_WITNESS_BLOCK_HASH_MISMATCH";
        } else report.status = "WITNESS_UNAVAILABLE";
        break;
      }
      const decoded = decodeWindow(
        evidence.raw,
        chain.chainId,
        from,
        to,
        primary.blockEndHash,
      );
      if (!decoded.ok) throw new RpcError("INVALID_RESPONSE", decoded.reason);
      const result = await store.commitBackfillWindow({
        chainId: chain.chainId,
        owner,
        window: {
          fromBlock: from,
          toBlock: to,
          toBlockHash: primary.blockEndHash,
          logCount: decoded.rows.length,
          finalized: true,
        },
        rows: decoded.rows,
        headBlock: finalized,
        safeBlock: finalized,
        witness: { ...rec, committed: true },
      });
      report.records.push({ ...rec, committed: true });
      report.windows++;
      report.inserted += result.inserted;
      if (TRUSTED_CONSENSUS.includes(rec.consensus)) report.verified++;
      else report.development++;
    }
    if (
      report.status === "DONE" &&
      report.windows === (options.maxWindows ?? 10)
    )
      report.status = "PARTIAL";
  } catch (error) {
    report.status = "ERROR";
    report.error =
      error instanceof RpcError
        ? `${error.code}${error.detail ? `:${error.detail}` : ""}`
        : error instanceof Error
          ? error.message.slice(0, 80)
          : "UNKNOWN";
  } finally {
    await store.releaseBackfillLease(chain.chainId, owner).catch(() => {});
  }
  report.historicalIndexedFrom =
    (await store.getCheckpoint(chain.chainId))?.indexedFromBlock.toString() ??
    null;
  return report;
}
// Witness windows committed before V1.5. A trusted agreement whose decoded rows differ from the
// stored rows (or whose end hash differs) is an integrity failure: the chain is halted, nothing is
// rewritten automatically.
export async function reverifyOnce(
  store: DataStore,
  pool: RpcPool,
  chain: StoredChain,
  options: {
    maxWindows?: number;
    signal?: AbortSignal;
    now?: () => number;
    oldestFirst?: boolean;
  } = {},
): Promise<LaneReport> {
  const now = options.now ?? Date.now;
  const report: LaneReport = {
    chainId: chain.chainId,
    lane: "reverify",
    status: "DONE",
    windows: 0,
    inserted: 0,
    verified: 0,
    development: 0,
    historicalIndexedFrom: null,
    error: null,
    records: [],
    disputes: [],
  };
  const cp = await store.getCheckpoint(chain.chainId);
  if (!cp) return { ...report, status: "NOT_INDEXED" };
  if (cp.haltedReason)
    return { ...report, status: "HALTED", error: cp.haltedReason };
  // Pre-V1.5 windows (no consensus) and development-only windows (no independent witness at commit
  // time) are both re-verified, so adding a witness operator later can make a chain release-eligible
  // without rewriting indexed data.
  const pending = (await store.listWindows(chain.chainId, 100000))
    .filter(
      (w) =>
        !w.witnessConsensus || w.witnessConsensus === "NO_INDEPENDENT_WITNESS",
    )
    .sort((a, b) =>
      (options.oldestFirst ?? true)
        ? a.fromBlock < b.fromBlock
          ? -1
          : 1
        : a.fromBlock < b.fromBlock
          ? 1
          : -1,
    );
  const verified = new Set<string>();
  try {
    for (const w of pending.slice(0, options.maxWindows ?? 20)) {
      if (options.signal?.aborted) break;
      const primaryEndpoint = attributablePrimary(pool);
      if (!primaryEndpoint) throw new RpcError("HTTP_ERROR", "NO_LOG_ENDPOINT");
      const primary = await fetchLogSet(
        pool,
        primaryEndpoint,
        chain.chainId,
        w.fromBlock,
        w.toBlock,
        {
          signal: options.signal,
          chainVerified: verified,
        },
      );
      const outcome = await witnessWindow({
        pool,
        chainId: chain.chainId,
        from: w.fromBlock,
        to: w.toBlock,
        primary,
        mode: "REVERIFY",
        signal: options.signal,
        now,
        chainVerified: verified,
      });
      for (const id of outcome.quarantine)
        pool.markFailure(id, "LOG_SET_MISMATCH");
      const rec = outcome.record;
      report.windows++;
      if (!outcome.trusted) {
        await store.recordWitness({ ...rec, committed: false });
        report.records.push({ ...rec, committed: false });
        if (rec.consensus === "NO_INDEPENDENT_WITNESS") {
          report.status = "WITNESS_UNAVAILABLE";
          break;
        }
        report.disputes.push({
          ...rec,
          committed: false,
          diff: outcome.witness
            ? diffLogSets(primary.logs, outcome.witness.logs)
            : null,
        });
        if (rec.consensus === "UNRESOLVED") {
          await store.haltChain(
            chain.chainId,
            `LOG_CONSENSUS_UNRESOLVED:${w.fromBlock}-${w.toBlock}`,
          );
          report.status = "HALTED";
          report.error = `LOG_CONSENSUS_UNRESOLVED:${w.fromBlock}-${w.toBlock}`;
          break;
        }
        continue;
      }
      const agreed = outcome.commit === "WITNESS" ? outcome.witness! : primary;
      const decoded = decodeWindow(
        agreed.raw,
        chain.chainId,
        w.fromBlock,
        w.toBlock,
        agreed.blockEndHash,
      );
      const stored = await store.windowRows(
        chain.chainId,
        w.fromBlock,
        w.toBlock,
      );
      if (
        !decoded.ok ||
        agreed.blockEndHash !== w.toBlockHash.toLowerCase() ||
        !sameRows(decoded.rows, stored)
      ) {
        const reason = `STORED_WINDOW_MISMATCH:${w.fromBlock}-${w.toBlock}`;
        await store.recordWitness({ ...rec, committed: false });
        await store.haltChain(chain.chainId, reason);
        report.status = "HALTED";
        report.error = reason;
        break;
      }
      const record = { ...rec, committed: true };
      if (
        await store.markWindowWitnessed(
          chain.chainId,
          w.fromBlock,
          w.toBlock,
          record,
        )
      ) {
        report.verified++;
        report.records.push(record);
      }
    }
    if (report.status === "DONE" && pending.length > (options.maxWindows ?? 20))
      report.status = "PARTIAL";
  } catch (error) {
    report.status = "ERROR";
    report.error =
      error instanceof RpcError
        ? `${error.code}${error.detail ? `:${error.detail}` : ""}`
        : error instanceof Error
          ? error.message.slice(0, 80)
          : "UNKNOWN";
  }
  return report;
}
