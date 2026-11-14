-- Otherbridge V1.11 unified chain/asset registry. Additive only: new tables and indexes. No DROP/TRUNCATE/DELETE/
-- RENAME. Never stores wallet addresses, balances, API keys or raw upstream payloads; identity is chain + exact
-- contract (or explicit native), a symbol is display text only.

CREATE TABLE IF NOT EXISTS chain_identities (
  id text PRIMARY KEY CHECK (id ~ '^([0-9]{1,18}|catalog:[a-z0-9-]{1,60})$'),
  chain_id text CHECK (chain_id IS NULL OR chain_id ~ '^[0-9]{1,18}$'),
  caip2 text CHECK (caip2 IS NULL OR length(caip2) BETWEEN 3 AND 120),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  short_name text NOT NULL CHECK (length(short_name) BETWEEN 1 AND 32),
  environment text NOT NULL CHECK (environment IN ('mainnet','testnet','devnet','local','unknown')),
  environment_source text NOT NULL CHECK (environment_source IN ('routing-catalog','custom-registry','tvl-catalog','ethereum-lists','local-test','none')),
  ecosystem text NOT NULL CHECK (ecosystem IN ('EVM','SVM','UTXO','MVM','TVM','STL','OTHER')),
  native_symbol text CHECK (native_symbol IS NULL OR length(native_symbol) BETWEEN 1 AND 16),
  explorer text CHECK (explorer IS NULL OR explorer ~ '^https://[^\s]{4,200}$'),
  logo_path text CHECK (logo_path IS NULL OR logo_path ~ '^/(assets|networks)/[A-Za-z0-9_./-]{1,200}$'),
  logo_source text NOT NULL CHECK (logo_source IN ('local-verified','official','trustwallet','curated','monogram')),
  logo_sha256 text CHECK (logo_sha256 IS NULL OR logo_sha256 ~ '^[0-9a-f]{64}$'),
  updated_at timestamptz NOT NULL,
  -- A testnet/devnet/local chain can never be stored as a mainnet by construction of the sync job; the logo of a
  -- monogram chain is never a path.
  CHECK (logo_source <> 'monogram' OR logo_path IS NULL)
);
CREATE INDEX IF NOT EXISTS chain_identities_environment ON chain_identities (environment);

