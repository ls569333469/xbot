const assert = require('node:assert/strict');
const test = require('node:test');
const { GmgnCacheWarmer } = require('../jobs/gmgn-cache-warmup');

function createWarmer(options = {}) {
  const rows = options.rows || [];
  const loaded = [];
  let queryCount = 0;
  const warmer = new GmgnCacheWarmer({
    db: {
      query: async () => {
        queryCount += 1;
        return { rows };
      }
    },
    policy: {
      getPolicy: async () => options.policy || {
        whitelistIds: rows.map((row) => row.id),
        chains: ['sol']
      }
    },
    loader: options.loader || (async (row) => loaded.push(row.id)),
    logger: { error() {} },
    batchSize: options.batchSize || 3
  });
  return { warmer, loaded, getQueryCount: () => queryCount };
}

test('cache warmer rotates bounded batches across authorized whitelist rows', async () => {
  const rows = [1, 2, 3, 4].map((id) => ({
    id,
    chain_id: 'sol',
    contract_address: `Token${id}`
  }));
  const { warmer, loaded } = createWarmer({ rows, batchSize: 3 });

  assert.deepEqual(await warmer.runOnce(), { status: 'completed', processed: 3, total: 4 });
  assert.deepEqual(await warmer.runOnce(), { status: 'completed', processed: 3, total: 4 });
  assert.deepEqual(loaded, [1, 2, 3, 4, 1, 2]);
  assert.equal(warmer.getStatus().processed, 6);
  assert.ok(warmer.getStatus().lastSuccessAt instanceof Date);
});

test('cache warmer skips database work when the live policy is empty', async () => {
  const { warmer, getQueryCount } = createWarmer({
    policy: { whitelistIds: [], chains: [] }
  });

  assert.deepEqual(await warmer.runOnce(), { status: 'completed', processed: 0 });
  assert.equal(getQueryCount(), 0);
  assert.equal(warmer.getStatus().lastError, null);
});

test('cache warmer releases its running guard after a loader failure', async () => {
  let attempts = 0;
  const { warmer } = createWarmer({
    rows: [{ id: 1, chain_id: 'sol', contract_address: 'Token1' }],
    loader: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('fixture failure');
        error.code = 'FIXTURE_FAILURE';
        throw error;
      }
    }
  });

  await assert.rejects(() => warmer.runOnce(), { code: 'FIXTURE_FAILURE' });
  assert.equal(warmer.getStatus().active, false);
  assert.equal(warmer.getStatus().lastError, 'FIXTURE_FAILURE');

  assert.deepEqual(await warmer.runOnce(), { status: 'completed', processed: 1, total: 1 });
  assert.equal(warmer.getStatus().lastError, null);
  assert.equal(warmer.getStatus().consecutiveFailures, 0);
  assert.ok(warmer.getStatus().lastRecoveredAt instanceof Date);
});

test('cache warmer reports a system failure only after three consecutive failures', async () => {
  const { warmer } = createWarmer({
    rows: [{ id: 1, chain_id: 'sol', contract_address: 'Token1' }],
    loader: async () => {
      const error = new Error('provider unavailable');
      error.code = 'GMGN_NETWORK_ERROR';
      throw error;
    }
  });

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await assert.rejects(() => warmer.runOnce(), { code: 'GMGN_NETWORK_ERROR' });
    assert.equal(warmer.getStatus().systemFailure, attempt >= 3);
  }
  assert.equal(warmer.getStatus().consecutiveFailures, 3);
  assert.ok(warmer.getStatus().failureStartedAt instanceof Date);
});
