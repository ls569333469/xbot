-- P12 additive-first migration. This migration must not submit provider writes.

ALTER TABLE trade_attempts DROP CONSTRAINT IF EXISTS trade_attempts_chain_check;
ALTER TABLE trade_attempts
  ADD CONSTRAINT trade_attempts_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE position_lots DROP CONSTRAINT IF EXISTS position_lots_chain_check;
ALTER TABLE position_lots
  ADD CONSTRAINT position_lots_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE chain_receipts DROP CONSTRAINT IF EXISTS chain_receipts_chain_check;
ALTER TABLE chain_receipts
  ADD CONSTRAINT chain_receipts_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE budget_reservations DROP CONSTRAINT IF EXISTS budget_reservations_chain_check;
ALTER TABLE budget_reservations
  ADD CONSTRAINT budget_reservations_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE budget_ledger DROP CONSTRAINT IF EXISTS budget_ledger_chain_check;
ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE chain_live_readiness DROP CONSTRAINT IF EXISTS chain_live_readiness_chain_check;
ALTER TABLE chain_live_readiness
  ADD CONSTRAINT chain_live_readiness_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE shadow_trade_evaluations DROP CONSTRAINT IF EXISTS shadow_trade_evaluations_chain_check;
ALTER TABLE shadow_trade_evaluations
  ADD CONSTRAINT shadow_trade_evaluations_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

ALTER TABLE chain_readiness_evidence DROP CONSTRAINT IF EXISTS chain_readiness_evidence_chain_check;
ALTER TABLE chain_readiness_evidence
  ADD CONSTRAINT chain_readiness_evidence_chain_check
  CHECK(chain IN('sol','bsc','base','eth','robinhood'));

CREATE TABLE IF NOT EXISTS trade_intents (
  id bigserial PRIMARY KEY,
  source_key text NOT NULL UNIQUE,
  scope_key text NOT NULL,
  side text NOT NULL CHECK(side IN('buy','sell')),
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  position_id int REFERENCES positions(id) ON DELETE SET NULL,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  close_generation int NOT NULL DEFAULT 1 CHECK(close_generation > 0),
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth','robinhood')),
  wallet_address text NOT NULL,
  contract_address text NOT NULL,
  wallet_lane_key text NOT NULL,
  status text NOT NULL DEFAULT 'created' CHECK(status IN(
    'created','submitting','awaiting_result','retry_verifying','retry_scheduled',
    'confirmed','exhausted','rejected','uncertain','cancelled'
  )),
  max_retries int NOT NULL DEFAULT 0 CHECK(max_retries BETWEEN 0 AND 2),
  retry_count int NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 2),
  expires_at timestamptz,
  next_retry_at timestamptz,
  retry_claimed_at timestamptz,
  principal_amount_raw text,
  principal_amount_display numeric(38,18),
  slippage_cap numeric(10,4),
  config_snapshot_json jsonb NOT NULL DEFAULT '{}',
  last_error_code text,
  confirmation_source text,
  incident_status text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_intents_active_scope
  ON trade_intents(scope_key)
  WHERE status IN(
    'created','submitting','awaiting_result','retry_verifying','retry_scheduled','uncertain'
  );
CREATE INDEX IF NOT EXISTS idx_trade_intents_retry_due
  ON trade_intents(status, next_retry_at)
  WHERE status = 'retry_scheduled';
CREATE INDEX IF NOT EXISTS idx_trade_intents_wallet
  ON trade_intents(chain, wallet_address, status);

