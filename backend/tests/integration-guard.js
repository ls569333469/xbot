const testDatabase = String(process.env.XBOT_TEST_DB_NAME || '').trim();
const productionDatabase = String(
  process.env.XBOT_PRODUCTION_DB_NAME || process.env.DB_NAME || ''
).trim();

if (!testDatabase || !/test/i.test(testDatabase) || testDatabase === productionDatabase) {
  throw new Error(
    'Integration tests require XBOT_TEST_DB_NAME to name a dedicated test database'
  );
}

process.env.NODE_ENV = 'test';
process.env.DB_NAME = testDatabase;
