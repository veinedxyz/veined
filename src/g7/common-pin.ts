// V1.11 P0 repair: canonical COMMON finalized pin for the BSC side of the G7 read-only preflight.
//
// Before: the BSC pin was the newest `finalized` block of ONE endpoint (bsc-dataseed). A second, independent
// endpoint that had not yet seen that block answered "block not found" for every state read, all three re-pins
// chased an even newer block, and the preflight failed closed (owner retry of 2026-10-06; 3 of 3 attempts).
//
// Now: every vetted source reports its own finalized head. For an ordered pair of sources from DIFFERENT operator
// groups the pin is the highest block both can serve — the lower of the two finalized heads, stepping down a
// bounded number of blocks while a source cannot serve that header yet — and both must return the identical block
// hash. Logs witnesses (never state votes) must serve the same hash. The pin must be recent and never below the
// caller's floor. When the preferred pair cannot pin, the next independent pair from the vetted list is tried.
//
// Nothing is relaxed: one source never decides; `latest`/unfinalized state is never used; two sources of the same
// operator group never count as independent; a hash disagreement at a finalized height fails closed at once
// without trying another pair; no safe pair => RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE (BLOCKED, no wallet request).
import { G7RpcError } from "./rpc";

export interface PinSource {
  readonly url: string;
  readonly operatorGroup: string;
}
export interface PinPolicy {
  chainId: number;
  /** Maximum age of the pinned block (seconds, by block timestamp). */
  maxPinAgeSec: number;
  /** Maximum number of blocks below the common finalized head tried while a source cannot serve the header. */
  maxStepDown: number;
  /** Never pin below this block (e.g. the run's phase-A pin, so ledger deltas only move forward). */
  floor?: number;
  /** Sources that must serve the pin with the same hash (the logs source). Never a state vote. */
  witnesses?: readonly PinSource[];
  /** Alternative log sources. Exactly one must be from a THIRD independent operator, in addition to required witnesses. */
  witnessCandidates?: readonly PinSource[];
  /** Per-request timeout for the pin probes (ms). */
  probeTimeoutMs?: number;
}
export type PinFailure =
  | "WRONG_CHAIN_ID"
  | "UNAVAILABLE"
  | "RATE_LIMITED"
  | "TIMEOUT"
  | "NO_FINALIZED"
  | "BAD_HEADER"
  | "BLOCK_NOT_SERVED"
  | "PIN_TOO_OLD"
  | "PIN_BELOW_FLOOR"
  | "HASH_DISAGREEMENT"
  | "WITNESS_UNAVAILABLE";
export interface SourceHealth {
  /** Local availability hint only; never a consensus vote. */
  cooldownUntil?: number;
  url: string;
  host: string;
  operatorGroup: string;
  role: "state" | "witness";
  ok: boolean;
  chainId: number | null;
  finalized: number | null;
  finalizedHash: string | null;
  finalizedTimestamp: number | null;
  head: number | null;
  /** Blocks behind the highest finalized head reported by any healthy state source. */
  lagBlocks: number | null;
  failure: PinFailure | null;
  error: string | null;
}
export interface PairAttempt {
  a: string;
  b: string;
  candidate: number | null;
  tried: number[];
  outcome: "PINNED" | PinFailure;
  detail: string | null;
}
export interface CommonPin {
  block: string;
  number: number;
  hash: string;
  timestamp: number;
  ageSec: number;
  sources: [PinSource, PinSource];
  operatorGroups: [string, string];
  health: SourceHealth[];
  attempts: PairAttempt[];
  observedAt: number;
  witnesses: PinSource[];
}
export type PinErrorCode =
  "RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE" | "RPC_FINALIZED_HASH_DISAGREEMENT";
