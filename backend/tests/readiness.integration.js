const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const { getSnapshot } = require('../domains/trade/readiness-service');

test('readiness snapshot reads the live policy before dependent whitelist checks', async () => {
  const snapshot = await getSnapshot();
  assert.equal(snapshot.checks.database, true);
  assert.equal(snapshot.checks.migration, true);
  assert.ok(Array.isArray(snapshot.blockers));
  assert.ok(Array.isArray(snapshot.advisories));
  assert.ok(Array.isArray(snapshot.chains));
  assert.equal(snapshot.blockers.includes('FAST_PATH_SLO_NOT_VERIFIED'), false);
  assert.equal(snapshot.chains.some((chain) => chain.blockers.includes('CHAIN_SHADOW_NOT_VERIFIED')), false);
  assert.equal(snapshot.chains.some((chain) => chain.blockers.includes('CHAIN_LIVE_DISABLED')), false);
});

test('deferred external alerts remain visible without blocking automatic readiness', async () => {
  const previous = process.env.TRADE_ALERTS_VERIFIED;
  process.env.TRADE_ALERTS_VERIFIED = 'false';
  try {
    const snapshot = await getSnapshot();
    assert.equal(snapshot.checks.alertsVerified, false);
    assert.equal(snapshot.blockers.includes('TRADE_ALERTS_NOT_VERIFIED'), false);
  } finally {
    if (previous === undefined) delete process.env.TRADE_ALERTS_VERIFIED;
    else process.env.TRADE_ALERTS_VERIFIED = previous;
  }
});

test.after(async () => { await db.pool.end(); });
