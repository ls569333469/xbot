BEGIN;

CREATE TABLE IF NOT EXISTS token_research_xai_checkpoints (
  report_id bigint PRIMARY KEY REFERENCES token_research_reports(id) ON DELETE CASCADE,
  prompt_version text NOT NULL,
  search_status text NOT NULL DEFAULT 'pending'
    CHECK(search_status IN(
      'pending', 'searching', 'format_repair', 'targeted_followup',
      'result_ready', 'completed', 'insufficient', 'failed'
    )),
  evidence_text text,
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  search_usage jsonb,
  search_tool_calls int NOT NULL DEFAULT 0
    CHECK(search_tool_calls BETWEEN 0 AND 8),
  grok_request_attempts int NOT NULL DEFAULT 0
    CHECK(grok_request_attempts BETWEEN 0 AND 2),
  second_request_reason text
    CHECK(second_request_reason IS NULL OR second_request_reason IN('format_repair','targeted_followup')),
  last_error_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_token_research_xai_evidence_length
    CHECK(evidence_text IS NULL OR char_length(evidence_text) <= 20000)
);

CREATE INDEX IF NOT EXISTS idx_token_research_xai_checkpoints_expiry
  ON token_research_xai_checkpoints(expires_at);

COMMIT;
