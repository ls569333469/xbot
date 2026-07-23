const test = require('node:test');
const assert = require('node:assert/strict');
const {
  IntervalLimiter,
  TwitterApiIoXClient,
  calculateFollowingsCredits
} = require('../lib/x-client');

test('followings credit calculation follows official tiers', () => {
  assert.equal(calculateFollowingsCredits(0), 60);
  assert.equal(calculateFollowingsCredits(20), 60);
  assert.equal(calculateFollowingsCredits(99), 297);
  assert.equal(calculateFollowingsCredits(100), 200);
  assert.equal(calculateFollowingsCredits(199), 398);
  assert.equal(calculateFollowingsCredits(200), 200);
});

test('IntervalLimiter serializes callers using one global interval', async () => {
  let clock = 0;
  const sleeps = [];
  const limiter = new IntervalLimiter(100, {
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    }
  });

  await Promise.all([limiter.wait(), limiter.wait(), limiter.wait()]);
  assert.deepEqual(sleeps, [100, 100]);
});

test('TwitterApiIoXClient maps followings and records actual credits', async () => {
  const finalized = [];
  const usage = {
    reserveUsage: async (provider, endpoint, credits) => ({ provider, endpoint, reservedCredits: credits }),
    finalizeUsage: async (...args) => finalized.push(args)
  };
  const payload = {
    status: 'success',
    followings: [
      { id: '1', userName: '@Neet_Sol', name: 'NEET' },
      { id: '2', userName: 'BlackBullSol', name: 'Black Bull' }
    ],
    has_next_page: true,
    next_cursor: 'cursor-2'
  };
  const client = new TwitterApiIoXClient('test-key', {
    limiter: { wait: async () => {} },
    usage,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: { get: () => null },
      text: async () => JSON.stringify(payload)
    })
  });

  const result = await client.getUserFollowingPage('Wanshenme', { pageSize: 20 });
  assert.deepEqual(result.users.map((user) => user.handle), ['neet_sol', 'blackbullsol']);
  assert.equal(result.hasNextPage, true);
  assert.equal(result.nextCursor, 'cursor-2');
  assert.equal(finalized[0][1], 60);
});

test('TwitterApiIoXClient classifies authentication failures without retrying', async () => {
  let calls = 0;
  const client = new TwitterApiIoXClient('test-key', {
    limiter: { wait: async () => {} },
    usage: {
      reserveUsage: async () => ({ provider: 'twitterapi', endpoint: '/test', reservedCredits: 15 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => {
      calls++;
      return {
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        headers: { get: () => null },
        text: async () => JSON.stringify({ message: 'bad key' })
      };
    }
  });

  await assert.rejects(client.request('GET', '/test'), { code: 'TWITTERAPI_UNAUTHORIZED' });
  assert.equal(calls, 1);
});

test('TwitterApiIoXClient retries temporary server failures', async () => {
  let calls = 0;
  const sleeps = [];
  const client = new TwitterApiIoXClient('test-key', {
    maxAttempts: 2,
    sleep: async (ms) => sleeps.push(ms),
    limiter: { wait: async () => {} },
    usage: {
      reserveUsage: async () => ({ provider: 'twitterapi', endpoint: '/test', reservedCredits: 15 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => {
      calls++;
      const failed = calls === 1;
      return {
        ok: !failed,
        status: failed ? 503 : 200,
        statusText: failed ? 'Unavailable' : 'OK',
        headers: { get: () => null },
        text: async () => JSON.stringify(failed ? { message: 'retry' } : { status: 'success' })
      };
    }
  });

  const result = await client.request('GET', '/test');
  assert.equal(result.status, 'success');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});
