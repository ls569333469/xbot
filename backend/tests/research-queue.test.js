const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_CONCURRENCY,
  LIVE_CONCURRENCY,
  LIVE_RESEARCH_ADMISSION_WEIGHT,
  jobStatusFromCounts,
  normalizeAddresses,
  researchAdmission,
  schedulerAllowsResearch
} = require('../domains/research/queue');

test('research jobs deduplicate addresses and keep the agreed concurrency', () => {
  const address = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(normalizeAddresses('base', [address, address.toUpperCase()]), [address]);
  assert.equal(DEFAULT_CONCURRENCY, 3);
  assert.equal(LIVE_CONCURRENCY, 1);
  assert.equal(LIVE_RESEARCH_ADMISSION_WEIGHT, 9);
});

test('research job status isolates partial failures', () => {
  assert.equal(jobStatusFromCounts({ active_count: 2, failed_count: 0, total_count: 3 }), 'running');
  assert.equal(jobStatusFromCounts({ active_count: 0, failed_count: 1, total_count: 3 }), 'partial');
  assert.equal(jobStatusFromCounts({ active_count: 0, failed_count: 3, total_count: 3 }), 'failed');
  assert.equal(jobStatusFromCounts({ active_count: 0, failed_count: 0, total_count: 3 }), 'completed');
  assert.equal(jobStatusFromCounts({ active_count: 0, failed_count: 0, cancelled_count: 3, total_count: 3 }), 'cancelled');
});

test('research waits behind trade leases, higher-priority queues, and cooldowns', () => {
  assert.equal(schedulerAllowsResearch({ state: 'healthy', reservedWeight: 0, queueByPriority: {} }), true);
  assert.equal(schedulerAllowsResearch({ state: 'healthy', reservedWeight: 5, queueByPriority: {} }), false);
  assert.equal(schedulerAllowsResearch({ state: 'queued', reservedWeight: 0, queueByPriority: { 1: 1 } }), false);
  assert.equal(schedulerAllowsResearch({ state: 'queued', reservedWeight: 0, queueByPriority: { 4: 2 } }), false);
  assert.equal(schedulerAllowsResearch({ state: 'queued', reservedWeight: 0, queueByPriority: { 5: 2 } }), true);
  assert.equal(schedulerAllowsResearch({ state: 'cooling', reservedWeight: 0, queueByPriority: {} }), false);
  assert.deepEqual(researchAdmission({ state: 'cooling', cooldownUntil: 1234 }), {
    allowed: false,
    wait_reason: 'GMGN_COOLDOWN',
    retry_at: 1234
  });
  assert.deepEqual(researchAdmission({
    state: 'healthy', reservedWeight: 0, availableWeight: 8, queueByPriority: {}
  }, { liveMode: true }), {
    allowed: false,
    wait_reason: 'TRADE_CAPACITY_RESERVED',
    retry_at: null
  });
  assert.equal(researchAdmission({
    state: 'healthy', reservedWeight: 0, availableWeight: 9, queueByPriority: {}
  }, { liveMode: true }).allowed, true);
});

test('research jobs reject more than thirty independent CA requests', () => {
  const addresses = Array.from({ length: 31 }, (_, index) => (
    `0x${String(index + 1).padStart(40, '0')}`
  ));
  assert.throws(() => normalizeAddresses('eth', addresses), /At most 30/);
});
