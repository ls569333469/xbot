const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const test = require('node:test');

const backendRoot = path.resolve(__dirname, '..');

test('fresh databases start from migration 000 before incremental migrations', () => {
  const migrationNames = fs.readdirSync(path.join(backendRoot, 'db', 'migrations'))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  assert.equal(migrationNames[0], '000_initial_schema.sql');
  const baseSchema = fs.readFileSync(
    path.join(backendRoot, 'db', 'migrations', migrationNames[0]),
    'utf8'
  );
  assert.match(baseSchema, /CREATE TABLE IF NOT EXISTS config/);
  assert.match(baseSchema, /CREATE TABLE IF NOT EXISTS ca_whitelist/);
  assert.match(baseSchema, /CREATE TABLE IF NOT EXISTS x_signal_relations/);
  const launchMigration = fs.readFileSync(
    path.join(backendRoot, 'db', 'migrations', '020_p16_1_prelaunch_project_monitor.sql'),
    'utf8'
  );
  assert.match(launchMigration, /CREATE TABLE IF NOT EXISTS project_launch_rules/);
  assert.match(launchMigration, /CREATE TABLE IF NOT EXISTS project_launch_discoveries/);
  assert.match(launchMigration, /ADD COLUMN IF NOT EXISTS launch_rule_id/);
  assert.match(launchMigration, /WHERE source\.source_kind = 'project'/);
});

test('database setup uses DB_NAME and never seeds a configured database', () => {
  const setup = fs.readFileSync(path.join(backendRoot, 'scripts', 'db-setup.js'), 'utf8');
  const seed = fs.readFileSync(path.join(backendRoot, 'db', 'seed.sql'), 'utf8');
  assert.match(setup, /process\.env\.DB_NAME/);
  assert.match(setup, /SELECT COUNT\(\*\)::int AS count FROM config/);
  assert.doesNotMatch(setup, /datname = 'xbot'/);
  assert.match(seed, /ON CONFLICT \(key\) DO NOTHING/);
  assert.doesNotMatch(seed, /dailyBudget|maxOpenPositions|consecutive_loss_limit/);
});
