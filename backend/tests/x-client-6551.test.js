const test = require('node:test');
const assert = require('node:assert/strict');
const { X6551Client, normalizeTweets, normalizeWatchFlags } = require('../lib/x-client-6551');

function response(payload, options = {}) {
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    text: async () => JSON.stringify(payload)
  };
}

test('X6551Client normalizes Watch accounts and explicit flags', async () => {
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => response({
      success: true,
      data: {
        list: [
          { twAccount: '@Neet_Sol', newTweetBol: true, updateNameBol: true },
          { username: 'WanShenMe', newFlwBol: true }
        ]
      }
    })
  });

  const watches = await client.listWatches();
  assert.deepEqual(watches.map((watch) => watch.username), ['neet_sol', 'wanshenme']);
  assert.deepEqual(watches.map((watch) => watch.providerUsername), ['Neet_Sol', 'WanShenMe']);
  assert.equal(watches[0].flags.newTweetBol, true);
  assert.equal(watches[0].flags.updateNameBol, true);
  assert.equal(watches[0].flags.newFlwBol, false);
});

test('X6551Client preserves provider casing when deleting a Watch', async () => {
  let requestBody;
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      return response({ success: true });
    }
  });

  await client.deleteWatch('@CupseyToken');
  assert.deepEqual(requestBody, { username: 'CupseyToken' });
});

test('X6551Client never retries Watch mutations', async () => {
  let calls = 0;
  const client = new X6551Client('test-token', {
    sleep: async () => {},
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => {
      calls += 1;
      return response({ message: 'temporary failure' }, { ok: false, status: 503 });
    }
  });

  await assert.rejects(client.addWatch('neet_sol', normalizeWatchFlags()), { code: 'X6551_HTTP_ERROR' });
  assert.equal(calls, 1);
});

test('X6551Client does not finalize the same usage reservation twice', async () => {
  let finalizeCalls = 0;
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {
        finalizeCalls += 1;
        throw new Error('usage database unavailable');
      }
    },
    fetchImpl: async () => response({ success: true, data: { screenName: 'neet_sol', userId: '1' } })
  });

  await assert.rejects(client.getUserProfile('neet_sol'), /usage database unavailable/);
  assert.equal(finalizeCalls, 1);
});

test('X6551Client accepts a provider-confirmed profile without a numeric user ID', async () => {
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => response({
      success: true,
      data: { screenName: 'MEADGod', name: 'MEAD' }
    })
  });

  assert.deepEqual(await client.getUserProfile('@MEADGod'), {
    id: 'meadgod',
    handle: 'meadgod',
    name: 'MEAD',
    followers_count: 0,
    following_count: 0
  });
});

test('X6551Client rejects a profile response for a different account', async () => {
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async () => response({
      success: true,
      data: { screenName: 'DifferentAccount', name: 'Wrong user' }
    })
  });

  await assert.rejects(client.getUserProfile('@MEADGod'), { code: 'X6551_PROFILE_MISMATCH' });
});

test('X6551Client exposes bounded user tweet and search helpers', async () => {
  const requests = [];
  const client = new X6551Client('test-token', {
    usage: {
      reserveUsage: async () => ({ reservedCredits: 0 }),
      finalizeUsage: async () => {}
    },
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return response({ success: true, data: { tweets: [{ id: '123', text: 'CA 0xabc', userScreenName: 'Project' }] } });
    }
  });

  assert.deepEqual(await client.getUserTweets('@@Project', { maxResults: 500 }), [{
    id: '123', text: 'CA 0xabc', created_at: null, user_handle: 'project'
  }]);
  assert.deepEqual(await client.searchTweets({ keywords: '0xabc', fromUser: '@Project', maxResults: 2 }), [{
    id: '123', text: 'CA 0xabc', created_at: null, user_handle: 'project'
  }]);
  assert.match(requests[0].url, /twitter_user_tweets$/);
  assert.equal(requests[0].body.maxResults, 100);
  assert.deepEqual(requests[1].body, {
    maxResults: 2,
    product: 'Top',
    keywords: '0xabc',
    fromUser: 'project'
  });
  assert.deepEqual(normalizeTweets({ data: [{ id: 'profile-only' }] }), []);
});
