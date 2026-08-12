const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../lib/db');
const { NotificationOutboxWorker } = require('../jobs/notification-outbox');

test('P27 outbox claims due rows and recovers an expired sending lease atomically', async () => {
  const originalConnect = db.pool.connect;
  const queries = [];
  db.pool.connect = async () => ({
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('RETURNING item.*')) return { rows: [{ id: 7, channel: 'entity_event' }] };
      return { rows: [] };
    },
    release() {}
  });
  try {
    const worker = new NotificationOutboxWorker({ workerId: 'p27-test', leaseMs: 12_000 });
    const rows = await worker.claim(5);
    assert.equal(rows[0].id, 7);
    const claim = queries.find((item) => item.sql.includes('RETURNING item.*'));
    assert.match(claim.sql, /FOR UPDATE SKIP LOCKED/);
    assert.match(claim.sql, /status = 'sending' AND locked_at </);
    assert.match(claim.sql, /locked_by = \$3/);
    assert.deepEqual(claim.params, [5, 12_000, 'p27-test']);
  } finally {
    db.pool.connect = originalConnect;
  }
});

test('P27 outbox sends entity events as minimal envelopes and releases its lease', async () => {
  const originalQuery = db.query;
  const updates = [];
  db.query = async (sql, params = []) => {
    updates.push({ sql, params });
    return { rows: [] };
  };
  try {
    const worker = new NotificationOutboxWorker({ workerId: 'p27-relay' });
    worker.claim = async () => [{
      id: 9,
      channel: 'entity_event',
      aggregate_type: 'signal',
      aggregate_id: '81',
      payload: {
        contract_version: 'p27.events.v1',
        entity_type: 'signal',
        entity_id: '81',
        change_type: 'created'
      }
    }];
    const messages = [];
    worker.wsBroadcast = (message) => messages.push(message);
    const result = await worker.runOnce();
    assert.deepEqual(result, { status: 'completed', processed: 1 });
    assert.deepEqual(messages, [{
      type: 'entity:changed',
      event_id: '9',
      contract_version: 'p27.events.v1',
      payload: { entity_type: 'signal', entity_id: '81', change_type: 'created' }
    }]);
    assert.match(updates[0].sql, /locked_at = NULL, locked_by = NULL/);
    assert.match(updates[0].sql, /locked_by = \$2/);
    assert.deepEqual(updates[0].params, [9, 'p27-relay']);
  } finally {
    db.query = originalQuery;
  }
});
