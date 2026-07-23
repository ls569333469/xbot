CREATE TABLE IF NOT EXISTS shadow_trade_evaluations (
  id bigserial PRIMARY KEY,
  signal_id int NOT NULL UNIQUE REFERENCES trade_signals(id) ON DELETE CASCADE,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  status text NOT NULL CHECK(status IN('running','passed','rejected','failed')),
  risk_snapshot jsonb NOT NULL DEFAULT '{}',
  quote_summary jsonb NOT NULL DEFAULT '{}',
  error_code text,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shadow_trade_evaluations_created
  ON shadow_trade_evaluations(created_at DESC);
