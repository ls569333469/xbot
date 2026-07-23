const logger = require('../lib/logger');
const { reconciler } = require('../domains/trade/reconciliation-service');

async function run() {
  logger.info('jobs', 'Running always-on trade reconciliation');
  return reconciler.runOnce();
}

module.exports = { run };
