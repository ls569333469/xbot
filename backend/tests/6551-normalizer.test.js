const test = require('node:test');
const assert = require('node:assert/strict');
const { normalize6551Event } = require('../domains/x-monitor/6551/normalizer');
const { redactPayload } = require('../domains/x-monitor/6551/event-inbox');

function tweetEvent(overrides = {}) {
  return {
    id: 1001,
    twAccount: 'WanShenMe',
    eventType: 'NEW_TWEET',
    createdAt: '2026-07-21T08:00:00Z',
    content: {
      id: '2030318958512164966',
      text: 'Watching @neet_sol and ANSEM',
      createdAt: '2026-07-21T08:00:00Z',
      userScreenName: 'WanShenMe',
      userIdStr: '42',
      mentions: [{ username: 'Neet_Sol' }]
    },
    ...overrides
  };
}

test('normalizes official Tweet and CA payloads to one semantic behavior key', () => {
  const tweet = normalize6551Event(tweetEvent())[0];
  const ca = normalize6551Event(tweetEvent({
    id: 1002,
    eventType: 'CA',
    ca: 'Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump'
  }))[0];

  assert.equal(tweet.actorHandle, 'wanshenme');
  assert.deepEqual(tweet.targetHandles, ['neet_sol']);
  assert.equal(tweet.semanticKey, 'tweet:wanshenme:2030318958512164966');
  assert.equal(ca.semanticKey, tweet.semanticKey);
  assert.ok(ca.extractedCas.includes('Ce2gx9KGXJ6C9Mp5b5x1sn9Mg87JwEbrQby4Zqo3pump'));
});

test('reply enrichment uses the original tweet author even when text has other mentions', () => {
  const event = tweetEvent({
    eventType: 'NEW_TWEET_REPLY',
    content: {
      id: '2030318958512164967',
      text: 'cc @somebody_else',
      createdAt: '2026-07-21T08:01:00Z',
      userScreenName: 'WanShenMe',
      mentions: [{ username: 'somebody_else' }]
    }
  });
  assert.equal(normalize6551Event(event)[0].needsEnrichment, true);

  const normalized = normalize6551Event(event, {
    enrichment: { data: { replyStatus: { userScreenName: 'Neet_Sol' } } }
  })[0];
  assert.equal(normalized.needsEnrichment, false);
  assert.ok(normalized.targetHandles.includes('neet_sol'));
});

test('normalizes a 6551 quote from the monitored actor to the quoted project account', () => {
  const event = tweetEvent({
    id: 1003,
    twAccount: 'heyibinance',
    eventType: 'NEW_TWEET_QUOTE',
    content: {
      id: '2080177272146088551',
      text: 'Worth reading',
      createdAt: 'Thu Jul 23 06:24:44 +0000 2026',
      userIdStr: '359',
      userScreenName: 'heyibinance',
      quotedStatus: {
        id: '2080173034921742888',
        text: 'Project update',
        userIdStr: '4800',
        userScreenName: '48clubian'
      }
    }
  });

  const normalized = normalize6551Event(event)[0];
  assert.equal(normalized.actorHandle, 'heyibinance');
  assert.equal(normalized.activityType, 'quote');
  assert.equal(normalized.needsEnrichment, false);
  assert.ok(normalized.targetHandles.includes('48clubian'));
});

test('uses a leading reply mention when the first 6551 Reply payload omits replyStatus', () => {
  const event = tweetEvent({
    eventType: 'NEW_TWEET_REPLY',
    content: {
      id: '2030318958512164968',
      text: '@CupseyToken 666',
      isReply: true,
      createdAt: '2026-07-21T08:01:01Z',
      userScreenName: 'WanShenMe'
    }
  });

  const normalized = normalize6551Event(event)[0];
  assert.equal(normalized.activityType, 'reply');
  assert.equal(normalized.needsEnrichment, false);
  assert.ok(normalized.targetHandles.includes('cupseytoken'));
});

test('infers a Reply from CA payload replyStatus even when isReply is omitted', () => {
  const event = tweetEvent({
    eventType: 'CA',
    ca: '6NwarBvDkXhByqVp2Qkq5i9XbtA2B3Bwe8SWGu9vpump',
    content: {
      id: '2030318958512164969',
      text: '@CupseyToken 666',
      createdAt: '2026-07-21T08:01:02Z',
      userScreenName: 'WanShenMe',
      replyStatus: { userScreenName: 'CupseyToken' }
    }
  });

  const normalized = normalize6551Event(event)[0];
  assert.equal(normalized.activityType, 'reply');
  assert.equal(normalized.needsEnrichment, false);
  assert.ok(normalized.targetHandles.includes('cupseytoken'));
});

test('normalizes the real 6551 follow direction from monitored actor to content target', () => {
  const follow = normalize6551Event({
    id: 2001,
    twAccount: 'WanShenMe',
    eventType: 'NEW_FOLLOWER',
    createdAt: '2026-07-21T08:02:00Z',
    content: JSON.stringify([{ id: 42, twId: 42, twAccount: 'Neet_Sol' }])
  })[0];
  const unfollow = normalize6551Event({
    id: 2002,
    twAccount: 'WanShenMe',
    eventType: 'NEW_UNFOLLOWER',
    createdAt: '2026-07-21T08:03:00Z',
    content: JSON.stringify([{ id: 42, twId: 42, twAccount: 'Neet_Sol' }])
  })[0];

  assert.equal(follow.actorHandle, 'wanshenme');
  assert.equal(follow.activityType, 'follow');
  assert.deepEqual(follow.targetHandles, ['neet_sol']);
  assert.equal(follow.semanticKey, 'follow:wanshenme:neet_sol');
  assert.equal(unfollow.activityType, 'unfollow');
});

test('fails closed when a Tweet payload lacks a provider timestamp', () => {
  const event = tweetEvent();
  delete event.createdAt;
  delete event.content.createdAt;
  assert.throws(() => normalize6551Event(event), { code: 'X6551_EVENT_SCHEMA_ERROR' });
});

test('redacts credentials and token query parameters before Inbox persistence', () => {
  const redacted = redactPayload({
    token: 'secret-token',
    nested: {
      authorization: 'Bearer abc.def',
      url: 'wss://example.test/path?token=abc123&mode=watch',
      text: 'normal content'
    }
  });
  assert.equal(redacted.token, '[REDACTED]');
  assert.equal(redacted.nested.authorization, '[REDACTED]');
  assert.equal(redacted.nested.url, 'wss://example.test/path?token=[REDACTED]&mode=watch');
  assert.equal(redacted.nested.text, 'normal content');
});
