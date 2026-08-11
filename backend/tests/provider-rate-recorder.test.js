const assert = require('node:assert/strict');
const test = require('node:test');
const db = require('../lib/db');
const gmgnHttp = require('../lib/gmgn-http');
const recorder = require('../lib/provider-rate-recorder');

test('GMGN request audit persists every P22 provenance field', async () => {
  const previousQuery = db.query;
  let captured = null;
  recorder.stop();
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };

  try {
    recorder.start();
    gmgnHttp.requestEvents.emit('request', {
      path: '/v1/user/info',
      method: 'GET',
      weight: 1,
      status: 429,
      latencyMs: 25,
      remaining: 0,
      resetAt: Date.now() + 60_000,
      errorCode: 'RATE_LIMIT_BANNED',
      source: 'p21_follow_discovery_activation',
      processRole: 'execution',
      signalId: 809,
      policyId: 2,
      whitelistId: 905,
      context: { stage: 'wallet' }
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.ok(captured);
    assert.match(captured.sql, /\$15/);
    assert.equal(captured.params.length, 15);
    assert.equal(captured.params[9], 'p21_follow_discovery_activation');
    assert.equal(captured.params[13], 905);
    assert.deepEqual(JSON.parse(captured.params[14]), {
      stage: 'wallet',
      trace_id: null,
      execution_session_id: null,
      rate_scope: null
    });
  } finally {
    recorder.stop();
    db.query = previousQuery;
  }
});
