const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/041_p24_local_event_provider_status.sql'
), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '../scripts/audit-db-schema.js'), 'utf8');
const readiness = fs.readFileSync(path.resolve(
  __dirname, '../domains/trade/readiness-service.js'
), 'utf8');

test('P24 schema accepts current-event CA provenance in shared candidate tables', () => {
  assert.match(migration, /dynamic_asset_variants_provider_status_check/i);
  assert.match(migration, /dynamic_ca_resolution_candidates_provider_status_check/i);
  assert.match(migration, /local_event/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/i);
});

test('P24 migration remains mandatory after the P25 readiness upgrade', () => {
  assert.match(audit, /041_p24_local_event_provider_status\.sql/);
  assert.match(readiness, /042_p25_gmgn_terminal_execution\.sql/);
});
