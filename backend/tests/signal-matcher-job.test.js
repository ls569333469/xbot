const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../lib/db');
const { claimSignals } = require('../jobs/signal-matcher');

test('legacy simulated claims use upstream source time and reject missing 6551 time', async () => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  };
  try {
    await claimSignals('paper');
    assert.match(calls[0].sql, /activity\.source_created_at IS NULL/);
    assert.match(calls[0].sql, /SOURCE_EVENT_TIME_MISSING/);
    assert.match(calls[1].sql, /ORDER BY COALESCE\(activity\.source_created_at, queued\.created_at\)/);
  } finally {
    db.query = originalQuery;
  }
});