-- Every attempted chain image ingestion (accepted or refused) with its provenance.
CREATE TABLE IF NOT EXISTS chain_image_sources (
  id bigserial PRIMARY KEY,
  chain_identity_id text NOT NULL REFERENCES chain_identities(id),
  source text NOT NULL CHECK (source IN ('local-verified','official','trustwallet','curated')),
  source_url text NOT NULL CHECK (source_url ~ '^https://[^\s]{4,600}$'),
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  sanitized_sha256 text CHECK (sanitized_sha256 IS NULL OR sanitized_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('ACCEPTED','REFUSED')),
  refusal_reason text CHECK (refusal_reason IS NULL OR refusal_reason ~ '^[A-Z_]{2,60}$'),
  observed_at timestamptz NOT NULL,
  CHECK ((status = 'ACCEPTED') = (sanitized_sha256 IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS asset_identities (
  asset_key text PRIMARY KEY CHECK (asset_key ~ '^[0-9]{1,18}:(native|0x[0-9a-f]{40})$'),
  chain_id text NOT NULL CHECK (chain_id ~ '^[0-9]{1,18}$'),
  is_native boolean NOT NULL,
  level text NOT NULL CHECK (level IN ('CANONICAL','CURATED','MARKET_LISTED','DEX_DISCOVERED','IMPORTED_UNVERIFIED','BLOCKED')),
  symbol text NOT NULL CHECK (length(symbol) BETWEEN 1 AND 32),
  name text NOT NULL CHECK (length(name) <= 120),
  decimals integer NOT NULL CHECK (decimals BETWEEN 0 AND 36),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (is_native = (asset_key LIKE '%:native')),
  CHECK (split_part(asset_key, ':', 1) = chain_id)
);
CREATE INDEX IF NOT EXISTS asset_identities_chain_level ON asset_identities (chain_id, level);
-- Display lookups only; a symbol never identifies an asset (no uniqueness on it, by design).
CREATE INDEX IF NOT EXISTS asset_identities_symbol ON asset_identities (chain_id, upper(symbol));

CREATE TABLE IF NOT EXISTS asset_contracts (
  asset_key text PRIMARY KEY REFERENCES asset_identities(asset_key),
  chain_id text NOT NULL CHECK (chain_id ~ '^[0-9]{1,18}$'),
  address text NOT NULL CHECK (address ~ '^(native|0x[0-9a-f]{40})$'),
  standard text NOT NULL CHECK (standard IN ('native','erc20')),
  code_sha256 text CHECK (code_sha256 IS NULL OR code_sha256 ~ '^[0-9a-f]{64}$'),
  verified_at timestamptz,
  UNIQUE (chain_id, address)
);

CREATE TABLE IF NOT EXISTS asset_metadata_sources (
  id bigserial PRIMARY KEY,
  asset_key text NOT NULL REFERENCES asset_identities(asset_key),
  source text NOT NULL CHECK (source IN ('native','onebridge','otherbridge-curated','trustwallet','coingecko','dexscreener','routing','onchain','user-import')),
  symbol text CHECK (symbol IS NULL OR length(symbol) <= 64),
  name text CHECK (name IS NULL OR length(name) <= 160),
  decimals integer CHECK (decimals IS NULL OR decimals BETWEEN 0 AND 36),
  raw_sha256 text CHECK (raw_sha256 IS NULL OR raw_sha256 ~ '^[0-9a-f]{64}$'),
  observed_at timestamptz NOT NULL,
  UNIQUE (asset_key, source)
);

-- Market/DEX evidence is informational: never transaction math, never a safety claim.
CREATE TABLE IF NOT EXISTS asset_market_sources (
  id bigserial PRIMARY KEY,
  asset_key text NOT NULL REFERENCES asset_identities(asset_key),
  source text NOT NULL CHECK (source IN ('coingecko','dexscreener')),
  external_id text CHECK (external_id IS NULL OR length(external_id) BETWEEN 1 AND 120),
  price_usd numeric(40, 18) CHECK (price_usd IS NULL OR price_usd >= 0),
  liquidity_usd numeric(30, 2) CHECK (liquidity_usd IS NULL OR liquidity_usd >= 0),
  pairs integer CHECK (pairs IS NULL OR pairs >= 0),
  observed_at timestamptz NOT NULL,
  UNIQUE (asset_key, source)
);

-- Sanitized images only (content-addressed by the sanitized bytes).
CREATE TABLE IF NOT EXISTS asset_images (
  sha256 text PRIMARY KEY CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  asset_key text NOT NULL REFERENCES asset_identities(asset_key),
  source text NOT NULL CHECK (source IN ('canonical-local','trustwallet','coingecko','dexscreener')),
  source_url text CHECK (source_url IS NULL OR source_url ~ '^https://[^\s]{4,600}$'),
  source_sha256 text CHECK (source_sha256 IS NULL OR source_sha256 ~ '^[0-9a-f]{64}$'),
  format text NOT NULL CHECK (format IN ('png','webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 1024),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 1024),
  path text CHECK (path IS NULL OR path ~ '^/(assets|networks)/[A-Za-z0-9_./-]{1,200}$'),
  observed_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS asset_images_asset ON asset_images (asset_key);

CREATE TABLE IF NOT EXISTS asset_risk_flags (
  asset_key text NOT NULL REFERENCES asset_identities(asset_key),
  flag text NOT NULL CHECK (flag IN ('SYMBOL_IMPERSONATION','BIDI_OR_INVISIBLE','MIXED_SCRIPT','LONG_TEXT','URL_IN_TEXT','NO_CODE','METADATA_MISMATCH','NO_MARKET_EVIDENCE','LOW_LIQUIDITY','TESTNET','SPAM_LISTED')),
  source text NOT NULL CHECK (length(source) BETWEEN 1 AND 40),
  observed_at timestamptz NOT NULL,
  PRIMARY KEY (asset_key, flag)
);

CREATE TABLE IF NOT EXISTS asset_route_capabilities (
  id bigserial PRIMARY KEY,
  asset_key text NOT NULL REFERENCES asset_identities(asset_key),
  provider text NOT NULL CHECK (provider IN ('routing-core','otherbridge-onebridge')),
  peer_chain_id text CHECK (peer_chain_id IS NULL OR peer_chain_id ~ '^[0-9]{1,18}$'),
  peer_asset_key text CHECK (peer_asset_key IS NULL OR peer_asset_key ~ '^[0-9]{1,18}:(native|0x[0-9a-f]{40})$'),
  status text NOT NULL CHECK (status IN ('ROUTABLE','REGISTERED_NOT_VERIFIED','VERIFIED_ROUTE','NO_VERIFIED_ROUTE')),
  runtime_pin text CHECK (runtime_pin IS NULL OR length(runtime_pin) <= 400),
  observed_at timestamptz NOT NULL,
  UNIQUE (asset_key, provider, peer_chain_id, peer_asset_key)
);

CREATE TABLE IF NOT EXISTS asset_registry_sync_runs (
  id text PRIMARY KEY CHECK (length(id) BETWEEN 8 AND 120),
  job text NOT NULL CHECK (job IN ('chains','trustwallet','coingecko','dexscreener','routing','onebridge','build','verify','coverage','db-upsert')),
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('RUNNING','OK','PARTIAL','FAILED')),
  counts text CHECK (counts IS NULL OR length(counts) <= 4000),
  source_digest text CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS asset_registry_sync_runs_job ON asset_registry_sync_runs (job, started_at);
