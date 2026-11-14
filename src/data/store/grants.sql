-- Idempotent least-privilege grants, re-applied after every migration run (not a migration).
-- Roles are created by `pnpm data:db:migrate` from local secrets or by the production operator.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otherbridge_indexer') THEN
    -- Indexer reads only data-plane tables (never API key verifiers or usage).
    REVOKE ALL ON api_clients, api_keys, api_usage_events, api_usage_daily, rate_limit_buckets, api_concurrency_slots,
      portfolio_scan_runs, portfolio_scan_coverage, native_balance_snapshots, wallet_balance_snapshots FROM otherbridge_indexer;
    GRANT SELECT ON chains, rpc_endpoints, rpc_health, indexer_leases, indexer_checkpoints, indexed_block_windows,
      erc20_transfers, wallet_token_discovery, tokens, schema_migrations TO otherbridge_indexer;
    GRANT INSERT, UPDATE ON chains, rpc_endpoints, rpc_health, indexer_checkpoints, tokens TO otherbridge_indexer;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO otherbridge_indexer;
    GRANT INSERT, UPDATE, DELETE ON indexer_leases, indexed_block_windows, erc20_transfers, wallet_token_discovery TO otherbridge_indexer;
    -- V1.5: witness evidence is append-only for the indexer; backfill has its own lease table.
    GRANT SELECT, INSERT ON indexed_window_witnesses TO otherbridge_indexer;
    GRANT SELECT, INSERT, UPDATE ON indexer_backfill_leases TO otherbridge_indexer;
    REVOKE ALL ON ops_backup_events FROM otherbridge_indexer;
    -- V1.11: the asset registry sync runs as the indexer role (writes registry rows, never wallet data).
    GRANT SELECT, INSERT, UPDATE ON chain_identities, chain_image_sources, asset_identities, asset_contracts,
      asset_metadata_sources, asset_market_sources, asset_images, asset_risk_flags, asset_route_capabilities,
      asset_registry_sync_runs TO otherbridge_indexer;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otherbridge_api') THEN
    GRANT SELECT ON chains, rpc_endpoints, rpc_health, indexer_checkpoints, indexed_block_windows,
      erc20_transfers, wallet_token_discovery, tokens, api_clients, api_keys, api_usage_daily,
      native_balance_snapshots, wallet_balance_snapshots, rate_limit_buckets, api_concurrency_slots TO otherbridge_api;
    REVOKE INSERT, UPDATE ON rpc_health FROM otherbridge_api;
    GRANT INSERT, UPDATE ON native_balance_snapshots, wallet_balance_snapshots, api_usage_daily, tokens TO otherbridge_api;
    GRANT INSERT ON portfolio_scan_runs, portfolio_scan_coverage, api_usage_events TO otherbridge_api;
    GRANT UPDATE (last_used_at) ON api_keys TO otherbridge_api;
    GRANT INSERT, UPDATE, DELETE ON rate_limit_buckets, api_concurrency_slots TO otherbridge_api;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO otherbridge_api;
    -- V1.5: read-only witness summaries for coverage; no backup/ops visibility.
    GRANT SELECT ON indexed_window_witnesses TO otherbridge_api;
    REVOKE ALL ON ops_backup_events, indexer_backfill_leases FROM otherbridge_api;
    -- V1.11: read-only asset registry for the app/Data API; sync bookkeeping stays invisible.
    GRANT SELECT ON chain_identities, asset_identities, asset_contracts, asset_metadata_sources, asset_market_sources,
      asset_images, asset_risk_flags, asset_route_capabilities TO otherbridge_api;
    REVOKE ALL ON chain_image_sources, asset_registry_sync_runs FROM otherbridge_api;
  END IF;
  -- V1.5 monitoring reader: aggregate, non-secret operational tables only. No API keys/verifiers,
  -- no clients, no usage events, no wallet pseudonym snapshots, no transfers.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otherbridge_monitor') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM otherbridge_monitor;
    GRANT SELECT ON chains, rpc_endpoints, rpc_health, indexer_leases, indexer_backfill_leases, indexer_checkpoints,
      indexed_block_windows, indexed_window_witnesses, ops_backup_events, schema_migrations TO otherbridge_monitor;
    GRANT SELECT (chain_id, metadata_status, suspicious, spam) ON tokens TO otherbridge_monitor;
    -- Scan-run aggregates only: never the wallet pseudonym (wallet_hash) or the API client id.
    GRANT SELECT (origin, state, started_at, finished_at, chains_planned, chains_checked, chains_pending, chains_failed)
      ON portfolio_scan_runs TO otherbridge_monitor;
    -- V1.11: registry sync health only.
    GRANT SELECT (job, started_at, finished_at, status) ON asset_registry_sync_runs TO otherbridge_monitor;
  END IF;
  -- V1.5 backup role: read-everything for pg_dump plus its own event rows; never writes data tables.
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'otherbridge_backup') THEN
    GRANT pg_read_all_data TO otherbridge_backup;
    GRANT INSERT ON ops_backup_events TO otherbridge_backup;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO otherbridge_backup;
  END IF;
