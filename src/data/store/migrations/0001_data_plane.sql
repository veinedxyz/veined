-- Otherbridge V1.4 self-hosted data plane. Additive only: no DROP/TRUNCATE/DELETE here.
-- Never stores private keys, seeds, raw API keys or wallet signatures.

CREATE TABLE IF NOT EXISTS chains (
  chain_id text PRIMARY KEY CHECK (chain_id ~ '^(\d{1,18}|catalog:[a-z0-9-]{1,60})$'),
  canonical_id text NOT NULL UNIQUE,
  eip155_id text CHECK (eip155_id IS NULL OR eip155_id ~ '^\d{1,18}$'),
  ecosystem text NOT NULL CHECK (ecosystem IN ('EVM','SVM','UTXO','MVM','TVM','STL','UNKNOWN')),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  mainnet boolean NOT NULL,
  native_symbol text NOT NULL CHECK (length(native_symbol) <= 32),
  native_name text NOT NULL CHECK (length(native_name) <= 120),
  native_decimals smallint NOT NULL CHECK (native_decimals BETWEEN 0 AND 36),
  finality_kind text NOT NULL CHECK (finality_kind IN ('finalized-tag','safe-tag','depth')),
  finality_depth integer NOT NULL CHECK (finality_depth >= 0),
  configured_tier text NOT NULL CHECK (configured_tier IN ('FULL_INDEXED','ON_DEMAND_FUNGIBLE','NATIVE_ONLY','CATALOG_ONLY')),
  index_start_blocks integer CHECK (index_start_blocks IS NULL OR index_start_blocks > 0),
  token_event_model text CHECK (token_event_model IN ('erc20-transfer','spl-token-accounts')),
  enabled boolean NOT NULL DEFAULT true,
  tvl_usd double precision CHECK (tvl_usd IS NULL OR tvl_usd >= 0),
  routable boolean NOT NULL DEFAULT false,
  sources text[] NOT NULL,
  multicall_address text CHECK (multicall_address IS NULL OR multicall_address ~ '^0x[0-9a-f]{40}$'),
  multicall_code_hash text,
  multicall_verified_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rpc_endpoints (
  id text PRIMARY KEY CHECK (length(id) <= 400),
  chain_id text NOT NULL REFERENCES chains(chain_id),
  url text NOT NULL CHECK (url ~ '^https://[a-z0-9.-]+(:[0-9]{2,5})?(/[A-Za-z0-9._~/-]*)?$'),
  host text NOT NULL,
  provenance text NOT NULL CHECK (provenance IN ('curated','public-registry','operator')),
  priority integer NOT NULL DEFAULT 100,
  status text NOT NULL CHECK (status IN ('APPROVED','REJECTED','QUARANTINED')),
  reason text,
  supports_logs boolean NOT NULL DEFAULT false,
  max_log_range integer NOT NULL DEFAULT 0 CHECK (max_log_range >= 0),
  supports_batch boolean NOT NULL DEFAULT false,
  supports_finalized boolean NOT NULL DEFAULT false,
  supports_safe boolean NOT NULL DEFAULT false,
  archive boolean NOT NULL DEFAULT false,
  logs_per_block double precision,
  latency_ms integer,
  latest_block numeric(20,0),
  admitted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, url)
);
CREATE INDEX IF NOT EXISTS rpc_endpoints_chain_status ON rpc_endpoints (chain_id, status);

CREATE TABLE IF NOT EXISTS rpc_health (
  endpoint_id text PRIMARY KEY REFERENCES rpc_endpoints(id),
  checked_at timestamptz NOT NULL,
  ok_count integer NOT NULL DEFAULT 0,
  error_count integer NOT NULL DEFAULT 0,
  consecutive_failures integer NOT NULL DEFAULT 0,
  latency_ms integer,
  error_rate double precision NOT NULL DEFAULT 0 CHECK (error_rate BETWEEN 0 AND 1),
  latest_block numeric(20,0),
  quarantined_until timestamptz,
  quarantine_reason text
);

