-- P16: versioned exit strategies, whitelist templates, research reports, and
-- explicit direct-source X rules. This migration does not alter positions or
-- historical trade attempts.

ALTER TABLE ca_whitelist
  ADD COLUMN IF NOT EXISTS exit_strategy jsonb,
  ADD COLUMN IF NOT EXISTS exit_strategy_version int NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS token_logo_url text,
  ADD COLUMN IF NOT EXISTS token_official_x_handle text,
  ADD COLUMN IF NOT EXISTS token_website_url text,
  ADD COLUMN IF NOT EXISTS token_metadata_source text,
  ADD COLUMN IF NOT EXISTS token_metadata_fetched_at timestamptz;

UPDATE ca_whitelist
SET exit_strategy = jsonb_build_object(
  'version', 1,
  'sell_ratio_type', 'buy_amount',
  'legs', jsonb_build_array(
    jsonb_build_object(
      'type', 'take_profit',
      'trigger_pct', COALESCE(auto_tp_pct, 100),
      'sell_pct', 100
    ),
    jsonb_build_object(
      'type', 'stop_loss',
      'drop_pct', COALESCE(auto_sl_pct, 20),
      'sell_pct', 100
    )
  )
)
WHERE exit_strategy IS NULL;

ALTER TABLE ca_whitelist
  ALTER COLUMN exit_strategy SET DEFAULT
    '{"version":1,"sell_ratio_type":"buy_amount","legs":[{"type":"take_profit","trigger_pct":100,"sell_pct":100},{"type":"stop_loss","drop_pct":20,"sell_pct":100}]}'::jsonb,
  ALTER COLUMN exit_strategy SET NOT NULL;

