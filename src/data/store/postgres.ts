import postgres, { type Sql } from "postgres";
import type { ChainRecord } from "../registry/chains";
import type { AdmissionResult } from "../rpc/admission";
import type { EndpointHealth } from "../rpc/health";
import type { MulticallVerification } from "../evm/multicall";
import type { TransferRow } from "../evm/erc20";
import { committedDigest, type LogWindowWitness } from "../indexer/witness";
import type {
  ActivityCursor,
  ActivityRow,
  ApiClient,
  ApiKeyRecord,
  BackupEvent,
  Checkpoint,
  CommitWindow,
  DataStore,
  DiscoveryRow,
  IndexVerification,
  ScanRunRecord,
  StoredChain,
  TokenRow,
  TokenUpsert,
  UsageEvent,
  WindowRow,
  WitnessSummary,
} from "./types";
// Every statement below is a parameterized tagged template; no caller string reaches SQL text.
type Row = Record<string, unknown>;
const big = (v: unknown) => BigInt(String(v));
const bigOrNull = (v: unknown) =>
  v === null || v === undefined ? null : BigInt(String(v));
const ms = (v: unknown) =>
  v instanceof Date
    ? v.getTime()
    : v === null || v === undefined
      ? null
      : new Date(String(v)).getTime();
const iso = (v: number) => new Date(v);
const COMMITTABLE = new Set([
  "MATCH",
  "TIEBREAK_MATCH_PRIMARY",
  "TIEBREAK_MATCH_WITNESS",
  "NO_INDEPENDENT_WITNESS",
]);
const TRUSTED = ["MATCH", "TIEBREAK_MATCH_PRIMARY", "TIEBREAK_MATCH_WITNESS"];

