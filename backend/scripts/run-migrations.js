const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const { runMigrations } = require('../lib/migrations');
const db = require('../lib/db');

async function main() {
  const applied = await runMigrations();
  process.stdout.write(JSON.stringify({
    database: process.env.DB_NAME || null,
    applied,
    result: 'passed'
  }) + '\n');
}

main()
  .catch((error) => {
    if (error.code === 'MIGRATION_BASELINE_REQUIRED') {
      process.stderr.write(JSON.stringify({
        result: 'baseline_required',
        code: error.code,
        applied: error.applied || [],
        next: 'Run scripts/import-migration-manifest.js with the reviewed P26 manifest, then rerun migrations'
      }) + '\n');
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
