const { spawnSync } = require('child_process');
const path = require('path');

const backendRoot = path.resolve(__dirname, '..');
const database = String(process.argv[2] || process.env.XBOT_TEST_DB_NAME || '').trim();
if (!database || !/test/i.test(database) || database === String(process.env.DB_NAME || '').trim()) {
  throw new Error('P27 migration rehearsal requires a dedicated database name containing "test"');
}

function run(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: backendRoot,
    env: {
      ...process.env,
      DB_NAME: options.database || database,
      XBOT_TEST_DB_NAME: database
    },
    encoding: 'utf8',
    windowsHide: true
  });
  if (options.expectedStatus !== undefined) {
    if (result.status === options.expectedStatus) return result;
  } else if (result.status === 0) {
    return result;
  }
  throw new Error([
    `Command failed (${result.status}): node ${args.join(' ')}`,
    result.stdout,
    result.stderr
  ].filter(Boolean).join('\n'));
}

const recreated = run(['scripts/manage-test-database.js', 'recreate', database], {
  database: String(process.env.DB_NAME || 'xbot').trim()
});
const bootstrap = run(['scripts/run-migrations.js'], { expectedStatus: 2 });
if (!bootstrap.stderr.includes('"code":"MIGRATION_BASELINE_REQUIRED"')
    || !bootstrap.stderr.includes('044_p27_migration_manifest.sql')) {
  throw new Error('P27 bootstrap did not stop after migration 044');
}
const imported = run([
  'scripts/import-migration-manifest.js',
  '--manifest', 'db/manifests/p26_80e9f5a_migrations.json',
  '--confirmed-by', 'p27-migration-rehearsal',
  '--confirmation-note', 'Automated dedicated database rehearsal against frozen P26 baseline',
  '--confirmation', 'IMPORT SIGNED MIGRATION BASELINE'
]);
const additive = run(['scripts/run-migrations.js']);
if (!additive.stdout.includes('045_p27_signal_contract_snapshots.sql')
    || !additive.stdout.includes('046_p27_reliable_notification_outbox.sql')
    || !additive.stdout.includes('047_p27_local_candidate_metadata_backfill.sql')
    || !additive.stdout.includes('048_p27_shared_gmgn_asset_metadata.sql')
    || !additive.stdout.includes('049_p27_metadata_enqueue_missing_only.sql')) {
  throw new Error('P27 additive migrations were not applied after baseline import');
}
const secondStart = run(['scripts/run-migrations.js']);
if (!secondStart.stdout.includes('"applied":[]')) {
  throw new Error('P27 second migration start was not a zero-change run');
}
const audit = run(['scripts/audit-db-schema.js']);

process.stdout.write(`${JSON.stringify({
  result: 'passed',
  database,
  phases: {
    recreated: recreated.stdout.trim(),
    bootstrap: '044_then_baseline_required',
    manifest: imported.stdout.trim(),
    additive: [
      '045_p27_signal_contract_snapshots.sql',
      '046_p27_reliable_notification_outbox.sql',
      '047_p27_local_candidate_metadata_backfill.sql',
      '048_p27_shared_gmgn_asset_metadata.sql',
      '049_p27_metadata_enqueue_missing_only.sql'
    ],
    second_start: 'zero_change',
    schema_audit: audit.stdout.trim()
  }
}, null, 2)}\n`);
