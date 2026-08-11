const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(
  __dirname, '../db/migrations/036_p21_follow_discovery.sql'
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const candidateSourceMigration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/037_p21_follow_discovery_candidate_source.sql'
), 'utf8');
const schemaAudit = fs.readFileSync(
  path.resolve(__dirname, '../scripts/audit-db-schema.js'), 'utf8'
);
const followResolver = fs.readFileSync(
  path.resolve(__dirname, '../domains/follow-discovery/resolver.js'), 'utf8'
);
const grokResearcher = fs.readFileSync(
  path.resolve(__dirname, '../domains/follow-discovery/grok-researcher.js'), 'utf8'
);

test('P21 migration keeps one current follow policy per KOL while preserving archives', () => {
  assert.match(migration, /archived_at\s+timestamptz/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS uq_follow_discovery_policy_kol_current/i);
  assert.match(migration, /ON follow_discovery_policies\s*\(kol_id\)\s*WHERE archived_at IS NULL/i);
  assert.doesNotMatch(migration, /UNIQUE\s*\(kol_id\)/i);
  assert.match(migration, /kol_id int NOT NULL REFERENCES x_kol_accounts\(id\) ON DELETE RESTRICT/i);
  assert.match(migration, /policy_id bigint NOT NULL REFERENCES follow_discovery_policies\(id\) ON DELETE RESTRICT/i);
});

test('P21 migration isolates follow whitelists from fixed and dynamic strategy uniqueness', () => {
  assert.match(migration, /uq_whitelist_follow_discovery_active/i);
  assert.match(
    migration,
    /source NOT IN \('dynamic_keyword', 'follow_discovery'\)/i
  );
  assert.match(migration, /source = 'follow_discovery'/i);
});

test('P21 migration extends the shared signal pipeline without creating another trade stack', () => {
  assert.match(migration, /follow_discovery_event_id/i);
  assert.match(migration, /signal_type IN \([^)]*'follow_discovery'/i);
  assert.doesNotMatch(
    migration,
    /CREATE TABLE IF NOT EXISTS\s+(?:trade_attempts|trade_orders|positions|position_lots)\b/i
  );
});

test('P21 candidate materialization is accepted by the shared dynamic index constraint', () => {
  assert.match(candidateSourceMigration, /dynamic_candidate_index_source_type_check/i);
  assert.match(candidateSourceMigration, /'follow_discovery'/i);
  assert.match(candidateSourceMigration, /DROP CONSTRAINT IF EXISTS/i);
});

test('schema audit requires P21 migration, tables, and unique indexes', () => {
  assert.match(schemaAudit, /036_p21_follow_discovery\.sql/);
  assert.match(schemaAudit, /037_p21_follow_discovery_candidate_source\.sql/);
  assert.match(schemaAudit, /follow_discovery_policies/);
  assert.match(schemaAudit, /follow_discovery_events/);
  assert.match(schemaAudit, /uq_follow_discovery_policy_kol_current/);
  assert.match(schemaAudit, /uq_trade_signal_follow_discovery_event/);
});

test('P21 follow discovery uses Grok x_search and does not depend on 6551 post retrieval', () => {
  assert.match(grokResearcher, /tools:\s*\[\{ type: 'x_search' \}, \{ type: 'web_search' \}\]/);
  assert.match(grokResearcher, /api\.x\.ai/);
  assert.match(grokResearcher, /reasoning_effort/);
  assert.match(grokResearcher, /XAI_SEARCH_NO_TOOL_USE/);
  assert.doesNotMatch(followResolver, /getUserTweets|fetchXProfileTweetIds|X6551Client/);
});
