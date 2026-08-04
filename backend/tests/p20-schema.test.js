const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migrationPath = path.resolve(__dirname, '../db/migrations/028_p20_readonly_dynamic_resolution.sql');
const migration = fs.readFileSync(migrationPath, 'utf8');
const runtimeMigrationPath = path.resolve(__dirname, '../db/migrations/029_p20_runtime_dynamic_signal_pipeline.sql');
const runtimeMigration = fs.readFileSync(runtimeMigrationPath, 'utf8');
const approvedTermMigrationPath = path.resolve(
  __dirname, '../db/migrations/034_p20_approved_term_intent_and_index_bounds.sql'
);
const approvedTermMigration = fs.readFileSync(approvedTermMigrationPath, 'utf8');
const familySplitMigrationPath = path.resolve(
  __dirname, '../db/migrations/035_p20_split_implicit_asset_families.sql'
);
const familySplitMigration = fs.readFileSync(familySplitMigrationPath, 'utf8');

test('P20.1 migration creates only discovery, resolution, and screening tables', () => {
  for (const table of [
    'dynamic_asset_families',
    'dynamic_asset_variants',
    'dynamic_asset_variant_relations',
    'dynamic_candidate_index',
    'dynamic_ca_resolution_attempts',
    'dynamic_ca_resolution_candidates',
    'x_actor_screening_runs',
    'x_actor_screening_results'
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`, 'i'));
  }
});

test('P20.1 migration does not alter current live execution contracts', () => {
  assert.doesNotMatch(migration, /ALTER TABLE\s+(?:ca_whitelist|trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i);
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:ca_whitelist|trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i);
  assert.doesNotMatch(migration, /dynamic_targets|matched_dynamic_resolution_id/i);
});

test('P20 runtime migration includes reclaimable launch-window leases', () => {
  assert.match(runtimeMigration, /CREATE TABLE IF NOT EXISTS dynamic_launch_windows\b/i);
  for (const column of ['worker_id', 'locked_at', 'lease_expires_at']) {
    assert.match(runtimeMigration, new RegExp(`\\b${column}\\b`, 'i'));
  }
  assert.match(runtimeMigration, /Migration 029|P20\.2-P20\.5/i);
});

test('P20 approved-term migration extends the audit intent and bounds provider index values', () => {
  assert.match(approvedTermMigration, /approved_term_direct/i);
  assert.match(approvedTermMigration, /octet_length\(identity_key\)\s*<=\s*1024/i);
  assert.match(approvedTermMigration, /octet_length\(normalized_key\)\s*<=\s*1024/i);
  assert.match(approvedTermMigration, /octet_length\(source_ref\)\s*<=\s*1024/i);
  assert.doesNotMatch(
    approvedTermMigration,
    /ALTER TABLE\s+(?:ca_whitelist|trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i
  );
});

test('P20 family migration splits implicit same-name groups without touching explicit family keys', () => {
  assert.match(familySplitMigration, /'variant:'\s*\|\|\s*variant\.chain_id/i);
  assert.match(familySplitMigration, /legacy\.identity_key LIKE 'symbol:%'/i);
  assert.match(familySplitMigration, /legacy\.identity_key LIKE 'name:%'/i);
  assert.match(familySplitMigration, /legacy\.identity_key LIKE 'ca:%'/i);
  assert.doesNotMatch(familySplitMigration, /LIKE 'key:%'/i);
  assert.doesNotMatch(
    familySplitMigration,
    /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?(?:ca_whitelist|trade_signals|trade_intents|trade_attempts|trade_orders|positions)\b/i
  );
});
