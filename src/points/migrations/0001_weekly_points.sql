-- VEINED weekly points, referrals and leaderboard: schema PROPOSAL 0001.
-- Not applied to any production database. Applied only by src/points/migrate.ts on an explicitly supplied URL
-- (isolated test databases in this delivery). Up-only, additive, no destructive statements.
-- Amounts are numeric(40,0) counts of the smallest unit (1 unit = 0.000001 point); the weekly pool is exactly
-- 200,000 points = 200000000000 units, referral commissions included.

CREATE SCHEMA IF NOT EXISTS veined_points;

CREATE TABLE veined_points.activity (
  event_id text PRIMARY KEY,
  operation_key text NOT NULL,
  account text NOT NULL,
  season integer NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_FINALITY', 'ELIGIBLE', 'REJECTED', 'REVERSED')),
  revision integer NOT NULL CHECK (revision >= 1),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One live record per settled operation across every category (a swap can never also count as a trade).
CREATE UNIQUE INDEX activity_live_operation
  ON veined_points.activity (operation_key)
  WHERE status IN ('PENDING_FINALITY', 'ELIGIBLE');
CREATE INDEX activity_season ON veined_points.activity (season);
CREATE INDEX activity_account ON veined_points.activity (account);

CREATE TABLE veined_points.referral_code (
  code text PRIMARY KEY CHECK (code ~ '^[0-9A-HJKMNP-TV-Z]{8}$'),
  account text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);

-- One parent per account, never self.
CREATE TABLE veined_points.referral_binding (
  child text PRIMARY KEY,
  parent text NOT NULL,
  record jsonb NOT NULL,
  CHECK (child <> parent)
);
CREATE INDEX referral_binding_parent ON veined_points.referral_binding (parent);

CREATE TABLE veined_points.account_flag (
  account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('EXCLUDED', 'REVIEW')),
  record jsonb NOT NULL,
  PRIMARY KEY (account, kind)
);

CREATE TABLE veined_points.task (
  id text PRIMARY KEY,
  version integer NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'CANCELLED')),
  record jsonb NOT NULL
);

CREATE TABLE veined_points.task_completion (
  id text PRIMARY KEY,
  task_id text NOT NULL REFERENCES veined_points.task (id),
  account text NOT NULL,
  season integer NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'VOIDED')),
  revision integer NOT NULL CHECK (revision >= 1),
  event_ids text[] NOT NULL,
  record jsonb NOT NULL
);
CREATE INDEX task_completion_task ON veined_points.task_completion (task_id);
CREATE INDEX task_completion_season ON veined_points.task_completion (season);

CREATE TABLE veined_points.season (
  season integer PRIMARY KEY CHECK (season >= 1),
  state text NOT NULL CHECK (state IN ('OPEN', 'CALCULATING', 'REVIEW_PENDING', 'FINALIZED', 'PUBLISHED')),
  version integer NOT NULL CHECK (version >= 1),
  policy_hash text NOT NULL CHECK (policy_hash ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL
);

CREATE TABLE veined_points.ledger_entry (
  id text PRIMARY KEY,
  season integer NOT NULL REFERENCES veined_points.season (season),
  account text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('ACTIVITY', 'TASK', 'REFERRAL_COMMISSION', 'CORRECTION')),
  amount_units numeric(40, 0) NOT NULL CHECK (kind = 'CORRECTION' OR amount_units >= 0),
  source_ref text NOT NULL,
  record jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX ledger_entry_season ON veined_points.ledger_entry (season);
CREATE INDEX ledger_entry_account ON veined_points.ledger_entry (account);

-- Historical payouts are immutable.
CREATE FUNCTION veined_points.refuse_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'VEINED_POINTS_IMMUTABLE' USING ERRCODE = 'P0001';
END
$$;
CREATE TRIGGER ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON veined_points.ledger_entry
  FOR EACH ROW EXECUTE FUNCTION veined_points.refuse_mutation();

-- Defence in depth for the weekly budget: checked at commit for every season touched by a transaction.
CREATE FUNCTION veined_points.enforce_weekly_budget() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount_units), 0) FROM veined_points.ledger_entry WHERE season = NEW.season)
     > 200000000000 THEN
    RAISE EXCEPTION 'VEINED_POINTS_BUDGET_EXCEEDED' USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER ledger_entry_weekly_budget
  AFTER INSERT ON veined_points.ledger_entry
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION veined_points.enforce_weekly_budget();

CREATE TABLE veined_points.correction (
  id text PRIMARY KEY,
  season integer NOT NULL REFERENCES veined_points.season (season),
  status text NOT NULL CHECK (status IN ('PROPOSED', 'APPLIED', 'REJECTED')),
  record jsonb NOT NULL
);

-- Append-only, hash-chained audit log.
CREATE TABLE veined_points.audit_log (
  seq bigint PRIMARY KEY CHECK (seq >= 1),
  at timestamptz NOT NULL,
  actor text NOT NULL,
  action text NOT NULL,
  target text NOT NULL,
  prev_hash text NOT NULL CHECK (prev_hash ~ '^[0-9a-f]{64}$'),
  hash text NOT NULL UNIQUE CHECK (hash ~ '^[0-9a-f]{64}$'),
  record jsonb NOT NULL
);
CREATE TRIGGER audit_log_immutable
  BEFORE UPDATE OR DELETE ON veined_points.audit_log
  FOR EACH ROW EXECUTE FUNCTION veined_points.refuse_mutation();

-- Distributed lease locks with fencing tokens (settlement, referral graph).
CREATE SEQUENCE veined_points.lock_fence;
CREATE TABLE veined_points.lease_lock (
  name text PRIMARY KEY,
  owner text NOT NULL,
  token bigint NOT NULL,
  expires_at timestamptz NOT NULL
);
