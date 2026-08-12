const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/043_p26_local_rpc_provider_status.sql'
), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '../scripts/audit-db-schema.js'), 'utf8');

test('P26 schema accepts deterministic local RPC provenance in candidate tables', () => {
  assert.match(migration, /dynamic_asset_variants_provider_status_check/i);
  assert.match(migration, /dynamic_ca_resolution_candidates_provider_status_check/i);
  assert.match(migration, /local_event/i);
  assert.match(migration, /local_rpc/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/i);
});

test('P26 local RPC migration remains mandatory in the schema audit', () => {
  assert.match(audit, /043_p26_local_rpc_provider_status\.sql/);
});
