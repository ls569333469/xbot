// D:\AI_Projects\xbot\backend\scripts\test-risk-rejects.js
require('dotenv').config();
const db = require('../lib/db');
const signalMatcher = require('../jobs/signal-matcher');
const engineState = require('../lib/engine-state');

async function runTest() {
  console.log('=== Risk Manager Rejection Test Starting ===');

  // Clear tables
  await db.query('DELETE FROM positions');
  await db.query('DELETE FROM trade_signals');
  await db.query('DELETE FROM x_activities');
  await db.query('DELETE FROM ca_whitelist');
  await db.query('DELETE FROM x_kol_accounts');
  await db.query('DELETE FROM budget_tracking');

  const kolRes = await db.query(
    "INSERT INTO x_kol_accounts (x_handle, display_name, weight, enabled) VALUES ('elonmusk', 'Elon Musk', 10, true) RETURNING id"
  );
  const kolId = kolRes.rows[0].id;

  const wlRes = await db.query(
    `INSERT INTO ca_whitelist (contract_address, chain_id, symbol, project_name, budget_per_trade, total_budget, status, allow_repeat_buy, max_repeat_buys, current_buy_count)
     VALUES ('FRBe123456789012345678901234567890123456', 'sol', 'PEPE', 'Pepe Coin', 0.5, 2.0, 'active', false, 1, 0)
     RETURNING *`
  );
  const whitelist = wlRes.rows[0];

  // Insert a mock activity with extracted_cas and extracted_tickers populated!
  const actRes = await db.query(
    `INSERT INTO x_activities (kol_id, kol_handle, activity_type, tweet_id, tweet_text, extracted_cas, extracted_tickers, processed)
     VALUES ($1, 'elonmusk', 'tweet', '1000000000000000002', 'I love $PEPE!', ARRAY['FRBe123456789012345678901234567890123456'], ARRAY['PEPE'], false)
     RETURNING id`,
    [kolId]
  );
  const activityId = actRes.rows[0].id;

  console.log('\n[1] Testing Rejection when ENGINE_LOCKED (Armed = false)...');
  engineState.setArmed(false);
  
  // Trigger signal-matcher
  await signalMatcher.run({ wsBroadcast: () => {} });

  // Query status of the signal
  let sigRes = await db.query('SELECT status, reject_reason FROM trade_signals LIMIT 1');
  if (sigRes.rows.length > 0) {
    console.log(`✓ Signal matched and status updated to: "${sigRes.rows[0].status}", reject_reason: "${sigRes.rows[0].reject_reason}"`);
  }

  // Clear trade signals and reset processed = false on activity to test armed case
  await db.query('DELETE FROM trade_signals');
  await db.query('UPDATE x_activities SET processed = false WHERE id = $1', [activityId]);

  console.log('\n[2] Testing approved trade when ENGINE_ARMED (Armed = true)...');
  engineState.setArmed(true);
  await signalMatcher.run({ wsBroadcast: () => {} });
  
  sigRes = await db.query('SELECT status, reject_reason FROM trade_signals LIMIT 1');
  if (sigRes.rows.length > 0) {
    console.log(`✓ Signal status: "${sigRes.rows[0].status}" (Expected: executed)`);
  }
  let posRes = await db.query('SELECT id, status FROM positions');
  console.log(`✓ Positions count: ${posRes.rows.length}, first position status: "${posRes.rows[0]?.status}"`);

  // Update whitelist buy_count manually to simulate a purchase was done, to test repeat buy check
  await db.query('UPDATE ca_whitelist SET current_buy_count = 1 WHERE id = $1', [whitelist.id]);

  // Insert another mock activity for repeat buy test
  const actRes2 = await db.query(
    `INSERT INTO x_activities (kol_id, kol_handle, activity_type, tweet_id, tweet_text, extracted_cas, extracted_tickers, processed)
     VALUES ($1, 'elonmusk', 'tweet', '1000000000000000003', 'Still bullish on $PEPE!', ARRAY['FRBe123456789012345678901234567890123456'], ARRAY['PEPE'], false)
     RETURNING id`,
    [kolId]
  );
  const activityId2 = actRes2.rows[0].id;

  console.log('\n[3] Testing Rejection due to REACHED_BUY_LIMIT (allow_repeat_buy = false, current_buy_count = 1)...');
  await signalMatcher.run({ wsBroadcast: () => {} });

  // Query status of the new signal
  const sigRes2 = await db.query('SELECT status, reject_reason FROM trade_signals WHERE activity_id = $1', [activityId2]);
  if (sigRes2.rows.length > 0) {
    console.log(`✓ Signal status: "${sigRes2.rows[0].status}", reject_reason: "${sigRes2.rows[0].reject_reason}" (Expected: REACHED_BUY_LIMIT)`);
  }

  await db.pool.end();
  console.log('\n=== Risk Manager Rejection Test Finished ===');
}

runTest().catch(err => console.error(err));
