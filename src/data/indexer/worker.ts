import { z } from "zod";
import { decodeTransfer, TRANSFER_TOPIC, type TransferRow } from "../evm/erc20";
import { RangeController } from "./ranges";
import { planRewind } from "./reorg";
import { RpcError } from "../rpc/transport";
import { readMetadata } from "../balances/evm";
import {
  diffLogSets,
  evidenceFrom,
  LogSetError,
  witnessCandidates,
  witnessWindow,
  type LogSetEvidence,
  type LogWindowWitness,
  type WitnessPolicy,
} from "./witness";
import type { RpcPool, ApprovedEndpoint } from "../rpc/pool";
import type { DataStore, StoredChain } from "../store/types";
const quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/);
const header = z
  .object({
    number: quantity,
    hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    parentHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  })
  .passthrough();
const hexTag = (b: bigint) => `0x${b.toString(16)}`;
export interface WitnessTally {
  trusted: number;
  development: number;
  tiebreaks: number;
  mismatches: number;
  unresolved: number;
  unavailable: number;
  lastConsensus: string | null;
}
export interface IndexReport {
  chainId: string;
  owner: string;
  status:
    | "CURRENT"
    | "ADVANCED"
    | "LEASE_HELD"
    | "ERROR"
    | "FINALIZED_CONFLICT"
    | "NO_LOG_ENDPOINT"
    | "HALTED"
    | "WITNESS_UNAVAILABLE";
  windows: number;
  inserted: number;
  duplicates: number;
  skippedNonErc20: number;
  reorgs: number;
  rewoundRows: number;
  fromBlock: string | null;
  throughBlock: string | null;
  headBlock: string | null;
  finalizedBlock: string | null;
  range: number;
  durationMs: number;
  error: string | null;
  witness: WitnessTally;
  // Non-secret evidence for disputed windows (endpoint IDs, digests, bounded key diff).
  disputes: (LogWindowWitness & {
    diff: ReturnType<typeof diffLogSets> | null;
  })[];
}
export interface IndexOptions {
  maxWindows?: number;
  maxMs?: number;
  initialRange?: number;
  confirmations?: number;
  signal?: AbortSignal;
  now?: () => number;
  // V1.5: "required" never commits a window without independent consensus (release semantics);
  // "best-effort" commits it as development-only (NO_INDEPENDENT_WITNESS) and says so.
  witness?: WitnessPolicy;
}
const logEndpoints = (e: ApprovedEndpoint) =>
  e.supportsLogs && e.maxLogRange > 0;
