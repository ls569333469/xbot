const path = require('path');
const { Client } = require('pg');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const action = String(process.argv[2] || '').trim().toLowerCase();
const databaseName = String(process.argv[3] || process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.DB_NAME || '').trim();

if (!['recreate', 'drop'].includes(action)) {
  throw new Error('Usage: node scripts/manage-test-database.js <recreate|drop> <test_database>');
}
if (!databaseName || !/test/i.test(databaseName) || databaseName === productionDatabase) {
  throw new Error('Test database name must contain "test" and differ from DB_NAME');
}
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) {
  throw new Error('Test database name may contain only letters, digits, and underscores');
}

const quotedName = `"${databaseName}"`;
const client = new Client({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: 'postgres',
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || ''
});

async function main() {
  await client.connect();
  await client.query(
    `SELECT pg_terminate_backend(pid)
     FROM pg_stat_activity
     WHERE datname = $1 AND pid <> pg_backend_pid()`,
    [databaseName]
  );
  await client.query(`DROP DATABASE IF EXISTS ${quotedName}`);
  if (action === 'recreate') await client.query(`CREATE DATABASE ${quotedName}`);
  process.stdout.write(`${action.toUpperCase()}_TEST_DATABASE=${databaseName}\n`);
}

main()
  .catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
  });
