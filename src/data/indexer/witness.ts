import { createHash } from "node:crypto";
import { z } from "zod";
import { TRANSFER_TOPIC } from "../evm/erc20";
import { RpcError } from "../rpc/transport";
import { independent } from "../registry/rpc-provenance";
import type { ApprovedEndpoint, RpcPool } from "../rpc/pool";
// V1.5 independent log-set witnessing. A window's complete eth_getLogs result is normalized into a
// deterministic digest per endpoint; only an exact digest match between operationally independent
// endpoints (or a 2-of-3 independent tiebreak) makes a window trusted. Counts alone never decide.
export type LogConsensus =
  | "MATCH"
  | "MISMATCH"
  | "NO_INDEPENDENT_WITNESS"
  | "TIEBREAK_MATCH_PRIMARY"
  | "TIEBREAK_MATCH_WITNESS"
  | "UNRESOLVED";
export type WitnessFailure =
  | "PRIMARY_FAILED"
  | "WITNESS_FAILED"
  | "LOG_SET_MISMATCH"
  | "BLOCK_HASH_MISMATCH"
  | "NO_WITNESS"
  | "CONSENSUS_UNRESOLVED";
export const TRUSTED_CONSENSUS: readonly LogConsensus[] = [
  "MATCH",
  "TIEBREAK_MATCH_PRIMARY",
  "TIEBREAK_MATCH_WITNESS",
];
export interface LogWindowWitness {
  chainId: string;
  fromBlock: bigint;
  toBlock: bigint;
  mode: "LIVE" | "BACKFILL" | "REVERIFY";
  primaryEndpointId: string;
  witnessEndpointId: string | null;
  tiebreakEndpointId: string | null;
  primaryOperator: string | null;
  witnessOperator: string | null;
  tiebreakOperator: string | null;
  primaryBlockStartHash: string;
  primaryBlockEndHash: string;
  witnessBlockStartHash: string | null;
  witnessBlockEndHash: string | null;
  primaryLogCount: number;
  witnessLogCount: number | null;
  tiebreakLogCount: number | null;
  primaryDigest: string;
  witnessDigest: string | null;
  tiebreakDigest: string | null;
  consensus: LogConsensus;
  failure: WitnessFailure | null;
  committed: boolean;
  observedAt: number;
}
// The digest of the log set that was actually committed (the witness set when it won the tiebreak).
export const committedDigest = (w: LogWindowWitness) =>
  w.consensus === "TIEBREAK_MATCH_WITNESS" && w.witnessDigest
    ? w.witnessDigest
    : w.primaryDigest;
const hex32 = /^0x[0-9a-fA-F]{64}$/;
const quantity = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/;
// Required fields have exact grammars; extra provider fields (e.g. blockTimestamp) are ignored and
// never enter the digest, so they cannot create false agreement or disagreement.
export const witnessLogSchema = z
  .object({
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
    topics: z.array(z.string().regex(hex32)).min(1).max(4),
    data: z.string().regex(/^0x([0-9a-fA-F]{2}){0,4096}$/),
    blockNumber: z.string().regex(quantity),
    blockHash: z.string().regex(hex32),
    transactionHash: z.string().regex(hex32),
    transactionIndex: z.string().regex(quantity).nullable().optional(),
    logIndex: z.string().regex(quantity),
    removed: z.boolean().optional(),
  })
  .passthrough();
