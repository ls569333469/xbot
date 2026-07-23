CREATE TABLE IF NOT EXISTS shadow_run_sessions (
  id bigserial PRIMARY KEY,
  policy_hash text NOT NULL,
  policy_json jsonb NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK(status IN(
    'running','interrupted','completed','failed'
  )),
  required_duration_hours int NOT NULL DEFAULT 24,
  required_samples int NOT NULL DEFAULT 50,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  last_heartbeat_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  stop_reason text,
  code_version text NOT NULL DEFAULT 'local-worktree',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_shadow_run_sessions_running
  ON shadow_run_sessions((status)) WHERE status = 'running';
CREATE INDEX IF NOT EXISTS idx_shadow_run_sessions_started
  ON shadow_run_sessions(started_at DESC);

ALTER TABLE shadow_trade_evaluations
  ADD COLUMN IF NOT EXISTS session_id bigint REFERENCES shadow_run_sessions(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_shadow_trade_evaluations_session
  ON shadow_trade_evaluations(session_id, status, completed_at);
