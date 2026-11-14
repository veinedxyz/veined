import type { Sql } from "postgres";
import { newRegistry, type MetricsRegistry } from "./metrics";
import { securityInvariants } from "../../security/invariants";
import { provenanceForUrl } from "../registry/rpc-provenance";
// V1.5 DB-derived operational metrics (read by the least-privilege monitor role). Cross-process
// truth for indexer, witness, RPC health, portfolio scans, tokens and backups, plus frozen security
// invariants. Labels are chain IDs, endpoint IDs, fixed enums and bounded error codes only.
type Row = Record<string, unknown>;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
// Most specific bounded code: "INVALID_RESPONSE:FINALIZED_CONFLICT" -> FINALIZED_CONFLICT,
// "LOG_CONSENSUS_UNRESOLVED:78-102" -> LOG_CONSENSUS_UNRESOLVED. Free text never becomes a label.
const code = (v: unknown) => {
  if (typeof v !== "string" || !v) return "NONE";
  const parts = v.split(":").filter((p) => /^[A-Z][A-Z0-9_]{2,47}$/.test(p));
  return parts.length ? parts[parts.length - 1] : "OTHER";
};
export async function collectOpsMetrics(
  sql: Sql | null,
  options: { now?: () => number; registry?: MetricsRegistry } = {},
) {
  const r = options.registry ?? newRegistry(2000);
  const now = options.now ?? Date.now;
  const started = now();
  const inv = securityInvariants();
  for (const [k, v] of Object.entries(inv))
    r.set(
      `security_${k}`,
      {},
      v,
      `Frozen security invariant ${k} (expected execution_gate_open=0, fee_collection_enabled=0, write_registry_entries=0, global_kill_enabled=1, contract_registry_drift=0).`,
    );
  let up = 0;
  if (sql)
    try {
      await sql`SELECT 1`;
      up = 1;
    } catch {
      up = 0;
    }
  r.set("db_up", {}, up, "PostgreSQL reachable by the monitor role.");
  if (!sql || !up) {
    r.set("ops_exporter_scrape_duration_seconds", {}, (now() - started) / 1000);
    return r.render();
  }
  try {
    const [v] = await sql<
      Row[]
    >`SELECT max(version) AS v FROM schema_migrations`;
    r.set("schema_version", {}, n(v?.v), "Applied migration version.");
    for (const c of await sql<Row[]>`
      SELECT chain_id, indexed_from_block, indexed_through_block, head_block, safe_block,
        historical_complete, last_error, halted_reason, extract(epoch from (now() - updated_at)) AS age
      FROM indexer_checkpoints`) {
      const chain = String(c.chain_id);
      const lag =
        c.head_block === null
          ? 0
          : n(c.head_block) - n(c.indexed_through_block);
      r.set(
        "indexer_indexed_head_block",
        { chain },
        n(c.indexed_through_block),
        "Last committed indexed block.",
      );
      r.set(
        "indexer_chain_head_block",
        { chain },
        n(c.head_block),
        "Chain head observed by the indexer at its last commit.",
      );
      r.set(
        "indexer_lag_blocks",
        { chain },
        Math.max(0, lag),
        "Head minus indexed-through at the last commit.",
      );
      r.set(
        "indexer_historical_from_block",
        { chain },
        n(c.indexed_from_block),
        "Oldest indexed block (backfill lane).",
      );
      r.set(
        "indexer_historical_complete",
        { chain },
        c.historical_complete ? 1 : 0,
      );
      r.set(
        "indexer_checkpoint_age_seconds",
        { chain },
        n(c.age),
        "Seconds since the checkpoint last changed.",
      );
      r.set(
        "indexer_halted",
        { chain },
        c.halted_reason ? 1 : 0,
        "1 = trusted advancement paused (consensus/integrity) until operator resume.",
      );
      r.set(
        "indexer_last_error",
        { chain, code: code(c.last_error) },
        c.last_error ? 1 : 0,
        "Bounded last error code of the chain checkpoint.",
      );
    }
    for (const w of await sql<Row[]>`
      SELECT chain_id, COALESCE(witness_consensus, 'UNWITNESSED') AS consensus, count(*)::int AS n
      FROM indexed_block_windows GROUP BY 1, 2`)
      r.set(
        "indexer_windows",
        { chain: String(w.chain_id), consensus: String(w.consensus) },
        n(w.n),
        "Committed windows by witness consensus (UNWITNESSED = pre-V1.5).",
      );
    for (const w of await sql<Row[]>`
      SELECT chain_id, consensus, COALESCE(failure, 'NONE') AS failure, count(*)::int AS total,
        count(*) FILTER (WHERE observed_at > now() - interval '1 hour')::int AS recent
      FROM indexed_window_witnesses GROUP BY 1, 2, 3`) {
      const labels = {
        chain: String(w.chain_id),
        consensus: String(w.consensus),
        failure: String(w.failure),
      };
      r.set(
        "witness_records",
        labels,
        n(w.total),
        "All witness evidence rows.",
      );
      r.set(
        "witness_records_recent",
        labels,
        n(w.recent),
        "Witness evidence rows in the last hour.",
      );
    }
    for (const l of await sql<Row[]>`
      SELECT chain_id, 'live' AS lane, (expires_at > now())::int AS active,
        extract(epoch from (now() - acquired_at)) AS held FROM indexer_leases
      UNION ALL SELECT chain_id, 'backfill', (expires_at > now())::int,
        extract(epoch from (now() - acquired_at)) FROM indexer_backfill_leases`) {
      r.set(
        "indexer_lease_active",
        { chain: String(l.chain_id), lane: String(l.lane) },
        n(l.active),
      );
      r.set(
        "indexer_lease_held_seconds",
        { chain: String(l.chain_id), lane: String(l.lane) },
        n(l.active) ? n(l.held) : 0,
      );
    }
    const endpoints = await sql<Row[]>`
      SELECT e.id, e.chain_id, e.url, e.status, e.reason, e.supports_logs, h.latency_ms, h.error_rate,
        h.consecutive_failures, h.quarantine_reason,
        (h.quarantined_until IS NOT NULL AND h.quarantined_until > now()) AS quarantined
      FROM rpc_endpoints e LEFT JOIN rpc_health h ON h.endpoint_id = e.id`;
    const perChain = new Map<
      string,
      { healthy: number; logs: number; operators: Set<string> }
    >();
    const rejected = new Map<string, number>();
    for (const e of endpoints) {
      const chain = String(e.chain_id);
      if (e.status !== "APPROVED") {
        const reason = code(e.reason);
        rejected.set(reason, (rejected.get(reason) ?? 0) + 1);
        continue;
      }
      const healthy = !e.quarantined && n(e.consecutive_failures) < 3;
      const s = perChain.get(chain) ?? {
        healthy: 0,
        logs: 0,
        operators: new Set<string>(),
      };
      if (healthy) {
        s.healthy++;
        if (e.supports_logs) {
          s.logs++;
          const p = provenanceForUrl(String(e.url));
          if (p.witnessEligible && p.operatorGroup)
            s.operators.add(p.operatorGroup);
        }
      }
      perChain.set(chain, s);
      const endpoint = String(e.id);
      if (e.latency_ms !== null)
        r.set(
          "rpc_endpoint_latency_ms",
          { chain, endpoint },
          n(e.latency_ms),
          "EWMA latency per admitted endpoint.",
        );
      r.set(
        "rpc_endpoint_error_rate",
        { chain, endpoint },
        n(e.error_rate),
        "EWMA error rate per admitted endpoint.",
      );
      r.set(
        "rpc_endpoint_quarantined",
        {
          chain,
          endpoint,
          reason: e.quarantined ? code(e.quarantine_reason) : "NONE",
        },
        e.quarantined ? 1 : 0,
      );
    }
    for (const [chain, s] of perChain) {
      r.set(
        "rpc_healthy_endpoints",
        { chain },
        s.healthy,
        "Approved endpoints not quarantined and below the failure threshold.",
      );
      r.set("rpc_healthy_log_endpoints", { chain }, s.logs);
      r.set(
        "rpc_witness_operators",
        { chain },
        s.operators.size,
        "Distinct healthy witness-eligible log operators (independence).",
      );
    }
    for (const [reason, count] of rejected)
      r.set(
        "rpc_admission_rejected",
        { reason },
        count,
        "Admission rejections by safe reason code (SSRF/DNS/URL policy included).",
      );
    const [q] = await sql<Row[]>`
      SELECT count(*) FILTER (WHERE quarantine_reason = 'CHAIN_MISMATCH' AND quarantined_until > now())::int AS chain_mismatch,
        count(*) FILTER (WHERE quarantine_reason = 'LOG_SET_MISMATCH' AND quarantined_until > now())::int AS log_mismatch
      FROM rpc_health`;
    r.set("rpc_chain_id_mismatch_quarantines", {}, n(q.chain_mismatch));
    r.set("rpc_log_mismatch_quarantines", {}, n(q.log_mismatch));
    for (const t of await sql<Row[]>`
      SELECT metadata_status, count(*)::int AS n, count(*) FILTER (WHERE suspicious)::int AS suspicious,
        count(*) FILTER (WHERE spam)::int AS spam FROM tokens GROUP BY 1`) {
      r.set("tokens", { metadata: String(t.metadata_status) }, n(t.n));
      r.set(
        "tokens_suspicious",
        { metadata: String(t.metadata_status) },
        n(t.suspicious),
        "Tokens flagged suspicious (impersonation/sanitizer).",
      );
      r.set("tokens_spam", { metadata: String(t.metadata_status) }, n(t.spam));
    }
    for (const s of await sql<Row[]>`
      SELECT origin, state, count(*)::int AS n,
        COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch from (finished_at - started_at))), 0) AS p95,
        COALESCE(sum(chains_checked), 0)::int AS checked, COALESCE(sum(chains_failed), 0)::int AS failed,
        COALESCE(sum(chains_pending), 0)::int AS pending
      FROM portfolio_scan_runs WHERE started_at > now() - interval '1 hour' GROUP BY 1, 2`) {
      const labels = {
        origin: String(s.origin),
        state: String(s.state)
          .replace(/[^A-Z_]/g, "")
          .slice(0, 20),
      };
      r.set(
        "portfolio_scans_recent",
        labels,
        n(s.n),
        "Portfolio scans in the last hour (no wallet labels).",
      );
      r.set("portfolio_scan_duration_p95_seconds", labels, n(s.p95));
      r.set("portfolio_chains_checked_recent", labels, n(s.checked));
      r.set("portfolio_chains_failed_recent", labels, n(s.failed));
      r.set("portfolio_chains_pending_recent", labels, n(s.pending));
    }
    for (const b of await sql<Row[]>`
      SELECT kind, ok, extract(epoch from max(at)) AS at, count(*)::int AS n FROM ops_backup_events GROUP BY 1, 2`) {
      const kind = String(b.kind);
      r.set(
        b.ok
          ? "backup_last_success_timestamp_seconds"
          : "backup_last_failure_timestamp_seconds",
        { kind },
        n(b.at),
        "Unix time of the last backup/verify/restore-drill outcome.",
      );
      r.set("backup_events", { kind, ok: b.ok ? "true" : "false" }, n(b.n));
    }
  } catch {
    r.inc(
      "ops_exporter_errors_total",
      {},
      1,
      "Collector query failures (partial scrape).",
    );
  }
  r.set("ops_exporter_scrape_duration_seconds", {}, (now() - started) / 1000);
  return r.render();
}
