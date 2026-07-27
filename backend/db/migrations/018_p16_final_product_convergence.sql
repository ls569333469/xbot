-- P16 final convergence: CA-only X sources and durable research jobs.
-- Existing rule modes are backed up before they are normalized. This migration
-- does not modify positions, orders, trade attempts, or historical signals.

CREATE TABLE IF NOT EXISTS p16_source_rule_match_mode_backup (
  source_rule_id bigint PRIMARY KEY,
  whitelist_id int NOT NULL,
  actor_id int NOT NULL,
  match_mode text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT NOW()
);

INSERT INTO p16_source_rule_match_mode_backup
  (source_rule_id, whitelist_id, actor_id, match_mode)
SELECT id, whitelist_id, actor_id, match_mode
FROM x_signal_source_rules
ON CONFLICT (source_rule_id) DO NOTHING;

ALTER TABLE x_signal_source_rules
  ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'project';

ALTER TABLE x_signal_source_rules
  DROP CONSTRAINT IF EXISTS x_signal_source_rules_match_mode_check;
ALTER TABLE x_signal_source_rules
  DROP CONSTRAINT IF EXISTS x_signal_source_rules_source_kind_check;

UPDATE x_signal_source_rules
SET match_mode = 'ca_only', source_kind = COALESCE(NULLIF(source_kind, ''), 'project'),
    updated_at = NOW()
WHERE match_mode <> 'ca_only' OR source_kind IS NULL OR source_kind = '';

ALTER TABLE x_signal_source_rules
  ALTER COLUMN match_mode SET DEFAULT 'ca_only';
ALTER TABLE x_signal_source_rules
  ADD CONSTRAINT x_signal_source_rules_match_mode_check
    CHECK(match_mode = 'ca_only');
ALTER TABLE x_signal_source_rules
  ADD CONSTRAINT x_signal_source_rules_source_kind_check
    CHECK(source_kind IN('project','ecosystem'));

ALTER TABLE token_research_reports
  ADD COLUMN IF NOT EXISTS prompt_version text NOT NULL DEFAULT 'p16-project-team-v2',
  ADD COLUMN IF NOT EXISTS model_name text,
  ADD COLUMN IF NOT EXISTS xai_duration_ms int,
  ADD COLUMN IF NOT EXISTS xai_error_code text,
  ADD COLUMN IF NOT EXISTS cache_key text,
  ADD COLUMN IF NOT EXISTS analysis_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS analysis_finished_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_token_research_reports_cache
  ON token_research_reports(cache_key, expires_at DESC);

CREATE TABLE IF NOT EXISTS research_jobs (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  mode text NOT NULL CHECK(mode IN('single','batch')),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','running','completed','partial','failed')),
  total_count int NOT NULL CHECK(total_count BETWEEN 1 AND 30),
  completed_count int NOT NULL DEFAULT 0,
  failed_count int NOT NULL DEFAULT 0,
  prompt_version text NOT NULL DEFAULT 'p16-project-team-v2',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_research_jobs_status
  ON research_jobs(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS research_job_items (
  id bigserial PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES research_jobs(id) ON DELETE CASCADE,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK(status IN('queued','gmgn','grok','verification','completed','failed')),
  report_id bigint REFERENCES token_research_reports(id) ON DELETE SET NULL,
  attempt_count int NOT NULL DEFAULT 0,
  error_code text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms int,
  locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(job_id, contract_address)
);
CREATE INDEX IF NOT EXISTS idx_research_job_items_claim
  ON research_job_items(status, locked_at, created_at);
CREATE INDEX IF NOT EXISTS idx_research_job_items_job
  ON research_job_items(job_id, id);
