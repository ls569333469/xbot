const PERFORMANCE_MODES = Object.freeze(['post_calls', 'follow_discovery']);
const PERFORMANCE_RUN_STATUSES = Object.freeze([
  'pending', 'extracting', 'pricing', 'completed', 'no_samples', 'price_retry', 'failed'
]);
const PRICE_STATUSES = Object.freeze(['pending', 'completed', 'retry', 'no_data', 'failed']);
const CHAIN_IDS = Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood']);
const REPLAY_PROVIDER_VERSION = 'p33-kline-replay-v1';

function normalizeMode(value) {
  const mode = String(value || '').trim().toLowerCase();
  return PERFORMANCE_MODES.includes(mode) ? mode : null;
}

function addressKey(chainId, address) {
  const value = String(address || '').trim();
  return String(chainId || '').toLowerCase() === 'sol' ? value : value.toLowerCase();
}

module.exports = {
  ADDRESS: addressKey,
  CHAIN_IDS,
  PERFORMANCE_MODES,
  PERFORMANCE_RUN_STATUSES,
  PRICE_STATUSES,
  REPLAY_PROVIDER_VERSION,
  addressKey,
  normalizeMode
};
