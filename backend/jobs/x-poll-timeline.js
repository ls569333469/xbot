const db = require('../lib/db');
const logger = require('../lib/logger');
const { createXClient } = require('../lib/x-client');
const xMonitorQueries = require('../domains/x-monitor/queries');
const { extractFromText, extractHandles } = require('../lib/signal-extractor');
const { normalizeXHandles } = require('../lib/x-handles');

let running = false;

function latestTweetId(tweets, fallback) {
  return tweets.reduce((latest, tweet) => {
    if (!tweet.id) return latest;
    if (!latest) return tweet.id;
    try {
      return BigInt(tweet.id) > BigInt(latest) ? tweet.id : latest;
    } catch {
      return String(tweet.id) > String(latest) ? tweet.id : latest;
    }
  }, fallback || null);
}

async function run(deps) {
  const provider = String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
  if (!['mock', 'socialdata'].includes(provider)) {
    return { status: 'skipped', reason: 'timeline_polling_provider_unsupported', provider };
  }
  if (running) return;
  running = true;
  logger.info('jobs', 'Running x-poll-timeline job');
  try {
    const xClient = createXClient();
    const res = await db.query(
      'SELECT * FROM x_kol_accounts WHERE enabled = true ORDER BY last_polled_at ASC NULLS FIRST LIMIT 3'
    );

    for (const kol of res.rows) {
      try {
        const tweets = await xClient.getUserTimeline(kol.x_handle, kol.last_tweet_id);
        const newLastTweetId = latestTweetId(tweets, kol.last_tweet_id);

        if (!kol.last_tweet_id) {
          await db.query(
            'UPDATE x_kol_accounts SET last_polled_at = NOW(), last_tweet_id = $1 WHERE id = $2',
            [newLastTweetId, kol.id]
          );
          logger.info('jobs', `Initialized timeline baseline for KOL ${kol.x_handle}`);
          continue;
        }

        for (const tweet of tweets) {
          const { cas, tickers } = extractFromText(tweet.text);
          const targetHandles = normalizeXHandles([
            ...(tweet.target_handles || []),
            ...extractHandles(tweet.text)
          ]);

          await xMonitorQueries.insertActivity({
            kol_id: kol.id,
            kol_handle: kol.x_handle,
            activity_type: tweet.activity_type || 'tweet',
            tweet_id: tweet.id,
            tweet_text: tweet.text,
            target_x_handle: targetHandles[0] || null,
            target_x_handles: targetHandles,
            extracted_cas: cas,
            extracted_tickers: tickers,
            provider_event_id: `tweet:${tweet.id}`,
            source_created_at: tweet.created_at || null,
            raw_json: tweet.raw_json || tweet
          });
        }

        await db.query(
          'UPDATE x_kol_accounts SET last_polled_at = NOW(), last_tweet_id = $1 WHERE id = $2',
          [newLastTweetId, kol.id]
        );
      } catch (err) {
        logger.error('jobs', `Failed to poll timeline for KOL ${kol.x_handle}: ${err.message}`);
      }
    }
  } finally {
    running = false;
  }
}

module.exports = { run };
