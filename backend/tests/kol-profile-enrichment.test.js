const assert = require('node:assert/strict');
const test = require('node:test');
const {
  KolProfileEnrichmentWorker,
  retryDelayMs
} = require('../jobs/kol-profile-enrichment');

test('KOL profile retry delay follows bounded exponential schedule', () => {
  assert.equal(retryDelayMs({}, 1), 60_000);
  assert.equal(retryDelayMs({}, 2), 5 * 60_000);
  assert.equal(retryDelayMs({}, 99), 24 * 60 * 60_000);
  assert.equal(retryDelayMs({ code: 'X6551_AUTH_ERROR' }, 1), 6 * 60 * 60_000);
});

test('KOL profile worker completes a pending profile', async () => {
  const completed = [];
  const worker = new KolProfileEnrichmentWorker({
    isEnabled: () => true,
    logger: { warn() {}, error() {} },
    clientFactory: () => ({
      getUserProfile: async () => ({ id: '12345', handle: 'meadgod', name: 'MEAD' })
    }),
    queries: {
      claimPendingProfiles: async () => [{ id: 7, x_handle: 'meadgod', profile_attempt_count: 0 }],
      completeProfileVerification: async (...args) => {
        completed.push(args);
        return { id: 7, profile_status: 'verified' };
      },
      failProfileVerification: async () => assert.fail('failure path should not run')
    }
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, { status: 'completed', processed: 1, verified: 1, failed: 0 });
  assert.deepEqual(completed[0], [
    7,
    'meadgod',
    { id: '12345', handle: 'meadgod', name: 'MEAD' }
  ]);
});

test('KOL profile worker schedules another attempt after provider failure', async () => {
  const failures = [];
  const error = new Error('rate limited');
  error.code = 'X6551_RATE_LIMITED';
  const worker = new KolProfileEnrichmentWorker({
    isEnabled: () => true,
    logger: { warn() {}, error() {} },
    clientFactory: () => ({ getUserProfile: async () => { throw error; } }),
    queries: {
      claimPendingProfiles: async () => [{ id: 8, x_handle: 'robinhoodcrypto', profile_attempt_count: 0 }],
      completeProfileVerification: async () => assert.fail('success path should not run'),
      failProfileVerification: async (...args) => failures.push(args)
    }
  });

  const before = Date.now();
  const result = await worker.runOnce();
  assert.deepEqual(result, { status: 'completed', processed: 1, verified: 0, failed: 1 });
  assert.equal(failures[0][0], 8);
  assert.equal(failures[0][1], 'X6551_RATE_LIMITED');
  assert.ok(failures[0][2].getTime() >= before + 59_000);
});
