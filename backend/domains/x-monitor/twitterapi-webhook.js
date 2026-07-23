const crypto = require('crypto');
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const { normalizeXHandle, normalizeXHandles } = require('../../lib/x-handles');
const { extractFromText, extractHandles } = require('../../lib/signal-extractor');
const xMonitorQueries = require('./queries');
const { matchActivity } = require('../signal/matcher');

function secureEqual(actual, expected) {
  const left = Buffer.from(String(actual || ''));
  const right = Buffer.from(String(expected || ''));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authenticateWebhook(req, expectedSecret = process.env.TWITTERAPI_IO_WEBHOOK_SECRET) {
  if (!expectedSecret) return false;
  const supplied = req.get('x-xbot-webhook-secret') || req.query.token;
  return secureEqual(supplied, expectedSecret);
}

function normalizeEventType(type) {
  const value = String(type || '').toLowerCase();
  if (['post', 'tweet', 'thread', 'mention'].includes(value)) return 'tweet';
  if (['repost', 'retweet'].includes(value)) return 'retweet';
  if (value === 'quote') return 'quote';
  if (value === 'reply') return 'reply';
  return null;
}

function parseTimestamp(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number' || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function authorFromTweet(tweet) {
  const author = tweet.author || tweet.user || {};
  return {
    id: String(tweet.user_id || author.id || author.id_str || ''),
    handle: normalizeXHandle(
      tweet.screen_name || author.userName || author.username || author.screen_name
    )
  };
}

function nestedAuthorHandle(value) {
  if (!value) return '';
  const author = value.author || value.user || {};
  return normalizeXHandle(
    value.screen_name || value.userName || value.username
      || author.userName || author.username || author.screen_name
  );
}

function targetHandlesFromTweet(tweet, text) {
  const entityMentions = [
    ...(tweet.entities?.user_mentions || []),
    ...(tweet.entities?.mentions || [])
  ].map((mention) => mention.screen_name || mention.userName || mention.username);

  return normalizeXHandles([
    ...(Array.isArray(tweet.mentions) ? tweet.mentions : []),
    ...entityMentions,
    ...extractHandles(text),
    tweet.inReplyToUsername,
    tweet.in_reply_to_screen_name,
    nestedAuthorHandle(tweet.retweeted_tweet),
    nestedAuthorHandle(tweet.retweeted_status),
    nestedAuthorHandle(tweet.quoted_tweet),
    nestedAuthorHandle(tweet.quoted_status)
  ]);
}

function tweetsFromPayload(payload) {
  if (payload?.event_type === 'fast_tweet' && payload.tweet) return [payload.tweet];
  if (payload?.event_type === 'tweet') {
    if (Array.isArray(payload.tweets)) return payload.tweets;
    if (payload.tweet) return [payload.tweet];
  }
  return [];
}

function normalizeTweet(payload, tweet) {
  const id = String(tweet.id || tweet.id_str || tweet.tweet_id || '');
  const text = String(tweet.text || tweet.full_text || '');
  const author = authorFromTweet(tweet);
  const activityType = normalizeEventType(
    tweet.type
      || (tweet.retweeted_status || tweet.retweeted_tweet ? 'retweet' : null)
      || (tweet.quoted_status || tweet.quoted_tweet ? 'quote' : null)
      || (tweet.in_reply_to_screen_name || tweet.inReplyToUsername ? 'reply' : null)
      || 'tweet'
  );
  const createdAt = parseTimestamp(
    tweet.created_ms || tweet.snowflake_created_ms || tweet.createdAt
      || tweet.created_at || tweet.tweet_created_at
  );

  if (!id || !author.handle || !activityType) return null;

  return {
    id,
    text,
    author,
    activityType,
    createdAt,
    targetHandles: targetHandlesFromTweet(tweet, text),
    providerTimestamp: parseTimestamp(payload.timestamp),
    raw: tweet
  };
}

function assertFreshPayload(payload, now = new Date()) {
  const timestamp = parseTimestamp(payload?.timestamp);
  if (!timestamp) {
    const error = new Error('Webhook event timestamp is required');
    error.code = 'WEBHOOK_TIMESTAMP_REQUIRED';
    throw error;
  }
  const maxAgeMs = Math.max(60000, Number(process.env.TWITTER_WEBHOOK_MAX_AGE_MS || 600000));
  const ageMs = now.getTime() - timestamp.getTime();
  if (ageMs > maxAgeMs || ageMs < -60000) {
    const error = new Error('Webhook event is outside the accepted time window');
    error.code = 'WEBHOOK_STALE_EVENT';
    throw error;
  }
}

async function findEnabledKol(author) {
  const result = await db.query(
    `SELECT * FROM x_kol_accounts
     WHERE enabled = true
       AND (LOWER(x_handle) = $1 OR ($2 <> '' AND x_user_id = $2))
     LIMIT 1`,
    [author.handle, author.id]
  );
  return result.rows[0] || null;
}

async function ingestTwitterApiEvent(payload, options = {}) {
  if (String(process.env.X_DATA_PROVIDER || '').toLowerCase() !== 'twitterapi') {
    const error = new Error('TwitterAPI.io webhook is inactive for the current provider');
    error.code = 'WEBHOOK_PROVIDER_INACTIVE';
    throw error;
  }
  assertFreshPayload(payload, options.now || new Date());
  const normalizedTweets = tweetsFromPayload(payload)
    .map((tweet) => normalizeTweet(payload, tweet))
    .filter(Boolean);
  const activities = [];
  let matched = 0;

  for (const tweet of normalizedTweets) {
    const kol = await findEnabledKol(tweet.author);
    if (!kol) continue;

    const extracted = extractFromText(tweet.text);
    const activity = await xMonitorQueries.insertActivity({
      kol_id: kol.id,
      kol_handle: kol.x_handle,
      activity_type: tweet.activityType,
      tweet_id: tweet.id,
      tweet_text: tweet.text,
      target_x_handle: tweet.targetHandles[0] || null,
      target_x_handles: tweet.targetHandles,
      extracted_cas: extracted.cas,
      extracted_tickers: extracted.tickers,
      provider_event_id: `twitterapi:${tweet.id}`,
      provider: 'twitterapi',
      source_created_at: tweet.createdAt,
      observation_started_at: tweet.createdAt,
      observation_ended_at: new Date(),
      raw_json: tweet.raw
    });
    if (!activity) continue;

    activities.push(activity);
    try {
      matched += await matchActivity(activity);
      await db.query('UPDATE x_activities SET processed = true WHERE id = $1', [activity.id]);
    } catch (error) {
      logger.error('twitterapi-webhook', `Immediate signal matching failed: ${error.message}`, {
        activity_id: activity.id
      });
    }

    await db.query(
      `UPDATE x_kol_accounts
       SET stream_status = 'active', stream_active_at = COALESCE(stream_active_at, NOW()), updated_at = NOW()
       WHERE id = $1`,
      [kol.id]
    );
  }

  return { received: normalizedTweets.length, inserted: activities.length, matched, activities };
}

module.exports = {
  authenticateWebhook,
  ingestTwitterApiEvent,
  normalizeEventType,
  normalizeTweet,
  tweetsFromPayload
};
