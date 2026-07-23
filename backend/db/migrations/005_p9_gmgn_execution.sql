ALTER TABLE trade_signals DROP CONSTRAINT IF EXISTS trade_signals_status_check;
ALTER TABLE trade_signals
  ADD CONSTRAINT trade_signals_status_check
  CHECK(status IN(
    'signal_only','recorded','pending','pending_risk','approved','execution_reserved',
    'rejected','executed','expired'
  ));

ALTER TABLE positions DROP CONSTRAINT IF EXISTS positions_status_check;
ALTER TABLE positions
  ADD CONSTRAINT positions_status_check
  CHECK(status IN(
    'pending','open','open_unprotected','open_protected','partially_closed','closing',
    'closed','protection_failed','close_uncertain','tp_hit','sl_hit','manual_close','failed'
  ));

ALTER TABLE x_provider_events
  ADD COLUMN IF NOT EXISTS transport_received_at timestamptz,
  ADD COLUMN IF NOT EXISTS inbox_committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS signal_committed_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_path text,
  ADD COLUMN IF NOT EXISTS receive_to_inbox_ms int,
  ADD COLUMN IF NOT EXISTS receive_to_signal_ms int;

CREATE TABLE IF NOT EXISTS trade_attempts (
  id bigserial PRIMARY KEY,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  position_id int REFERENCES positions(id) ON DELETE SET NULL,
  side text NOT NULL CHECK(side IN('buy','sell','strategy_create','strategy_cancel')),
  idempotency_key text NOT NULL UNIQUE,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  wallet_address text NOT NULL,
  input_token text NOT NULL,
  output_token text NOT NULL,
  input_amount_raw text NOT NULL,
  input_amount_display numeric(38,18),
  output_amount_raw text,
  output_amount_display numeric(38,18),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN(
    'reserved','preparing','submitting','submitted','confirming','confirmed',
    'submission_uncertain','reconciliation_required','rejected','failed'
  )),
  request_fingerprint text NOT NULL,
  error_code text,
  error_class text,
  requires_manual_review boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  submit_started_at timestamptz,
  submitted_at timestamptz,
  confirmed_at timestamptz,
  last_reconciled_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS trade_orders (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES trade_attempts(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'gmgn',
  provider_order_id text,
  auth_client_id text,
  tx_hash text,
  provider_status text,
  normalized_status text NOT NULL DEFAULT 'submitted' CHECK(normalized_status IN(
    'submitted','pending','chain_verifying','confirmed','failed','expired','unknown'
  )),
  input_token text,
  output_token text,
  input_amount_raw text,
  output_amount_raw text,
  input_decimals int,
  output_decimals int,
  input_amount_display numeric(38,18),
  output_amount_display numeric(38,18),
  price_usd numeric(38,18),
  gas_native numeric(38,18),
  gas_usd numeric(38,18),
  platform_fee_native numeric(38,18),
  route_fee_native numeric(38,18),
  quote_json jsonb NOT NULL DEFAULT '{}',
  report_json jsonb NOT NULL DEFAULT '{}',
  last_response_json jsonb NOT NULL DEFAULT '{}',
  submitted_at timestamptz NOT NULL DEFAULT NOW(),
  confirmed_at timestamptz,
  last_queried_at timestamptz,
  next_query_at timestamptz NOT NULL DEFAULT NOW(),
  query_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_orders_provider_id
  ON trade_orders(provider, provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS strategy_groups (
  id bigserial PRIMARY KEY,
  position_id int NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  provider text NOT NULL DEFAULT 'gmgn',
  provider_order_id text,
  close_attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  strategy_version int NOT NULL DEFAULT 1,
  total_amount_raw text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN(
    'pending','running','partially_filled','triggered','cancelling','cancelled',
    'completed','failed','unknown'
  )),
  requested_params jsonb NOT NULL DEFAULT '{}',
  provider_params jsonb NOT NULL DEFAULT '{}',
  provider_status text,
  strategy_status text,
  close_amount_raw text,
  close_output_amount_raw text,
  close_tx_hash text,
  close_price numeric(38,18),
  close_time timestamptz,
  last_reconciled_at timestamptz,
  next_query_at timestamptz NOT NULL DEFAULT NOW(),
  query_count int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(position_id, strategy_version)
);

CREATE TABLE IF NOT EXISTS strategy_legs (
  id bigserial PRIMARY KEY,
  group_id bigint NOT NULL REFERENCES strategy_groups(id) ON DELETE CASCADE,
  provider_order_id text,
  leg_index int NOT NULL,
  order_type text NOT NULL,
  amount_raw text NOT NULL,
  trigger_value text,
  status text NOT NULL DEFAULT 'pending',
  strategy_status text,
  requested_params jsonb NOT NULL DEFAULT '{}',
  provider_params jsonb NOT NULL DEFAULT '{}',
  filled_amount_raw text NOT NULL DEFAULT '0',
  exit_order_id text,
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(group_id, leg_index)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_legs_provider_order
  ON strategy_legs(provider_order_id) WHERE provider_order_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_strategy_groups_provider_order
  ON strategy_groups(provider_order_id) WHERE provider_order_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS position_lots (
  id bigserial PRIMARY KEY,
  position_id int NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  buy_order_id bigint REFERENCES trade_orders(id) ON DELETE SET NULL,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  wallet_address text NOT NULL,
  token_address text NOT NULL,
  token_decimals int NOT NULL,
  opened_amount_raw text NOT NULL,
  remaining_amount_raw text NOT NULL,
  reserved_by_strategy_raw text NOT NULL DEFAULT '0',
  externally_changed_amount_raw text NOT NULL DEFAULT '0',
  cost_native numeric(38,18),
  cost_usd numeric(38,18),
  fee_native numeric(38,18),
  realized_cost_native numeric(38,18) NOT NULL DEFAULT 0,
  realized_proceeds_native numeric(38,18) NOT NULL DEFAULT 0,
  opened_at timestamptz NOT NULL DEFAULT NOW(),
  last_reconciled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_receipts (
  id bigserial PRIMARY KEY,
  order_id bigint REFERENCES trade_orders(id) ON DELETE CASCADE,
  strategy_group_id bigint REFERENCES strategy_groups(id) ON DELETE CASCADE,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  tx_hash text NOT NULL,
  block_ref text,
  receipt_status text NOT NULL DEFAULT 'pending' CHECK(receipt_status IN(
    'pending','confirmed','failed','reorged','replaced','dropped','unavailable'
  )),
  confirmations int NOT NULL DEFAULT 0,
  transfer_json jsonb NOT NULL DEFAULT '[]',
  raw_receipt_json jsonb NOT NULL DEFAULT '{}',
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(num_nonnulls(order_id, strategy_group_id) = 1),
  UNIQUE(chain, tx_hash)
);

CREATE TABLE IF NOT EXISTS trade_attempt_events (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL REFERENCES trade_attempts(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  reason text,
  actor text NOT NULL DEFAULT 'system',
  provider_request_id text,
  http_status int,
  latency_ms int,
  summary jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_reservations (
  id bigserial PRIMARY KEY,
  attempt_id bigint NOT NULL UNIQUE REFERENCES trade_attempts(id) ON DELETE CASCADE,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  native_symbol text NOT NULL,
  amount_native numeric(38,18) NOT NULL,
  fee_native numeric(38,18) NOT NULL DEFAULT 0,
  amount_usd_snapshot numeric(38,18),
  status text NOT NULL DEFAULT 'reserved' CHECK(status IN('reserved','committed','released')),
  reserved_at timestamptz NOT NULL DEFAULT NOW(),
  committed_at timestamptz,
  released_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id bigserial PRIMARY KEY,
  reservation_id bigint REFERENCES budget_reservations(id) ON DELETE SET NULL,
  attempt_id bigint REFERENCES trade_attempts(id) ON DELETE SET NULL,
  whitelist_id int REFERENCES ca_whitelist(id) ON DELETE SET NULL,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  entry_type text NOT NULL CHECK(entry_type IN('reserve','commit','release','adjustment')),
  amount_native numeric(38,18) NOT NULL,
  fee_native numeric(38,18) NOT NULL DEFAULT 0,
  amount_usd_snapshot numeric(38,18),
  reason text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prepare_tokens (
  id bigserial PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK(purpose IN('buy','close')),
  signal_id int REFERENCES trade_signals(id) ON DELETE CASCADE,
  position_id int REFERENCES positions(id) ON DELETE CASCADE,
  operator_id text NOT NULL,
  snapshot_hash text NOT NULL,
  snapshot_json jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS provider_rate_events (
  id bigserial PRIMARY KEY,
  provider text NOT NULL DEFAULT 'gmgn',
  endpoint text NOT NULL,
  method text NOT NULL,
  weight int NOT NULL,
  http_status int,
  latency_ms int,
  remaining numeric(12,4),
  reset_at timestamptz,
  event_type text NOT NULL DEFAULT 'request',
  error_code text,
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notification_outbox (
  id bigserial PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN('pending','sending','sent','failed')),
  attempt_count int NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT NOW(),
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chain_live_readiness (
  chain text PRIMARY KEY CHECK(chain IN('sol','bsc','base','eth')),
  implemented boolean NOT NULL DEFAULT false,
  contract_tested boolean NOT NULL DEFAULT false,
  shadow_verified boolean NOT NULL DEFAULT false,
  live_enabled boolean NOT NULL DEFAULT false,
  wallet_address text,
  balances_json jsonb NOT NULL DEFAULT '[]',
  native_balance numeric(38,18),
  last_error text,
  last_checked_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO chain_live_readiness(chain, implemented)
VALUES ('sol', true), ('bsc', true), ('base', true), ('eth', true)
ON CONFLICT (chain) DO NOTHING;

INSERT INTO trade_attempts
  (signal_id, whitelist_id, position_id, side, idempotency_key, chain,
   wallet_address, input_token, output_token, input_amount_raw,
   input_amount_display, output_amount_raw, output_amount_display,
   status, request_fingerprint, metadata, submitted_at, confirmed_at)
SELECT position.signal_id, position.whitelist_id, position.id, 'buy',
       'legacy-position:' || position.id || ':buy', position.chain_id,
       'gmgn-managed-wallet', 'legacy-native', position.contract_address,
       '0', position.amount_in, '0', position.amount_out,
       'confirmed', md5('legacy-position:' || position.id),
       jsonb_build_object('legacy_backfill_required', true),
       position.opened_at, position.opened_at
FROM positions AS position
WHERE position.execution_mode = 'live'
  AND position.buy_order_id IS NOT NULL
  AND position.chain_id IN ('sol','bsc','base','eth')
ON CONFLICT (idempotency_key) DO NOTHING;

INSERT INTO trade_orders
  (attempt_id, provider_order_id, tx_hash, provider_status, normalized_status,
   input_amount_display, output_amount_display, submitted_at, confirmed_at,
   next_query_at, quote_json, report_json, last_response_json)
SELECT attempt.id, position.buy_order_id, position.buy_tx_hash,
       'legacy_confirmed', 'confirmed', position.amount_in, position.amount_out,
       position.opened_at, position.opened_at, NOW(), '{}', '{}',
       jsonb_build_object('legacy_backfill_required', true)
FROM trade_attempts AS attempt
JOIN positions AS position ON position.id = attempt.position_id
WHERE attempt.metadata @> '{"legacy_backfill_required": true}'::jsonb
  AND position.buy_order_id IS NOT NULL
ON CONFLICT DO NOTHING;

INSERT INTO chain_receipts
  (order_id, chain, tx_hash, receipt_status, raw_receipt_json)
SELECT orders.id, attempt.chain, orders.tx_hash, 'unavailable',
       jsonb_build_object('legacy_backfill_required', true)
FROM trade_orders AS orders
JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
WHERE orders.tx_hash IS NOT NULL
  AND orders.last_response_json @> '{"legacy_backfill_required": true}'::jsonb
ON CONFLICT (chain, tx_hash) DO NOTHING;

CREATE TABLE IF NOT EXISTS trade_runtime_state (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trade_attempts_status_created
  ON trade_attempts(status, created_at);
CREATE INDEX IF NOT EXISTS idx_trade_orders_due
  ON trade_orders(normalized_status, next_query_at)
  WHERE normalized_status IN('submitted','pending','chain_verifying','unknown');
CREATE INDEX IF NOT EXISTS idx_position_lots_position
  ON position_lots(position_id, id);
CREATE INDEX IF NOT EXISTS idx_strategy_groups_status
  ON strategy_groups(status, next_query_at);
CREATE INDEX IF NOT EXISTS idx_budget_ledger_chain_created
  ON budget_ledger(chain, created_at);
CREATE INDEX IF NOT EXISTS idx_rate_events_created
  ON provider_rate_events(provider, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_outbox_due
  ON notification_outbox(status, next_attempt_at)
  WHERE status IN('pending','failed');
