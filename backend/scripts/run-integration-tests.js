const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });

const testDatabase = String(process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(process.env.DB_NAME || '').trim();

if (!testDatabase || !/test/i.test(testDatabase) || testDatabase === productionDatabase) {
  process.stderr.write(
    'Integration tests require XBOT_TEST_DB_NAME to name a dedicated test database.\n'
  );
  process.exit(1);
}

const testsDirectory = path.resolve(__dirname, '../tests');
const files = fs.readdirSync(testsDirectory)
  .filter((file) => file.endsWith('.integration.js'))
  .sort()
  .map((file) => path.join(testsDirectory, file));

if (files.length === 0) {
  process.stderr.write('No integration test files were found.\n');
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-concurrency=1', ...files],
  {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_NAME: testDatabase,
      XBOT_PRODUCTION_DB_NAME: productionDatabase
    },
    stdio: 'inherit'
  }
);

process.exit(result.status ?? 1);
