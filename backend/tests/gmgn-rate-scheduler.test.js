const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WeightedRateScheduler,
  endpointWeight,
  parseResetAt
} = require('../lib/gmgn-rate-scheduler');

test('scheduler reserves quote and swap atomically as seven weight', async () => {
  let now = 1_000_000;
  const scheduler = new WeightedRateScheduler({ now: () => now, jitter: () => 0 });
  const lease = await scheduler.reserveTrade();
  assert.equal(lease.remainingWeight, 7);
  assert.equal(scheduler.getStatus().reservedWeight, 7);
  assert.equal(scheduler.getStatus().reservedLastSecond, 7);
  assert.equal(scheduler.getStatus().consumedLastSecond, 0);
  lease.consume(endpointWeight('GET', '/v1/trade/quote'));
  assert.equal(scheduler.getStatus().reservedWeight, 5);
  assert.equal(scheduler.getStatus().consumedLastSecond, 2);
  lease.consume(endpointWeight('POST', '/v1/trade/swap'));
  assert.equal(lease.remainingWeight, 0);
  assert.equal(scheduler.getStatus().reservedWeight, 0);
  assert.equal(scheduler.getStatus().consumedLastSecond, 7);
  assert.equal(scheduler.getStatus().availableWeight, 7);
  now += 500;
  assert.equal(scheduler.getStatus().availableWeight, 14);
});

test('first 429 globally cools and degrades the scheduler', () => {
  const now = 1_000_000;
  const scheduler = new WeightedRateScheduler({ now: () => now, jitter: () => 0 });
  scheduler.observe429((now + 120_000) / 1000);
  const status = scheduler.getStatus();
  assert.equal(status.state, 'cooling');
  assert.equal(status.cooldownUntil, now + 120_000);
  assert.equal(status.currentRate, 11);
  assert.equal(parseResetAt((now + 1_000) / 1000, now), now + 1_000);
});

test('official endpoint weights include read, quote, swap, and strategy writes', () => {
  assert.equal(endpointWeight('GET', '/v1/user/info'), 1);
  assert.equal(endpointWeight('GET', '/v1/user/wallet_activity'), 3);
  assert.equal(endpointWeight('GET', '/v1/trade/quote'), 2);
  assert.equal(endpointWeight('POST', '/v1/trade/swap'), 5);
  assert.equal(endpointWeight('POST', '/v1/trade/strategy/cancel'), 2);
});