// Strict ERC20 Transfer decoding of one window's complete raw log set.
export function decodeWindow(
  raw: unknown[],
  chainId: string,
  from: bigint,
  to: bigint,
  endHash: string,
) {
  const rows: TransferRow[] = [];
  let skipped = 0;
  const blockHashes = new Map<bigint, string>();
  for (const item of raw) {
    const decoded = decodeTransfer(item, chainId);
    if (!decoded.ok) {
      if (
        ["NOT_ERC20_SHAPE", "BAD_DATA_SIZE", "WRONG_TOPIC"].includes(
          decoded.reason,
        )
      ) {
        skipped++;
        continue;
      }
      return { ok: false as const, reason: decoded.reason };
    }
    const r = decoded.row;
    if (r.blockNumber < from || r.blockNumber > to)
      throw new RpcError("INVALID_RESPONSE", "LOG_OUTSIDE_RANGE");
    const known = blockHashes.get(r.blockNumber);
    if (known && known !== r.blockHash)
      throw new RpcError("INVALID_RESPONSE", "BLOCK_HASH_SPLIT");
    blockHashes.set(r.blockNumber, r.blockHash);
    rows.push(r);
  }
  if (blockHashes.has(to) && blockHashes.get(to) !== endHash.toLowerCase())
    throw new RpcError("INVALID_RESPONSE", "LOG_FORK_MISMATCH");
  return { ok: true as const, rows, skipped };
}
export async function indexOnce(
  store: DataStore,
  pool: RpcPool,
  chain: StoredChain,
  owner: string,
  options: IndexOptions = {},
): Promise<IndexReport> {
  const now = options.now ?? Date.now,
    started = now();
  const policy = options.witness ?? "best-effort";
  const report: IndexReport = {
    chainId: chain.chainId,
    owner,
    status: "CURRENT",
    windows: 0,
    inserted: 0,
    duplicates: 0,
    skippedNonErc20: 0,
    reorgs: 0,
    rewoundRows: 0,
    fromBlock: null,
    throughBlock: null,
    headBlock: null,
    finalizedBlock: null,
    range: 0,
    durationMs: 0,
    error: null,
    witness: {
      trusted: 0,
      development: 0,
      tiebreaks: 0,
      mismatches: 0,
      unresolved: 0,
      unavailable: 0,
      lastConsensus: null,
    },
    disputes: [],
  };
  if (!pool.available(logEndpoints))
    return { ...report, status: "NO_LOG_ENDPOINT" };
  const existing = await store.getCheckpoint(chain.chainId);
  // A paused chain does not advance until an operator resumes it after investigation.
  if (existing?.haltedReason)
    return {
      ...report,
      status: "HALTED",
      error: existing.haltedReason,
      durationMs: now() - started,
    };
  const signal = options.signal;
  const opts = { signal, timeoutMs: 8000, maxBytes: 100000 };
  const getHeader = async (
    tag: string,
    filter?: (e: ApprovedEndpoint) => boolean,
    attempts = filter ? 1 : 3,
  ) => {
    const { value, endpoint } = await pool.call(
      { method: "eth_getBlockByNumber", params: [tag, false] },
      { ...opts, filter, attempts },
    );
    if (value === null) return { block: null, endpoint };
    return { block: header.parse(value), endpoint };
  };
  // Canonical hash must agree across two healthy endpoints when two exist (RPC poisoning defense).
  const canonical = async (block: bigint): Promise<string | null> => {
    const first = await getHeader(hexTag(block));
    if (!first.block) return null;
    if (pool.available((e) => e.id !== first.endpoint.id) > 0) {
      try {
        const second = await getHeader(
          hexTag(block),
          (e) => e.id !== first.endpoint.id,
        );
        if (
          second.block &&
          second.block.hash.toLowerCase() !== first.block.hash.toLowerCase()
        )
          throw new RpcError("INVALID_RESPONSE", "RPC_INCONSISTENT");
      } catch (error) {
        if (error instanceof RpcError && error.detail === "RPC_INCONSISTENT")
          throw error;
        /* A single unavailable secondary does not block; disagreement does. */
      }
    }
    return first.block.hash.toLowerCase();
  };
  let leased = false;
  try {
    const latest = await getHeader("latest");
    if (!latest.block) throw new RpcError("INVALID_RESPONSE", "NO_HEAD");
    const head = BigInt(latest.block.number);
    let finalized = head - BigInt(chain.finality.depth);
    const tag =
      chain.finality.kind === "finalized-tag"
        ? "finalized"
        : chain.finality.kind === "safe-tag"
          ? "safe"
          : null;
    if (tag)
      try {
        const f = await getHeader(
          tag,
          (e) => (tag === "finalized" ? e.supportsFinalized : e.supportsSafe),
          3,
        );
        // Conservative: the lower of the tag and the configured depth (a lying tag cannot finalize early).
        if (f.block && BigInt(f.block.number) < finalized)
          finalized = BigInt(f.block.number);
      } catch {
        /* Tag unavailable on healthy endpoints: confirmation-depth policy applies. */
      }
    if (finalized < 0n) finalized = 0n;
    const target = head - BigInt(options.confirmations ?? 3);
    report.headBlock = head.toString();
    report.finalizedBlock = finalized.toString();
    let cp = existing;
    const startFrom = cp
      ? cp.indexedThroughBlock + 1n
      : target - BigInt((chain.indexStartBlocks ?? 2000) - 1) > 0n
        ? target - BigInt((chain.indexStartBlocks ?? 2000) - 1)
        : 0n;
    if (
      !(await store.acquireLease(
        chain.chainId,
        owner,
        60000,
        startFrom,
        target,
      ))
    )
      return { ...report, status: "LEASE_HELD", durationMs: now() - started };
    leased = true;
    if (!cp) {
      const anchor =
        startFrom === 0n
          ? "0x" + "0".repeat(64)
          : await canonical(startFrom - 1n);
      if (!anchor) throw new RpcError("INVALID_RESPONSE", "NO_ANCHOR");
      await store.initCheckpoint(chain.chainId, owner, startFrom, anchor);
      cp = (await store.getCheckpoint(chain.chainId))!;
    }
    report.fromBlock = cp.indexedFromBlock.toString();
    const reconcile = async () => {
      const current = (await store.getCheckpoint(chain.chainId))!;
      if (current.indexedThroughBlock < current.indexedFromBlock)
        return current;
      const hash = await canonical(current.indexedThroughBlock);
      if (hash === null || hash === current.throughBlockHash) return current;
      // One extra window lets planRewind refuse (REWIND_DEPTH_EXCEEDED) instead of over-rewinding.
      const windows = await store.listWindows(chain.chainId, 65);
      const plan = await planRewind(
        windows,
        canonical,
        current.indexedFromBlock - 1n,
      );
      if (plan.kind === "FINALIZED_CONFLICT") {
        await store.setCheckpointError(
          chain.chainId,
          `FINALIZED_CONFLICT:${plan.block}`,
        );
        throw new RpcError("INVALID_RESPONSE", "FINALIZED_CONFLICT");
      }
      if (plan.kind === "REWIND") {
        const anchor =
          plan.anchorHash ??
          (plan.keepThrough < 0n
            ? "0x" + "0".repeat(64)
            : await canonical(plan.keepThrough));
        if (!anchor) throw new RpcError("INVALID_RESPONSE", "NO_ANCHOR");
        report.rewoundRows += await store.rewind(
          chain.chainId,
          owner,
          plan.keepThrough,
          anchor,
        );
        report.reorgs++;
      }
      return (await store.getCheckpoint(chain.chainId))!;
    };
    cp = await reconcile();
    let endpointRange = Math.max(
      ...pool.ranked(logEndpoints).map((e) => e.maxLogRange),
      1,
    );
    // Keep windows witnessable: a witness with a smaller log range reads at most 16 chunks.
    const eligible = pool.ranked(
      (e) => logEndpoints(e) && e.witnessEligible === true,
    );
    const eligibleIds = new Set(eligible.map((e) => e.id));
    if (eligible.length >= 2)
      endpointRange = Math.max(
        1,
        Math.min(
          endpointRange,
          Math.min(...eligible.slice(0, 3).map((e) => e.maxLogRange)) * 16,
        ),
      );
    const range = new RangeController(
      options.initialRange ?? Math.min(100, endpointRange),
      endpointRange,
      1,
    );
    let through = cp.indexedThroughBlock,
      throughHash = cp.throughBlockHash;
    let failures = 0;
    const verifiedEndpoints = new Set<string>();
    while (through < target && report.windows < (options.maxWindows ?? 50)) {
      if (signal?.aborted || now() - started > (options.maxMs ?? 25000)) break;
      const from = through + 1n,
        to =
          from + BigInt(range.size) - 1n > target
            ? target
            : from + BigInt(range.size) - 1n;
      // Sandwich on one endpoint: it must already hold `to` before and after the log query.
      // With two or more witness-eligible operators the primary is chosen among them, so a routing
      // provider (unattributable operator) never becomes the side a witness is compared against.
      const before = await getHeader(
        hexTag(to),
        eligible.length >= 2 ? (e) => eligibleIds.has(e.id) : logEndpoints,
        3,
      );
      if (!before.block)
        throw new RpcError("INVALID_RESPONSE", "ENDPOINT_BEHIND");
      const pinned = (e: ApprovedEndpoint) => e.id === before.endpoint.id;
      if (!verifiedEndpoints.has(before.endpoint.id)) {
        const id = await pool.call(
          { method: "eth_chainId", params: [] },
          { ...opts, filter: pinned, attempts: 1 },
        );
        if (
          typeof id.value !== "string" ||
          !quantity.safeParse(id.value).success ||
          BigInt(id.value) !== BigInt(chain.chainId)
        ) {
          pool.markFailure(before.endpoint.id, "CHAIN_MISMATCH");
          throw new RpcError("INVALID_RESPONSE", "CHAIN_MISMATCH");
        }
        verifiedEndpoints.add(before.endpoint.id);
      }
      const parent = await getHeader(hexTag(from), pinned);
      if (!parent.block)
        throw new RpcError("INVALID_RESPONSE", "ENDPOINT_BEHIND");
      if (
        throughHash &&
        parent.block.parentHash.toLowerCase() !== throughHash.toLowerCase()
      ) {
        const reconciled = await reconcile();
        through = reconciled.indexedThroughBlock;
        throughHash = reconciled.throughBlockHash;
        if (++failures > 6)
          throw new RpcError("INVALID_RESPONSE", "REORG_LOOP");
        continue;
      }
      let logs: unknown[];
      try {
        const { value } = await pool.call(
          {
            method: "eth_getLogs",
            params: [
              {
                fromBlock: hexTag(from),
                toBlock: hexTag(to),
                topics: [TRANSFER_TOPIC],
              },
            ],
          },
          {
            signal,
            timeoutMs: 15000,
            maxBytes: 16000000,
            filter: pinned,
            attempts: 1,
            policy: {
              ...pool.policy,
              maxLogRange: before.endpoint.maxLogRange + 1,
            },
          },
        );
        logs = z.array(z.unknown()).max(100000).parse(value);
      } catch (error) {
        const code =
          error instanceof RpcError ? error.code : "INVALID_RESPONSE";
        if (
          [
            "RANGE_TOO_LARGE",
            "RESPONSE_TOO_LARGE",
            "TIMEOUT",
            "POLICY_REJECTED",
          ].includes(code) ||
          error instanceof z.ZodError
        ) {
          if (!range.failure())
            throw new RpcError("RANGE_TOO_LARGE", "MIN_RANGE");
          if (++failures > 8) throw error;
          continue;
        }
        throw error;
      }
      const after = await getHeader(hexTag(to), pinned);
      if (
        !after.block ||
        after.block.hash.toLowerCase() !== before.block.hash.toLowerCase()
      )
        throw new RpcError("INVALID_RESPONSE", "HEAD_CHANGED_DURING_WINDOW");
      const decoded = decodeWindow(
        logs,
        chain.chainId,
        from,
        to,
        before.block.hash,
      );
      if (!decoded.ok) {
        pool.markFailure(before.endpoint.id, "MALFORMED_LOG");
        throw new RpcError("INVALID_RESPONSE", decoded.reason);
      }
      let primary: LogSetEvidence;
      try {
        primary = evidenceFrom(
          before.endpoint,
          chain.chainId,
          from,
          to,
          logs,
          parent.block.hash,
          before.block.hash,
        );
      } catch (error) {
        if (error instanceof LogSetError) {
          pool.markFailure(before.endpoint.id, "MALFORMED_LOG");
          throw new RpcError("INVALID_RESPONSE", error.code);
        }
        throw error;
      }
      // Independent log-set witness: a mismatched or unknown witness never commits a trusted window.
      const outcome = await witnessWindow({
        pool,
        chainId: chain.chainId,
        from,
        to,
        primary,
        signal,
        now,
        chainVerified: verifiedEndpoints,
      });
      for (const id of outcome.quarantine)
        pool.markFailure(id, "LOG_SET_MISMATCH");
      const rec = outcome.record;
      report.witness.lastConsensus = rec.consensus;
      if (
        rec.consensus === "TIEBREAK_MATCH_PRIMARY" ||
        rec.consensus === "TIEBREAK_MATCH_WITNESS"
      )
        report.witness.tiebreaks++;
      let commitRows: TransferRow[] | null = null,
        skipped = decoded.skipped;
      if (outcome.commit === "PRIMARY") commitRows = decoded.rows;
      else if (outcome.commit === "WITNESS" && outcome.witness) {
        const w = decodeWindow(
          outcome.witness.raw,
          chain.chainId,
          from,
          to,
          before.block.hash,
        );
        if (!w.ok) throw new RpcError("INVALID_RESPONSE", w.reason);
        commitRows = w.rows;
        skipped = w.skipped;
      } else if (
        rec.consensus === "NO_INDEPENDENT_WITNESS" &&
        policy === "best-effort"
      )
        commitRows = decoded.rows;
      if (commitRows === null) {
        await store.recordWitness({ ...rec, committed: false });
        const diff = outcome.witness
          ? diffLogSets(primary.logs, outcome.witness.logs)
          : null;
        if (rec.consensus !== "NO_INDEPENDENT_WITNESS")
          report.disputes.push({ ...rec, committed: false, diff });
        if (rec.consensus === "UNRESOLVED") {
          report.witness.unresolved++;
          await store.haltChain(
            chain.chainId,
            `LOG_CONSENSUS_UNRESOLVED:${from}-${to}`,
          );
          report.status = "HALTED";
          report.error = `LOG_CONSENSUS_UNRESOLVED:${from}-${to}`;
          break;
        }
        if (rec.consensus === "MISMATCH") {
          report.witness.mismatches++;
          throw new RpcError(
            "INVALID_RESPONSE",
            "LOG_WITNESS_BLOCK_HASH_MISMATCH",
          );
        }
        report.witness.unavailable++;
        await store.setCheckpointError(
          chain.chainId,
          `LOG_WITNESS_UNAVAILABLE:${rec.failure}`,
        );
        report.status = "WITNESS_UNAVAILABLE";
        report.error = `LOG_WITNESS_UNAVAILABLE:${rec.failure}`;
        break;
      }
      if (rec.consensus === "NO_INDEPENDENT_WITNESS")
        report.witness.development++;
      else report.witness.trusted++;
      const result = await store.commitWindow({
        chainId: chain.chainId,
        owner,
        window: {
          fromBlock: from,
          toBlock: to,
          toBlockHash: before.block.hash.toLowerCase(),
          logCount: commitRows.length,
          finalized: to <= finalized,
        },
        rows: commitRows,
        headBlock: head,
        safeBlock: finalized,
        witness: { ...rec, committed: true },
      });
      report.windows++;
      report.inserted += result.inserted;
      report.duplicates += result.duplicates;
      report.skippedNonErc20 += skipped;
      range.success(logs.length);
      through = to;
      throughHash = before.block.hash.toLowerCase();
      failures = 0;
    }
    await store.promoteFinalized(chain.chainId, finalized, owner);
    const learned = pool.ranked(logEndpoints)[0];
    if (
      learned &&
      range.size !== learned.maxLogRange &&
      range.size < learned.maxLogRange
    )
      await store.learnLogRange(learned.id, Math.max(range.size, 1));
    report.throughBlock = through.toString();
    report.range = range.size;
    if (report.status !== "HALTED" && report.status !== "WITNESS_UNAVAILABLE")
      report.status = through >= target ? "CURRENT" : "ADVANCED";
    return { ...report, durationMs: now() - started };
  } catch (error) {
    const code =
      error instanceof RpcError
        ? `${error.code}${error.detail ? `:${error.detail}` : ""}`
        : error instanceof Error
          ? error.message.slice(0, 80)
          : "UNKNOWN";
    await store.setCheckpointError(chain.chainId, code).catch(() => {});
    return {
      ...report,
      status: code.includes("FINALIZED_CONFLICT")
        ? "FINALIZED_CONFLICT"
        : code.includes("CHAIN_HALTED")
          ? "HALTED"
          : "ERROR",
      error: code,
      durationMs: now() - started,
    };
  } finally {
    if (leased) await store.releaseLease(chain.chainId, owner).catch(() => {});
  }
}
export { witnessCandidates };
// Bounded metadata resolution for newly discovered tokens; failures are recorded, never guessed.
export async function resolveMetadata(
  store: DataStore,
  pool: RpcPool,
  chain: StoredChain,
  limit = 150,
  signal?: AbortSignal,
) {
  const pending = await store.pendingMetadata(chain.chainId, limit);
  if (!pending.length) return { resolved: 0, failed: 0 };
  const meta = await readMetadata(pool, pending, chain.multicall, signal);
  await store.upsertTokens(
    meta.map((m) => ({
      chainId: chain.chainId,
      address: m.token,
      symbol: m.symbol,
      name: m.name,
      decimals: m.decimals,
      suspicious: m.suspicious,
      metadataStatus:
        m.decimals !== null && m.symbol
          ? "OK"
          : m.decimals !== null || m.symbol
            ? "PARTIAL"
            : "FAILED",
      sources: ["indexed"],
    })),
  );
  return {
    resolved: meta.filter((m) => m.decimals !== null).length,
    failed: meta.filter((m) => m.decimals === null).length,
  };
}
