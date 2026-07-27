-- P16.1 separates pre-launch CA discovery from fixed-CA whitelist matching.
-- Historical project direct sources are disabled, not deleted or auto-converted.

CREATE TABLE IF NOT EXISTS project_launch_rules (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  project_name text,
  budget_per_trade numeric(18,8) NOT NULL CHECK(budget_per_trade > 0),
  total_budget numeric(18,8) NOT NULL CHECK(total_budget >= budget_per_trade),
  slippage numeric(5,2) NOT NULL DEFAULT 10 CHECK(slippage > 0 AND slippage <= 100),
  allow_repeat_buy boolean NOT NULL DEFAULT false,
  max_repeat_buys int NOT NULL DEFAULT 1 CHECK(max_repeat_buys >= 1),
  exit_strategy jsonb NOT NULL,
  exit_strategy_version int NOT NULL DEFAULT 1 CHECK(exit_strategy_version >= 1),
  status text NOT NULL DEFAULT 'active'
    CHECK(status IN('active','paused','triggered','expired')),
  discovery_count int NOT NULL DEFAULT 0 CHECK(discovery_count BETWEEN 0 AND 1),
  triggered_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_project_launch_rules_active
  ON project_launch_rules(chain_id, status, expires_at);

CREATE TABLE IF NOT EXISTS project_launch_sources (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'project',
  event_types text[] NOT NULL DEFAULT ARRAY['tweet']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT project_launch_sources_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['tweet','retweet','quote','reply']::text[]
  ),
  UNIQUE(launch_rule_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_sources_actor
  ON project_launch_sources(actor_id, enabled);

CREATE TABLE IF NOT EXISTS project_launch_relations (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  target_x_handle text NOT NULL,
  event_types text[] NOT NULL DEFAULT ARRAY['retweet','quote','reply']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT project_launch_relations_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['retweet','quote','reply']::text[]
  ),
  UNIQUE(launch_rule_id, actor_id, target_x_handle)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_relations_actor
  ON project_launch_relations(actor_id, enabled);

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS launch_rule_id bigint
    REFERENCES project_launch_rules(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_ca_whitelist_launch_rule
  ON ca_whitelist(launch_rule_id);

ALTER TABLE x_signal_source_rules
  DROP CONSTRAINT IF EXISTS x_signal_source_rules_source_kind_check;
ALTER TABLE x_signal_source_rules
  ADD CONSTRAINT x_signal_source_rules_source_kind_check
    CHECK(source_kind IN('project','ecosystem','launch'));

INSERT INTO whitelist_x_accounts
  (whitelist_id, handle, role, usage, evidence_snapshot)
SELECT account.whitelist_id,
       lower(regexp_replace(account.handle, '^@+', '')),
       account.role, 'identity', account.evidence_snapshot
FROM whitelist_x_accounts AS account
WHERE account.usage = 'direct_source'
ON CONFLICT (whitelist_id, handle, usage) DO UPDATE
  SET role = EXCLUDED.role,
      evidence_snapshot = EXCLUDED.evidence_snapshot,
      updated_at = NOW();

INSERT INTO whitelist_x_accounts
  (whitelist_id, handle, role, usage, evidence_snapshot)
SELECT source.whitelist_id,
       lower(regexp_replace(actor.x_handle, '^@+', '')),
       COALESCE(account.role, 'project'),
       'identity',
       COALESCE(account.evidence_snapshot, '{}'::jsonb)
FROM x_signal_source_rules AS source
JOIN x_kol_accounts AS actor ON actor.id = source.actor_id
LEFT JOIN whitelist_x_accounts AS account
  ON account.whitelist_id = source.whitelist_id
 AND account.usage = 'direct_source'
 AND lower(regexp_replace(account.handle, '^@+', ''))
     = lower(regexp_replace(actor.x_handle, '^@+', ''))
WHERE source.source_kind = 'project'
ON CONFLICT (whitelist_id, handle, usage) DO UPDATE
  SET role = EXCLUDED.role,
      evidence_snapshot = EXCLUDED.evidence_snapshot,
      updated_at = NOW();

UPDATE x_signal_source_rules
SET enabled = false, updated_at = NOW()
WHERE source_kind = 'project' AND enabled = true;

CREATE TABLE IF NOT EXISTS project_launch_discoveries (
  id bigserial PRIMARY KEY,
  launch_rule_id bigint NOT NULL REFERENCES project_launch_rules(id) ON DELETE RESTRICT,
  activity_id int NOT NULL REFERENCES x_activities(id) ON DELETE RESTRICT,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE RESTRICT,
  signal_id int REFERENCES trade_signals(id) ON DELETE SET NULL,
  trigger_kind text NOT NULL CHECK(trigger_kind IN('project_source','ecosystem_relation')),
  actor_handle text NOT NULL,
  target_x_handle text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(launch_rule_id, chain_id, contract_address),
  UNIQUE(launch_rule_id, activity_id)
);
CREATE INDEX IF NOT EXISTS idx_project_launch_discoveries_rule
  ON project_launch_discoveries(launch_rule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_project_launch_discoveries_contract
  ON project_launch_discoveries(chain_id, contract_address, created_at);
