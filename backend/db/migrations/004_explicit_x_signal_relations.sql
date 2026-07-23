CREATE TABLE IF NOT EXISTS x_signal_relations (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  kol_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_handle text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, kol_id, target_x_handle)
);

CREATE INDEX IF NOT EXISTS idx_x_signal_relations_kol
  ON x_signal_relations(kol_id, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_target
  ON x_signal_relations(target_x_handle, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_relations_whitelist
  ON x_signal_relations(whitelist_id, enabled);

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS matched_relation_ids bigint[] NOT NULL DEFAULT '{}';

-- Preserve the old behavior only when one enabled actor makes the mapping unambiguous.
INSERT INTO x_signal_relations (whitelist_id, kol_id, target_x_handle)
SELECT whitelist.id, kol.id, lower(regexp_replace(handle, '^@+', ''))
FROM ca_whitelist AS whitelist
CROSS JOIN x_kol_accounts AS kol
CROSS JOIN LATERAL unnest(whitelist.project_x_handles) AS handle
WHERE kol.enabled = true
  AND (SELECT COUNT(*) FROM x_kol_accounts WHERE enabled = true) = 1
  AND length(trim(handle)) > 0
ON CONFLICT (whitelist_id, kol_id, target_x_handle) DO NOTHING;
