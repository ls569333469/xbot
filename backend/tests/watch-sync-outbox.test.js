const assert = require('node:assert/strict');
const test = require('node:test');
const {
  claimWatchSyncBatch,
  completeWatchSync,
  enqueueWatchSyncForHandles,
  failWatchSync
} = require('../domains/x-monitor/6551/watch-sync-outbox');
const { WatchSyncWorker } = require('../jobs/6551-watch-sync');
const { roleFlags } = require('../domains/x-monitor/6551/watch-reconciler');

test('Watch Outbox deduplicates actor changes and reclaims abandoned processing rows', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'neet_sol', event_types: ['tweet'] }] };
      }
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
  const claimCall = calls.find((item) => item.sql.includes('RETURNING item.*'));
  assert.match(claimCall.sql, /status = 'processing'.*INTERVAL '2 minutes'/s);
  assert.deepEqual(claimCall.params, [20]);
  const demandCall = calls.find((item) => item.sql.includes('desired_fingerprint = EXCLUDED.desired_fingerprint'));
  assert.ok(demandCall);
  assert.match(demandCall.sql, /IS DISTINCT FROM EXCLUDED\.desired_fingerprint/);
});

test('Watch Outbox treats an exact managed remote Watch as an idempotent no-op', async () => {
  const previous = {
    provider: process.env.X_DATA_PROVIDER,
    apply: process.env.X_6551_WATCH_APPLY_ENABLED,
    token: process.env.OPENNEWS_TOKEN
  };
  process.env.X_DATA_PROVIDER = '6551';
  process.env.X_6551_WATCH_APPLY_ENABLED = 'false';
  process.env.OPENNEWS_TOKEN = 'test-token';
  const flags = roleFlags('kol', { eventTypes: ['quote', 'reply'] });
  let upsert;
  const executor = {
    async query(sql, params) {
      if (sql.includes(') AS desired') && sql.includes('GROUP BY x_handle')) {
        return { rows: [{ x_handle: 'vladtenev', event_types: ['quote', 'reply'] }] };
      }
      if (sql.includes('FROM x_provider_watches') && sql.includes('username = ANY')) {
        return { rows: [{ username: 'vladtenev', managed: true, sync_status: 'in_sync', remote_flags: flags }] };
      }
      if (sql.includes('INSERT INTO x_watch_sync_outbox')) upsert = { sql, params };
      return { rows: [] };
    }
  };

  try {
    await enqueueWatchSyncForHandles(['@VladTenev'], executor);
    assert.equal(upsert.params[1], 'succeeded');
    assert.equal(upsert.params[2], null);
    assert.equal(upsert.params[6], true);
  } finally {
    if (previous.provider === undefined) delete process.env.X_DATA_PROVIDER;
    else process.env.X_DATA_PROVIDER = previous.provider;
    if (previous.apply === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
    else process.env.X_6551_WATCH_APPLY_ENABLED = previous.apply;
    if (previous.token === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous.token;
  }
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
