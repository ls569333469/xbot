const assert = require('node:assert/strict');
const test = require('node:test');
const { PostgresGmgnRateLimit, scopeKey } = require('../lib/gmgn-shared-rate-limit');

function withEnv(values, fn) {
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve(fn()).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function fakeDb(row) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT rate_per_second')) return { rows: [row] };
      return { rows: [] };
    },
    release() {}
  };
  return { db: { pool: { connect: async () => client } }, calls };
}

test('GMGN audit and shared limiter resolve the same scope key', () => {
  assert.equal(scopeKey({
    P22_GMGN_RATE_SCOPE: 'p22-scope',
    P24_GMGN_RATE_SCOPE: 'legacy-scope'
  }), 'p22-scope');
  assert.equal(scopeKey({ P24_GMGN_RATE_SCOPE: 'legacy-scope' }), 'legacy-scope');
  assert.equal(scopeKey({ GMGN_API_HOST: 'https://example.test' }), 'gmgn:https://example.test');
});

test('P22 shared limiter reserves one weighted token in PostgreSQL state', async () => {
  const now = Date.now();
  const fixture = fakeDb({
    rate_per_second: 5, capacity: 10, available_tokens: 10,
    refilled_ms: now, cooldown_ms: null
  });
  await withEnv({ P22_GMGN_SHARED_LIMIT_ENABLED: 'true', P22_GMGN_RATE_SCOPE: 'test-scope' }, async () => {
    const limiter = new PostgresGmgnRateLimit({ db: fixture.db, now: () => now });
    const lease = await limiter.acquire(2, { priority: 1 });
    assert.ok(lease);
    const update = fixture.calls.find((item) => item.sql.includes('available_tokens = $2'));
    assert.equal(update.params[1], 8);
  });
});

test('P22 shared cooldown rejects background work before it reaches GMGN', async () => {
  const now = Date.now();
  const fixture = fakeDb({
    rate_per_second: 5, capacity: 10, available_tokens: 10,
    refilled_ms: now, cooldown_ms: now + 120_000
  });
  await withEnv({ P22_GMGN_SHARED_LIMIT_ENABLED: 'true', P22_GMGN_RATE_SCOPE: 'test-scope' }, async () => {
    const limiter = new PostgresGmgnRateLimit({ db: fixture.db, now: () => now });
    await assert.rejects(
      limiter.acquire(1, { priority: 5 }),
      (error) => error.code === 'GMGN_RATE_LIMIT_COOLDOWN'
        && error.retryAfterSeconds >= 119
    );
  });
});