export interface NormalizedLog {
  blockNumber: bigint;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string | null;
  logIndex: bigint;
  address: string;
  topics: string[];
  data: string;
  removed: boolean;
}
export class LogSetError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "LogSetError";
  }
}
export const MAX_WINDOW_LOGS = 100000;
// Canonical lowercase hex, decimal block/log numbers, deterministic (block, logIndex) order.
// Duplicate keys, out-of-range logs and split block hashes are rejected, never deduplicated.
export function normalizeLogs(
  raw: unknown,
  from: bigint,
  to: bigint,
): NormalizedLog[] {
  if (!Array.isArray(raw)) throw new LogSetError("NOT_AN_ARRAY");
  if (raw.length > MAX_WINDOW_LOGS) throw new LogSetError("TOO_MANY_LOGS");
  const out: NormalizedLog[] = [];
  const keys = new Set<string>(),
    txKeys = new Set<string>(),
    hashes = new Map<bigint, string>();
  for (const item of raw) {
    const p = witnessLogSchema.safeParse(item);
    if (!p.success) throw new LogSetError("MALFORMED_LOG");
    const l = p.data;
    const n: NormalizedLog = {
      blockNumber: BigInt(l.blockNumber),
      blockHash: l.blockHash.toLowerCase(),
      transactionHash: l.transactionHash.toLowerCase(),
      transactionIndex:
        l.transactionIndex == null
          ? null
          : BigInt(l.transactionIndex).toString(),
      logIndex: BigInt(l.logIndex),
      address: l.address.toLowerCase(),
      topics: l.topics.map((t) => t.toLowerCase()),
      data: l.data.toLowerCase(),
      removed: l.removed === true,
    };
    if (n.blockNumber < from || n.blockNumber > to)
      throw new LogSetError("LOG_OUTSIDE_RANGE");
    const key = `${n.blockNumber}:${n.logIndex}`,
      txKey = `${n.transactionHash}:${n.logIndex}`;
    if (keys.has(key) || txKeys.has(txKey))
      throw new LogSetError("DUPLICATE_LOG");
    keys.add(key);
    txKeys.add(txKey);
    const known = hashes.get(n.blockNumber);
    if (known && known !== n.blockHash)
      throw new LogSetError("BLOCK_HASH_SPLIT");
    hashes.set(n.blockNumber, n.blockHash);
    out.push(n);
  }
  return out.sort((a, b) =>
    a.blockNumber !== b.blockNumber
      ? a.blockNumber < b.blockNumber
        ? -1
        : 1
      : a.logIndex < b.logIndex
        ? -1
        : a.logIndex > b.logIndex
          ? 1
          : 0,
  );
}
// Domain-separated SHA-256 over chain, range, filter, count and every bound log field.
export function logSetDigest(
  chainId: string,
  from: bigint,
  to: bigint,
  logs: NormalizedLog[],
): string {
  if (!/^\d{1,18}$/.test(chainId)) throw new LogSetError("CHAIN_ID");
  const h = createHash("sha256");
  h.update(
    `otherbridge.log-window.v1\nchain=${chainId}\nfrom=${from}\nto=${to}\nfilter=topic0:${TRANSFER_TOPIC}\ncount=${logs.length}\n`,
  );
  for (const l of logs)
    h.update(
      `${l.blockNumber}|${l.blockHash}|${l.transactionHash}|${l.transactionIndex ?? "-"}|${l.logIndex}|${l.address}|${l.topics.join(",")}|${l.data}|${l.removed ? 1 : 0}\n`,
    );
  return h.digest("hex");
}
export interface LogSetEvidence {
  endpoint: ApprovedEndpoint;
  raw: unknown[];
  logs: NormalizedLog[];
  count: number;
  digest: string;
  blockStartHash: string;
  blockEndHash: string;
}
export function evidenceFrom(
  endpoint: ApprovedEndpoint,
  chainId: string,
  from: bigint,
  to: bigint,
  raw: unknown[],
  blockStartHash: string,
  blockEndHash: string,
): LogSetEvidence {
  const logs = normalizeLogs(raw, from, to);
  const end = logs.filter((l) => l.blockNumber === to);
  const start = logs.filter((l) => l.blockNumber === from);
  // Every log in the window's edge blocks must sit on the endpoint's own sandwiched headers.
  if (
    end.some((l) => l.blockHash !== blockEndHash.toLowerCase()) ||
    start.some((l) => l.blockHash !== blockStartHash.toLowerCase())
  )
    throw new LogSetError("LOG_FORK_MISMATCH");
  return {
    endpoint,
    raw,
    logs,
    count: logs.length,
    digest: logSetDigest(chainId, from, to, logs),
    blockStartHash: blockStartHash.toLowerCase(),
    blockEndHash: blockEndHash.toLowerCase(),
  };
}
const header = z
  .object({
    number: z.string().regex(quantity),
    hash: z.string().regex(hex32),
    parentHash: z.string().regex(hex32),
  })
  .passthrough();
