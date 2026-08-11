const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/038_p22_gmgn_shared_rate_state_and_audit.sql'
), 'utf8');
const snapshotMigration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/039_p22_follow_verification_snapshot.sql'
), 'utf8');
const audit = fs.readFileSync(path.resolve(
  __dirname, '../scripts/audit-db-schema.js'
), 'utf8');

test('P22 schema provides one PostgreSQL GMGN limiter state per shared scope', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS gmgn_rate_limit_state/i);
  assert.match(migration, /scope_key text PRIMARY KEY/i);
  assert.match(migration, /cooldown_until timestamptz/i);
  assert.match(migration, /ALTER TABLE provider_rate_events/i);
  assert.match(migration, /source text/i);
  assert.match(migration, /context_json jsonb/i);
});

test('P22 schema stores P21 verification snapshots on whitelists', () => {
  assert.match(snapshotMigration, /provider_verification_snapshot jsonb/i);
  assert.match(audit, /038_p22_gmgn_shared_rate_state_and_audit\.sql/);
  assert.match(audit, /039_p22_follow_verification_snapshot\.sql/);
  assert.match(audit, /provider_verification_snapshot/);
});