CREATE TABLE IF NOT EXISTS trade_intent_sources (
  id bigserial PRIMARY KEY,
  intent_id bigint NOT NULL REFERENCES trade_intents(id) ON DELETE CASCADE,
  source_key text NOT NULL UNIQUE,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  source_json jsonb NOT NULL DEFAULT '{}',
  merged boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_intent_sources_intent
  ON trade_intent_sources(intent_id, created_at);

ALTER TABLE trade_attempts
  ADD COLUMN IF NOT EXISTS intent_id bigint REFERENCES trade_intents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS attempt_no int,
  ADD COLUMN IF NOT EXISTS retry_of_attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS failure_class text,
  ADD COLUMN IF NOT EXISTS failure_evidence_json jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS retry_eligible boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS retry_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS pre_submit_snapshot_json jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS snapshot_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS failure_evidence_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS funds_write_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS funds_write_completed_at timestamptz,
  ADD COLUMN IF NOT EXISTS estimated_fee_native numeric(38,18),
  ADD COLUMN IF NOT EXISTS actual_fee_native numeric(38,18),
  ADD COLUMN IF NOT EXISTS fee_escalation_level int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_reconcile_at timestamptz,
  ADD COLUMN IF NOT EXISTS terminal_audit_until timestamptz;

INSERT INTO trade_intents(
  source_key, scope_key, side, signal_id, position_id, whitelist_id,
  chain, wallet_address, contract_address, wallet_lane_key, status,
  max_retries, retry_count, principal_amount_raw, principal_amount_display,
  config_snapshot_json, last_error_code, created_at, updated_at, completed_at
)
SELECT
  CASE
    WHEN attempt.side = 'buy' AND attempt.signal_id IS NOT NULL
      THEN 'buy:signal:' || attempt.signal_id
    ELSE 'legacy:attempt:' || attempt.id
  END,
  'legacy:attempt:' || attempt.id,
  CASE WHEN attempt.side = 'sell' THEN 'sell' ELSE 'buy' END,
  attempt.signal_id,
  attempt.position_id,
  attempt.whitelist_id,
  attempt.chain,
  attempt.wallet_address,
  CASE WHEN attempt.side = 'sell' THEN attempt.input_token ELSE attempt.output_token END,
  'wallet_lane:' || attempt.chain || ':' || CASE
    WHEN attempt.chain = 'sol' THEN attempt.wallet_address
    ELSE lower(attempt.wallet_address)
  END,
  CASE
    WHEN attempt.status = 'confirmed' THEN 'confirmed'
    WHEN attempt.status = 'rejected' THEN 'rejected'
    WHEN attempt.status = 'failed' THEN 'exhausted'
    WHEN attempt.status IN ('submission_uncertain','reconciliation_required') THEN 'uncertain'
    ELSE 'awaiting_result'
  END,
  0,
  0,
  attempt.input_amount_raw,
  attempt.input_amount_display,
  jsonb_build_object('legacy_backfill', true, 'attempt_id', attempt.id),
  attempt.error_code,
  attempt.created_at,
  attempt.updated_at,
  CASE WHEN attempt.status IN ('confirmed','rejected','failed')
    THEN COALESCE(attempt.confirmed_at, attempt.updated_at) ELSE NULL END
FROM trade_attempts AS attempt
ON CONFLICT (source_key) DO NOTHING;

INSERT INTO trade_intent_sources(intent_id, source_key, signal_id, source_json, merged, created_at)
SELECT intent.id, intent.source_key, intent.signal_id,
       jsonb_build_object('legacy_backfill', true), false, intent.created_at
FROM trade_intents AS intent
ON CONFLICT (source_key) DO NOTHING;

UPDATE trade_attempts AS attempt
SET intent_id = intent.id,
    attempt_no = COALESCE(attempt.attempt_no, 1),
    next_reconcile_at = COALESCE(attempt.next_reconcile_at, attempt.last_reconciled_at, attempt.created_at)
FROM trade_intents AS intent
WHERE intent.source_key = CASE
        WHEN attempt.side = 'buy' AND attempt.signal_id IS NOT NULL
          THEN 'buy:signal:' || attempt.signal_id
        ELSE 'legacy:attempt:' || attempt.id
      END
  AND attempt.intent_id IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM trade_attempts WHERE intent_id IS NULL OR attempt_no IS NULL) THEN
    RAISE EXCEPTION 'P12 historical attempt backfill is incomplete';
  END IF;
END $$;

