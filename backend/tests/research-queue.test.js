const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_CONCURRENCY,
  jobStatusFromCounts,
  normalizeAddresses,
  schedulerAllowsResearch
} = require('../domains/research/queue');

test('research jobs deduplicate addresses and keep the agreed concurrency', () => {
  const address = '0x1111111111111111111111111111111111111111';
  assert.deepEqual(normalizeAddresses('base', [address, address.toUpperCase()]), [address]);
  assert.equal(DEFAULT_CONCURRENCY, 3);
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
  assert.equal(schedulerAllowsResearch({ state: 'queued', reservedWeight: 0, queueByPriority: { 4: 2 } }), true);
  assert.equal(schedulerAllowsResearch({ state: 'cooling', reservedWeight: 0, queueByPriority: {} }), false);
});

test('research jobs reject more than thirty independent CA requests', () => {
  const addresses = Array.from({ length: 31 }, (_, index) => (
    `0x${String(index + 1).padStart(40, '0')}`
  ));
  assert.throws(() => normalizeAddresses('eth', addresses), /At most 30/);
});