export interface PinDiagnostics {
  code: PinErrorCode;
  chain: "bsc";
  health: SourceHealth[];
  attempts: PairAttempt[];
  observedAt: number;
}
export class PinError extends G7RpcError {
  constructor(readonly diagnostics: PinDiagnostics) {
    super(diagnostics.code, pinSummary(diagnostics));
  }
}
export type PinCall = <T>(
  url: string,
  method: string,
  params: unknown[],
  timeoutMs?: number,
) => Promise<T>;
interface Header {
  number: number;
  hash: string;
  timestamp: number;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
};
const HEX_QTY = /^0x[0-9a-f]{1,16}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
function parseHeader(raw: unknown): Header | null {
  if (raw === null || raw === undefined) return null;
  const h = raw as { number?: unknown; hash?: unknown; timestamp?: unknown };
  if (
    typeof h.number !== "string" ||
    !HEX_QTY.test(h.number) ||
    typeof h.hash !== "string" ||
    !HASH.test(h.hash) ||
    typeof h.timestamp !== "string" ||
    !HEX_QTY.test(h.timestamp)
  )
    throw new G7RpcError("BAD_HEADER");
  return {
    number: Number(BigInt(h.number)),
    hash: h.hash.toLowerCase(),
    timestamp: Number(BigInt(h.timestamp)),
  };
}
// Transport/RPC failure -> failure class (for evidence and owner-facing details only; never a pass).
export function classifyPinFailure(error: unknown): PinFailure {
  const e = error as { code?: unknown; message?: unknown };
  const text = `${String(e?.code ?? "")} ${String(e?.message ?? error)}`;
  if (/BAD_HEADER/.test(text)) return "BAD_HEADER";
  if (
    /AbortError|TimeoutError|ETIMEDOUT|UND_ERR_.*TIMEOUT|timed? ?out/i.test(
      text,
    )
  )
    return "TIMEOUT";
  if (
    /\b429\b|rate.?limit|too many requests|usage limit|quota|exceeded/i.test(
      text,
    )
  )
    return "RATE_LIMITED";
  if (
    /not found|unknown block|missing trie|header not found|block not available/i.test(
      text,
    )
  )
    return "BLOCK_NOT_SERVED";
  return "UNAVAILABLE";
}
export function pinSummary(d: PinDiagnostics) {
  const sources = d.health
    .map(
      (h) =>
        `${h.host}[${h.operatorGroup}]=${h.ok ? `fin ${h.finalized}${h.lagBlocks ? ` lag ${h.lagBlocks}` : ""}` : h.failure}`,
    )
    .join(", ");
  const tried = d.attempts
    .map((a) => `${host(a.a)}+${host(a.b)}:${a.outcome}`)
    .join(", ");
  return `${d.code} (bsc) sources: ${sources}; pairs: ${tried || "none"}`.slice(
    0,
    380,
  );
}

