-- P14 separates code capability, contract validation, acceptance, and production approval.

ALTER TABLE chain_readiness_evidence
  ADD COLUMN IF NOT EXISTS context_hash text,
  ADD COLUMN IF NOT EXISTS valid_until timestamptz;

CREATE INDEX IF NOT EXISTS idx_chain_readiness_evidence_valid
  ON chain_readiness_evidence(chain, evidence_type, valid_until, created_at DESC);

CREATE TABLE IF NOT EXISTS live_acceptance_scopes (
  id bigserial PRIMARY KEY,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth','robinhood')),
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'active' CHECK(status IN('active','completed','cancelled')),
  contract_evidence_id bigint NOT NULL REFERENCES chain_readiness_evidence(id) ON DELETE RESTRICT,
  context_hash text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL,
  completed_by text,
  completion_reason text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(expires_at > created_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_live_acceptance_scope_active
  ON live_acceptance_scopes((status)) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_live_acceptance_scope_lookup
  ON live_acceptance_scopes(status, expires_at DESC, id DESC);

-- The unified GMGN execution path is implemented for Robinhood Chain. Production
-- approval remains closed until a valid contract probe and manual E2E evidence pass.
UPDATE chain_live_readiness
SET implemented = true, live_enabled = false, updated_at = NOW()
WHERE chain = 'robinhood';

-- Preserve production approval only for the four chains that already have a
-- confirmed Buy, Sell, and on-chain receipt history in this database.
UPDATE chain_live_readiness AS readiness
SET live_enabled = true, updated_at = NOW()
WHERE readiness.chain IN ('sol','bsc','base','eth')
  AND readiness.contract_tested = true
  AND EXISTS (
    SELECT 1 FROM trade_attempts AS attempt
    WHERE attempt.chain = readiness.chain AND attempt.side = 'buy' AND attempt.status = 'confirmed'
  )
  AND EXISTS (
    SELECT 1 FROM trade_attempts AS attempt
    WHERE attempt.chain = readiness.chain AND attempt.side = 'sell' AND attempt.status = 'confirmed'
  )
  AND EXISTS (
    SELECT 1
    FROM chain_receipts AS receipt
    JOIN trade_orders AS orders ON orders.id = receipt.order_id
    JOIN trade_attempts AS attempt ON attempt.id = orders.attempt_id
    WHERE attempt.chain = readiness.chain AND receipt.receipt_status = 'confirmed'
  );
