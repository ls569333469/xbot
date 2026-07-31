-- P20.1: read-only dynamic asset discovery and resolution audit model.
-- This migration deliberately does not alter whitelist, signal, trade, budget,
-- position, engine, or live-authorization tables.

CREATE TABLE IF NOT EXISTS dynamic_asset_families (
  id bigserial PRIMARY KEY,
  identity_key text NOT NULL,
  canonical_name text,
  canonical_symbol text,
  aliases text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'candidate'
    CHECK(status IN('candidate','verified','rejected','archived')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(identity_key)
);

CREATE TABLE IF NOT EXISTS dynamic_asset_variants (
  id bigserial PRIMARY KEY,
  asset_family_id bigint NOT NULL
    REFERENCES dynamic_asset_families(id) ON DELETE RESTRICT,
  chain_id text NOT NULL
    CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  name text,
  symbol text,
  launchpad text,
  exchange text,
  official_x_handles text[] NOT NULL DEFAULT '{}',
  website_url text,
  source_types text[] NOT NULL DEFAULT '{}',
  provider_status text NOT NULL DEFAULT 'unknown'
    CHECK(provider_status IN('unknown','verified','error')),
  tradable_status text NOT NULL DEFAULT 'unknown'
    CHECK(tradable_status IN('unknown','tradable','untradable')),
  market_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  security_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  field_availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  fetched_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(length(btrim(contract_address)) > 0),
  CHECK(chain_id = 'sol' OR contract_address = lower(contract_address)),
  UNIQUE(chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_asset_variants_family
  ON dynamic_asset_variants(asset_family_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_asset_variants_freshness
  ON dynamic_asset_variants(expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS dynamic_asset_variant_relations (
  id bigserial PRIMARY KEY,
  from_variant_id bigint NOT NULL
    REFERENCES dynamic_asset_variants(id) ON DELETE CASCADE,
  to_variant_id bigint NOT NULL
    REFERENCES dynamic_asset_variants(id) ON DELETE CASCADE,
  relation_type text NOT NULL
    CHECK(relation_type IN('original','relaunch','migration','cross_chain','cto','unknown')),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence text NOT NULL DEFAULT 'unknown'
    CHECK(confidence IN('verified','high','medium','low','unknown')),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(from_variant_id <> to_variant_id),
  UNIQUE(from_variant_id, to_variant_id, relation_type)
);

CREATE TABLE IF NOT EXISTS dynamic_candidate_index (
  id bigserial PRIMARY KEY,
  variant_id bigint NOT NULL
    REFERENCES dynamic_asset_variants(id) ON DELETE CASCADE,
  key_type text NOT NULL
    CHECK(key_type IN('symbol','name','x_handle','source_post_id','launchpad','chain_ca')),
  normalized_key text NOT NULL,
  source_type text NOT NULL
    CHECK(source_type IN('tweet_ca','tweet_url','project_account','research','whitelist','gmgn_rank','gmgn_hot','gmgn_trenches','gmgn_info')),
  source_ref text,
  field_available boolean NOT NULL DEFAULT true,
  fetched_at timestamptz NOT NULL DEFAULT NOW(),
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(length(btrim(normalized_key)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_candidate_index_entry
  ON dynamic_candidate_index(
    variant_id,
    key_type,
    normalized_key,
    source_type,
    COALESCE(source_ref, '')
  );
CREATE INDEX IF NOT EXISTS idx_dynamic_candidate_index_lookup
  ON dynamic_candidate_index(key_type, normalized_key, expires_at);

CREATE TABLE IF NOT EXISTS dynamic_ca_resolution_attempts (
  id bigserial PRIMARY KEY,
  x_provider_event_id bigint REFERENCES x_provider_events(id) ON DELETE SET NULL,
  x_activity_id int REFERENCES x_activities(id) ON DELETE SET NULL,
  kol_id int REFERENCES x_kol_accounts(id) ON DELETE SET NULL,
  actor_handle text,
  source_provider text NOT NULL DEFAULT 'offline',
  source_event_id text,
  event_type text,
  resolver_revision text NOT NULL,
  intent_rule_revision text NOT NULL,
  intent_class text NOT NULL
    CHECK(intent_class IN(
      'buy_direct','launch_direct','full_ca_solo','neutral_reference',
      'comparison_or_list','historical_review','sell_or_exit',
      'negative_or_warning','security_incident','quoted_only',
      'multi_asset_ambiguous','unknown'
    )),
  intent_reason_codes text[] NOT NULL DEFAULT '{}',
  observed_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_owned_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  quoted_terms jsonb NOT NULL DEFAULT '[]'::jsonb,
  allowed_chain_ids text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','resolved','rejected','ambiguous','not_found','provider_failed')),
  selected_family_id bigint REFERENCES dynamic_asset_families(id) ON DELETE SET NULL,
  selected_variant_id bigint REFERENCES dynamic_asset_variants(id) ON DELETE SET NULL,
  resolution_confidence text NOT NULL DEFAULT 'unknown'
    CHECK(resolution_confidence IN('verified','high','medium','low','unknown')),
  resolution_reason_codes text[] NOT NULL DEFAULT '{}',
  failure_code text,
  candidate_coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  timing_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT NOW(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_resolution_source_revision
  ON dynamic_ca_resolution_attempts(source_provider, source_event_id, resolver_revision)
  WHERE source_event_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dynamic_resolution_status_created
  ON dynamic_ca_resolution_attempts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dynamic_resolution_actor_created
  ON dynamic_ca_resolution_attempts(actor_handle, created_at DESC)
  WHERE actor_handle IS NOT NULL;

CREATE TABLE IF NOT EXISTS dynamic_ca_resolution_candidates (
  id bigserial PRIMARY KEY,
  resolution_attempt_id bigint NOT NULL
    REFERENCES dynamic_ca_resolution_attempts(id) ON DELETE CASCADE,
  variant_id bigint REFERENCES dynamic_asset_variants(id) ON DELETE SET NULL,
  chain_id text NOT NULL
    CHECK(chain_id IN('sol','bsc','base','eth','robinhood')),
  contract_address text NOT NULL,
  score numeric(10,4),
  strong_anchor_codes text[] NOT NULL DEFAULT '{}',
  support_reason_codes text[] NOT NULL DEFAULT '{}',
  rejection_reason_codes text[] NOT NULL DEFAULT '{}',
  provider_status text NOT NULL DEFAULT 'unknown'
    CHECK(provider_status IN('unknown','verified','error')),
  tradable_status text NOT NULL DEFAULT 'unknown'
    CHECK(tradable_status IN('unknown','tradable','untradable')),
  field_availability jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  selected boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK(length(btrim(contract_address)) > 0),
  CHECK(chain_id = 'sol' OR contract_address = lower(contract_address)),
  UNIQUE(resolution_attempt_id, chain_id, contract_address)
);

CREATE INDEX IF NOT EXISTS idx_dynamic_resolution_candidates_attempt
  ON dynamic_ca_resolution_candidates(resolution_attempt_id, selected DESC, score DESC);

CREATE TABLE IF NOT EXISTS x_actor_screening_runs (
  id bigserial PRIMARY KEY,
  input_handles text[] NOT NULL DEFAULT '{}',
  sample_started_at timestamptz,
  sample_ended_at timestamptz,
  screening_revision text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN('pending','running','completed','partial','failed','cancelled')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_error text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS x_actor_screening_results (
  id bigserial PRIMARY KEY,
  screening_run_id bigint NOT NULL
    REFERENCES x_actor_screening_runs(id) ON DELETE CASCADE,
  x_handle text NOT NULL,
  sample_size int NOT NULL DEFAULT 0,
  direct_intent_rate numeric(8,6),
  ca_resolution_rate numeric(8,6),
  false_positive_rate numeric(8,6),
  executable_win_rate numeric(8,6),
  return_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommendation text NOT NULL DEFAULT 'insufficient_data'
    CHECK(recommendation IN('approve_for_record','watch','reject','insufficient_data')),
  reason_codes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE(screening_run_id, x_handle)
);
