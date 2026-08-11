const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const migration = fs.readFileSync(path.resolve(
  __dirname, '../db/migrations/042_p25_gmgn_terminal_execution.sql'
), 'utf8');
const audit = fs.readFileSync(path.resolve(__dirname, '../scripts/audit-db-schema.js'), 'utf8');
const readiness = fs.readFileSync(path.resolve(
  __dirname, '../domains/trade/readiness-service.js'
), 'utf8');

test('P25 keeps the shared GMGN bucket large enough for gas plus swap', () => {
  assert.match(migration, /capacity\s*=\s*GREATEST\(capacity,\s*6\)/i);
  assert.doesNotMatch(migration, /DROP TABLE|DROP COLUMN|DELETE FROM/i);
});

test('P25 migration is mandatory for schema audit and live readiness', () => {
  assert.match(audit, /042_p25_gmgn_terminal_execution\.sql/);
  assert.match(readiness, /042_p25_gmgn_terminal_execution\.sql/);
});
