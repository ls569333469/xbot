CREATE TABLE IF NOT EXISTS chain_readiness_evidence (
  id bigserial PRIMARY KEY,
  chain text NOT NULL CHECK(chain IN('sol','bsc','base','eth')),
  evidence_type text NOT NULL CHECK(evidence_type IN(
    'contract_probe','manual_e2e','shadow_report','live_approval'
  )),
  whitelist_id int,
  status text NOT NULL CHECK(status IN('passed','failed')),
  evidence_hash text NOT NULL UNIQUE,
  summary_json jsonb NOT NULL DEFAULT '{}',
  migration_name text NOT NULL,
  code_version text NOT NULL DEFAULT 'local-worktree',
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chain_readiness_evidence_lookup
  ON chain_readiness_evidence(chain, evidence_type, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_chain_readiness_evidence_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'chain readiness evidence is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chain_readiness_evidence_immutable
  ON chain_readiness_evidence;
CREATE TRIGGER trg_chain_readiness_evidence_immutable
BEFORE UPDATE OR DELETE ON chain_readiness_evidence
FOR EACH ROW EXECUTE FUNCTION prevent_chain_readiness_evidence_mutation();
