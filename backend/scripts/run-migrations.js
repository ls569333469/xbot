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
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end().catch(() => {});
  });
