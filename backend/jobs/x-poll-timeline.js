const db = require('../lib/db');
const logger = require('../lib/logger');
const { createXClient } = require('../lib/x-client');
const xMonitorQueries = require('../domains/x-monitor/queries');
const { extractFromText, extractHandles } = require('../lib/signal-extractor');

async function run(deps) {
  logger.info('jobs', 'Running x-poll-timeline job');
  const xClient = createXClient();
  
  // Get up to 3 enabled KOLs sorted by oldest last_polled_at
  const res = await db.query(
    'SELECT * FROM x_kol_accounts WHERE enabled = true ORDER BY last_polled_at ASC NULLS FIRST LIMIT 3'
  );
  const kols = res.rows;
  
  for (const kol of kols) {
    try {
      const tweets = await xClient.getUserTimeline(kol.x_handle, kol.last_tweet_id);
      
      for (const tweet of tweets) {
        const { cas, tickers } = extractFromText(tweet.text);
        const handles = extractHandles(tweet.text);
        // Usually target handle is one of the mentions, just pick first for simplicity or null
        const targetHandle = handles.length > 0 ? handles[0] : null;

        await xMonitorQueries.insertActivity({
          kol_id: kol.id,
          kol_handle: kol.x_handle,
          activity_type: 'tweet',
          tweet_id: tweet.id,
          tweet_text: tweet.text,
          target_x_handle: targetHandle,
          extracted_cas: cas,
          extracted_tickers: tickers,
          raw_json: tweet
        });
      }
      
      const newLastTweetId = tweets.length > 0 ? tweets[0].id : kol.last_tweet_id;
      
      await db.query(
        'UPDATE x_kol_accounts SET last_polled_at = NOW(), last_tweet_id = $1 WHERE id = $2',
        [newLastTweetId, kol.id]
      );
    } catch (err) {
      logger.error('jobs', `Failed to poll timeline for KOL ${kol.x_handle}: ${err.message}`);
    }
  }
}

module.exports = { run };
