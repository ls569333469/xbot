const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../lib/db');
const service = require('../domains/trade/prepare-token-service');

test('prepare tokens store only a hash and consume through one conditional update', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('INSERT INTO prepare_tokens')) {
      return { rows: [{ id: 1, expires_at: new Date(Date.now() + 60_000) }] };
    }
    if (sql.includes('UPDATE prepare_tokens')) {
      return { rows: [{ id: 1, purpose: 'buy', signal_id: 9, snapshot_hash: 'snapshot' }] };
    }
    throw new Error('Unexpected query');
  };
  try {
    const created = await service.create({
      purpose: 'buy', signalId: 9, operatorId: 'operator', snapshotHash: 'snapshot', snapshot: { a: 1 }
    });
    assert.ok(created.token.length >= 40);
    assert.notEqual(calls[0].params[0], created.token);
    const consumed = await service.consume(created.token, { purpose: 'buy', operatorId: 'operator' });
    assert.equal(consumed.signal_id, 9);
    assert.match(calls[1].sql, /consumed_at IS NULL/);
    assert.match(calls[1].sql, /expires_at > NOW\(\)/);
  } finally {
    db.query = originalQuery;
  }
});

test('prepare token replay or mismatch fails closed', async () => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });
  try {
    await assert.rejects(
      service.consume('invalid', { purpose: 'close', operatorId: 'operator' }),
      error => error.code === 'PREPARE_TOKEN_INVALID'
    );
  } finally {
    db.query = originalQuery;
  }
});
