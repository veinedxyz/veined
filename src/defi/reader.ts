import {
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  type Hex,
} from "viem";
import { z } from "zod";
import type { RpcPool, ApprovedEndpoint } from "../data/rpc/pool";
import { RpcError } from "../data/rpc/transport";
import type { PriceEvidence } from "../data/core/price";
import { freshPrice, usdValue } from "../data/core/price";
import { sanitizeText } from "../data/core/sanitize";
import {
  addressSchema,
  type PositionAsset,
  type PositionEvidence,
  type ProtocolDeployment,
  type PositionRef,
} from "./model";
import { abiFor, functionName, type ViewName } from "./abi";
import rpcSnapshot from "../data/registry/rpc-registry.snapshot.json" with { type: "json" };
import { decodeAggregate3Result, encodeAggregate3 } from "../data/evm/erc20";
import { MULTICALL3, MULTICALL3_CODEHASH } from "../data/evm/multicall";
import { cached, cacheGet, cacheKey, cacheSet } from "./cache";
const MULTICALL_BY_CHAIN = rpcSnapshot.multicall as Record<string, string>;
import { uint } from "./math";
export const NATIVE_ASSET = "0x0000000000000000000000000000000000000000";
// V1.14.1 request plan. Reads issued in the same event-loop turn are coalesced into one pinned Multicall3 aggregate
// (deterministic FIFO chunks of COALESCE_MAX exact capabilities); a failed aggregate is split in halves at most
// SPLIT_DEPTH times (never on a rate limit or an endpoint in cooldown, never re-sending the whole batch); without a
// verified Multicall3 the same reads go out as JSON-RPC batches of at most BATCH_MAX (the transport limit).
export const COALESCE_MAX = 120;
export const SPLIT_DEPTH = 2;
export const BATCH_MAX = 20;
const NO_SPLIT = new Set([
  "RATE_LIMITED",
  "POLICY_REJECTED",
  "URL_REJECTED",
  "UNSAFE_DNS",
  "MULTICALL_RESULT_MALFORMED",
  "TARGET_NOT_AUTHORIZED",
]);
export interface BlockPin {
  number: bigint;
  hash: Hex;
  timestamp: bigint;
  observedAt: number;
  endpointId: string;
  endpointGroup: string;
}
const blockSchema = z.object({
  number: z.string().regex(/^0x[0-9a-f]+$/),
  hash: z.string().regex(/^0x[0-9a-f]{64}$/),
  timestamp: z.string().regex(/^0x[0-9a-f]+$/),
});
/** Ordered settle: every read runs (they coalesce into one request); the first failure in program order is thrown. */
export async function all<T extends readonly unknown[]>(reads: {
  readonly [K in keyof T]: Promise<T[K]>;
}): Promise<T> {
  const settled = await Promise.allSettled(reads);
  for (const s of settled) if (s.status === "rejected") throw s.reason;
  return settled.map(
    (s) => (s as PromiseFulfilledResult<unknown>).value,
  ) as unknown as T;
}
export async function pinChain(
  pool: RpcPool,
  signal: AbortSignal,
  filter?: (endpoint: ApprovedEndpoint) => boolean,
): Promise<BlockPin> {
  const opts = { signal, timeoutMs: 3500, attempts: 2, filter };
  let chainId: unknown, block: unknown, endpoint: ApprovedEndpoint;
  // V1.14.1: chain identity and head in one JSON-RPC batch on one endpoint (two sequential calls without batch support).
  try {
    if (!pool.available((e) => e.supportsBatch && (!filter || filter(e))))
      throw Error("NO_BATCH");
    const r = await pool.batch(
      [
        { method: "eth_chainId", params: [] },
        { method: "eth_getBlockByNumber", params: ["latest", false] },
      ],
      opts,
    );
    if (!r.items[0].ok || !r.items[1].ok)
      throw (r.items.find((i) => !i.ok) as { error: RpcError }).error;
    chainId = r.items[0].value;
    block = r.items[1].value;
    endpoint = r.endpoint;
  } catch (e) {
    if (e instanceof RpcError && e.code === "RATE_LIMITED") throw e;
    if (signal.aborted) throw new RpcError("TIMEOUT");
    const c = await pool.call({ method: "eth_chainId", params: [] }, opts);
    chainId = c.value;
    const b = await pool.call(
      { method: "eth_getBlockByNumber", params: ["latest", false] },
      { ...opts, filter: (e) => e.id === c.endpoint.id, attempts: 1 },
    );
    block = b.value;
    endpoint = b.endpoint;
  }
  if (BigInt(String(chainId)) !== BigInt(pool.chainId))
    throw Error("CHAIN_MISMATCH");
  const p = blockSchema.parse(block);
  const now = Date.now(),
    timestamp = BigInt(p.timestamp);
  if (
    timestamp * 1000n > BigInt(now + 30000) ||
    BigInt(now) - timestamp * 1000n > 300000n
  )
    throw Error("STALE_BLOCK");
  return {
    number: BigInt(p.number),
    hash: p.hash as Hex,
    timestamp,
    observedAt: now,
    endpointId: endpoint.id,
    endpointGroup: endpoint.operatorGroup ?? "unknown",
  };
}
/**
 * One reorg check per pinned block for every adapter that finished its reads within a short window. Each request is
 * answered by a block-hash read that STARTS after the request (so after that adapter's last read) — never by an
 * earlier check — which keeps the V1.14 guarantee while sending one request for adapters finishing together.
 */
