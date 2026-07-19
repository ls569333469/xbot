// D:\AI_Projects\xbot\backend\jobs\budget-reset.js
const db = require('../lib/db');
const logger = require('../lib/logger');

async function reset() {
  logger.info('cron', 'Running midnight budget-reset job...');
  try {
    // 1. Reset daily spent budgets
    const budgetRes = await db.query(
      `UPDATE budget_tracking 
       SET spent = 0, updated_at = NOW() 
       WHERE period_type = 'daily'`
    );
    
    // 2. Reset whitelist daily buying states
    const wlRes = await db.query(
      `UPDATE ca_whitelist 
       SET spent_budget = 0, current_buy_count = 0, updated_at = NOW() 
       WHERE status = 'active'`
    );
    
    logger.info('cron', `Budget reset completed. Reset ${budgetRes.rowCount} daily budget periods and ${wlRes.rowCount} active whitelists.`);
  } catch (err) {
    logger.error('cron', `Budget reset job failed: ${err.message}`, { stack: err.stack });
  }
}

module.exports = { run: reset, reset };
