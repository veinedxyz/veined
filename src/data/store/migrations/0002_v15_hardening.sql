-- Otherbridge V1.5 pre-release hardening. Additive only: new tables, new nullable/defaulted columns,
-- new indexes. No DROP/TRUNCATE/DELETE/RENAME. Never stores secrets, wallet data or raw API keys.

-- Independent log-set witness evidence for every indexed window attempt (committed or not).
CREATE TABLE IF NOT EXISTS indexed_window_witnesses (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL REFERENCES chains(chain_id),
  from_block bigint NOT NULL CHECK (from_block >= 0),
  to_block bigint NOT NULL,
  mode text NOT NULL CHECK (mode IN ('LIVE','BACKFILL','REVERIFY')),
  primary_endpoint_id text NOT NULL CHECK (length(primary_endpoint_id) BETWEEN 1 AND 400),
  witness_endpoint_id text CHECK (witness_endpoint_id IS NULL OR length(witness_endpoint_id) BETWEEN 1 AND 400),
  tiebreak_endpoint_id text CHECK (tiebreak_endpoint_id IS NULL OR length(tiebreak_endpoint_id) BETWEEN 1 AND 400),
  primary_operator text CHECK (primary_operator IS NULL OR primary_operator ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  witness_operator text CHECK (witness_operator IS NULL OR witness_operator ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  tiebreak_operator text CHECK (tiebreak_operator IS NULL OR tiebreak_operator ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  primary_block_start_hash text NOT NULL CHECK (primary_block_start_hash ~ '^0x[0-9a-f]{64}$'),
  primary_block_end_hash text NOT NULL CHECK (primary_block_end_hash ~ '^0x[0-9a-f]{64}$'),
  witness_block_start_hash text CHECK (witness_block_start_hash IS NULL OR witness_block_start_hash ~ '^0x[0-9a-f]{64}$'),
  witness_block_end_hash text CHECK (witness_block_end_hash IS NULL OR witness_block_end_hash ~ '^0x[0-9a-f]{64}$'),
  primary_log_count integer NOT NULL CHECK (primary_log_count >= 0),
  witness_log_count integer CHECK (witness_log_count IS NULL OR witness_log_count >= 0),
  tiebreak_log_count integer CHECK (tiebreak_log_count IS NULL OR tiebreak_log_count >= 0),
  primary_digest text NOT NULL CHECK (primary_digest ~ '^[0-9a-f]{64}$'),
  witness_digest text CHECK (witness_digest IS NULL OR witness_digest ~ '^[0-9a-f]{64}$'),
  tiebreak_digest text CHECK (tiebreak_digest IS NULL OR tiebreak_digest ~ '^[0-9a-f]{64}$'),
  consensus text NOT NULL CHECK (consensus IN ('MATCH','MISMATCH','NO_INDEPENDENT_WITNESS','TIEBREAK_MATCH_PRIMARY','TIEBREAK_MATCH_WITNESS','UNRESOLVED')),
  failure text CHECK (failure IS NULL OR failure IN ('PRIMARY_FAILED','WITNESS_FAILED','LOG_SET_MISMATCH','BLOCK_HASH_MISMATCH','NO_WITNESS','CONSENSUS_UNRESOLVED')),
  committed boolean NOT NULL,
  observed_at timestamptz NOT NULL,
  CHECK (to_block >= from_block),
  -- A disputed or unresolved window can never be recorded as committed.
  CHECK (NOT committed OR consensus IN ('MATCH','TIEBREAK_MATCH_PRIMARY','TIEBREAK_MATCH_WITNESS','NO_INDEPENDENT_WITNESS'))
);
CREATE INDEX IF NOT EXISTS indexed_window_witnesses_chain_range ON indexed_window_witnesses (chain_id, from_block, to_block);
CREATE INDEX IF NOT EXISTS indexed_window_witnesses_consensus ON indexed_window_witnesses (consensus, observed_at);

-- Committed windows carry their consensus and primary digest; NULL = indexed before V1.5 (unwitnessed).
ALTER TABLE indexed_block_windows ADD COLUMN IF NOT EXISTS witness_consensus text
  CHECK (witness_consensus IS NULL OR witness_consensus IN ('MATCH','TIEBREAK_MATCH_PRIMARY','TIEBREAK_MATCH_WITNESS','NO_INDEPENDENT_WITNESS'));
ALTER TABLE indexed_block_windows ADD COLUMN IF NOT EXISTS log_digest text
  CHECK (log_digest IS NULL OR log_digest ~ '^[0-9a-f]{64}$');
ALTER TABLE indexed_block_windows ADD COLUMN IF NOT EXISTS lane text NOT NULL DEFAULT 'live'
  CHECK (lane IN ('live','backfill'));

-- Trusted index advancement pause (LOG_CONSENSUS_UNRESOLVED etc.); cleared only by an operator.
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS halted_reason text
  CHECK (halted_reason IS NULL OR halted_reason ~ '^[A-Z0-9_:.-]{1,120}$');
ALTER TABLE indexer_checkpoints ADD COLUMN IF NOT EXISTS halted_at timestamptz;

-- Backward historical backfill uses its own lease so it never races the live head lane.
CREATE TABLE IF NOT EXISTS indexer_backfill_leases (
  chain_id text PRIMARY KEY REFERENCES chains(chain_id),
  owner_id text NOT NULL CHECK (length(owner_id) BETWEEN 8 AND 120),
  acquired_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);

-- Backup / verify / restore-drill outcomes for monitoring (no secrets, no file contents).
CREATE TABLE IF NOT EXISTS ops_backup_events (
  id bigserial PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('BACKUP','VERIFY','RESTORE_DRILL')),
  ok boolean NOT NULL,
  at timestamptz NOT NULL,
  backup_id text CHECK (backup_id IS NULL OR backup_id ~ '^[A-Za-z0-9_.-]{1,80}$'),
  sha256 text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  detail text CHECK (detail IS NULL OR detail ~ '^[A-Za-z0-9_:. ,=-]{0,200}$')
);
CREATE INDEX IF NOT EXISTS ops_backup_events_kind_at ON ops_backup_events (kind, at);
