import type { Sql } from "postgres";
import type { CatalogIndex } from "./store";
import type { QueueEntry } from "./queue";
import type { ContractIndexEntry } from "../reverse-index";
// Forward-only load of an accepted catalog into the self-hosted database. Identity rows are upserted (first_seen is
// preserved, nothing is deleted: removed protocols stay as REMOVED_UPSTREAM). Coverage and queue rows are keyed by the
// sync id, so every accepted catalog version remains queryable.
const chunk = <T>(rows: T[], n = 500) =>
  Array.from({ length: Math.ceil(rows.length / n) }, (_, i) =>
    rows.slice(i * n, i * n + n),
  );
export interface LoadSource {
  id: string;
  url: string;
  revision: string | null;
  sha256: string | null;
  bytes: number | null;
  license: string;
  use: string;
}
export async function loadUniverseIntoDb(
  sql: Sql,
  index: CatalogIndex,
  receipt: unknown,
  queue: QueueEntry[],
  contracts: ContractIndexEntry[],
  sources: LoadSource[],
) {
  const u = index.universe;
  return sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext('otherbridge-defi-universe-load'))`;
    const [done] =
      await tx`SELECT sync_id FROM defi_universe_syncs WHERE sync_id=${u.syncId}`;
    if (done) return { state: "ALREADY_LOADED" as const, syncId: u.syncId };
    await tx`INSERT INTO defi_universe_syncs(sync_id,generated_at,catalog_sha256,stats,receipt) VALUES(${u.syncId},${new Date(u.generatedAt)},${index.sha256},${tx.json(JSON.parse(JSON.stringify(u.stats)))},${tx.json(JSON.parse(JSON.stringify(receipt ?? {})))})`;
    for (const s of sources)
      await tx`INSERT INTO defi_source_revisions VALUES(${u.syncId},${s.id},${s.url},${s.revision},${s.sha256},${s.bytes},${s.license},${s.use})`;
    for (const rows of chunk([...index.chains.values()])) {
      const values = rows.map((c) => ({
        chain_key: c.key,
        name: c.name,
        vm: c.vm,
        chain_id: c.chainId,
        status: c.status,
        mapping_status: c.mapping.status,
        mapping_reason: c.mapping.reason,
        first_seen: c.firstSeen,
        last_seen: c.lastSeen,
        payload: JSON.parse(JSON.stringify(c)),
      }));
      await tx`INSERT INTO defi_catalog_chains ${tx(values)} ON CONFLICT(chain_key) DO UPDATE SET name=excluded.name,vm=excluded.vm,chain_id=excluded.chain_id,status=excluded.status,mapping_status=excluded.mapping_status,mapping_reason=excluded.mapping_reason,last_seen=excluded.last_seen,payload=excluded.payload`;
    }
    const aliases = [...index.chains.values()].flatMap((c) =>
      [c.name, ...c.aliases].map((alias) => ({
        alias,
        chain_key: c.key,
        last_seen: c.lastSeen,
      })),
    );
    const uniqueAliases = [
      ...new Map(aliases.map((a) => [a.alias, a])).values(),
    ];
    for (const rows of chunk(uniqueAliases))
      await tx`INSERT INTO defi_catalog_chain_aliases ${tx(rows)} ON CONFLICT(alias) DO UPDATE SET chain_key=excluded.chain_key,last_seen=excluded.last_seen`;
    for (const rows of chunk(u.protocols)) {
      const values = rows.map((p) => ({
        protocol_id: p.id,
        llama_id: p.llamaId,
        slug: p.slug,
        name: p.name,
        category: p.category,
        product_category: p.productCategory,
        status: p.status,
        mapping_status: p.mapping.status,
        mapping_reason: p.mapping.reason,
        tvl_usd: p.tvlUsd,
        first_seen: p.firstSeen,
        last_seen: p.lastSeen,
        payload: JSON.parse(JSON.stringify(p)),
      }));
      await tx`INSERT INTO defi_catalog_protocols ${tx(values)} ON CONFLICT(protocol_id) DO UPDATE SET llama_id=excluded.llama_id,slug=excluded.slug,name=excluded.name,category=excluded.category,product_category=excluded.product_category,status=excluded.status,mapping_status=excluded.mapping_status,mapping_reason=excluded.mapping_reason,tvl_usd=excluded.tvl_usd,last_seen=excluded.last_seen,payload=excluded.payload`;
    }
    for (const rows of chunk(u.rows)) {
      const values = rows.map((r) => ({
        protocol_id: r.protocolId,
        chain_key: r.chainKey,
        raw_chain: r.rawChain,
        tvl_usd: r.tvlUsd,
        borrowed_usd: r.borrowedUsd,
        last_seen: u.syncId,
      }));
      await tx`INSERT INTO defi_catalog_protocol_chains ${tx(values)} ON CONFLICT(protocol_id,chain_key) DO UPDATE SET raw_chain=excluded.raw_chain,tvl_usd=excluded.tvl_usd,borrowed_usd=excluded.borrowed_usd,last_seen=excluded.last_seen`;
    }
    const coverage = [
      ...new Map(
        index.coverage.map((c) => [
          `${c.protocolId}|${c.chainKey}|${c.product}`,
          c,
        ]),
      ).values(),
    ];
    for (const rows of chunk(coverage)) {
      const values = rows.map((c) => ({
        sync_id: u.syncId,
        protocol_id: c.protocolId,
        chain_key: c.chainKey,
        product: c.product,
        version: c.version,
        adapter_version: c.adapterVersion,
        status: c.status,
        reason: c.reason,
        deployments: c.deployments,
      }));
      await tx`INSERT INTO defi_coverage ${tx(values)}`;
    }
    for (const rows of chunk(queue)) {
      const values = rows.map((q) => ({
        sync_id: u.syncId,
        protocol_id: q.protocolId,
        priority: q.priority.toFixed(3),
        tier: q.tier,
        payload: JSON.parse(JSON.stringify(q)),
      }));
      await tx`INSERT INTO defi_adapter_queue ${tx(values)}`;
    }
    for (const rows of chunk(contracts)) {
      const values = rows.map((c) => ({
        chain_id: c.chainId,
        contract: c.contract,
        deployment_id: c.deploymentId,
        protocol_id: c.protocolId,
        product: c.product,
        version: c.version,
        role: c.role,
        source: c.source,
      }));
      await tx`INSERT INTO defi_contract_index ${tx(values)} ON CONFLICT(chain_id,contract,deployment_id,role) DO UPDATE SET protocol_id=excluded.protocol_id,product=excluded.product,version=excluded.version,source=excluded.source`;
    }
    return {
      state: "LOADED" as const,
      syncId: u.syncId,
      chains: index.chains.size,
      protocols: u.protocols.length,
      protocolChains: u.rows.length,
      coverage: coverage.length,
      queue: queue.length,
      contracts: contracts.length,
    };
  });
}
