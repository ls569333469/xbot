const assert = require('node:assert/strict');
const test = require('node:test');
const {
  claimWatchSyncBatch,
  completeWatchSync,
  enqueueWatchSyncForHandles,
  failWatchSync
} = require('../domains/x-monitor/6551/watch-sync-outbox');
const { WatchSyncWorker } = require('../jobs/6551-watch-sync');

test('Watch Outbox deduplicates actor changes and reclaims abandoned processing rows', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('RETURNING item.*')) {
        return { rows: [{ actor_handle: 'neet_sol', desired_version: '4', attempt_count: 0 }] };
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(
    await enqueueWatchSyncForHandles(['@Neet_Sol', 'neet_sol'], executor),
    ['neet_sol']
  );
  const claimed = await claimWatchSyncBatch(20, executor);
  assert.equal(claimed.length, 1);
  assert.match(calls[1].sql, /status = 'processing'.*INTERVAL '2 minutes'/s);
  assert.deepEqual(calls[1].params, [20]);
});

test('Watch Outbox completion and failure are guarded by desired version', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    }
  };
  const row = { actor_handle: 'neet_sol', desired_version: 7, attempt_count: 2 };
  await completeWatchSync([row], executor);
  await failWatchSync([row], 'provider unavailable', executor);

  assert.match(calls[0].sql, /desired_version = \$2 THEN 'succeeded' ELSE 'pending'/);
  assert.deepEqual(calls[0].params, ['neet_sol', 7]);
  assert.match(calls[1].sql, /desired_version = \$2 THEN 'failed' ELSE 'pending'/);
  assert.deepEqual(calls[1].params.slice(0, 3), ['neet_sol', 7, 3]);
  assert.equal(calls[1].params[4], 'provider unavailable');
});

test('Watch Sync Worker only authorizes takeover for actors claimed from the Outbox', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('RETURNING item.*')) {
        return {
          rows: [
            { actor_handle: 'vladtenev', desired_version: '4', attempt_count: 0 },
            { actor_handle: 'meadgod', desired_version: '2', attempt_count: 0 }
          ]
        };
      }
      return { rows: [] };
    }
  };
  let applyOptions;
  const worker = new WatchSyncWorker({
    db: executor,
    clientFactory: () => ({ provider: '6551' }),
    applyPlan: async (_client, options) => {
      applyOptions = options;
      return { results: [] };
    }
  });
  worker.enabled = () => true;

  const result = await worker.runOnce();

  assert.equal(result.status, 'completed');
  assert.deepEqual(applyOptions.adopt, ['vladtenev', 'meadgod']);
  assert.equal(applyOptions.allowUnresolvedBlockers, true);
  assert.equal(calls.filter((item) => item.sql.includes("THEN 'succeeded'")).length, 2);
});