CREATE TABLE IF NOT EXISTS whitelist_templates (
  id bigserial PRIMARY KEY,
  name text NOT NULL,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  template_snapshot jsonb NOT NULL,
  version int NOT NULL DEFAULT 1,
  is_default boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_templates_default_chain
  ON whitelist_templates(chain_id) WHERE is_default = true;
CREATE INDEX IF NOT EXISTS idx_whitelist_templates_chain
  ON whitelist_templates(chain_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS token_research_reports (
  id bigserial PRIMARY KEY,
  chain_id text NOT NULL CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  status text NOT NULL DEFAULT 'completed'
    CHECK(status IN('pending','completed','partial','failed')),
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  candidates jsonb NOT NULL DEFAULT '[]'::jsonb,
  analyzer_version text NOT NULL DEFAULT 'p16-v1',
  fetched_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz NOT NULL DEFAULT (NOW() + INTERVAL '1 hour'),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_token_research_reports_lookup
  ON token_research_reports(chain_id, contract_address, expires_at DESC);

CREATE TABLE IF NOT EXISTS x_actor_directory (
  id bigserial PRIMARY KEY,
  x_user_id text,
  handle text NOT NULL,
  display_name text,
  avatar_url text,
  role_types text[] NOT NULL DEFAULT '{}',
  organization text,
  chain_ids text[] NOT NULL DEFAULT '{}',
  source_types text[] NOT NULL DEFAULT '{}',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence text NOT NULL DEFAULT 'unverified'
    CHECK(confidence IN('verified','high','medium','low','unverified')),
  status text NOT NULL DEFAULT 'candidate'
    CHECK(status IN('candidate','confirmed','rejected','archived')),
  follower_count bigint,
  is_verified boolean NOT NULL DEFAULT false,
  is_favorite boolean NOT NULL DEFAULT false,
  use_count int NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  last_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_x_actor_directory_handle
  ON x_actor_directory(lower(handle));
CREATE INDEX IF NOT EXISTS idx_x_actor_directory_search
  ON x_actor_directory(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS whitelist_x_accounts (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  handle text NOT NULL,
  role text NOT NULL DEFAULT 'project',
  usage text NOT NULL DEFAULT 'identity'
    CHECK(usage IN('identity','direct_source','interaction_target')),
  evidence_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(whitelist_id, handle, usage)
);
CREATE INDEX IF NOT EXISTS idx_whitelist_x_accounts_whitelist
  ON whitelist_x_accounts(whitelist_id, usage);

CREATE TABLE IF NOT EXISTS x_signal_source_rules (
  id bigserial PRIMARY KEY,
  whitelist_id int NOT NULL REFERENCES ca_whitelist(id) ON DELETE CASCADE,
  actor_id int NOT NULL REFERENCES x_kol_accounts(id) ON DELETE CASCADE,
  event_types text[] NOT NULL DEFAULT ARRAY['tweet']::text[],
  match_mode text NOT NULL DEFAULT 'ca_or_ticker'
    CHECK(match_mode IN('ca_or_ticker','any_post')),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CONSTRAINT x_signal_source_rules_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['tweet','retweet','quote','reply']::text[]
  ),
  UNIQUE(whitelist_id, actor_id)
);
CREATE INDEX IF NOT EXISTS idx_x_signal_source_rules_actor
  ON x_signal_source_rules(actor_id, enabled);
CREATE INDEX IF NOT EXISTS idx_x_signal_source_rules_whitelist
  ON x_signal_source_rules(whitelist_id, enabled);

ALTER TABLE trade_signals
  ADD COLUMN IF NOT EXISTS matched_source_rule_ids bigint[] NOT NULL DEFAULT '{}';

-- Preserve project identities before separating legacy tweet behavior from
-- Actor -> Target interaction relations.
INSERT INTO whitelist_x_accounts (whitelist_id, handle, role, usage)
SELECT DISTINCT whitelist_id, lower(regexp_replace(target_x_handle, '^@+', '')),
       'project', 'interaction_target'
FROM x_signal_relations
ON CONFLICT (whitelist_id, handle, usage) DO NOTHING;

INSERT INTO x_signal_source_rules (whitelist_id, actor_id, event_types, match_mode, enabled)
SELECT whitelist_id, kol_id, ARRAY['tweet']::text[], 'ca_or_ticker', enabled
FROM x_signal_relations
WHERE 'tweet' = ANY(event_types)
ON CONFLICT (whitelist_id, actor_id) DO UPDATE
SET event_types = ARRAY(
      SELECT DISTINCT value
      FROM unnest(x_signal_source_rules.event_types || EXCLUDED.event_types) AS value
      ORDER BY value
    ),
    enabled = x_signal_source_rules.enabled OR EXCLUDED.enabled,
    updated_at = NOW();

-- Historical Tweet signals must keep resolvable evidence after their legacy
-- relation is converted into a direct-source rule.
UPDATE trade_signals AS signal
SET matched_source_rule_ids = ARRAY[source_rule.id]::bigint[],
    matched_relation_ids = '{}'::bigint[],
    updated_at = NOW()
FROM x_activities AS activity,
     x_signal_source_rules AS source_rule
WHERE activity.id = signal.activity_id
  AND lower(activity.activity_type) = 'tweet'
  AND cardinality(signal.matched_relation_ids) > 0
  AND source_rule.whitelist_id = signal.whitelist_id
  AND source_rule.actor_id = signal.kol_id
  AND 'tweet' = ANY(source_rule.event_types);

UPDATE x_signal_relations
SET event_types = array_remove(event_types, 'tweet'), updated_at = NOW()
WHERE 'tweet' = ANY(event_types) AND cardinality(event_types) > 1;

DELETE FROM x_signal_relations
WHERE event_types = ARRAY['tweet']::text[];

ALTER TABLE x_signal_relations
  ALTER COLUMN event_types SET DEFAULT ARRAY['retweet','quote','reply','follow']::text[];
ALTER TABLE x_signal_relations
  DROP CONSTRAINT IF EXISTS x_signal_relations_event_types_check;
ALTER TABLE x_signal_relations
  ADD CONSTRAINT x_signal_relations_event_types_check CHECK(
    cardinality(event_types) > 0
    AND event_types <@ ARRAY['retweet','quote','reply','follow']::text[]
  );

-- Existing KOL history is only a directory seed. It does not create new Watch
-- demand because Watch reconciliation reads active whitelist rules only.
INSERT INTO x_actor_directory
  (x_user_id, handle, display_name, chain_ids, source_types, confidence, status,
   use_count, last_used_at)
SELECT NULLIF(x_user_id, ''), lower(regexp_replace(x_handle, '^@+', '')),
       display_name, COALESCE(chain_ids, '{}'), ARRAY['xbot_history']::text[],
       'unverified', 'candidate', 0, updated_at
FROM x_kol_accounts
WHERE NULLIF(lower(regexp_replace(x_handle, '^@+', '')), '') IS NOT NULL
ON CONFLICT (lower(handle)) DO NOTHING;
