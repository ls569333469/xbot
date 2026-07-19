// D:\AI_Projects\xbot\backend\scripts\test-concurrency-locks.js
require('dotenv').config(); // Load environment variables first!
const db = require('../lib/db');
const tradeEngine = require('../domains/trade/trade-engine');
const engineState = require('../lib/engine-state');

async function runTest() {
  console.log('=== Concurrency Locks Test Starting ===');
  engineState.setArmed(true);
  console.log('Armed engine state: true');

  // Insert fresh KOL and Whitelist entry for test
  console.log('\n[1] Preparing database whitelist...');
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
     VALUES ('FRBe123456789012345678901234567890123456', 'sol', 'PEPE', 'Pepe Coin', 0.5, 1.0, 'active', false, 1, 0)
     RETURNING *`
  );
  const whitelist = wlRes.rows[0];
  console.log(`Inserted Whitelist ID: ${whitelist.id}, current_buy_count: 0`);

  // Insert mock activity first to satisfy activity_id foreign key constraint in trade_signals
  const actRes = await db.query(
    `INSERT INTO x_activities (kol_id, kol_handle, activity_type, tweet_id, tweet_text, processed)
     VALUES ($1, 'elonmusk', 'tweet', '1000000000000000001', 'Test tweet for PEPE!', true)
     RETURNING id`,
    [kolId]
  );
  const activityId = actRes.rows[0].id;

  // Insert signals into trade_signals table
  await db.query(
    `INSERT INTO trade_signals (id, activity_id, whitelist_id, kol_id, kol_handle, kol_weight, signal_type, status)
     VALUES 
     (101, $1, $2, $3, 'elonmusk', 10, 'ca_mention', 'recorded'),
     (102, $1, $2, $3, 'elonmusk', 10, 'ticker_mention', 'recorded'),
     (103, $1, $2, $3, 'elonmusk', 10, 'handle_match', 'recorded')`,
    [activityId, whitelist.id, kolId]
  );

  // Simulate 3 concurrent signals for the same whitelist entry
  console.log('\n[2] Triggering 3 concurrent openRealPosition transactions in parallel...');
  const signals = [
    { id: 101, kol_id: kolId, kol_handle: 'elonmusk', whitelist_id: whitelist.id, chain_id: 'sol', contract_address: whitelist.contract_address, signal_type: 'ca_mention' },
    { id: 102, kol_id: kolId, kol_handle: 'elonmusk', whitelist_id: whitelist.id, chain_id: 'sol', contract_address: whitelist.contract_address, signal_type: 'ticker_mention' },
    { id: 103, kol_id: kolId, kol_handle: 'elonmusk', whitelist_id: whitelist.id, chain_id: 'sol', contract_address: whitelist.contract_address, signal_type: 'handle_match' }
  ];

  const results = await Promise.allSettled(
    signals.map((sig, idx) => {
      console.log(`- Initiating openRealPosition #${idx + 1}...`);
      return tradeEngine.openRealPosition(sig, () => {});
    })
  );

  console.log('\n[3] Inspection Results:');
  results.forEach((res, idx) => {
    if (res.status === 'fulfilled') {
      console.log(`Transaction #${idx + 1}: SUCCESS! Position created:`, res.value.id);
    } else {
      console.log(`Transaction #${idx + 1}: REJECTED! Reason:`, res.reason.message);
    }
  });

  // Query whitelist status after concurrent buys
  const finalWlRes = await db.query('SELECT current_buy_count, spent_budget FROM ca_whitelist WHERE id = $1', [whitelist.id]);
  const finalWl = finalWlRes.rows[0];
  console.log(`\n[4] Final Whitelist stats: buy_count: ${finalWl.current_buy_count}, spent_budget: ${finalWl.spent_budget}`);

  // Query final budget status
  const finalBudgetRes = await db.query('SELECT spent, budget_limit FROM budget_tracking');
  if (finalBudgetRes.rows.length > 0) {
    console.log(`Final Daily Budget: spent: ${finalBudgetRes.rows[0].spent} / limit: ${finalBudgetRes.rows[0].budget_limit}`);
  }

  // End connection pool
  await db.pool.end();
  console.log('\n=== Concurrency Locks Test Finished ===');
}
runTest().catch(err => console.error(err));
