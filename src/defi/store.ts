import type { Sql } from "postgres";
import { walletPseudonym } from "../data/core/privacy";
import type { DefiScan, PositionRef } from "./model";
import { deployments, protocolUrls } from "./registry";
export interface DiscoveryStore {
  refs(
    deploymentId: string,
    wallet: string,
    limit: number,
  ): Promise<{ refs: PositionRef[]; complete: boolean }>;
  record(
    scan: DefiScan,
    clientScope: string,
    retentionMs: number,
  ): Promise<void>;
}
export class PostgresDefiStore implements DiscoveryStore {
  constructor(readonly sql: Sql) {}
  async syncRegistry() {
    for (const d of deployments) {
      await this
        .sql`INSERT INTO defi_protocols(id,name,official_url) VALUES(${d.protocolId},${d.name},${protocolUrls[d.protocolId]}) ON CONFLICT(id) DO UPDATE SET name=excluded.name,official_url=excluded.official_url`;
      await this
        .sql`INSERT INTO defi_adapter_versions(adapter,version) VALUES(${d.adapter},'1.0.0') ON CONFLICT DO NOTHING`;
      await this
        .sql`INSERT INTO defi_protocol_deployments(id,protocol_id,chain_id,adapter,version,contracts,official_source,revision,environment,status) VALUES(${d.id},${d.protocolId},${d.chainId},${d.adapter},'1.0.0',${this.sql.json(d.contracts)},${d.source},${d.revision},'mainnet',${d.status}) ON CONFLICT(id) DO UPDATE SET contracts=excluded.contracts,official_source=excluded.official_source,revision=excluded.revision`;
    }
  }
  async refs(deploymentId: string, wallet: string, limit: number) {
    const deployment = deployments.find((d) => d.id === deploymentId);
    // V1.14: a historically complete registry lane (all markets / all vaults since the official deployment block)
    // turns discovery into a bounded, complete candidate set; the adapter prefilters it with batched exact reads.
    const lane =
      deployment?.adapter === "morpho-blue"
        ? "markets"
        : deployment?.adapter === "morpho-vault"
          ? "vaults"
          : null;
    if (lane) {
      const [state] = await this
        .sql`SELECT historical_complete FROM defi_index_lanes WHERE deployment_id=${deploymentId} AND lane=${lane}`;
      if (state?.historical_complete === true) {
        const entries = await this
          .sql`SELECT entry_key FROM defi_registry_entries WHERE deployment_id=${deploymentId} AND lane=${lane} ORDER BY source_block,log_index LIMIT ${limit + 1}`;
        if (entries.length <= limit)
          return {
            refs: entries.map((e) =>
              lane === "markets"
                ? {
                    key: String(e.entry_key),
                    marketId: String(e.entry_key),
                    discovery: "registry" as const,
                  }
                : {
                    key: String(e.entry_key),
                    contract: String(e.entry_key),
                    discovery: "registry" as const,
                  },
            ),
            complete: true,
          };
      }
    }
    const chain = deployment?.chainId ?? "";
    const cp = await this
      .sql`SELECT historical_complete FROM defi_event_checkpoints WHERE deployment_id=${deploymentId}`;
    const rows = await this
      .sql`SELECT r.*,max(t.last_block) AS token_block FROM defi_position_refs r LEFT JOIN wallet_protocol_activity a ON a.deployment_id=r.deployment_id AND a.position_key=r.position_key AND a.wallet_address=${wallet} LEFT JOIN wallet_token_discovery t ON t.chain_id=${chain} AND t.wallet=${wallet} AND t.token=r.contract WHERE r.deployment_id=${deploymentId} GROUP BY r.deployment_id,r.position_key ORDER BY max(t.last_block) DESC NULLS LAST,max(a.source_block) DESC NULLS LAST,r.position_key LIMIT ${limit + 1}`;
    return {
      refs: rows.slice(0, limit).map((r) => ({
        key: String(r.position_key),
        ...(r.contract ? { contract: String(r.contract) } : {}),
        ...(r.market_id ? { marketId: String(r.market_id) } : {}),
        discovery: r.token_block
          ? ("token-triggered" as const)
          : ("event-index" as const),
      })),
      complete: cp[0]?.historical_complete === true && rows.length <= limit,
    };
  }
  async record(scan: DefiScan, scope: string, retentionMs: number) {
    if (retentionMs === 0) return;
    if (
      !Number.isInteger(retentionMs) ||
      retentionMs < 1000 ||
      retentionMs > 86400000
    )
      throw Error("RETENTION_INVALID");
    await this.sql.begin(async (tx) => {
      await tx`DELETE FROM defi_scan_runs WHERE expires_at < now()`;
      await tx`INSERT INTO defi_scan_runs(id,client_scope,wallet_hash,started_at,expires_at,state,rpc_calls) VALUES(${scan.scanId},${walletPseudonym(scope)},${walletPseudonym(scan.wallet)},${new Date(scan.observedAt)},${new Date(scan.observedAt + retentionMs)},${scan.continuation.length || scan.coverage.some((c) => c.state !== "FULL_POSITION") ? "PARTIAL" : "COMPLETE"},${scan.coverage.reduce((a, c) => a + c.calls, 0)}) ON CONFLICT(id) DO NOTHING`;
      for (const c of scan.coverage)
        await tx`INSERT INTO defi_scan_coverage VALUES(${scan.scanId},${c.deploymentId},${tx.json(c)}) ON CONFLICT DO NOTHING`;
      for (const p of scan.positions) {
        await tx`INSERT INTO defi_position_snapshots VALUES(${scan.scanId},${p.id},${tx.json(p)}) ON CONFLICT DO NOTHING`;
        let ordinal = 0;
        for (const a of [
          ...p.supplied,
          ...p.collateral,
          ...p.borrowed,
          ...p.underlying,
        ])
          await tx`INSERT INTO defi_position_assets VALUES(${scan.scanId},${p.id},${ordinal++},${a.role},${a.assetId},${a.rawAmount},${tx.json(a)}) ON CONFLICT DO NOTHING`;
        for (let i = 0; i < p.rewards.length; i++)
          await tx`INSERT INTO defi_position_rewards VALUES(${scan.scanId},${p.id},${i},${tx.json(p.rewards[i])}) ON CONFLICT DO NOTHING`;
        await tx`INSERT INTO defi_position_risk VALUES(${scan.scanId},${p.id},${tx.json(p.risk)}) ON CONFLICT DO NOTHING`;
      }
      // V1.14 scan receipt (catalog version, candidate funnel, skipped/failed counts); expires with its scan run.
      if (scan.receipt)
        await tx`INSERT INTO defi_scan_receipts VALUES(${scan.scanId},${scan.receipt.catalogVersion ?? "UNAVAILABLE"},${tx.json(JSON.parse(JSON.stringify(scan.receipt)))}) ON CONFLICT DO NOTHING`;
    });
  }
  async purge() {
    await this.sql`DELETE FROM defi_scan_runs WHERE expires_at < now()`;
  }
}
