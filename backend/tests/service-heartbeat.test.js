const assert = require('node:assert/strict');
const test = require('node:test');
const { ServiceHeartbeat, latestHeartbeat } = require('../lib/service-heartbeat');

test('service heartbeat persists process role and status without credentials', async () => {
  const calls = [];
  const heartbeat = new ServiceHeartbeat({
    db: { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [] }; } },
    logger: { error: () => {} },
    now: () => new Date('2026-07-22T00:00:00.000Z'),
    processId: 42,
    instanceId: 'instance-test',
    intervalMs: 60_000
  });
  heartbeat.start({
    role: 'ingestion',
    statusProvider: () => ({ wss: { status: 'subscribed', lastError: null } })
  });
  await new Promise((resolve) => setImmediate(resolve));
  await heartbeat.stop();

  assert.equal(calls[0].params[0], 'ingestion');
  assert.equal(calls[0].params[1], 'instance-test');
  assert.equal(calls[0].params[2], 42);
  assert.equal(calls[0].params[3].wss.status, 'subscribed');
  assert.equal(JSON.stringify(calls).includes('OPENNEWS_TOKEN'), false);
});

test('latest heartbeat marks a recent shared status as fresh', async () => {
  const result = await latestHeartbeat(['ingestion'], {
    query: async () => ({ rows: [{
      role: 'ingestion',
      instance_id: 'instance-test',
      process_id: 42,
      status_json: { wss: { status: 'subscribed' } },
      started_at: new Date('2026-07-22T00:00:00.000Z'),
      heartbeat_at: new Date('2026-07-22T00:00:05.000Z'),
      age_ms: 5_000
    }] })
  });
  assert.equal(result.fresh, true);
  assert.equal(result.status.wss.status, 'subscribed');
});