export class PinVerifier {
  requests = 0;
  private pending?: Promise<void>;
  constructor(
    private pool: RpcPool,
    private pin: BlockPin,
    private windowMs = 15,
  ) {}
  verify(signal: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    const p = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        if (this.pending === p) this.pending = undefined;
        this.requests++;
        this.pool
          .call(
            {
              method: "eth_getBlockByNumber",
              params: ["0x" + this.pin.number.toString(16), false],
            },
            {
              signal,
              attempts: 1,
              filter: (e) => e.id === this.pin.endpointId,
            },
          )
          .then((r) => {
            if (blockSchema.parse(r.value).hash !== this.pin.hash)
              throw Error("REORG_PIN_CHANGED");
          })
          .then(resolve, reject);
      }, this.windowMs);
    });
    this.pending = p;
    return p;
  }
}
export interface ReadContext {
  readAggregate?: (
    calls: { target: string; name: ViewName; args?: readonly unknown[] }[],
  ) => Promise<PromiseSettledResult<unknown>[] | null>;
  readMany?: (
    calls: { target: string; name: ViewName; args?: readonly unknown[] }[],
  ) => Promise<PromiseSettledResult<unknown>[]>;
  deployment: ProtocolDeployment;
  wallet: string;
  pin: BlockPin;
  signal: AbortSignal;
  read: (
    target: string,
    name: ViewName,
    args?: readonly unknown[],
  ) => Promise<unknown>;
  code: (target: string) => Promise<Hex>;
  asset: (
    target: string,
    raw: bigint,
    role: PositionAsset["role"],
    metadata?: { symbol: string; decimals: number },
  ) => Promise<PositionAsset>;
  evidence: PositionEvidence[];
  calls: number;
  errors: number;
  batches: number;
  fallbacks: number;
  /** V1.14.1 static-metadata cache hits (identity proofs, code proofs, token metadata). */
  cacheHits?: number;
}
interface Pending {
  target: string;
  name: ViewName;
  data: Hex;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
// A value, a contract revert or an undecodable return at the pinned block is the same for every reader of the round.
const deterministic = (e: unknown) =>
  e instanceof RpcError
    ? e.code === "EXECUTION_REVERTED"
    : !(
        e instanceof Error &&
        /^(MULTICALL_RESULT_MALFORMED|TIMEOUT|RPC_BUDGET_EXHAUSTED|TARGET_NOT_AUTHORIZED|BATCH_BUDGET_EXHAUSTED)$/.test(
          e.message,
        )
      );
const reason = (e: unknown) =>
  e instanceof RpcError
    ? e.detail === "NO_HEALTHY_ENDPOINT" || e.detail === "NO_BATCH_ENDPOINT"
      ? "ENDPOINT_COOLDOWN"
      : e.code
    : e instanceof Error
      ? e.message
      : "UNKNOWN";
/** Each call capability is exact calldata + target, generated by a pinned adapter. */
export class DefiReader implements ReadContext {
  refs?: PositionRef[];
  discoveryComplete?: boolean;
  trustedOracles?: Set<string>;
  curatedVaults?: Set<string>;
  held?: string[];
  readonly evidence: PositionEvidence[] = [];
  /** Logical exact view reads (each counted once, whatever transport carried it). */
  calls = 0;
  errors = 0;
  /** Batch requests sent (Multicall3 aggregates + JSON-RPC batches). */
  batches = 0;
  fallbacks = 0;
  /** V1.14.1 request census of this reader. */
  http = 0;
  rpcItems = 0;
  multicallBatches = 0;
  retries = 0;
  cooldownSkips = 0;
  cacheHits = 0;
  /** Identical exact reads answered by another adapter of the same scan round at the same pin. */
  memoHits = 0;
  private targets: Set<string>;
  private metadata = new Map<
    string,
    Promise<{ symbol: string; decimals: number }>
  >();
  private queue: Pending[] = [];
  private scheduled = false;
  constructor(
    readonly deployment: ProtocolDeployment,
    readonly wallet: string,
    readonly pin: BlockPin,
    readonly signal: AbortSignal,
    private pool: RpcPool,
    private prices = new Map<string, PriceEvidence>(),
    private maxCalls = 256,
    private verifier?: PinVerifier,
    /** V1.14.1 scan-round memo for one chain pin (same block, same endpoint, same wallet): target+calldata -> result. */
    private memo?: Map<string, Promise<unknown>>,
  ) {
    this.targets = new Set(Object.values(deployment.contracts));
    for (const a of deployment.assets ?? []) this.targets.add(a.underlying);
    this.evidence.push({
      kind: "official-registry",
      source: deployment.source,
      observedAt: pin.observedAt,
    });
  }
  authorize(target: string) {
    addressSchema.parse(target);
    if (target === "0x" + "0".repeat(40)) throw Error("INVALID_CONTRACT");
    this.targets.add(target);
  }
  private tick(target: string) {
    if (this.signal.aborted) throw Error("TIMEOUT");
    if (!this.targets.has(target)) throw Error("TARGET_NOT_AUTHORIZED");
    if (++this.calls > this.maxCalls) throw Error("RPC_BUDGET_EXHAUSTED");
  }
  private get block() {
    return "0x" + this.pin.number.toString(16);
  }
  private pinned = (e: ApprovedEndpoint) => e.id === this.pin.endpointId;
  private multicallVerified?: Promise<boolean>;
  /** Multicall3 at its canonical address, code hash verified at a pinned block (one proof per chain, LONG TTL). */
  private multicall(): Promise<boolean> {
    const address = MULTICALL_BY_CHAIN[this.deployment.chainId];
    if (address !== MULTICALL3) return Promise.resolve(false);
    this.multicallVerified ??= (async () => {
      try {
        const r = await cached(
          cacheKey("multicall", this.deployment.chainId, "chain", MULTICALL3),
          "LONG",
          async () => {
            const codeHex = await this.fetchCode(MULTICALL3);
            // Only a verified code hash is a cacheable fact; a mismatch fails closed for this reader only.
            if (keccak256(codeHex) !== MULTICALL3_CODEHASH)
              throw Error("MULTICALL_UNVERIFIED");
            return true;
          },
        );
        if (r.hit) this.cacheHits++;
        return r.value;
      } catch {
        return false;
      }
    })();
    return this.multicallVerified;
  }
  private encode(target: string, name: ViewName, args: readonly unknown[]) {
    return encodeFunctionData({
      abi: abiFor(name),
      functionName: functionName(name),
      args,
    });
  }
  private decode(name: ViewName, data: Hex) {
    return decodeFunctionResult({
      abi: abiFor(name),
      functionName: functionName(name),
      data,
    });
  }
  private record(source: string) {
    this.evidence.push({
      kind: "contract-view",
      source,
      blockNumber: this.pin.number.toString(),
      blockHash: this.pin.hash,
      endpointGroup: this.pin.endpointGroup,
      observedAt: this.pin.observedAt,
    });
  }
  /** One pinned aggregate of exact capabilities; resolves per-call results (never throws for an inner revert). */
  private async sendAggregate(
    batch: { target: string; name: ViewName; data: Hex }[],
  ): Promise<PromiseSettledResult<unknown>[]> {
    const data = encodeAggregate3(
      batch.map((c) => ({ target: c.target, callData: c.data })),
    );
    this.batches++;
    this.multicallBatches++;
    this.http++;
    this.rpcItems++;
    const r = await this.pool.call(
      { method: "eth_call", params: [{ to: MULTICALL3, data }, this.block] },
      {
        signal: this.signal,
        timeoutMs: 8000,
        attempts: 1,
        filter: this.pinned,
        maxBytes: 8_000_000,
        policy: {
          ecosystem: "EVM",
          multicall: MULTICALL3,
          maxInnerCalls: 500,
          defiViews: batch.map((c) => ({ to: c.target, data: c.data })),
        },
      },
    );
    // A partial or reordered result set is rejected as a whole: it can never become a zero.
    const rows = decodeAggregate3Result(r.value, batch.length);
    if (!rows) throw Error("MULTICALL_RESULT_MALFORMED");
    // One evidence record per aggregate (the inner capabilities are exact and listed by the adapter's refs).
    this.record(MULTICALL3 + ":aggregate3:" + batch.length);
    return rows.map((row, i): PromiseSettledResult<unknown> => {
      try {
        if (!row.success) throw Error("INNER_CALL_REVERTED");
        return {
          status: "fulfilled",
          value: this.decode(batch[i].name, row.returnData),
        };
      } catch (reason) {
        this.errors++;
        return { status: "rejected", reason };
      }
    });
  }
  /** Aggregate with deterministic bounded split on a non-throttling failure; every call settles exactly once. */
  private async aggregateSplit(
    batch: { target: string; name: ViewName; data: Hex }[],
    depth = 0,
  ): Promise<PromiseSettledResult<unknown>[]> {
    try {
      return await this.sendAggregate(batch);
    } catch (e) {
      const why = reason(e);
      if (why === "ENDPOINT_COOLDOWN") this.cooldownSkips++;
      if (
        !NO_SPLIT.has(why) &&
        why !== "ENDPOINT_COOLDOWN" &&
        batch.length >= 2 &&
        depth < SPLIT_DEPTH &&
        !this.signal.aborted
      ) {
        this.retries++;
        const mid = Math.ceil(batch.length / 2);
        const [a, b] = await Promise.all([
          this.aggregateSplit(batch.slice(0, mid), depth + 1),
          this.aggregateSplit(batch.slice(mid), depth + 1),
        ]);
        return [...a, ...b];
      }
      this.errors += batch.length;
      return batch.map(() => ({ status: "rejected", reason: e }));
    }
  }
  private async single(p: Pending) {
    this.http++;
    this.rpcItems++;
    try {
      const r = await this.pool.call(
        {
          method: "eth_call",
          params: [{ to: p.target, data: p.data }, this.block],
        },
        {
          signal: this.signal,
          timeoutMs: 3500,
          attempts: 1,
          filter: this.pinned,
          policy: {
            ecosystem: "EVM",
            defiViews: [{ to: p.target, data: p.data }],
          },
        },
      );
      const value = this.decode(p.name, r.value as Hex);
      this.record(p.target + ":" + functionName(p.name));
      p.resolve(value);
    } catch (e) {
      if (reason(e) === "ENDPOINT_COOLDOWN") this.cooldownSkips++;
      this.errors++;
      p.reject(e);
    }
  }
  /** JSON-RPC batches of at most BATCH_MAX exact eth_calls; a failed batch falls back to single calls once. */
  private async jsonBatch(chunk: Pending[]) {
    this.batches++;
    this.http++;
    this.rpcItems += chunk.length;
    try {
      const { items } = await this.pool.batch(
        chunk.map((c) => ({
          method: "eth_call",
          params: [{ to: c.target, data: c.data }, this.block],
        })),
        {
          signal: this.signal,
          timeoutMs: 4000,
          attempts: 1,
          filter: this.pinned,
          policy: {
            ecosystem: "EVM",
            defiViews: chunk.map((c) => ({ to: c.target, data: c.data })),
          },
        },
      );
      items.forEach((item, i) => {
        const c = chunk[i];
        try {
          if (!item.ok) throw item.error;
          const value = this.decode(c.name, item.value as Hex);
          this.record(c.target + ":" + functionName(c.name));
          c.resolve(value);
        } catch (e) {
          this.errors++;
          c.reject(e);
        }
      });
    } catch (e) {
      const why = reason(e);
      if (
        why === "RATE_LIMITED" ||
        why === "ENDPOINT_COOLDOWN" ||
        this.signal.aborted
      ) {
        if (why === "ENDPOINT_COOLDOWN") this.cooldownSkips++;
        this.errors += chunk.length;
        for (const c of chunk) c.reject(e);
        return;
      }
      this.fallbacks++;
      this.retries++;
      for (let i = 0; i < chunk.length; i += 4)
        await Promise.all(chunk.slice(i, i + 4).map((c) => this.single(c)));
    }
  }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      void this.flush();
    });
  }
  private async flush() {
    const queue = this.queue.splice(0);
    if (!queue.length) return;
    if (queue.length === 1) return this.single(queue[0]);
    if (await this.multicall()) {
      const chunks: Pending[][] = [];
      for (let i = 0; i < queue.length; i += COALESCE_MAX)
        chunks.push(queue.slice(i, i + COALESCE_MAX));
      await Promise.all(
        chunks.map(async (chunk) => {
          const results = await this.aggregateSplit(chunk);
          results.forEach((r, i) =>
            r.status === "fulfilled"
              ? chunk[i].resolve(r.value)
              : chunk[i].reject(r.reason),
          );
        }),
      );
      return;
    }
    if (this.pool.available((e) => this.pinned(e) && e.supportsBatch)) {
      const chunks: Pending[][] = [];
      for (let i = 0; i < queue.length; i += BATCH_MAX)
        chunks.push(queue.slice(i, i + BATCH_MAX));
      await Promise.all(chunks.map((c) => this.jsonBatch(c)));
      return;
    }
    for (let i = 0; i < queue.length; i += 4)
      await Promise.all(queue.slice(i, i + 4).map((p) => this.single(p)));
  }
  /** V1.14: up to 500 exact view capabilities in ONE pinned eth_call through the verified Multicall3. */
  async readAggregate(
    calls: { target: string; name: ViewName; args?: readonly unknown[] }[],
  ): Promise<PromiseSettledResult<unknown>[] | null> {
    if (calls.length > 500) throw Error("BATCH_BUDGET_EXHAUSTED");
    if (!(await this.multicall())) return null;
    const batch = calls.map((c) => {
      this.tick(c.target);
      return {
        target: c.target,
        name: c.name,
        data: this.encode(c.target, c.name, c.args ?? []),
      };
    });
    return this.aggregateSplit(batch);
  }
  /** Independent reads at the pin, coalesced into as few requests as the transport allows. */
  async readMany(
    calls: { target: string; name: ViewName; args?: readonly unknown[] }[],
  ) {
    if (calls.length > 128) throw Error("BATCH_BUDGET_EXHAUSTED");
    return Promise.allSettled(
      calls.map((c) => this.read(c.target, c.name, c.args)),
    );
  }
  read(target: string, name: ViewName, args: readonly unknown[] = []) {
    let data: Hex;
    try {
      // Authorization is per reader: a shared result never grants a capability this reader does not hold.
      this.tick(target);
      data = this.encode(target, name, args);
    } catch (e) {
      return Promise.reject(e);
    }
    const key = target + data;
    const shared = this.memo?.get(key);
    const own = () =>
      new Promise<unknown>((resolve, reject) => {
        this.queue.push({ target, name, data, resolve, reject });
        this.schedule();
      });
    if (shared) {
      this.memoHits++;
      return shared.then(
        (value) => {
          this.record(target + ":" + functionName(name));
          return value;
        },
        // Another adapter's transport failure (e.g. its own deadline) is never inherited: read with this budget.
        (e) => (deterministic(e) ? Promise.reject(e) : own()),
      );
    }
    const p = own();
    if (this.memo) {
      this.memo.set(key, p);
      // Only a deterministic outcome is shared (a value or a contract revert at this block); a transport failure is
      // dropped so another adapter reads again.
      p.catch((e) => {
        if (!deterministic(e)) this.memo?.delete(key);
      });
    }
    return p;
  }
  private async fetchCode(target: string) {
    this.http++;
    this.rpcItems++;
    const r = await this.pool.call(
      { method: "eth_getCode", params: [target, this.block] },
      {
        signal: this.signal,
        attempts: 1,
        filter: this.pinned,
        maxBytes: 4_000_000,
      },
    );
    if (
      typeof r.value !== "string" ||
      !/^0x[0-9a-f]+$/i.test(r.value) ||
      r.value === "0x" ||
      r.value === "0x0"
    )
      throw Error("NO_CONTRACT_CODE");
    return r.value as Hex;
  }
  private codeEvidence(target: string, proof: CodeProof) {
    this.evidence.push({
      kind: "contract-view",
      source: target + ":codehash:" + proof.codeHash,
      blockNumber: proof.block,
      blockHash: proof.blockHash,
      observedAt: proof.observedAt,
    });
  }
  /**
   * Contract code proof (LONG TTL per chain + address; the evidence keeps the block it was observed at). Resolves to
   * the keccak code hash: callers only need the proof that reviewed code exists at the address.
   */
  async code(target: string): Promise<Hex> {
    this.tick(target);
    const { value, hit } = await cached<CodeProof>(
      cacheKey("code", this.deployment.chainId, "chain", target),
      "LONG",
      async () => this.proof(await this.fetchCode(target)),
    );
    if (hit) this.cacheHits++;
    this.codeEvidence(target, value);
    return value.codeHash as Hex;
  }
  private proof(code: Hex): CodeProof {
    return {
      codeHash: keccak256(code),
      block: this.pin.number.toString(),
      blockHash: this.pin.hash,
      observedAt: this.pin.observedAt,
    };
  }
  /** V1.14.1: code proofs for several reviewed contracts in one JSON-RPC batch (cache misses only). */
  async codeMany(targets: string[]) {
    const unique = [...new Set(targets)];
    for (const t of unique) this.tick(t);
    const missing: string[] = [];
    const proofs = new Map<string, CodeProof>();
    for (const t of unique) {
      const hit = cacheGet<CodeProof>(
        cacheKey("code", this.deployment.chainId, "chain", t),
      );
      if (hit) {
        this.cacheHits++;
        proofs.set(t, hit);
      } else missing.push(t);
    }
    // The chain's Multicall3 code proof rides in the same batch while it is not verified yet (one request less).
    const mcKey = cacheKey(
      "multicall",
      this.deployment.chainId,
      "chain",
      MULTICALL3,
    );
    const withMulticall =
      missing.length > 0 &&
      MULTICALL_BY_CHAIN[this.deployment.chainId] === MULTICALL3 &&
      !this.multicallVerified &&
      cacheGet<boolean>(mcKey) === undefined &&
      !unique.includes(MULTICALL3);
    const batchable = this.pool.available(
      (e) => this.pinned(e) && e.supportsBatch,
    );
    const requested =
      withMulticall && batchable ? [...missing, MULTICALL3] : missing;
    if (requested.length > 1 && batchable) {
      for (let i = 0; i < requested.length; i += BATCH_MAX) {
        const chunk = requested.slice(i, i + BATCH_MAX);
        this.batches++;
        this.http++;
        this.rpcItems += chunk.length;
        const { items } = await this.pool.batch(
          chunk.map((t) => ({
            method: "eth_getCode",
            params: [t, this.block],
          })),
          {
            signal: this.signal,
            attempts: 1,
            filter: this.pinned,
            maxBytes: 8_000_000,
          },
        );
        items.forEach((item, k) => {
          if (
            !item.ok ||
            typeof item.value !== "string" ||
            !/^0x[0-9a-f]+$/i.test(item.value) ||
            item.value === "0x" ||
            item.value === "0x0"
          ) {
            // A missing Multicall3 only means "no aggregate" (the reader verifies again and fails closed).
            if (chunk[k] === MULTICALL3) return;
            throw Error("NO_CONTRACT_CODE");
          }
          proofs.set(chunk[k], this.proof(item.value as Hex));
        });
      }
      for (const t of missing)
        cacheSet(
          cacheKey("code", this.deployment.chainId, "chain", t),
          proofs.get(t),
          "LONG",
        );
      if (proofs.get(MULTICALL3)?.codeHash === MULTICALL3_CODEHASH)
        cacheSet(mcKey, true, "LONG");
    } else
      for (const t of missing) {
        const proof = this.proof(await this.fetchCode(t));
        proofs.set(t, proof);
        cacheSet(
          cacheKey("code", this.deployment.chainId, "chain", t),
          proof,
          "LONG",
        );
      }
    for (const t of unique) this.codeEvidence(t, proofs.get(t)!);
  }
  async asset(
    target: string,
    raw: bigint,
    role: PositionAsset["role"],
    known?: { symbol: string; decimals: number },
  ) {
    uint(raw);
    addressSchema.parse(target);
    // V1.14: the chain's native coin (exact protocol conversions denominated in ETH) uses the routing price list's
    // zero-address convention. It is never read as a contract and never authorized as a call target.
    if (target === NATIVE_ASSET) {
      const price = this.prices.get(NATIVE_ASSET);
      return {
        assetId: this.deployment.chainId + ":" + NATIVE_ASSET,
        chainId: this.deployment.chainId,
        contract: NATIVE_ASSET,
        symbol: known?.symbol ?? "ETH",
        decimals: 18,
        rawAmount: raw.toString(),
        role,
        ...(price ? { price } : {}),
        valueUsd: usdValue(raw, 18, freshPrice(price, this.pin.observedAt)),
      };
    }
    this.authorize(target);
    let meta = known;
    if (!meta) {
      let p = this.metadata.get(target);
      if (!p) {
        p = this.tokenMetadata(target);
        this.metadata.set(target, p);
      }
      meta = await p;
    }
    if (
      !Number.isInteger(meta.decimals) ||
      meta.decimals < 0 ||
      meta.decimals > 36
    )
      throw Error("INVALID_DECIMALS");
    const price = this.prices.get(target);
    return {
      assetId: this.deployment.chainId + ":" + target,
      chainId: this.deployment.chainId,
      contract: target,
      symbol: meta.symbol,
      decimals: meta.decimals,
      rawAmount: raw.toString(),
      role,
      ...(price ? { price } : {}),
      valueUsd: usdValue(
        raw,
        meta.decimals,
        freshPrice(price, this.pin.observedAt),
      ),
    };
  }
  /** Token decimals + symbol (LONG TTL). Only a complete read is cached; a symbol failure stays "?" for this scan. */
  private async tokenMetadata(target: string) {
    const key = cacheKey("token", this.deployment.chainId, "chain", target);
    const hit = cacheGet<{ symbol: string; decimals: number }>(key);
    if (hit) {
      this.cacheHits++;
      return hit;
    }
    const [d, s] = await Promise.allSettled([
      this.read(target, "decimals"),
      this.read(target, "symbol"),
    ]);
    if (d.status === "rejected") throw d.reason;
    const decimals = Number(d.value);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
      throw Error("INVALID_DECIMALS");
    // Metadata failure never hides balances or debt.
    const symbol =
      s.status === "fulfilled" ? sanitizeText(String(s.value), 32) || "?" : "?";
    const meta = { decimals, symbol };
    if (s.status === "fulfilled") cacheSet(key, meta, "LONG");
    return meta;
  }
  async verifyPin() {
    if (this.verifier) return this.verifier.verify(this.signal);
    this.http++;
    this.rpcItems++;
    const r = await this.pool.call(
      {
        method: "eth_getBlockByNumber",
        params: [this.block, false],
      },
      {
        signal: this.signal,
        attempts: 1,
        filter: this.pinned,
      },
    );
    if (blockSchema.parse(r.value).hash !== this.pin.hash)
      throw Error("REORG_PIN_CHANGED");
  }
}
interface CodeProof {
  codeHash: string;
  block: string;
  blockHash: string;
  observedAt: number;
}
export function authorize(ctx: ReadContext, target: string) {
  if (ctx instanceof DefiReader) ctx.authorize(target);
  return target;
}
export function exactAddress(value: unknown) {
  return addressSchema.parse(String(value).toLowerCase());
}
export function tuple(value: unknown, min: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length < min)
    throw Error("MALFORMED_POSITION");
  return value;
}