export async function selectCommonPin(
  sources: readonly PinSource[],
  call: PinCall,
  policy: PinPolicy,
  now: () => number = Date.now,
): Promise<CommonPin> {
  const observedAt = now();
  const timeout = policy.probeTimeoutMs ?? 8000;
  const witnesses = policy.witnesses ?? [];
  const candidates = policy.witnessCandidates ?? [];
  const header = async (url: string, tag: string) =>
    parseHeader(
      await call<unknown>(url, "eth_getBlockByNumber", [tag, false], timeout),
    );
  // 1. Measure every source and witness (chain id + own finalized head; head is informational).
  const measure = async (
    s: PinSource,
    role: SourceHealth["role"],
  ): Promise<SourceHealth> => {
    const base: SourceHealth = {
      url: s.url,
      host: host(s.url),
      operatorGroup: s.operatorGroup,
      role,
      ok: false,
      chainId: null,
      finalized: null,
      finalizedHash: null,
      finalizedTimestamp: null,
      head: null,
      lagBlocks: null,
      failure: null,
      error: null,
    };
    const [cid, fin, head] = await Promise.allSettled([
      call<string>(s.url, "eth_chainId", [], timeout),
      header(s.url, "finalized"),
      call<string>(s.url, "eth_blockNumber", [], timeout),
    ]);
    if (head.status === "fulfilled" && HEX_QTY.test(String(head.value)))
      base.head = Number(BigInt(head.value));
    if (cid.status === "rejected")
      return {
        ...base,
        failure: classifyPinFailure(cid.reason),
        error: String((cid.reason as Error)?.message ?? cid.reason).slice(
          0,
          160,
        ),
      };
    if (
      !HEX_QTY.test(String(cid.value)) ||
      Number(BigInt(cid.value)) !== policy.chainId
    )
      return {
        ...base,
        chainId: HEX_QTY.test(String(cid.value))
          ? Number(BigInt(cid.value))
          : null,
        failure: "WRONG_CHAIN_ID",
        error: `chainId ${String(cid.value).slice(0, 20)}`,
      };
    base.chainId = policy.chainId;
    if (fin.status === "rejected")
      return {
        ...base,
        failure: classifyPinFailure(fin.reason),
        error: String((fin.reason as Error)?.message ?? fin.reason).slice(
          0,
          160,
        ),
      };
    if (!fin.value) return { ...base, failure: "NO_FINALIZED" };
    return {
      ...base,
      ok: true,
      finalized: fin.value.number,
      finalizedHash: fin.value.hash,
      finalizedTimestamp: fin.value.timestamp,
    };
  };
  const measured = new Map<string, Promise<SourceHealth>>();
  const observation = (s: PinSource, role: SourceHealth["role"]) => {
    if (!measured.has(s.url)) measured.set(s.url, measure(s, role));
    return measured.get(s.url)!.then((h) => ({ ...h, role }));
  };
  const health = await Promise.all([
    ...sources.map((s) => observation(s, "state")),
    ...[...witnesses, ...candidates]
      .filter((s, i, all) => all.findIndex((w) => w.url === s.url) === i)
      .map((w) => observation(w, "witness")),
  ]);
  const stateHealth = health.filter((h) => h.role === "state");
  const witnessHealth = health.filter((h) => h.role === "witness");
  const top = Math.max(
    ...stateHealth.filter((h) => h.ok).map((h) => h.finalized!),
    -1,
  );
  for (const h of health)
    if (h.ok && top >= 0) h.lagBlocks = Math.max(0, top - h.finalized!);

  const attempts: PairAttempt[] = [];
  const fail = (code: PinErrorCode): never => {
    throw new PinError({ code, chain: "bsc", health, attempts, observedAt });
  };
  // A witness that is down blocks every pair (the logs/ledger source is required); report it, never skip it.
  const witnessDown = witnessHealth.find(
    (w) => witnesses.some((s) => s.url === w.url) && !w.ok,
  );
  const healthy = stateHealth.filter((h) => h.ok);
  // 2. Ordered pairs of DIFFERENT operator groups (vetted-list order = preference; the V1.6 pair first).
  for (let i = 0; i < healthy.length; i++)
    for (let j = i + 1; j < healthy.length; j++) {
      const a = healthy[i],
        b = healthy[j];
      if (
        !a.operatorGroup ||
        !b.operatorGroup ||
        a.operatorGroup === b.operatorGroup
      )
        continue;
      const alternatives = candidates.length
        ? witnessHealth.filter(
            (w) =>
              w.ok &&
              candidates.some((s) => s.url === w.url) &&
              !!w.operatorGroup &&
              w.operatorGroup !== a.operatorGroup &&
              w.operatorGroup !== b.operatorGroup,
          )
        : [null];
      // An unavailable/aliased pool cannot reduce the third-source requirement.
      for (const alternative of alternatives.length ? alternatives : [null]) {
        const selectedWitnesses = witnessHealth.filter((w) =>
          witnesses.some((s) => s.url === w.url),
        );
        if (alternative) selectedWitnesses.push(alternative);
        const attempt: PairAttempt = {
          a: a.url,
          b: b.url,
          candidate: null,
          tried: [],
          outcome: "BLOCK_NOT_SERVED",
          detail: null,
        };
        attempts.push(attempt);
        if (witnessDown || (candidates.length && !alternative)) {
          attempt.outcome = "WITNESS_UNAVAILABLE";
          attempt.detail = witnessDown
            ? `${witnessDown.host}:${witnessDown.failure}`
            : "No available THIRD independent log operator";
          continue;
        }
        const candidate = Math.min(
          a.finalized!,
          b.finalized!,
          ...selectedWitnesses.map((w) => w.finalized!),
        );
        attempt.candidate = candidate;
        if (policy.floor !== undefined && candidate < policy.floor) {
          attempt.outcome = "PIN_BELOW_FLOOR";
          attempt.detail = `candidate ${candidate} < floor ${policy.floor}`;
          continue;
        }
        let pinned: Header | null = null;
        for (let k = 0; k <= policy.maxStepDown; k++) {
          const n = candidate - k;
          if (n < 0 || (policy.floor !== undefined && n < policy.floor)) break;
          attempt.tried.push(n);
          const tag = `0x${n.toString(16)}`;
          const reads = await Promise.allSettled([
            header(a.url, tag),
            header(b.url, tag),
            ...selectedWitnesses.map((w) => header(w.url, tag)),
          ]);
          const failed = reads.find((r) => r.status === "rejected") as
            PromiseRejectedResult | undefined;
          if (failed) {
            const failure = classifyPinFailure(failed.reason);
            if (failure === "BLOCK_NOT_SERVED") continue; // lagging backend: step down (bounded)
            attempt.outcome = failure;
            attempt.detail = String(
              (failed.reason as Error)?.message ?? failed.reason,
            ).slice(0, 160);
            break;
          }
          const headers = reads.map(
            (r) => (r as PromiseFulfilledResult<Header | null>).value,
          );
          if (headers.some((h) => h === null)) continue; // not served yet: step down (bounded)
          const [ha, hb, ...hw] = headers as Header[];
          if ([ha, hb, ...hw].some((h) => h.number !== n)) {
            attempt.outcome = "BAD_HEADER";
            attempt.detail = `header number differs from ${n}`;
            break;
          }
          if (ha.hash !== hb.hash || hw.some((w) => w.hash !== ha.hash)) {
            // Two sources disagree on a block both report as finalized: a consensus fault, never "pick a side".
            attempt.outcome = "HASH_DISAGREEMENT";
            attempt.detail = `${n}: ${ha.hash} vs ${hb.hash}${hw.length ? ` vs ${hw.map((w) => w.hash).join(",")}` : ""}`;
            fail("RPC_FINALIZED_HASH_DISAGREEMENT");
          }
          pinned = ha;
          break;
        }
        if (!pinned) continue;
        const ageSec = Math.max(0, Math.floor(now() / 1000) - pinned.timestamp);
        if (ageSec > policy.maxPinAgeSec) {
          attempt.outcome = "PIN_TOO_OLD";
          attempt.detail = `age ${ageSec}s > ${policy.maxPinAgeSec}s`;
          continue;
        }
        attempt.outcome = "PINNED";
        return {
          block: `0x${pinned.number.toString(16)}`,
          number: pinned.number,
          hash: pinned.hash,
          timestamp: pinned.timestamp,
          ageSec,
          sources: [
            { url: a.url, operatorGroup: a.operatorGroup },
            { url: b.url, operatorGroup: b.operatorGroup },
          ],
          operatorGroups: [a.operatorGroup, b.operatorGroup],
          health,
          attempts,
          observedAt,
          witnesses: selectedWitnesses.map((w) => ({
            url: w.url,
            operatorGroup: w.operatorGroup,
          })),
        };
      }
    }
  return fail("RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE");
}