END
$$;

-- V1.13: discovery writes belong to the indexer; client financial snapshots belong to the API.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_indexer') THEN
  GRANT SELECT,INSERT,UPDATE,DELETE ON defi_protocols,defi_adapter_versions,defi_protocol_sources,defi_protocol_deployments,defi_position_refs,defi_event_checkpoints,defi_event_windows,erc721_transfers,wallet_nft_positions,defi_position_nft_refs,wallet_protocol_activity TO otherbridge_indexer;
  REVOKE ALL ON defi_scan_runs,defi_scan_coverage,defi_position_snapshots,defi_position_assets,defi_position_rewards,defi_position_risk FROM otherbridge_indexer;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_api') THEN
  GRANT SELECT ON defi_protocols,defi_adapter_versions,defi_protocol_sources,defi_protocol_deployments,defi_position_refs,defi_event_checkpoints,wallet_nft_positions,wallet_protocol_activity TO otherbridge_api;
  GRANT SELECT,INSERT,DELETE ON defi_scan_runs,defi_scan_coverage,defi_position_snapshots,defi_position_assets,defi_position_rewards,defi_position_risk TO otherbridge_api;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_monitor') THEN
  GRANT SELECT (state,started_at,expires_at,rpc_calls) ON defi_scan_runs TO otherbridge_monitor;
  GRANT SELECT ON defi_event_checkpoints TO otherbridge_monitor;
 END IF;
END $$;

-- V1.14: the catalog/coverage/queue/reverse index/lane checkpoints are written by the indexer role (sync loader and
-- backfills) and read by the API; scan receipts belong to the API like the other client scan snapshots.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_indexer') THEN
  GRANT SELECT,INSERT,UPDATE ON defi_universe_syncs,defi_source_revisions,defi_catalog_chains,defi_catalog_chain_aliases,defi_catalog_protocols,defi_catalog_protocol_chains,defi_coverage,defi_adapter_queue,defi_deployment_candidates,defi_contract_index TO otherbridge_indexer;
  GRANT SELECT,INSERT,UPDATE,DELETE ON defi_index_lanes,defi_index_lane_windows,defi_registry_entries TO otherbridge_indexer;
  REVOKE ALL ON defi_scan_receipts FROM otherbridge_indexer;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_api') THEN
  GRANT SELECT ON defi_universe_syncs,defi_source_revisions,defi_catalog_chains,defi_catalog_chain_aliases,defi_catalog_protocols,defi_catalog_protocol_chains,defi_coverage,defi_adapter_queue,defi_deployment_candidates,defi_contract_index,defi_index_lanes,defi_registry_entries TO otherbridge_api;
  GRANT SELECT,INSERT,DELETE ON defi_scan_receipts TO otherbridge_api;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='otherbridge_monitor') THEN
  GRANT SELECT (sync_id,generated_at,loaded_at,stats) ON defi_universe_syncs TO otherbridge_monitor;
  GRANT SELECT ON defi_index_lanes TO otherbridge_monitor;
 END IF;
END $$;