CREATE TABLE IF NOT EXISTS indexer_leases (
  chain_id text PRIMARY KEY REFERENCES chains(chain_id),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 8 AND 120),
  from_block numeric(20,0) NOT NULL,
  to_block numeric(20,0) NOT NULL,
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS indexer_checkpoints (
  chain_id text PRIMARY KEY REFERENCES chains(chain_id),
  indexed_from_block bigint NOT NULL CHECK (indexed_from_block >= 0),
  indexed_through_block bigint NOT NULL,
  through_block_hash text CHECK (through_block_hash IS NULL OR through_block_hash ~ '^0x[0-9a-f]{64}$'),
  head_block bigint,
  safe_block bigint,
  historical_complete boolean NOT NULL DEFAULT false,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (indexed_through_block >= indexed_from_block - 1)
);

CREATE TABLE IF NOT EXISTS indexed_block_windows (
  chain_id text NOT NULL REFERENCES chains(chain_id),
  from_block bigint NOT NULL,
  to_block bigint NOT NULL,
  to_block_hash text NOT NULL CHECK (to_block_hash ~ '^0x[0-9a-f]{64}$'),
  log_count integer NOT NULL CHECK (log_count >= 0),
  finalized boolean NOT NULL,
  committed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, from_block),
  CHECK (to_block >= from_block)
);
CREATE INDEX IF NOT EXISTS indexed_block_windows_chain_to ON indexed_block_windows (chain_id, to_block);

CREATE TABLE IF NOT EXISTS erc20_transfers (
  chain_id text NOT NULL REFERENCES chains(chain_id),
  block_number bigint NOT NULL CHECK (block_number >= 0),
  block_hash text NOT NULL CHECK (block_hash ~ '^0x[0-9a-f]{64}$'),
  tx_hash text NOT NULL CHECK (tx_hash ~ '^0x[0-9a-f]{64}$'),
  log_index integer NOT NULL CHECK (log_index >= 0),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  from_address text NOT NULL CHECK (from_address ~ '^0x[0-9a-f]{40}$'),
  to_address text NOT NULL CHECK (to_address ~ '^0x[0-9a-f]{40}$'),
  value numeric(78,0) NOT NULL CHECK (value >= 0),
  PRIMARY KEY (chain_id, tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS erc20_transfers_chain_block ON erc20_transfers (chain_id, block_number);
CREATE INDEX IF NOT EXISTS erc20_transfers_from ON erc20_transfers (from_address, chain_id, block_number);
CREATE INDEX IF NOT EXISTS erc20_transfers_to ON erc20_transfers (to_address, chain_id, block_number);

CREATE TABLE IF NOT EXISTS wallet_token_discovery (
  chain_id text NOT NULL REFERENCES chains(chain_id),
  wallet text NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  token text NOT NULL CHECK (token ~ '^0x[0-9a-f]{40}$'),
  first_block bigint NOT NULL,
  last_block bigint NOT NULL,
  transfer_count integer NOT NULL CHECK (transfer_count > 0),
  PRIMARY KEY (chain_id, wallet, token)
);
CREATE INDEX IF NOT EXISTS wallet_token_discovery_wallet ON wallet_token_discovery (wallet, chain_id);

CREATE TABLE IF NOT EXISTS tokens (
  chain_id text NOT NULL REFERENCES chains(chain_id),
  address text NOT NULL CHECK (length(address) BETWEEN 1 AND 128),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 32),
  name text CHECK (name IS NULL OR length(name) <= 120),
  decimals smallint CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 36),
  metadata_status text NOT NULL DEFAULT 'PENDING' CHECK (metadata_status IN ('OK','PARTIAL','FAILED','PENDING')),
  sources text[] NOT NULL,
  suspicious boolean NOT NULL DEFAULT false,
  spam boolean NOT NULL DEFAULT false,
  price_usd text CHECK (price_usd IS NULL OR price_usd ~ '^(0|[1-9][0-9]{0,14})(\.[0-9]{1,18})?$'),
  price_observed_at timestamptz,
  price_confidence text CHECK (price_confidence IS NULL OR price_confidence IN ('verified','derived','unknown')),
  price_method text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, address)
);

