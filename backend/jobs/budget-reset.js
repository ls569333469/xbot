// D:\AI_Projects\xbot\backend\jobs\budget-reset.js
const logger = require('../lib/logger');

async function reset() {
  logger.warn('cron', 'Legacy budget-reset is disabled; P9 budgets use immutable reservation and ledger periods.');
  return { status: 'disabled', reason: 'P9_LEDGER_IS_CUMULATIVE' };
}

module.exports = { run: reset, reset };
