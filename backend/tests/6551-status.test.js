const assert = require('node:assert/strict');
const test = require('node:test');
const { X6551Client } = require('../lib/x-client-6551');
const { getRemoteWatchSummary } = require('../domains/x-monitor/6551/status');

test('6551 remote Watch status is cached and explicit refresh bypasses the cache', async () => {
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    token: process.env.OPENNEWS_TOKEN,
    listWatches: X6551Client.prototype.listWatches
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.OPENNEWS_TOKEN = `status-cache-${Date.now()}`;
  let calls = 0;
  X6551Client.prototype.listWatches = async () => {
    calls += 1;
    return [{ username: 'vladtenev' }, { username: 'robinhoodapp' }];
  };

  try {
    assert.deepEqual(await getRemoteWatchSummary(), { count: 2, error: null });
    assert.deepEqual(await getRemoteWatchSummary(), { count: 2, error: null });
    assert.equal(calls, 1);
    assert.deepEqual(await getRemoteWatchSummary({ force: true }), { count: 2, error: null });
    assert.equal(calls, 2);
  } finally {
    X6551Client.prototype.listWatches = previous.listWatches;
    if (previous.provider === undefined) delete process.env.X_DATA_PROVIDER;
    else process.env.X_DATA_PROVIDER = previous.provider;
    if (previous.token === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous.token;
  }
});
