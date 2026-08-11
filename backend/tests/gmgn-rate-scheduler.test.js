const assert = require('node:assert/strict');
const test = require('node:test');
const {
  INTERNAL_CAPACITY,
  INTERNAL_RATE,
  WeightedRateScheduler,
  PRIORITIES,
  endpointWeight,
  parseResetAt
} = require('../lib/gmgn-rate-scheduler');

test('scheduler reserves only the default swap weight', async () => {
  let now = 1_000_000;
  const scheduler = new WeightedRateScheduler({
    rate: 14, capacity: 14, now: () => now, jitter: () => 0
  });
  const lease = await scheduler.reserveTrade();
  assert.equal(lease.remainingWeight, 5);
  assert.equal(scheduler.getStatus().reservedWeight, 5);
  assert.equal(scheduler.getStatus().reservedLastSecond, 5);
  assert.equal(scheduler.getStatus().consumedLastSecond, 0);
  lease.consume(endpointWeight('POST', '/v1/trade/swap'));
  assert.equal(lease.remainingWeight, 0);
  assert.equal(scheduler.getStatus().reservedWeight, 0);
  assert.equal(scheduler.getStatus().consumedLastSecond, 5);
  assert.equal(scheduler.getStatus().availableWeight, 9);
  now += 500;
  assert.equal(scheduler.getStatus().availableWeight, 14);
});

test('scheduler supports an explicit gas-plus-swap reservation for BSC/Base', async () => {
  const scheduler = new WeightedRateScheduler({ rate: 14, capacity: 14, now: () => 1_000_000, jitter: () => 0 });
  const lease = await scheduler.reserveTrade({ weight: 6 });
  lease.consume(endpointWeight('GET', '/v1/trade/gas_price'));
  lease.consume(endpointWeight('POST', '/v1/trade/swap'));
  assert.equal(lease.remainingWeight, 0);
  assert.equal(scheduler.getStatus().consumedLastSecond, 6);
});

test('trade evidence uses an independent four-weight lease below critical reconciliation', async () => {
  const scheduler = new WeightedRateScheduler({
    rate: 14, capacity: 14, now: () => 1_000_000, jitter: () => 0
  });
  const tradeLease = await scheduler.reserveTrade();
  const evidenceLease = await scheduler.reserveTradeEvidence();
  assert.equal(tradeLease.remainingWeight, 5);
  assert.equal(evidenceLease.remainingWeight, 4);
  assert.equal(scheduler.getStatus().reservedWeight, 9);
  assert.ok(PRIORITIES.CRITICAL_RECONCILIATION < PRIORITIES.TRADE_EVIDENCE);
  evidenceLease.consume(1);
  evidenceLease.consume(3);
  tradeLease.release();
  assert.equal(scheduler.getStatus().reservedWeight, 0);
});

test('first 429 globally cools and degrades the scheduler', () => {
  const now = 1_000_000;
  const scheduler = new WeightedRateScheduler({
    rate: 14, capacity: 14, now: () => now, jitter: () => 0
  });
  scheduler.observe429((now + 120_000) / 1000);
  const status = scheduler.getStatus();
  assert.equal(status.state, 'cooling');
  assert.equal(status.cooldownUntil, now + 120_000);
  assert.equal(status.currentRate, 11);
  assert.equal(parseResetAt((now + 1_000) / 1000, now), now + 1_000);
});

test('default scheduler paces reads while retaining one atomic trade reservation', () => {
  const scheduler = new WeightedRateScheduler({ now: () => 1_000_000, jitter: () => 0 });
  const status = scheduler.getStatus();
  assert.equal(INTERNAL_RATE, 5);
  assert.equal(INTERNAL_CAPACITY, 10);
  assert.equal(status.configuredRate, 5);
  assert.equal(status.configuredCapacity, 10);
});

test('account-level rate bans enforce a longer minimum cooldown', () => {
  const now = 1_000_000;
  const scheduler = new WeightedRateScheduler({ now: () => now, jitter: () => 0 });
  scheduler.observe429(null, { minimumCooldownMs: 5 * 60_000 });
  assert.equal(scheduler.getStatus().cooldownUntil, now + 5 * 60_000);
});

test('cooldown rejects background requests instead of queueing them', async () => {
  const now = 1_000_000;
  const scheduler = new WeightedRateScheduler({ now: () => now, jitter: () => 0 });
  scheduler.observe429(null, { minimumCooldownMs: 5 * 60_000 });
  await assert.rejects(
    scheduler.acquire(1),
    (error) => error.code === 'GMGN_RATE_LIMIT_COOLDOWN'
      && error.resetAt === now + 5 * 60_000
  );
  assert.equal(scheduler.getStatus().queueDepth, 0);
});

test('official endpoint weights include read, quote, swap, and strategy writes', () => {
  assert.equal(endpointWeight('GET', '/v1/user/info'), 1);
  assert.equal(endpointWeight('GET', '/v1/user/wallet_activity'), 3);
  assert.equal(endpointWeight('GET', '/v1/trade/quote'), 2);
  assert.equal(endpointWeight('POST', '/v1/trade/swap'), 5);
  assert.equal(endpointWeight('POST', '/v1/trade/strategy/cancel'), 2);
  assert.equal(endpointWeight('GET', '/v1/market/rank'), 1);
  assert.equal(endpointWeight('POST', '/v1/market/hot_searches'), 3);
  assert.equal(endpointWeight('POST', '/v1/trenches'), 3);
  assert.equal(endpointWeight('GET', '/v1/market/token_top_holders'), 5);
});