export function connect(
  url: string,
  options: { max?: number; application?: string } = {},
) {
  const parsed = new URL(url);
  if (!/^postgres(ql)?:$/.test(parsed.protocol))
    throw Error("DATABASE_URL_INVALID");
  return postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: 8,
    max_lifetime: 1800,
    onnotice: () => {},
    connection: {
      application_name: options.application ?? "otherbridge-data",
      statement_timeout: 15000,
    },
  });
}
export class PostgresStore implements DataStore {
  readonly kind = "postgres" as const;
  constructor(readonly sql: Sql) {}
  private tx<T>(fn: (sql: Sql) => Promise<T>): Promise<T> {
    return this.sql.begin((t) => fn(t as unknown as Sql)) as Promise<T>;
  }
  async ping() {
    try {
      await this.sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }
  async close() {
    await this.sql.end({ timeout: 5 });
  }
  async upsertChains(chains: ChainRecord[]) {
    let count = 0;
    for (const c of chains) {
      await this.sql`
        INSERT INTO chains (chain_id, canonical_id, eip155_id, ecosystem, name, mainnet, native_symbol,
          native_name, native_decimals, finality_kind, finality_depth, configured_tier, index_start_blocks,
          token_event_model, enabled, tvl_usd, routable, sources, updated_at)
        VALUES (${c.chainId}, ${c.canonicalId}, ${c.eip155}, ${c.ecosystem}, ${c.name}, ${c.mainnet},
          ${c.native.symbol.slice(0, 32)}, ${c.native.name.slice(0, 120)}, ${c.native.decimals},
          ${c.finality.kind}, ${c.finality.depth}, ${c.configuredTier}, ${c.indexStartBlocks},
          ${c.tokenEventModel}, ${c.enabled}, ${c.tvlUsd}, ${c.routable}, ${c.sources}, now())
        ON CONFLICT (chain_id) DO UPDATE SET canonical_id = EXCLUDED.canonical_id,
          eip155_id = EXCLUDED.eip155_id, ecosystem = EXCLUDED.ecosystem, name = EXCLUDED.name,
          mainnet = EXCLUDED.mainnet, native_symbol = EXCLUDED.native_symbol, native_name = EXCLUDED.native_name,
          native_decimals = EXCLUDED.native_decimals, finality_kind = EXCLUDED.finality_kind,
          finality_depth = EXCLUDED.finality_depth, configured_tier = EXCLUDED.configured_tier,
          index_start_blocks = EXCLUDED.index_start_blocks, token_event_model = EXCLUDED.token_event_model,
          enabled = EXCLUDED.enabled, tvl_usd = EXCLUDED.tvl_usd, routable = EXCLUDED.routable,
          sources = EXCLUDED.sources, updated_at = now()`;
      count++;
    }
    return count;
  }
  async listChains(): Promise<StoredChain[]> {
    const rows = await this.sql<
      Row[]
    >`SELECT * FROM chains ORDER BY tvl_usd DESC NULLS LAST, chain_id`;
    return rows.map((r) => ({
      chainId: String(r.chain_id),
      canonicalId: String(r.canonical_id),
      eip155: (r.eip155_id as string | null) ?? null,
      ecosystem: r.ecosystem as StoredChain["ecosystem"],
      name: String(r.name),
      mainnet: Boolean(r.mainnet),
      native: {
        symbol: String(r.native_symbol),
        name: String(r.native_name),
        decimals: Number(r.native_decimals),
      },
      finality: {
        kind: r.finality_kind as StoredChain["finality"]["kind"],
        depth: Number(r.finality_depth),
      },
      configuredTier: r.configured_tier as StoredChain["configuredTier"],
      indexStartBlocks:
        r.index_start_blocks === null ? null : Number(r.index_start_blocks),
      tokenEventModel:
        (r.token_event_model as StoredChain["tokenEventModel"]) ?? null,
      enabled: Boolean(r.enabled),
      tvlUsd: r.tvl_usd === null ? null : Number(r.tvl_usd),
      routable: Boolean(r.routable),
      sources: (r.sources as StoredChain["sources"]) ?? [],
      multicall: (r.multicall_address as string | null) ?? null,
      multicallVerifiedAt: ms(r.multicall_verified_at),
    }));
  }
  async setMulticall(chainId: string, v: MulticallVerification) {
    await this.sql`
      UPDATE chains SET multicall_address = ${v.verified ? v.address : null},
        multicall_code_hash = ${v.codeHash}, multicall_verified_at = ${iso(v.observedAt)}
      WHERE chain_id = ${chainId}`;
  }
  async upsertEndpoint(r: AdmissionResult, priority: number) {
    if (!r.host) return;
    const id = `${r.chainId}:${r.host}${new URL(r.url).pathname === "/" ? "" : new URL(r.url).pathname}`;
    await this.sql`
      INSERT INTO rpc_endpoints (id, chain_id, url, host, provenance, priority, status, reason, supports_logs,
        max_log_range, supports_batch, supports_finalized, supports_safe, archive, logs_per_block, latency_ms,
        latest_block, admitted_at)
      VALUES (${id}, ${r.chainId}, ${r.url}, ${r.host}, ${r.provenance}, ${priority}, ${r.status}, ${r.reason},
        ${r.supportsLogs}, ${r.maxLogRange}, ${r.supportsBatch}, ${r.supportsFinalized}, ${r.supportsSafe},
        ${r.archive}, ${r.logsPerBlock}, ${r.latencyMs}, ${r.latestBlock}, ${iso(r.checkedAt)})
      ON CONFLICT (chain_id, url) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason,
        priority = EXCLUDED.priority, supports_logs = EXCLUDED.supports_logs, max_log_range = EXCLUDED.max_log_range,
        supports_batch = EXCLUDED.supports_batch, supports_finalized = EXCLUDED.supports_finalized,
        supports_safe = EXCLUDED.supports_safe, archive = EXCLUDED.archive, logs_per_block = EXCLUDED.logs_per_block,
        latency_ms = EXCLUDED.latency_ms, latest_block = EXCLUDED.latest_block, admitted_at = EXCLUDED.admitted_at`;
  }
  async listEndpoints(chainId?: string) {
    const rows = chainId
      ? await this.sql<
          Row[]
        >`SELECT * FROM rpc_endpoints WHERE chain_id = ${chainId} AND status = 'APPROVED' ORDER BY priority, id`
      : await this.sql<
          Row[]
        >`SELECT * FROM rpc_endpoints WHERE status = 'APPROVED' ORDER BY chain_id, priority, id`;
    return rows.map((r) => ({
      id: String(r.id),
      chainId: String(r.chain_id),
      url: String(r.url),
      allowPort: r.provenance !== "public-registry",
      priority: Number(r.priority),
      supportsLogs: Boolean(r.supports_logs),
      maxLogRange: Number(r.max_log_range),
      supportsBatch: Boolean(r.supports_batch),
      supportsFinalized: Boolean(r.supports_finalized),
      supportsSafe: Boolean(r.supports_safe),
      archive: Boolean(r.archive),
      status: String(r.status),
    }));
  }
  async recordHealth(endpointId: string, h: EndpointHealth) {
    await this.sql`
      INSERT INTO rpc_health (endpoint_id, checked_at, ok_count, error_count, consecutive_failures, latency_ms,
        error_rate, latest_block, quarantined_until, quarantine_reason)
      VALUES (${endpointId}, ${iso(h.checkedAt || Date.now())}, ${h.ok}, ${h.errors}, ${h.consecutiveFailures},
        ${h.latencyMs}, ${Math.min(1, Math.max(0, h.errorRate))}, ${h.latestBlock?.toString() ?? null},
        ${h.quarantinedUntil ? iso(h.quarantinedUntil) : null}, ${h.quarantineReason})
      ON CONFLICT (endpoint_id) DO UPDATE SET checked_at = EXCLUDED.checked_at, ok_count = EXCLUDED.ok_count,
        error_count = EXCLUDED.error_count, consecutive_failures = EXCLUDED.consecutive_failures,
        latency_ms = EXCLUDED.latency_ms, error_rate = EXCLUDED.error_rate, latest_block = EXCLUDED.latest_block,
        quarantined_until = EXCLUDED.quarantined_until, quarantine_reason = EXCLUDED.quarantine_reason`;
  }
  async loadHealth() {
    const rows = await this.sql<Row[]>`SELECT * FROM rpc_health`;
    return new Map(
      rows.map((r) => [
        String(r.endpoint_id),
        {
          ok: Number(r.ok_count),
          errors: Number(r.error_count),
          consecutiveFailures: Number(r.consecutive_failures),
          latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
          errorRate: Number(r.error_rate),
          latestBlock: bigOrNull(r.latest_block),
          checkedAt: ms(r.checked_at) ?? 0,
          quarantinedUntil: ms(r.quarantined_until),
          quarantineReason: (r.quarantine_reason as string | null) ?? null,
        } satisfies EndpointHealth,
      ]),
    );
  }
  async learnLogRange(endpointId: string, range: number) {
    await this
      .sql`UPDATE rpc_endpoints SET max_log_range = ${Math.max(0, Math.floor(range))} WHERE id = ${endpointId}`;
  }
  async acquireLease(
    chainId: string,
    owner: string,
    ttlMs: number,
    from: bigint,
    to: bigint,
  ) {
    const rows = await this.sql<Row[]>`
      INSERT INTO indexer_leases (chain_id, owner_id, from_block, to_block, acquired_at, expires_at)
      VALUES (${chainId}, ${owner}, ${from.toString()}, ${to.toString()}, now(), now() + ${ttlMs} * interval '1 millisecond')
      ON CONFLICT (chain_id) DO UPDATE SET owner_id = EXCLUDED.owner_id, from_block = EXCLUDED.from_block,
        to_block = EXCLUDED.to_block, acquired_at = CASE WHEN indexer_leases.owner_id = EXCLUDED.owner_id
          THEN indexer_leases.acquired_at ELSE now() END, expires_at = EXCLUDED.expires_at
      WHERE indexer_leases.expires_at < now() OR indexer_leases.owner_id = EXCLUDED.owner_id
      RETURNING owner_id`;
    return rows.length === 1 && rows[0].owner_id === owner;
  }
  async releaseLease(chainId: string, owner: string) {
    await this
      .sql`UPDATE indexer_leases SET expires_at = now() WHERE chain_id = ${chainId} AND owner_id = ${owner}`;
  }
  private checkpoint(r: Row): Checkpoint {
    return {
      chainId: String(r.chain_id),
      indexedFromBlock: big(r.indexed_from_block),
      indexedThroughBlock: big(r.indexed_through_block),
      throughBlockHash: (r.through_block_hash as string | null) ?? null,
      headBlock: bigOrNull(r.head_block),
      safeBlock: bigOrNull(r.safe_block),
      historicalComplete: Boolean(r.historical_complete),
      lastError: (r.last_error as string | null) ?? null,
      updatedAt: ms(r.updated_at) ?? 0,
      haltedReason: (r.halted_reason as string | null) ?? null,
      haltedAt: ms(r.halted_at),
    };
  }
  async getCheckpoint(chainId: string) {
    const [r] = await this.sql<
      Row[]
    >`SELECT * FROM indexer_checkpoints WHERE chain_id = ${chainId}`;
    return r ? this.checkpoint(r) : null;
  }
  async listCheckpoints() {
    return (
      await this.sql<Row[]>`SELECT * FROM indexer_checkpoints ORDER BY chain_id`
    ).map((r) => this.checkpoint(r));
  }
  private async holdLease(sql: Sql, chainId: string, owner: string) {
    const rows = await sql`
      SELECT 1 FROM indexer_leases WHERE chain_id = ${chainId} AND owner_id = ${owner} AND expires_at > now() FOR UPDATE`;
    if (rows.length !== 1) throw Error("LEASE_LOST");
  }
  async initCheckpoint(
    chainId: string,
    owner: string,
    fromBlock: bigint,
    anchorHash: string,
  ) {
    await this.tx(async (sql) => {
      await this.holdLease(sql, chainId, owner);
      await sql`
        INSERT INTO indexer_checkpoints (chain_id, indexed_from_block, indexed_through_block, through_block_hash)
        VALUES (${chainId}, ${fromBlock.toString()}, ${(fromBlock - 1n).toString()}, ${anchorHash.toLowerCase()})
        ON CONFLICT (chain_id) DO NOTHING`;
    });
  }
  // Atomic window commit with lease fencing and contiguous-checkpoint enforcement.
  async commitWindow(input: CommitWindow) {
    const { chainId, owner, window } = input;
    return this.tx(async (sql) => {
      await this.holdLease(sql, chainId, owner);
      const [cp] = await sql<Row[]>`
        SELECT indexed_through_block, halted_reason FROM indexer_checkpoints WHERE chain_id = ${chainId} FOR UPDATE`;
      if (!cp || big(cp.indexed_through_block) !== window.fromBlock - 1n)
        throw Error("CHECKPOINT_RACE");
      if (cp.halted_reason) throw Error("CHAIN_HALTED");
      const result = await this.insertWindow(sql, input, "live");
      await sql`
        UPDATE indexer_checkpoints SET indexed_through_block = ${window.toBlock.toString()},
          through_block_hash = ${window.toBlockHash.toLowerCase()}, head_block = ${input.headBlock.toString()},
          safe_block = ${input.safeBlock.toString()}, last_error = NULL, updated_at = now()
        WHERE chain_id = ${chainId}`;
      await sql`UPDATE indexer_leases SET expires_at = now() + interval '60 seconds' WHERE chain_id = ${chainId} AND owner_id = ${owner}`;
      return result;
    });
  }
  // V1.5 backward historical lane: finalized windows only, contiguous below indexed_from_block,
  // fenced by its own lease; the live lane's lease and checkpoint head are never touched.
  async commitBackfillWindow(input: CommitWindow) {
    const { chainId, owner, window } = input;
    if (!window.finalized) throw Error("BACKFILL_REQUIRES_FINALIZED");
    return this.tx(async (sql) => {
      const lease = await sql`
        SELECT 1 FROM indexer_backfill_leases WHERE chain_id = ${chainId} AND owner_id = ${owner} AND expires_at > now() FOR UPDATE`;
      if (lease.length !== 1) throw Error("LEASE_LOST");
      const [cp] = await sql<Row[]>`
        SELECT indexed_from_block, halted_reason FROM indexer_checkpoints WHERE chain_id = ${chainId} FOR UPDATE`;
      if (!cp || big(cp.indexed_from_block) !== window.toBlock + 1n)
        throw Error("CHECKPOINT_RACE");
      if (cp.halted_reason) throw Error("CHAIN_HALTED");
      if (window.fromBlock < 0n) throw Error("ROW_OUTSIDE_WINDOW");
      const result = await this.insertWindow(sql, input, "backfill");
      await sql`
        UPDATE indexer_checkpoints SET indexed_from_block = ${window.fromBlock.toString()},
          updated_at = now() WHERE chain_id = ${chainId}`;
      await sql`UPDATE indexer_backfill_leases SET expires_at = now() + interval '60 seconds' WHERE chain_id = ${chainId} AND owner_id = ${owner}`;
      return result;
    });
  }
  private async insertWitness(sql: Sql, w: LogWindowWitness) {
    await sql`
      INSERT INTO indexed_window_witnesses (chain_id, from_block, to_block, mode, primary_endpoint_id,
        witness_endpoint_id, tiebreak_endpoint_id, primary_operator, witness_operator, tiebreak_operator,
        primary_block_start_hash, primary_block_end_hash, witness_block_start_hash, witness_block_end_hash,
        primary_log_count, witness_log_count, tiebreak_log_count, primary_digest, witness_digest,
        tiebreak_digest, consensus, failure, committed, observed_at)
      VALUES (${w.chainId}, ${w.fromBlock.toString()}, ${w.toBlock.toString()}, ${w.mode},
        ${w.primaryEndpointId}, ${w.witnessEndpointId}, ${w.tiebreakEndpointId}, ${w.primaryOperator},
        ${w.witnessOperator}, ${w.tiebreakOperator}, ${w.primaryBlockStartHash.toLowerCase()},
        ${w.primaryBlockEndHash.toLowerCase()}, ${w.witnessBlockStartHash}, ${w.witnessBlockEndHash},
        ${w.primaryLogCount}, ${w.witnessLogCount}, ${w.tiebreakLogCount}, ${w.primaryDigest},
        ${w.witnessDigest}, ${w.tiebreakDigest}, ${w.consensus}, ${w.failure}, ${w.committed},
        ${iso(w.observedAt)})`;
  }
  private async insertWindow(
    sql: Sql,
    input: CommitWindow,
    lane: "live" | "backfill",
  ) {
    const { chainId, window } = input;
    if (
      input.rows.some(
        (r) =>
          r.chainId !== chainId ||
          r.blockNumber < window.fromBlock ||
          r.blockNumber > window.toBlock,
      )
    )
      throw Error("ROW_OUTSIDE_WINDOW");
    const w = input.witness;
    if (
      w &&
      (w.chainId !== chainId ||
        w.fromBlock !== window.fromBlock ||
        w.toBlock !== window.toBlock ||
        !w.committed ||
        !COMMITTABLE.has(w.consensus))
    )
      throw Error("WITNESS_RECORD_MISMATCH");
    {
      const inserted: TransferRow[] = [];
      for (let i = 0; i < input.rows.length; i += 2000) {
        const chunk = input.rows.slice(i, i + 2000);
        const values = chunk.map((r) => ({
          chain_id: chainId,
          block_number: r.blockNumber.toString(),
          block_hash: r.blockHash,
          tx_hash: r.txHash,
          log_index: r.logIndex,
          token: r.token,
          from_address: r.from,
          to_address: r.to,
          value: r.value.toString(),
        }));
        const done = await sql<Row[]>`
          INSERT INTO erc20_transfers ${sql(values)} ON CONFLICT DO NOTHING RETURNING tx_hash, log_index`;
        const keys = new Set(done.map((d) => `${d.tx_hash}:${d.log_index}`));
        inserted.push(
          ...chunk.filter((r) => keys.has(`${r.txHash}:${r.logIndex}`)),
        );
      }
      const discovery = new Map<
        string,
        {
          wallet: string;
          token: string;
          first: bigint;
          last: bigint;
          count: number;
        }
      >();
      for (const r of inserted)
        for (const wallet of new Set([r.from, r.to])) {
          if (/^0x0{40}$/.test(wallet)) continue;
          const key = `${wallet}:${r.token}`;
          const d = discovery.get(key);
          if (d) {
            d.first = d.first < r.blockNumber ? d.first : r.blockNumber;
            d.last = d.last > r.blockNumber ? d.last : r.blockNumber;
            d.count++;
          } else
            discovery.set(key, {
              wallet,
              token: r.token,
              first: r.blockNumber,
              last: r.blockNumber,
              count: 1,
            });
        }
      const entries = [...discovery.values()];
      for (let i = 0; i < entries.length; i += 4000) {
        const values = entries.slice(i, i + 4000).map((d) => ({
          chain_id: chainId,
          wallet: d.wallet,
          token: d.token,
          first_block: d.first.toString(),
          last_block: d.last.toString(),
          transfer_count: d.count,
        }));
        await sql`
          INSERT INTO wallet_token_discovery ${sql(values)}
          ON CONFLICT (chain_id, wallet, token) DO UPDATE SET
            first_block = LEAST(wallet_token_discovery.first_block, EXCLUDED.first_block),
            last_block = GREATEST(wallet_token_discovery.last_block, EXCLUDED.last_block),
            transfer_count = wallet_token_discovery.transfer_count + EXCLUDED.transfer_count`;
      }
      const tokens = [...new Set(inserted.map((r) => r.token))];
      for (let i = 0; i < tokens.length; i += 4000) {
        const values = tokens.slice(i, i + 4000).map((address) => ({
          chain_id: chainId,
          address,
          sources: ["indexed"],
        }));
        await sql`
          INSERT INTO tokens ${sql(values, "chain_id", "address", "sources")}
          ON CONFLICT (chain_id, address) DO UPDATE SET sources =
            ARRAY(SELECT DISTINCT unnest(tokens.sources || EXCLUDED.sources) ORDER BY 1)
          WHERE NOT ('indexed' = ANY(tokens.sources))`;
      }
      await sql`
        INSERT INTO indexed_block_windows (chain_id, from_block, to_block, to_block_hash, log_count, finalized,
          witness_consensus, log_digest, lane)
        VALUES (${chainId}, ${window.fromBlock.toString()}, ${window.toBlock.toString()},
          ${window.toBlockHash.toLowerCase()}, ${window.logCount}, ${window.finalized},
          ${w?.consensus ?? null}, ${w ? committedDigest(w) : null}, ${lane})`;
      if (w) await this.insertWitness(sql, w);
      return {
        inserted: inserted.length,
        duplicates: input.rows.length - inserted.length,
      };
    }
  }
  async listWindows(chainId: string, limit: number): Promise<WindowRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT * FROM indexed_block_windows WHERE chain_id = ${chainId} ORDER BY to_block DESC LIMIT ${limit}`;
    return rows.map((r) => ({
      fromBlock: big(r.from_block),
      toBlock: big(r.to_block),
      toBlockHash: String(r.to_block_hash),
      logCount: Number(r.log_count),
      finalized: Boolean(r.finalized),
      witnessConsensus:
        (r.witness_consensus as WindowRow["witnessConsensus"]) ?? null,
      logDigest: (r.log_digest as string | null) ?? null,
      lane: (r.lane as WindowRow["lane"]) ?? "live",
    }));
  }
  // Rolls back only unfinalized rows above keepThrough and rebuilds affected discovery aggregates.
  async rewind(
    chainId: string,
    owner: string,
    keepThrough: bigint,
    anchorHash: string,
  ) {
    return this.tx(async (sql) => {
      await this.holdLease(sql, chainId, owner);
      const keep = keepThrough.toString();
      const [conflict] = await sql<Row[]>`
        SELECT count(*)::int AS n FROM indexed_block_windows
        WHERE chain_id = ${chainId} AND to_block > ${keep} AND (finalized OR from_block <= ${keep})`;
      if (Number(conflict.n) > 0) throw Error("FINALIZED_CONFLICT");
      const affected = await sql<Row[]>`
        SELECT DISTINCT w.wallet, t.token FROM erc20_transfers t
        CROSS JOIN LATERAL (VALUES (t.from_address), (t.to_address)) AS w(wallet)
        WHERE t.chain_id = ${chainId} AND t.block_number > ${keep}`;
      const removed =
        await sql`DELETE FROM erc20_transfers WHERE chain_id = ${chainId} AND block_number > ${keep}`;
      await sql`DELETE FROM indexed_block_windows WHERE chain_id = ${chainId} AND from_block > ${keep}`;
      for (let i = 0; i < affected.length; i += 2000) {
        const pairs = affected.slice(i, i + 2000);
        const wallets = pairs.map((p) => String(p.wallet)),
          tokens = pairs.map((p) => String(p.token));
        await sql`
          DELETE FROM wallet_token_discovery d USING unnest(${wallets}::text[], ${tokens}::text[]) AS p(wallet, token)
          WHERE d.chain_id = ${chainId} AND d.wallet = p.wallet AND d.token = p.token`;
        await sql`
          INSERT INTO wallet_token_discovery (chain_id, wallet, token, first_block, last_block, transfer_count)
          SELECT ${chainId}, p.wallet, p.token, min(t.block_number), max(t.block_number), count(*)
          FROM unnest(${wallets}::text[], ${tokens}::text[]) AS p(wallet, token)
          JOIN erc20_transfers t ON t.chain_id = ${chainId} AND t.token = p.token
            AND (t.from_address = p.wallet OR t.to_address = p.wallet)
          WHERE p.wallet <> '0x0000000000000000000000000000000000000000'
          GROUP BY p.wallet, p.token`;
      }
      await sql`
        UPDATE indexer_checkpoints SET indexed_through_block = ${keep}, through_block_hash = ${anchorHash.toLowerCase()},
          last_error = NULL, updated_at = now() WHERE chain_id = ${chainId}`;
      return removed.count;
    });
  }
  async promoteFinalized(
    chainId: string,
    finalizedBlock: bigint,
    owner: string,
  ) {
    return this.tx(async (sql) => {
      await this.holdLease(sql, chainId, owner);
      const r = await sql`
      UPDATE indexed_block_windows SET finalized = true
      WHERE chain_id = ${chainId} AND NOT finalized AND to_block <= ${finalizedBlock.toString()}`;
      return r.count;
    });
  }
  async setCheckpointError(chainId: string, error: string | null) {
    await this
      .sql`UPDATE indexer_checkpoints SET last_error = ${error} WHERE chain_id = ${chainId}`;
  }
  async upsertTokens(rows: TokenUpsert[]) {
    let n = 0;
    for (const r of rows) {
      await this.sql`
        INSERT INTO tokens (chain_id, address, symbol, name, decimals, metadata_status, sources, suspicious, spam,
          price_usd, price_observed_at, price_confidence, price_method, updated_at)
        VALUES (${r.chainId}, ${r.address}, ${r.symbol ?? null}, ${r.name ?? null}, ${r.decimals ?? null},
          ${r.metadataStatus ?? "PENDING"}, ${r.sources}, ${r.suspicious ?? false}, ${r.spam ?? false},
          ${r.price?.priceUsd ?? null}, ${r.price?.observedAt ? iso(r.price.observedAt) : null},
          ${r.price?.confidence ?? null}, ${r.price?.method ?? null}, now())
        ON CONFLICT (chain_id, address) DO UPDATE SET
          symbol = COALESCE(EXCLUDED.symbol, tokens.symbol), name = COALESCE(EXCLUDED.name, tokens.name),
          decimals = COALESCE(EXCLUDED.decimals, tokens.decimals),
          metadata_status = CASE WHEN EXCLUDED.metadata_status = 'PENDING' THEN tokens.metadata_status ELSE EXCLUDED.metadata_status END,
          sources = ARRAY(SELECT DISTINCT unnest(tokens.sources || EXCLUDED.sources) ORDER BY 1),
          suspicious = tokens.suspicious OR EXCLUDED.suspicious, spam = tokens.spam OR EXCLUDED.spam,
          price_usd = COALESCE(EXCLUDED.price_usd, tokens.price_usd),
          price_observed_at = COALESCE(EXCLUDED.price_observed_at, tokens.price_observed_at),
          price_confidence = COALESCE(EXCLUDED.price_confidence, tokens.price_confidence),
          price_method = COALESCE(EXCLUDED.price_method, tokens.price_method), updated_at = now()`;
      n++;
    }
    return n;
  }
  async pendingMetadata(chainId: string, limit: number) {
    const rows = await this.sql<Row[]>`
      SELECT address FROM tokens WHERE chain_id = ${chainId} AND metadata_status = 'PENDING'
      ORDER BY updated_at LIMIT ${limit}`;
    return rows.map((r) => String(r.address));
  }
  private token(r: Row): TokenRow {
    return {
      chainId: String(r.chain_id),
      address: String(r.address),
      symbol: (r.symbol as string | null) ?? null,
      name: (r.name as string | null) ?? null,
      decimals: r.decimals === null ? null : Number(r.decimals),
      metadataStatus: r.metadata_status as TokenRow["metadataStatus"],
      sources: (r.sources as string[]) ?? [],
      suspicious: Boolean(r.suspicious),
      spam: Boolean(r.spam),
      price:
        r.price_usd === null
          ? null
          : {
              priceUsd: String(r.price_usd),
              observedAt: ms(r.price_observed_at),
              confidence:
                (r.price_confidence as "verified" | "derived" | "unknown") ??
                "unknown",
              method: String(r.price_method ?? "cached"),
            },
    };
  }
  async getTokens(chainId: string, addresses: string[]) {
    if (!addresses.length) return [];
    const rows = await this.sql<Row[]>`
      SELECT * FROM tokens WHERE chain_id = ${chainId} AND address = ANY(${addresses})`;
    return rows.map((r) => this.token(r));
  }
  async tokenUniverse(chainId: string, limit: number) {
    const rows = await this.sql<Row[]>`
      SELECT address FROM tokens WHERE chain_id = ${chainId} AND address ~ '^0x[0-9a-f]{40}$' AND NOT spam
      ORDER BY ('routing-catalog' = ANY(sources)) DESC, (price_usd IS NOT NULL) DESC, address LIMIT ${limit}`;
    return rows.map((r) => String(r.address));
  }
  async tokenCounts() {
    const rows = await this.sql<
      Row[]
    >`SELECT chain_id, count(*)::int AS n FROM tokens GROUP BY chain_id`;
    return new Map(rows.map((r) => [String(r.chain_id), Number(r.n)]));
  }
  async routedSymbols(chainId: string, symbols: string[]) {
    if (!symbols.length) return new Set<string>();
    const rows = await this.sql<Row[]>`
      SELECT DISTINCT upper(symbol) AS s FROM tokens
      WHERE chain_id = ${chainId} AND 'routing-catalog' = ANY(sources) AND upper(symbol) = ANY(${symbols.slice(0, 500)})`;
    return new Set(rows.map((r) => String(r.s)));
  }
  async discoveredTokens(
    chainId: string,
    wallet: string,
  ): Promise<DiscoveryRow[]> {
    const rows = await this.sql<Row[]>`
      SELECT token, first_block, last_block, transfer_count FROM wallet_token_discovery
      WHERE chain_id = ${chainId} AND wallet = ${wallet.toLowerCase()} ORDER BY last_block DESC LIMIT 2000`;
    return rows.map((r) => ({
      token: String(r.token),
      firstBlock: big(r.first_block),
      lastBlock: big(r.last_block),
      transferCount: Number(r.transfer_count),
    }));
  }
  async walletChains(wallet: string) {
    const rows = await this.sql<Row[]>`
      SELECT DISTINCT chain_id FROM wallet_token_discovery WHERE wallet = ${wallet.toLowerCase()} ORDER BY chain_id`;
    return rows.map((r) => String(r.chain_id));
  }
  async walletActivity(
    wallet: string,
    cursor: ActivityCursor | null,
    limit: number,
  ): Promise<ActivityRow[]> {
    const w = wallet.toLowerCase();
    const c = cursor ?? { chainId: "", blockNumber: -1n, logIndex: -1 };
    const rows = await this.sql<Row[]>`
      SELECT chain_id, block_number, log_index, tx_hash, token, from_address, to_address, value FROM (
        SELECT * FROM erc20_transfers WHERE from_address = ${w}
        UNION
        SELECT * FROM erc20_transfers WHERE to_address = ${w}
      ) t
      WHERE (chain_id, block_number, log_index) > (${c.chainId}, ${c.blockNumber.toString()}, ${c.logIndex})
      ORDER BY chain_id, block_number, log_index LIMIT ${limit}`;
    return rows.map((r) => ({
      chainId: String(r.chain_id),
      blockNumber: big(r.block_number),
      logIndex: Number(r.log_index),
      txHash: String(r.tx_hash),
      token: String(r.token),
      direction:
        r.from_address === w && r.to_address === w
          ? "self"
          : r.from_address === w
            ? "out"
            : "in",
      value: big(r.value),
    }));
  }
  async recordBalanceSnapshot(
    walletHash: string,
    chainId: string,
    token: string | null,
    balance: bigint,
    block: bigint,
    at: number,
  ) {
    if (token === null)
      await this.sql`
        INSERT INTO native_balance_snapshots (wallet_hash, chain_id, balance, block_number, observed_at)
        VALUES (${walletHash}, ${chainId}, ${balance.toString()}, ${block.toString()}, ${iso(at)})
        ON CONFLICT (wallet_hash, chain_id) DO UPDATE SET balance = EXCLUDED.balance,
          block_number = EXCLUDED.block_number, observed_at = EXCLUDED.observed_at`;
    else
      await this.sql`
        INSERT INTO wallet_balance_snapshots (wallet_hash, chain_id, token, balance, block_number, observed_at)
        VALUES (${walletHash}, ${chainId}, ${token}, ${balance.toString()}, ${block.toString()}, ${iso(at)})
        ON CONFLICT (wallet_hash, chain_id, token) DO UPDATE SET balance = EXCLUDED.balance,
          block_number = EXCLUDED.block_number, observed_at = EXCLUDED.observed_at`;
  }
  async recordScanRun(run: ScanRunRecord) {
    await this.tx(async (sql) => {
      await sql`
        INSERT INTO portfolio_scan_runs (id, wallet_hash, origin, client_id, started_at, finished_at, state,
          chains_planned, chains_checked, chains_pending, chains_failed)
        VALUES (${run.id}, ${run.walletHash}, ${run.origin}, ${run.clientId}, ${iso(run.startedAt)},
          ${iso(run.finishedAt)}, ${run.state}, ${run.planned}, ${run.checked}, ${run.pending}, ${run.failed})`;
      for (let i = 0; i < run.coverage.length; i += 2000) {
        const values = run.coverage.slice(i, i + 2000).map((c) => ({
          run_id: run.id,
          chain_id: c.chainId,
          state: c.state,
          tier: c.tier,
          observed_block: c.observedBlock,
        }));
        if (values.length)
          await sql`INSERT INTO portfolio_scan_coverage ${sql(values)}`;
      }
    });
  }
  async createClient(c: ApiClient) {
    await this.sql`
      INSERT INTO api_clients (id, display_name, status, plan_id, scopes, created_at)
      VALUES (${c.id}, ${c.displayName}, ${c.status}, ${c.planId}, ${c.scopes}, ${iso(c.createdAt)})`;
  }
  private client(r: Row): ApiClient {
    return {
      id: String(r.id),
      displayName: String(r.display_name),
      status: r.status as ApiClient["status"],
      planId: String(r.plan_id),
      scopes: (r.scopes as string[]) ?? [],
      createdAt: ms(r.created_at) ?? 0,
    };
  }
  async getClient(id: string) {
    const [r] = await this.sql<
      Row[]
    >`SELECT * FROM api_clients WHERE id = ${id}`;
    return r ? this.client(r) : null;
  }
  async listClients() {
    return (
      await this.sql<Row[]>`SELECT * FROM api_clients ORDER BY created_at`
    ).map((r) => this.client(r));
  }
  async createKey(k: ApiKeyRecord) {
    await this.sql`
      INSERT INTO api_keys (id, client_id, prefix, verifier, status, created_at)
      VALUES (${k.id}, ${k.clientId}, ${k.prefix}, ${k.verifier}, ${k.status}, ${iso(k.createdAt)})`;
  }
  async findKey(prefix: string): Promise<ApiKeyRecord | null> {
    const [r] = await this.sql<
      Row[]
    >`SELECT * FROM api_keys WHERE prefix = ${prefix}`;
    return r
      ? {
          id: String(r.id),
          clientId: String(r.client_id),
          prefix: String(r.prefix),
          verifier: String(r.verifier),
          status: r.status as ApiKeyRecord["status"],
          createdAt: ms(r.created_at) ?? 0,
          revokedAt: ms(r.revoked_at),
          lastUsedAt: ms(r.last_used_at),
        }
      : null;
  }
  async revokeKey(idOrPrefix: string, at: number) {
    const r = await this.sql`
      UPDATE api_keys SET status = 'REVOKED', revoked_at = ${iso(at)}
      WHERE (id = ${idOrPrefix} OR prefix = ${idOrPrefix}) AND status = 'ACTIVE'`;
    return r.count > 0;
  }
  async touchKey(id: string, at: number) {
    await this.sql`
      UPDATE api_keys SET last_used_at = ${iso(at)}
      WHERE id = ${id} AND (last_used_at IS NULL OR last_used_at < ${iso(at - 60000)})`;
  }
  async recordUsage(e: UsageEvent) {
    const day = new Date(e.at).toISOString().slice(0, 10);
    await this.tx(async (sql) => {
      await sql`
        INSERT INTO api_usage_events (client_id, key_id, at, endpoint_group, status, cost_units, latency_bucket, request_id)
        VALUES (${e.clientId}, ${e.keyId}, ${iso(e.at)}, ${e.endpointGroup}, ${e.status}, ${e.costUnits},
          ${e.latencyBucket}, ${e.requestId})`;
      await sql`
        INSERT INTO api_usage_daily (client_id, day, endpoint_group, requests, cost_units, errors)
        VALUES (${e.clientId}, ${day}, ${e.endpointGroup}, 1, ${e.costUnits}, ${e.status >= 400 ? 1 : 0})
        ON CONFLICT (client_id, day, endpoint_group) DO UPDATE SET requests = api_usage_daily.requests + 1,
          cost_units = api_usage_daily.cost_units + EXCLUDED.cost_units,
          errors = api_usage_daily.errors + EXCLUDED.errors`;
    });
  }
  async usageSummary(clientId: string, sinceDay: string) {
    const rows = await this.sql<Row[]>`
      SELECT to_char(day, 'YYYY-MM-DD') AS day, endpoint_group, requests, cost_units, errors FROM api_usage_daily
      WHERE client_id = ${clientId} AND day >= ${sinceDay} ORDER BY day, endpoint_group`;
    return rows.map((r) => ({
      day: String(r.day),
      endpointGroup: String(r.endpoint_group),
      requests: Number(r.requests),
      costUnits: Number(r.cost_units),
      errors: Number(r.errors),
    }));
  }
  // Atomic fixed-window counter: concurrent instances serialize on the bucket row.
  async consumeBucket(
    key: string,
    windowStart: number,
    windowSeconds: number,
    cost: number,
  ) {
    const [r] = await this.sql<Row[]>`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, window_seconds, count)
      VALUES (${key}, ${iso(windowStart)}, ${windowSeconds}, ${cost})
      ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_limit_buckets.count + EXCLUDED.count
      RETURNING count`;
    return Number(r.count);
  }
  async acquireSlot(
    clientId: string,
    requestId: string,
    cap: number,
    ttlMs: number,
  ) {
    return this.tx(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(hashtext(${`slot:${clientId}`}))`;
      await sql`DELETE FROM api_concurrency_slots WHERE client_id = ${clientId} AND expires_at < now()`;
      const [r] = await sql<
        Row[]
      >`SELECT count(*)::int AS n FROM api_concurrency_slots WHERE client_id = ${clientId}`;
      if (Number(r.n) >= cap) return false;
      await sql`
        INSERT INTO api_concurrency_slots (request_id, client_id, expires_at)
        VALUES (${requestId}, ${clientId}, now() + ${ttlMs} * interval '1 millisecond')`;
      return true;
    });
  }
  async releaseSlot(requestId: string) {
    await this
      .sql`DELETE FROM api_concurrency_slots WHERE request_id = ${requestId}`;
  }
  async verifyIndex(chainId: string): Promise<IndexVerification> {
    const cp = await this.getCheckpoint(chainId);
    const windows = (
      await this.sql<
        Row[]
      >`SELECT from_block, to_block FROM indexed_block_windows WHERE chain_id = ${chainId} ORDER BY from_block`
    ).map((r) => ({ from: big(r.from_block), to: big(r.to_block) }));
    const missing: { from: string; to: string }[] = [];
    let expected = cp?.indexedFromBlock ?? windows[0]?.from ?? 0n;
    for (const w of windows) {
      if (w.from > expected)
        missing.push({
          from: expected.toString(),
          to: (w.from - 1n).toString(),
        });
      if (w.from < expected)
        missing.push({ from: w.from.toString(), to: "OVERLAP" });
      expected = w.to + 1n;
    }
    const [dup] = await this.sql<Row[]>`
      SELECT (count(*) - count(DISTINCT (tx_hash, log_index)))::int AS n, count(*)::int AS total
      FROM erc20_transfers WHERE chain_id = ${chainId}`;
    const [orphans] = await this.sql<Row[]>`
      SELECT count(*)::int AS n FROM erc20_transfers t WHERE t.chain_id = ${chainId} AND NOT EXISTS (
        SELECT 1 FROM indexed_block_windows w WHERE w.chain_id = t.chain_id
          AND t.block_number BETWEEN w.from_block AND w.to_block)`;
    const [logs] = await this.sql<Row[]>`
      SELECT COALESCE(sum(log_count), 0)::bigint AS n FROM indexed_block_windows WHERE chain_id = ${chainId}`;
    const lastTo = windows.length
      ? windows[windows.length - 1].to
      : cp
        ? cp.indexedFromBlock - 1n
        : null;
    // V1.5: one block hash per block, transfers in a window's last block on that window's hash.
    const [hashes] = await this.sql<Row[]>`
      SELECT (SELECT count(*) FROM (SELECT block_number FROM erc20_transfers WHERE chain_id = ${chainId}
                GROUP BY block_number HAVING count(DISTINCT block_hash) > 1) x)::int
           + (SELECT count(*) FROM erc20_transfers t JOIN indexed_block_windows w
                ON w.chain_id = t.chain_id AND t.block_number = w.to_block
              WHERE t.chain_id = ${chainId} AND t.block_hash <> w.to_block_hash)::int AS n`;
    // A committed window must have its own committed witness record with the same digest.
    const [disputed] = await this.sql<Row[]>`
      SELECT count(*)::int AS n FROM indexed_block_windows w
      WHERE w.chain_id = ${chainId} AND w.witness_consensus IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM indexed_window_witnesses x WHERE x.chain_id = w.chain_id AND x.from_block = w.from_block
          AND x.to_block = w.to_block AND x.committed AND x.consensus = w.witness_consensus
          AND (CASE WHEN x.consensus = 'TIEBREAK_MATCH_WITNESS' THEN x.witness_digest ELSE x.primary_digest END) = w.log_digest
          AND x.primary_block_end_hash = w.to_block_hash)`;
    const invalid: string[] = [];
    if (cp?.historicalComplete && cp.indexedFromBlock > 0n)
      invalid.push("HISTORICAL_COMPLETE_WITHOUT_GENESIS");
    const [leases] = await this.sql<Row[]>`
      SELECT count(*)::int AS n FROM indexer_leases WHERE chain_id = ${chainId}
        AND expires_at > now() + interval '10 minutes'`;
    if (Number(leases.n) > 0) invalid.push("LEASE_TTL_IMPOSSIBLE");
    const [tok] = await this.sql<Row[]>`
      SELECT count(*)::int AS n FROM tokens WHERE chain_id = ${chainId} AND metadata_status = 'OK'
        AND (decimals IS NULL OR symbol IS NULL)`;
    if (Number(tok.n) > 0) invalid.push(`TOKEN_METADATA_STATUS:${tok.n}`);
    return {
      chainId,
      coverageFrom: cp?.indexedFromBlock.toString() ?? null,
      coverageThrough: cp?.indexedThroughBlock.toString() ?? null,
      missingRanges: missing,
      duplicateLogKeys: Number(dup.n),
      orphanRecords:
        Number(orphans.n) + (big(logs.n) !== big(dup.total) ? 1 : 0),
      checkpointMismatch:
        !!cp && lastTo !== null && lastTo !== cp.indexedThroughBlock,
      transfers: Number(dup.total),
      windows: windows.length,
      blockHashInconsistencies: Number(hashes.n),
      disputedCommittedWindows: Number(disputed.n),
      invalidCheckpointState: invalid,
      witness: await this.witnessSummary(chainId),
    };
  }
  async recordWitness(w: LogWindowWitness) {
    if (w.committed) throw Error("WITNESS_COMMITTED_ONLY_WITH_WINDOW");
    await this.insertWitness(this.sql, w);
  }
  private witness(r: Row): LogWindowWitness {
    const str = (v: unknown) =>
      v === null || v === undefined ? null : String(v);
    const num = (v: unknown) =>
      v === null || v === undefined ? null : Number(v);
    return {
      chainId: String(r.chain_id),
      fromBlock: big(r.from_block),
      toBlock: big(r.to_block),
      mode: r.mode as LogWindowWitness["mode"],
      primaryEndpointId: String(r.primary_endpoint_id),
      witnessEndpointId: str(r.witness_endpoint_id),
      tiebreakEndpointId: str(r.tiebreak_endpoint_id),
      primaryOperator: str(r.primary_operator),
      witnessOperator: str(r.witness_operator),
      tiebreakOperator: str(r.tiebreak_operator),
      primaryBlockStartHash: String(r.primary_block_start_hash),
      primaryBlockEndHash: String(r.primary_block_end_hash),
      witnessBlockStartHash: str(r.witness_block_start_hash),
      witnessBlockEndHash: str(r.witness_block_end_hash),
      primaryLogCount: Number(r.primary_log_count),
      witnessLogCount: num(r.witness_log_count),
      tiebreakLogCount: num(r.tiebreak_log_count),
      primaryDigest: String(r.primary_digest),
      witnessDigest: str(r.witness_digest),
      tiebreakDigest: str(r.tiebreak_digest),
      consensus: r.consensus as LogWindowWitness["consensus"],
      failure: (r.failure as LogWindowWitness["failure"]) ?? null,
      committed: Boolean(r.committed),
      observedAt: ms(r.observed_at) ?? 0,
    };
  }
  async listWitnessRecords(chainId: string, limit: number) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM indexed_window_witnesses WHERE chain_id = ${chainId} ORDER BY id DESC LIMIT ${Math.min(Math.max(1, limit), 5000)}`;
    return rows.map((r) => this.witness(r));
  }
  async witnessSummary(chainId: string): Promise<WitnessSummary> {
    const [w] = await this.sql<Row[]>`
      SELECT count(*)::int AS windows,
        count(*) FILTER (WHERE witness_consensus = ANY(${TRUSTED}))::int AS trusted,
        count(*) FILTER (WHERE witness_consensus = 'NO_INDEPENDENT_WITNESS')::int AS development,
        count(*) FILTER (WHERE witness_consensus IS NULL)::int AS unwitnessed,
        min(from_block) FILTER (WHERE witness_consensus = ANY(${TRUSTED})) AS first_trusted
      FROM indexed_block_windows WHERE chain_id = ${chainId}`;
    const by = await this.sql<Row[]>`
      SELECT consensus, count(*)::int AS n FROM indexed_window_witnesses WHERE chain_id = ${chainId} GROUP BY consensus`;
    const [last] = await this.sql<Row[]>`
      SELECT consensus, observed_at FROM indexed_window_witnesses WHERE chain_id = ${chainId} ORDER BY id DESC LIMIT 1`;
    return {
      chainId,
      windows: Number(w.windows),
      trustedWindows: Number(w.trusted),
      developmentWindows: Number(w.development),
      unwitnessedWindows: Number(w.unwitnessed),
      recordsByConsensus: Object.fromEntries(
        by.map((r) => [String(r.consensus), Number(r.n)]),
      ),
      lastConsensus: last ? String(last.consensus) : null,
      lastObservedAt: last ? ms(last.observed_at) : null,
      firstTrustedFrom:
        w.first_trusted === null ? null : String(w.first_trusted),
    };
  }
  async haltChain(chainId: string, reason: string) {
    if (!/^[A-Z0-9_:.-]{1,120}$/.test(reason))
      throw Error("HALT_REASON_INVALID");
    await this.sql`
      UPDATE indexer_checkpoints SET halted_reason = ${reason}, halted_at = now(), last_error = ${reason.slice(0, 80)}
      WHERE chain_id = ${chainId}`;
  }
  async resumeChain(chainId: string) {
    const r = await this.sql`
      UPDATE indexer_checkpoints SET halted_reason = NULL, halted_at = NULL, last_error = NULL
      WHERE chain_id = ${chainId} AND halted_reason IS NOT NULL`;
    return r.count > 0;
  }
  async acquireBackfillLease(chainId: string, owner: string, ttlMs: number) {
    const rows = await this.sql<Row[]>`
      INSERT INTO indexer_backfill_leases (chain_id, owner_id, acquired_at, expires_at)
      VALUES (${chainId}, ${owner}, now(), now() + ${ttlMs} * interval '1 millisecond')
      ON CONFLICT (chain_id) DO UPDATE SET owner_id = EXCLUDED.owner_id,
        acquired_at = CASE WHEN indexer_backfill_leases.owner_id = EXCLUDED.owner_id
          THEN indexer_backfill_leases.acquired_at ELSE now() END, expires_at = EXCLUDED.expires_at
      WHERE indexer_backfill_leases.expires_at < now() OR indexer_backfill_leases.owner_id = EXCLUDED.owner_id
      RETURNING owner_id`;
    return rows.length === 1 && rows[0].owner_id === owner;
  }
  async releaseBackfillLease(chainId: string, owner: string) {
    await this
      .sql`UPDATE indexer_backfill_leases SET expires_at = now() WHERE chain_id = ${chainId} AND owner_id = ${owner}`;
  }
  // REVERIFY of a window committed before V1.5: only the exact same window (range + to-block hash),
  // still unwitnessed, is marked; a rewound/replaced window is never marked by old evidence.
  async markWindowWitnessed(
    chainId: string,
    fromBlock: bigint,
    toBlock: bigint,
    record: LogWindowWitness,
  ) {
    if (
      record.mode !== "REVERIFY" ||
      !record.committed ||
      !TRUSTED.includes(record.consensus) ||
      record.chainId !== chainId ||
      record.fromBlock !== fromBlock ||
      record.toBlock !== toBlock
    )
      throw Error("WITNESS_RECORD_MISMATCH");
    return this.tx(async (sql) => {
      const r = await sql`
        UPDATE indexed_block_windows SET witness_consensus = ${record.consensus}, log_digest = ${committedDigest(record)}
        WHERE chain_id = ${chainId} AND from_block = ${fromBlock.toString()} AND to_block = ${toBlock.toString()}
          AND to_block_hash = ${record.primaryBlockEndHash.toLowerCase()}
          AND (witness_consensus IS NULL OR witness_consensus = 'NO_INDEPENDENT_WITNESS')`;
      if (r.count !== 1) return false;
      await this.insertWitness(sql, record);
      return true;
    });
  }
  async windowRows(chainId: string, fromBlock: bigint, toBlock: bigint) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM erc20_transfers WHERE chain_id = ${chainId}
        AND block_number BETWEEN ${fromBlock.toString()} AND ${toBlock.toString()}
      ORDER BY block_number, log_index`;
    return rows.map((r): TransferRow => ({
      chainId: String(r.chain_id),
      blockNumber: big(r.block_number),
      blockHash: String(r.block_hash),
      txHash: String(r.tx_hash),
      logIndex: Number(r.log_index),
      token: String(r.token),
      from: String(r.from_address),
      to: String(r.to_address),
      value: big(r.value),
    }));
  }
  async recordBackupEvent(e: BackupEvent) {
    await this.sql`
      INSERT INTO ops_backup_events (kind, ok, at, backup_id, sha256, size_bytes, duration_ms, detail)
      VALUES (${e.kind}, ${e.ok}, ${iso(e.at)}, ${e.backupId}, ${e.sha256}, ${e.sizeBytes},
        ${e.durationMs}, ${e.detail})`;
  }
  // Runnable by the api role: expired rate-limit windows and concurrency slots only.
  async purgeLimiterState(now: number) {
    const a = await this
      .sql`DELETE FROM rate_limit_buckets WHERE window_start < ${iso(now - 2 * 86400000)}`;
    const b = await this
      .sql`DELETE FROM api_concurrency_slots WHERE expires_at < ${iso(now)}`;
    return a.count + b.count;
  }
  async purgeExpired(now: number) {
    const out: Record<string, number> = {};
    out.rateLimitBuckets = (
      await this
        .sql`DELETE FROM rate_limit_buckets WHERE window_start < ${iso(now - 2 * 86400000)}`
    ).count;
    out.concurrencySlots = (
      await this
        .sql`DELETE FROM api_concurrency_slots WHERE expires_at < ${iso(now)}`
    ).count;
    out.nativeSnapshots = (
      await this
        .sql`DELETE FROM native_balance_snapshots WHERE observed_at < ${iso(now - 86400000)}`
    ).count;
    out.tokenSnapshots = (
      await this
        .sql`DELETE FROM wallet_balance_snapshots WHERE observed_at < ${iso(now - 86400000)}`
    ).count;
    out.scanRuns = (
      await this
        .sql`DELETE FROM portfolio_scan_runs WHERE started_at < ${iso(now - 7 * 86400000)}`
    ).count;
    out.usageEvents = (
      await this
        .sql`DELETE FROM api_usage_events WHERE at < ${iso(now - 30 * 86400000)}`
    ).count;
    out.usageDaily = (
      await this
        .sql`DELETE FROM api_usage_daily WHERE day < ${new Date(now - 400 * 86400000).toISOString().slice(0, 10)}`
    ).count;
    return out;
  }
}
