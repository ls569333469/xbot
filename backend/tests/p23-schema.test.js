const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/040_p23_runtime_scope_readiness_snapshot.sql'
), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '../scripts/audit-db-schema.js'), 'utf8');
const server = fs.readFileSync(path.resolve(__dirname, '../server.js'), 'utf8');
const systemRoutes = fs.readFileSync(path.resolve(__dirname, '../domains/system/routes.js'), 'utf8');

test('P23 adds only auditable scope and readiness snapshot fields', () => {
  assert.match(migration, /ALTER TABLE arm_preparations/i);
  assert.match(migration, /scope_type text/i);
  assert.match(migration, /scope_manifest_hash text/i);
  assert.match(migration, /readiness_snapshot jsonb/i);
  assert.match(migration, /scope_chain_ids text\[\]/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/i);
});

test('schema audit makes migration 040 and all P23 arm fields mandatory', () => {
  assert.match(audit, /040_p23_runtime_scope_readiness_snapshot\.sql/);
  assert.match(audit, /scope_manifest_hash/);
  assert.match(audit, /readiness_snapshot/);
  assert.match(audit, /probe_requested/);
});

test('P23 startup recovery reuses persisted readiness without probing GMGN', () => {
  assert.match(server, /restoreDesiredState\([\s\S]*?probe:\s*false/);
  assert.doesNotMatch(server, /restoreDesiredState\([\s\S]*?probe:\s*true/);
});

test('system readiness defaults to the active engine scope', () => {
  assert.match(systemRoutes, /\} : engineState\.getScopeInput\(\);/);
});
