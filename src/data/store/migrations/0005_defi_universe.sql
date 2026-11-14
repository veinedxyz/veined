-- V1.14 global DeFi universe. Additive only: catalog breadth (every chain/protocol), coverage truth, adapter queue,
-- reviewed deployment candidates, reverse contract index, lane checkpoints for factory/registry backfills and scan
-- receipts. Catalog rows are identity metadata; nothing here stores or enables financial adapter logic.
CREATE TABLE defi_universe_syncs (
  sync_id text PRIMARY KEY CHECK (sync_id ~ '^[a-zA-Z0-9-]{1,80}$'),
  generated_at timestamptz NOT NULL,
  loaded_at timestamptz NOT NULL DEFAULT now(),
  catalog_sha256 text NOT NULL CHECK (catalog_sha256 ~ '^[a-f0-9]{64}$'),
  stats jsonb NOT NULL,
  receipt jsonb NOT NULL
);
CREATE TABLE defi_source_revisions (
  sync_id text NOT NULL REFERENCES defi_universe_syncs(sync_id),
  source_id text NOT NULL CHECK (source_id ~ '^[a-zA-Z0-9/._-]{1,100}$'),
  url text NOT NULL,
  revision text,
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[a-f0-9]{64}$'),
  bytes bigint CHECK (bytes IS NULL OR bytes >= 0),
  license_state text NOT NULL,
  use text NOT NULL,
  PRIMARY KEY (sync_id, source_id)
);
CREATE TABLE defi_catalog_chains (
  chain_key text PRIMARY KEY CHECK (chain_key ~ '^chain:[a-z0-9-]{1,80}$'),
  name text NOT NULL,
  vm text NOT NULL CHECK (vm IN ('EVM','Solana','Sui','Aptos','Cosmos','Bitcoin','Tron','Stellar','Other')),
  chain_id text CHECK (chain_id IS NULL OR chain_id ~ '^[0-9]{1,20}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE','REFERENCED_ONLY','METADATA_ONLY','REMOVED_UPSTREAM')),
  mapping_status text NOT NULL CHECK (mapping_status IN ('MAPPED','UNMAPPED')),
  mapping_reason text,
  first_seen text NOT NULL,
  last_seen text NOT NULL,
  payload jsonb NOT NULL
);
CREATE TABLE defi_catalog_chain_aliases (
  alias text PRIMARY KEY,
  chain_key text NOT NULL REFERENCES defi_catalog_chains(chain_key),
  last_seen text NOT NULL
);
CREATE TABLE defi_catalog_protocols (
  protocol_id text PRIMARY KEY CHECK (protocol_id ~ '^llama:[0-9a-z#._-]{1,80}$'),
  llama_id text NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  product_category text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','DEPRECATED','DEAD','RUGGED','REMOVED_UPSTREAM')),
  mapping_status text NOT NULL CHECK (mapping_status IN ('MAPPED','UNMAPPED')),
  mapping_reason text,
  tvl_usd double precision CHECK (tvl_usd IS NULL OR tvl_usd >= 0),
  first_seen text NOT NULL,
  last_seen text NOT NULL,
  payload jsonb NOT NULL
);
CREATE INDEX defi_catalog_protocols_name ON defi_catalog_protocols (lower(name));
CREATE INDEX defi_catalog_protocols_slug ON defi_catalog_protocols (slug);
CREATE INDEX defi_catalog_protocols_category ON defi_catalog_protocols (product_category, status);
CREATE TABLE defi_catalog_protocol_chains (
  protocol_id text NOT NULL REFERENCES defi_catalog_protocols(protocol_id),
  chain_key text NOT NULL REFERENCES defi_catalog_chains(chain_key),
  raw_chain text NOT NULL,
  tvl_usd double precision CHECK (tvl_usd IS NULL OR tvl_usd >= 0),
  borrowed_usd double precision CHECK (borrowed_usd IS NULL OR borrowed_usd >= 0),
  last_seen text NOT NULL,
  PRIMARY KEY (protocol_id, chain_key)
);
CREATE INDEX defi_catalog_protocol_chains_chain ON defi_catalog_protocol_chains (chain_key);
CREATE TABLE defi_coverage (
  sync_id text NOT NULL REFERENCES defi_universe_syncs(sync_id),
  protocol_id text NOT NULL,
  chain_key text NOT NULL,
  product text NOT NULL,
  version text,
  adapter_version text,
  status text NOT NULL CHECK (status IN ('FULL_POSITION','PARTIAL_POSITION','DISCOVERY_ONLY','NOT_CHECKED','CATALOG_ONLY','NEEDS_REVIEW','UNSUPPORTED','DEPRECATED','FAILED')),
  reason text NOT NULL CHECK (reason ~ '^[A-Z0-9_]{1,100}$'),
  deployments jsonb NOT NULL,
  PRIMARY KEY (sync_id, protocol_id, chain_key, product)
);
CREATE INDEX defi_coverage_status ON defi_coverage (sync_id, status);
CREATE TABLE defi_adapter_queue (
  sync_id text NOT NULL REFERENCES defi_universe_syncs(sync_id),
  protocol_id text NOT NULL,
  priority numeric(7,3) NOT NULL CHECK (priority >= 0 AND priority <= 100),
  tier text NOT NULL CHECK (tier IN ('P0','P1','P2','P3','P4')),
  payload jsonb NOT NULL,
  PRIMARY KEY (sync_id, protocol_id)
);
CREATE TABLE defi_deployment_candidates (
  candidate_id text PRIMARY KEY CHECK (candidate_id ~ '^[a-z0-9:._-]{1,200}$'),
  protocol_id text NOT NULL,
  chain_id text NOT NULL CHECK (chain_id ~ '^[0-9]{1,20}$'),
  contract text NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
  role text NOT NULL,
  source_url text NOT NULL,
  source_revision text,
  review_state text NOT NULL CHECK (review_state IN ('CANDIDATE','REVIEWED','REJECTED')),
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE defi_contract_index (
  chain_id text NOT NULL CHECK (chain_id ~ '^[0-9]{1,20}$'),
  contract text NOT NULL CHECK (contract ~ '^0x[0-9a-f]{40}$'),
  deployment_id text NOT NULL,
  protocol_id text NOT NULL,
  product text NOT NULL,
  version text,
  role text NOT NULL CHECK (role IN ('market','pool','vault','factory','staking','position-manager','rewards','comptroller','strategy','router','oracle','receipt-token','debt-token','gauge','registry','withdrawal-queue')),
  source text NOT NULL,
  PRIMARY KEY (chain_id, contract, deployment_id, role)
);
CREATE INDEX defi_contract_index_protocol ON defi_contract_index (protocol_id);
-- Independent, resumable checkpoint lanes per deployment and event family (for example a complete Morpho market
-- registry while wallet activity remains a separate, partial lane). Canonical hash per window; reorg-safe rollback.
CREATE TABLE defi_index_lanes (
  deployment_id text NOT NULL,
  lane text NOT NULL CHECK (lane ~ '^[a-z0-9-]{1,40}$'),
  start_block numeric(78,0) NOT NULL,
  indexed_from numeric(78,0) NOT NULL,
  indexed_through numeric(78,0) NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  historical_complete boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (deployment_id, lane)
);
CREATE TABLE defi_index_lane_windows (
  deployment_id text NOT NULL,
  lane text NOT NULL,
  from_block numeric(78,0) NOT NULL,
  to_block numeric(78,0) NOT NULL,
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  logs integer NOT NULL CHECK (logs >= 0),
  PRIMARY KEY (deployment_id, lane, to_block),
  FOREIGN KEY (deployment_id, lane) REFERENCES defi_index_lanes(deployment_id, lane)
);
CREATE TABLE defi_registry_entries (
  deployment_id text NOT NULL,
  lane text NOT NULL,
  entry_key text NOT NULL CHECK (entry_key ~ '^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$'),
  source_block numeric(78,0) NOT NULL,
  source_hash text NOT NULL CHECK (source_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  detail jsonb NOT NULL,
  PRIMARY KEY (deployment_id, lane, entry_key),
  FOREIGN KEY (deployment_id, lane) REFERENCES defi_index_lanes(deployment_id, lane)
);
CREATE TABLE defi_scan_receipts (
  scan_id text PRIMARY KEY REFERENCES defi_scan_runs(id) ON DELETE CASCADE,
  catalog_version text NOT NULL,
  payload jsonb NOT NULL
);