ALTER TABLE trade_attempts ALTER COLUMN intent_id SET NOT NULL;
ALTER TABLE trade_attempts ALTER COLUMN attempt_no SET NOT NULL;
ALTER TABLE trade_attempts
  ADD CONSTRAINT trade_attempts_attempt_no_check CHECK(attempt_no > 0);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_attempts_intent_number
  ON trade_attempts(intent_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_trade_attempts_terminal_audit
  ON trade_attempts(next_reconcile_at)
  WHERE status IN('submitted','confirming','submission_uncertain','reconciliation_required');

CREATE OR REPLACE FUNCTION p12_guard_trade_attempt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.pre_submit_snapshot_json <> '{}'::jsonb
     AND NEW.pre_submit_snapshot_json IS DISTINCT FROM OLD.pre_submit_snapshot_json THEN
    RAISE EXCEPTION 'pre-submit snapshot is immutable for attempt %', OLD.id;
  END IF;
  IF NEW.status = 'superseded'
     AND (OLD.funds_write_started_at IS NOT NULL
          OR OLD.status IN('submitting','submitted','confirming','confirmed',
                           'submission_uncertain','reconciliation_required',
                           'failure_verifying','definitive_failed_no_fill')) THEN
    RAISE EXCEPTION 'submitted attempt % cannot be superseded', OLD.id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_p12_guard_trade_attempt_mutation ON trade_attempts;
CREATE TRIGGER trg_p12_guard_trade_attempt_mutation
BEFORE UPDATE ON trade_attempts
FOR EACH ROW EXECUTE FUNCTION p12_guard_trade_attempt_mutation();

ALTER TABLE trade_attempts DROP CONSTRAINT IF EXISTS trade_attempts_status_check;
ALTER TABLE trade_attempts
  ADD CONSTRAINT trade_attempts_status_check CHECK(status IN(
    'reserved','preparing','submitting','submitted','confirming','confirmed',
    'submission_uncertain','reconciliation_required','failure_verifying',
    'definitive_failed_no_fill','retry_blocked','superseded','rejected','failed'
  ));

ALTER TABLE trade_orders DROP CONSTRAINT IF EXISTS trade_orders_normalized_status_check;
ALTER TABLE trade_orders
  ADD CONSTRAINT trade_orders_normalized_status_check CHECK(normalized_status IN(
    'submitted','pending','chain_verifying','failure_verifying',
    'definitive_failed_no_fill','confirmed','failed','expired','unknown'
  ));
DROP INDEX IF EXISTS idx_trade_orders_due;
CREATE INDEX idx_trade_orders_due
  ON trade_orders(normalized_status, next_query_at)
  WHERE normalized_status IN(
    'submitted','pending','chain_verifying','failure_verifying',
    'definitive_failed_no_fill','unknown'
  );

CREATE TABLE IF NOT EXISTS wallet_write_lanes (
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth','robinhood')),
  wallet_address text NOT NULL,
  lane_key text NOT NULL UNIQUE,
  state text NOT NULL DEFAULT 'idle' CHECK(state IN('idle','submitting','quarantined')),
  owner_attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  reason_code text,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  lease_expires_at timestamptz,
  quarantined_at timestamptz,
  released_at timestamptz,
  released_by text,
  release_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY(chain, wallet_address)
);
CREATE INDEX IF NOT EXISTS idx_wallet_write_lanes_state
  ON wallet_write_lanes(state, updated_at);

CREATE TABLE IF NOT EXISTS chain_trade_circuits (
  chain text PRIMARY KEY CHECK(chain IN('sol','bsc','base','eth','robinhood')),
  state text NOT NULL DEFAULT 'open' CHECK(state IN('open','tripped')),
  consecutive_failures int NOT NULL DEFAULT 0 CHECK(consecutive_failures >= 0),
  threshold int NOT NULL DEFAULT 3 CHECK(threshold > 0),
  reason_code text,
  last_failure_attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  last_success_attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  last_failure_at timestamptz,
  last_success_at timestamptz,
  tripped_at timestamptz,
  reset_at timestamptz,
  reset_by text,
  reset_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
INSERT INTO chain_trade_circuits(chain)
VALUES ('sol'),('bsc'),('base'),('eth'),('robinhood')
ON CONFLICT (chain) DO NOTHING;

CREATE TABLE IF NOT EXISTS trade_failure_evidence (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES trade_attempts(id) ON DELETE CASCADE,
  snapshot_version int NOT NULL,
  evidence_type text NOT NULL,
  status text NOT NULL CHECK(status IN('observed','passed','failed','conflict','unavailable')),
  evidence_json jsonb NOT NULL,
  evidence_hash text NOT NULL UNIQUE,
  observed_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_failure_evidence_attempt
  ON trade_failure_evidence(attempt_id, created_at);

CREATE TABLE IF NOT EXISTS trade_retry_decisions (
  id bigserial PRIMARY KEY,
  intent_id bigint NOT NULL REFERENCES trade_intents(id) ON DELETE CASCADE,
  attempt_id bigint NOT NULL REFERENCES trade_attempts(id) ON DELETE CASCADE,
  decision text NOT NULL CHECK(decision IN('retry_scheduled','retry_blocked','uncertain','exhausted')),
  reason_code text NOT NULL,
  evidence_json jsonb NOT NULL DEFAULT '{}',
  code_version text NOT NULL,
  decided_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_trade_retry_decisions_intent
  ON trade_retry_decisions(intent_id, decided_at);

CREATE TABLE IF NOT EXISTS trade_reconciliation_incidents (
  id bigserial PRIMARY KEY,
  intent_id bigint REFERENCES trade_intents(id) ON DELETE SET NULL,
  attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  incident_type text NOT NULL CHECK(incident_type IN(
    'late_confirmation','multiple_fill','budget_reconciliation_deficit','manual_lane_release'
  )),
  severity text NOT NULL DEFAULT 'high' CHECK(severity IN('medium','high','critical')),
  status text NOT NULL DEFAULT 'open' CHECK(status IN('open','acknowledged','resolved')),
  details_json jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  resolved_at timestamptz,
  resolved_by text,
  resolution text
);
CREATE INDEX IF NOT EXISTS idx_trade_reconciliation_incidents_open
  ON trade_reconciliation_incidents(status, created_at)
  WHERE status <> 'resolved';

ALTER TABLE budget_reservations
  ADD COLUMN IF NOT EXISTS intent_id bigint REFERENCES trade_intents(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS fee_used_native numeric(38,18) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reservation_version int NOT NULL DEFAULT 1;
UPDATE budget_reservations AS reservation
SET intent_id = attempt.intent_id
FROM trade_attempts AS attempt
WHERE attempt.id = reservation.attempt_id AND reservation.intent_id IS NULL;
ALTER TABLE budget_reservations ALTER COLUMN intent_id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_budget_reservations_intent
  ON budget_reservations(intent_id);

ALTER TABLE budget_ledger
  ADD COLUMN IF NOT EXISTS intent_id bigint REFERENCES trade_intents(id) ON DELETE SET NULL;
UPDATE budget_ledger AS ledger
SET intent_id = attempt.intent_id
FROM trade_attempts AS attempt
WHERE attempt.id = ledger.attempt_id AND ledger.intent_id IS NULL;
ALTER TABLE budget_ledger DROP CONSTRAINT IF EXISTS budget_ledger_entry_type_check;
ALTER TABLE budget_ledger
  ADD CONSTRAINT budget_ledger_entry_type_check
  CHECK(entry_type IN('reserve','commit','release','adjustment','fee_commit','deficit'));

INSERT INTO chain_live_readiness(chain, implemented, live_enabled)
VALUES ('robinhood', false, false)
ON CONFLICT (chain) DO NOTHING;

UPDATE config
SET value_json = jsonb_set(
  jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          jsonb_set(value_json, '{robinhood,enabled}', 'false'::jsonb, true),
          '{robinhood,nativeSymbol}', '"ETH"'::jsonb, true
        ),
        '{robinhood,retryEnabled}', 'false'::jsonb, true
      ),
      '{robinhood,maxRetries}', '0'::jsonb, true
    ),
    '{robinhood,retryWindowMs}', '30000'::jsonb, true
  ),
  '{robinhood,failureEvidenceWindowMs}', '30000'::jsonb, true
), updated_at = NOW()
WHERE key = 'chain_configs' AND value_json ? 'robinhood';

UPDATE config
SET value_json = (
  SELECT jsonb_object_agg(chain_key, chain_value || jsonb_build_object(
    'retryEnabled', false,
    'maxRetries', CASE WHEN chain_key = 'robinhood' THEN 0 ELSE 2 END,
    'retryWindowMs', CASE chain_key
      WHEN 'sol' THEN 8000 WHEN 'bsc' THEN 10000 WHEN 'base' THEN 12000 ELSE 30000 END,
    'failureEvidenceWindowMs', 30000,
    'feeEscalationEnabled', false,
    'maxRetryFeeNative', 0,
    'exitGasReserve', 0
  ))
  FROM jsonb_each(value_json) AS chains(chain_key, chain_value)
), updated_at = NOW()
WHERE key = 'chain_configs';