-- Short-lived observation caches keyed by a keyed pseudonym, never the raw wallet (DATA_RETENTION.md).
CREATE TABLE IF NOT EXISTS native_balance_snapshots (
  wallet_hash text NOT NULL CHECK (wallet_hash ~ '^[0-9a-f]{64}$'),
  chain_id text NOT NULL REFERENCES chains(chain_id),
  balance numeric(78,0) NOT NULL CHECK (balance >= 0),
  block_number numeric(20,0) NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (wallet_hash, chain_id)
);
CREATE TABLE IF NOT EXISTS wallet_balance_snapshots (
  wallet_hash text NOT NULL CHECK (wallet_hash ~ '^[0-9a-f]{64}$'),
  chain_id text NOT NULL REFERENCES chains(chain_id),
  token text NOT NULL,
  balance numeric(78,0) NOT NULL CHECK (balance >= 0),
  block_number numeric(20,0) NOT NULL,
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (wallet_hash, chain_id, token)
);
CREATE INDEX IF NOT EXISTS native_balance_snapshots_observed ON native_balance_snapshots (observed_at);
CREATE INDEX IF NOT EXISTS wallet_balance_snapshots_observed ON wallet_balance_snapshots (observed_at);

CREATE TABLE IF NOT EXISTS portfolio_scan_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 80),
  wallet_hash text NOT NULL CHECK (wallet_hash ~ '^[0-9a-f]{64}$'),
  origin text NOT NULL CHECK (origin IN ('app','api')),
  client_id text,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  state text NOT NULL,
  chains_planned integer NOT NULL,
  chains_checked integer NOT NULL,
  chains_pending integer NOT NULL,
  chains_failed integer NOT NULL
);
CREATE INDEX IF NOT EXISTS portfolio_scan_runs_started ON portfolio_scan_runs (started_at);
CREATE TABLE IF NOT EXISTS portfolio_scan_coverage (
  run_id text NOT NULL REFERENCES portfolio_scan_runs(id) ON DELETE CASCADE,
  chain_id text NOT NULL,
  state text NOT NULL,
  tier text NOT NULL,
  observed_block text,
  PRIMARY KEY (run_id, chain_id)
);

CREATE TABLE IF NOT EXISTS api_clients (
  id text PRIMARY KEY CHECK (id ~ '^cli_[a-z0-9]{16,40}$'),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 80),
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  plan_id text NOT NULL CHECK (plan_id IN ('internal','developer','starter','pro')),
  scopes text[] NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Only a one-way verifier is stored. The plaintext secret is displayed once by the admin CLI.
CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY CHECK (id ~ '^key_[a-z0-9]{16,40}$'),
  client_id text NOT NULL REFERENCES api_clients(id),
  prefix text NOT NULL UNIQUE CHECK (prefix ~ '^[a-z0-9]{12}$'),
  verifier text NOT NULL CHECK (verifier ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  last_used_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_client ON api_keys (client_id);
CREATE TABLE IF NOT EXISTS api_usage_events (
  id bigserial PRIMARY KEY,
  client_id text NOT NULL,
  key_id text,
  at timestamptz NOT NULL,
  endpoint_group text NOT NULL CHECK (length(endpoint_group) <= 40),
  status smallint NOT NULL,
  cost_units integer NOT NULL CHECK (cost_units >= 0),
  latency_bucket text NOT NULL CHECK (latency_bucket IN ('lt100','lt500','lt2000','lt10000','ge10000')),
  request_id text NOT NULL CHECK (request_id ~ '^req_[a-z0-9]{20,40}$')
);
CREATE INDEX IF NOT EXISTS api_usage_events_client_at ON api_usage_events (client_id, at);
CREATE INDEX IF NOT EXISTS api_usage_events_at ON api_usage_events (at);
CREATE TABLE IF NOT EXISTS api_usage_daily (
  client_id text NOT NULL,
  day date NOT NULL,
  endpoint_group text NOT NULL,
  requests bigint NOT NULL DEFAULT 0,
  cost_units bigint NOT NULL DEFAULT 0,
  errors bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, day, endpoint_group)
);
CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  bucket_key text NOT NULL CHECK (length(bucket_key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  window_seconds integer NOT NULL CHECK (window_seconds > 0),
  count integer NOT NULL CHECK (count >= 0),
  PRIMARY KEY (bucket_key, window_start)
);
CREATE INDEX IF NOT EXISTS rate_limit_buckets_window ON rate_limit_buckets (window_start);
CREATE TABLE IF NOT EXISTS api_concurrency_slots (
  request_id text PRIMARY KEY,
  client_id text NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS api_concurrency_slots_client ON api_concurrency_slots (client_id, expires_at);