const hexTag = (b: bigint) => `0x${b.toString(16)}`;
// Complete window read pinned to one endpoint: chain ID, header sandwich around the log reads, and
// adaptive chunking/bisection so an endpoint with a smaller range limit still yields the full set.
// Any failure throws; an unavailable endpoint can never be mistaken for "zero logs".
export async function fetchLogSet(
  pool: RpcPool,
  endpoint: ApprovedEndpoint,
  chainId: string,
  from: bigint,
  to: bigint,
  options: {
    signal?: AbortSignal;
    maxCalls?: number;
    chainVerified?: Set<string>;
  } = {},
): Promise<LogSetEvidence> {
  const pinned = (e: ApprovedEndpoint) => e.id === endpoint.id;
  const base = { signal: options.signal, filter: pinned, attempts: 1 };
  const get = async (tag: string) => {
    const { value } = await pool.call(
      { method: "eth_getBlockByNumber", params: [tag, false] },
      { ...base, timeoutMs: 8000, maxBytes: 100000 },
    );
    if (value === null)
      throw new RpcError("INVALID_RESPONSE", "ENDPOINT_BEHIND");
    const p = header.safeParse(value);
    if (!p.success) throw new RpcError("INVALID_RESPONSE", "BAD_HEADER");
    if (BigInt(p.data.number) !== BigInt(tag))
      throw new RpcError("INVALID_RESPONSE", "HEADER_NUMBER_MISMATCH");
    return p.data;
  };
  if (!options.chainVerified?.has(endpoint.id)) {
    const { value } = await pool.call(
      { method: "eth_chainId", params: [] },
      { ...base, timeoutMs: 8000, maxBytes: 10000 },
    );
    if (
      typeof value !== "string" ||
      !quantity.test(value) ||
      BigInt(value) !== BigInt(chainId)
    ) {
      pool.markFailure(endpoint.id, "CHAIN_MISMATCH");
      throw new RpcError("INVALID_RESPONSE", "CHAIN_MISMATCH");
    }
    options.chainVerified?.add(endpoint.id);
  }
  const before = await get(hexTag(to));
  const start = from === to ? before : await get(hexTag(from));
  const maxRange = BigInt(Math.max(1, endpoint.maxLogRange || 1));
  const queue: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += maxRange)
    queue.push([a, a + maxRange - 1n > to ? to : a + maxRange - 1n]);
  const raw: unknown[] = [];
  let calls = 0;
  const maxCalls = options.maxCalls ?? 64;
  while (queue.length) {
    const [a, b] = queue.shift()!;
    if (++calls > maxCalls)
      throw new RpcError("RANGE_TOO_LARGE", "WITNESS_CALL_BUDGET");
    try {
      const { value } = await pool.call(
        {
          method: "eth_getLogs",
          params: [
            {
              fromBlock: hexTag(a),
              toBlock: hexTag(b),
              topics: [TRANSFER_TOPIC],
            },
          ],
        },
        {
          ...base,
          timeoutMs: 15000,
          maxBytes: 16000000,
          policy: { ...pool.policy, maxLogRange: Number(b - a) + 2 },
        },
      );
      if (!Array.isArray(value))
        throw new RpcError("INVALID_RESPONSE", "LOGS_NOT_ARRAY");
      if (raw.length + value.length > MAX_WINDOW_LOGS)
        throw new RpcError("RESPONSE_TOO_LARGE", "WINDOW_LOGS");
      raw.push(...value);
    } catch (error) {
      const code = error instanceof RpcError ? error.code : "INVALID_RESPONSE";
      if (
        ["RANGE_TOO_LARGE", "RESPONSE_TOO_LARGE", "TIMEOUT"].includes(code) &&
        b > a &&
        !(error instanceof RpcError && error.detail === "WINDOW_LOGS")
      ) {
        const mid = a + (b - a) / 2n;
        queue.unshift([a, mid], [mid + 1n, b]);
        continue;
      }
      throw error;
    }
  }
  const after = await get(hexTag(to));
  if (after.hash.toLowerCase() !== before.hash.toLowerCase())
    throw new RpcError("INVALID_RESPONSE", "HEAD_CHANGED_DURING_WINDOW");
  try {
    return evidenceFrom(
      endpoint,
      chainId,
      from,
      to,
      raw,
      start.hash,
      before.hash,
    );
  } catch (error) {
    if (error instanceof LogSetError) {
      pool.markFailure(endpoint.id, "MALFORMED_LOG");
      throw new RpcError("INVALID_RESPONSE", error.code);
    }
    throw error;
  }
}
export interface WitnessOutcome {
  record: LogWindowWitness;
  commit: "PRIMARY" | "WITNESS" | null;
  trusted: boolean;
  quarantine: string[];
  halt: boolean;
  witness: LogSetEvidence | null;
}
export type WitnessPolicy = "required" | "best-effort";
// Outside local development the default is "required"; the release profile refuses "best-effort"
// outright, so an unwitnessed window can never be produced by a release-profile indexer.
export function parseWitnessPolicy(
  raw: string | undefined,
  profile: "development" | "staging" | "release" = "development",
): WitnessPolicy {
  if (raw === undefined || raw === "")
    return profile === "development" ? "best-effort" : "required";
  if (raw !== "required" && raw !== "best-effort")
    throw Error("OTHERBRIDGE_INDEX_WITNESS_INVALID");
  if (profile === "release" && raw !== "required")
    throw Error("OTHERBRIDGE_INDEX_WITNESS_RELEASE_REQUIRED");
  return raw;
}
const logCapable = (e: ApprovedEndpoint) => e.supportsLogs && e.maxLogRange > 0;
// Witness candidates: healthy, log-capable, witness-eligible and independent of every endpoint
// already involved (no majority is claimed through an operator that is already counted).
export function witnessCandidates(pool: RpcPool, involved: ApprovedEndpoint[]) {
  return pool.ranked(
    (e) =>
      logCapable(e) &&
      e.witnessEligible === true &&
      involved.every((x) => x.id !== e.id && independent(x, e)),
  );
}
export async function witnessWindow(input: {
  pool: RpcPool;
  chainId: string;
  from: bigint;
  to: bigint;
  primary: LogSetEvidence;
  mode?: LogWindowWitness["mode"];
  fetch?: (endpoint: ApprovedEndpoint) => Promise<LogSetEvidence>;
  maxAttempts?: number;
  now?: () => number;
  signal?: AbortSignal;
  chainVerified?: Set<string>;
}): Promise<WitnessOutcome> {
  const { pool, chainId, from, to, primary } = input;
  const fetch =
    input.fetch ??
    ((e: ApprovedEndpoint) =>
      fetchLogSet(pool, e, chainId, from, to, {
        signal: input.signal,
        chainVerified: input.chainVerified,
      }));
  const record: LogWindowWitness = {
    chainId,
    fromBlock: from,
    toBlock: to,
    mode: input.mode ?? "LIVE",
    primaryEndpointId: primary.endpoint.id,
    witnessEndpointId: null,
    tiebreakEndpointId: null,
    primaryOperator: primary.endpoint.operatorGroup ?? null,
    witnessOperator: null,
    tiebreakOperator: null,
    primaryBlockStartHash: primary.blockStartHash,
    primaryBlockEndHash: primary.blockEndHash,
    witnessBlockStartHash: null,
    witnessBlockEndHash: null,
    primaryLogCount: primary.count,
    witnessLogCount: null,
    tiebreakLogCount: null,
    primaryDigest: primary.digest,
    witnessDigest: null,
    tiebreakDigest: null,
    consensus: "NO_INDEPENDENT_WITNESS",
    failure: "NO_WITNESS",
    committed: false,
    observedAt: (input.now ?? Date.now)(),
  };
  const result = (
    patch: Partial<LogWindowWitness>,
    rest: Partial<Omit<WitnessOutcome, "record">> = {},
  ): WitnessOutcome => ({
    record: { ...record, ...patch },
    commit: null,
    trusted: false,
    quarantine: [],
    halt: false,
    witness: null,
    ...rest,
  });
  const candidates = witnessCandidates(pool, [primary.endpoint]).slice(
    0,
    input.maxAttempts ?? 2,
  );
  // The primary must itself be attributable to one known operator: a routing/aggregating provider
  // may forward the query to the very operator that then "witnesses" it, so its agreement proves
  // nothing (no independence can be established from it).
  if (
    primary.endpoint.witnessEligible !== true ||
    !primary.endpoint.operatorGroup ||
    !candidates.length
  )
    return result({});
  let witness: LogSetEvidence | null = null;
  for (const c of candidates) {
    try {
      witness = await fetch(c);
      break;
    } catch {
      record.witnessEndpointId = c.id;
      record.witnessOperator = c.operatorGroup ?? null;
    }
  }
  if (!witness) return result({ failure: "WITNESS_FAILED" });
  Object.assign(record, {
    witnessEndpointId: witness.endpoint.id,
    witnessOperator: witness.endpoint.operatorGroup ?? null,
    witnessBlockStartHash: witness.blockStartHash,
    witnessBlockEndHash: witness.blockEndHash,
    witnessLogCount: witness.count,
    witnessDigest: witness.digest,
  });
  if (
    witness.blockStartHash !== primary.blockStartHash ||
    witness.blockEndHash !== primary.blockEndHash
  )
    // Endpoints disagree on canonical headers (fork in progress or a lying node): never commit;
    // the next cycle re-reads after canonical reconciliation.
    return result(
      { consensus: "MISMATCH", failure: "BLOCK_HASH_MISMATCH" },
      { witness },
    );
  if (witness.digest === primary.digest)
    return result(
      { consensus: "MATCH", failure: null },
      { commit: "PRIMARY", trusted: true, witness },
    );
  // Log-set mismatch: a third operator independent of both may break the tie.
  const third = witnessCandidates(pool, [
    primary.endpoint,
    witness.endpoint,
  ])[0];
  if (!third)
    return result(
      { consensus: "UNRESOLVED", failure: "CONSENSUS_UNRESOLVED" },
      { halt: true, witness },
    );
  let tie: LogSetEvidence;
  try {
    tie = await fetch(third);
  } catch {
    return result(
      {
        consensus: "UNRESOLVED",
        failure: "CONSENSUS_UNRESOLVED",
        tiebreakEndpointId: third.id,
        tiebreakOperator: third.operatorGroup ?? null,
      },
      { halt: true, witness },
    );
  }
  const tied: Partial<LogWindowWitness> = {
    tiebreakEndpointId: tie.endpoint.id,
    tiebreakOperator: tie.endpoint.operatorGroup ?? null,
    tiebreakLogCount: tie.count,
    tiebreakDigest: tie.digest,
  };
  const headersAgree =
    tie.blockStartHash === primary.blockStartHash &&
    tie.blockEndHash === primary.blockEndHash;
  if (headersAgree && tie.digest === primary.digest)
    return result(
      {
        ...tied,
        consensus: "TIEBREAK_MATCH_PRIMARY",
        failure: "LOG_SET_MISMATCH",
      },
      {
        commit: "PRIMARY",
        trusted: true,
        quarantine: [witness.endpoint.id],
        witness,
      },
    );
  if (headersAgree && tie.digest === witness.digest)
    return result(
      {
        ...tied,
        consensus: "TIEBREAK_MATCH_WITNESS",
        failure: "LOG_SET_MISMATCH",
      },
      {
        commit: "WITNESS",
        trusted: true,
        quarantine: [primary.endpoint.id],
        witness,
      },
    );
  return result(
    { ...tied, consensus: "UNRESOLVED", failure: "CONSENSUS_UNRESOLVED" },
    { halt: true, witness },
  );
}
// Bounded mismatch diagnostics (evidence only): which (block:logIndex) keys differ between two sets.
export function diffLogSets(a: NormalizedLog[], b: NormalizedLog[], cap = 50) {
  const line = (l: NormalizedLog) =>
    `${l.blockHash}|${l.transactionHash}|${l.transactionIndex ?? "-"}|${l.address}|${l.topics.join(",")}|${l.data}|${l.removed ? 1 : 0}`;
  const key = (l: NormalizedLog) => `${l.blockNumber}:${l.logIndex}`;
  const ma = new Map(a.map((l) => [key(l), line(l)])),
    mb = new Map(b.map((l) => [key(l), line(l)]));
  const onlyA: string[] = [],
    onlyB: string[] = [],
    changed: string[] = [];
  for (const [k, v] of ma)
    if (!mb.has(k)) onlyA.push(k);
    else if (mb.get(k) !== v) changed.push(k);
  for (const k of mb.keys()) if (!ma.has(k)) onlyB.push(k);
  return {
    onlyInFirst: onlyA.slice(0, cap),
    onlyInSecond: onlyB.slice(0, cap),
    changed: changed.slice(0, cap),
    totals: {
      onlyInFirst: onlyA.length,
      onlyInSecond: onlyB.length,
      changed: changed.length,
    },
  };
}
