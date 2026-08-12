const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  validateManifest,
  IMPORT_CONFIRMATION
} = require('../lib/migration-manifest');
const { migrationFiles } = require('../lib/migrations');

const backendRoot = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(
  backendRoot, 'db/manifests/p26_80e9f5a_migrations.json'
), 'utf8'));
const runner = fs.readFileSync(path.join(backendRoot, 'lib/migrations.js'), 'utf8');
const importer = fs.readFileSync(path.join(backendRoot, 'scripts/import-migration-manifest.js'), 'utf8');

test('P26 migration baseline is content-addressed and matches local 000-043 files', () => {
  const validated = validateManifest(manifest, {
    expectedReleaseSha: '80e9f5a77d62b84f930efd924aed329d4e047515'
  });
  assert.equal(validated.migrations.length, 44);
  assert.equal(validated.migrations.at(-1).name, '043_p26_local_rpc_provider_status.sql');
  const local = new Map(migrationFiles().map((file) => [file.name, file.checksum]));
  for (const entry of validated.migrations) {
    assert.equal(local.get(entry.name), entry.checksum_sha256, entry.name);
  }
});
test('manifest validation rejects checksum or digest drift', () => {
  const changed = structuredClone(manifest);
  changed.migrations[0].checksum_sha256 = '0'.repeat(64);
  assert.throws(() => validateManifest(changed), /digest mismatch/i);
});

test('runner pauses after 044 and rejects applied migration drift', () => {
  assert.match(runner, /file\.name === MANIFEST_MIGRATION[\s\S]+MigrationBaselineRequiredError/);
  assert.match(runner, /MIGRATION_CHECKSUM_MISMATCH/);
  assert.match(runner, /MIGRATION_FILE_MISSING/);
  assert.match(runner, /await verifyChecksums\(client, files\)/);
});

test('baseline import requires an explicit operator confirmation', () => {
  assert.equal(IMPORT_CONFIRMATION, 'IMPORT SIGNED MIGRATION BASELINE');
  assert.match(importer, /confirmed-by/);
  assert.match(importer, /confirmation-note/);
  assert.match(importer, /Database migration rows do not exactly match the signed baseline/);
});

test('P27 migrations remain additive and install snapshots plus reliable outbox fields', () => {
  const migration044 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/044_p27_migration_manifest.sql'
  ), 'utf8');
  const migration045 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/045_p27_signal_contract_snapshots.sql'
  ), 'utf8');
  const migration046 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/046_p27_reliable_notification_outbox.sql'
  ), 'utf8');
  const migration047 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/047_p27_local_candidate_metadata_backfill.sql'
  ), 'utf8');
  const migration048 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/048_p27_shared_gmgn_asset_metadata.sql'
  ), 'utf8');
  const migration049 = fs.readFileSync(path.join(
    backendRoot, 'db/migrations/049_p27_metadata_enqueue_missing_only.sql'
  ), 'utf8');
  assert.match(migration044, /release_migration_manifests/i);
  assert.match(migration044, /checksum_sha256/i);
  assert.match(migration045, /asset_snapshot/i);
  assert.match(migration045, /authorization_snapshot/i);
  assert.match(migration045, /fixed_ca','dynamic_policy','follow_discovery/i);
  assert.match(migration046, /channel IN \('alert','entity_event'\)/i);
  assert.match(migration046, /locked_at/i);
  assert.match(migration046, /dedupe_key/i);
  assert.match(migration047, /matched_dynamic_resolution_id/i);
  assert.match(migration047, /follow_discovery_event_id/i);
  assert.match(migration047, /historical_candidate_backfill/i);
  assert.doesNotMatch(migration047, /gmgn|grok|token\/info|security|pool_info/i);
  assert.match(migration048, /UNIQUE\(chain_id, contract_address_key\)/i);
  assert.match(migration048, /ON CONFLICT \(chain_id, contract_address_key\) DO NOTHING/i);
  assert.match(migration049, /asset_snapshot->>'name'/i);
  assert.match(migration049, /asset_snapshot->>'symbol'/i);
  for (const sql of [migration044, migration045, migration046, migration047,
    migration048, migration049]) {
    assert.doesNotMatch(sql, /DROP TABLE|DROP COLUMN|TRUNCATE/i);
  }
});
