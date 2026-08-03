-- P20 scheme A: keep dynamic policy budgets separate by native chain.
-- Existing legacy amounts seed every allowed chain as an explicit starting value;
-- operators must review the matrix before enabling Paper or Live.

ALTER TABLE x_actor_dynamic_policies
  ADD COLUMN IF NOT EXISTS chain_budgets jsonb NOT NULL DEFAULT '{}'::jsonb;

UPDATE x_actor_dynamic_policies
SET chain_budgets = COALESCE((
  SELECT jsonb_object_agg(chain_id, jsonb_build_object(
    'budget_per_trade', budget_per_trade,
    'daily_budget', daily_budget
  ))
  FROM unnest(allowed_chain_ids) AS chain_id
), '{}'::jsonb)
WHERE chain_budgets = '{}'::jsonb
  AND cardinality(allowed_chain_ids) > 0;

CREATE TABLE IF NOT EXISTS dynamic_policy_usage_daily_by_chain (
  actor_policy_id bigint NOT NULL REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  usage_date date NOT NULL,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  spent_native numeric(18,8) NOT NULL DEFAULT 0,
  reserved_native numeric(18,8) NOT NULL DEFAULT 0,
  new_token_count int NOT NULL DEFAULT 0,
  signal_count int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY(actor_policy_id, usage_date, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_policy_usage_daily_chain
  ON dynamic_policy_usage_daily_by_chain(actor_policy_id, usage_date, chain_id);
