const assert = require('node:assert/strict');
const test = require('node:test');
const {
  assertConfigKey,
  validateChainConfigs,
  validateLivePolicy,
  validateRiskConfig
} = require('../domains/config/service');

test('configuration service rejects arbitrary database config keys', () => {
  assert.throws(() => assertConfigKey('engine_armed'), { code: 'CONFIG_KEY_NOT_ALLOWED' });
  assert.doesNotThrow(() => assertConfigKey('live_policy'));
});

test('live policy is normalized and limited to P9.1 providers and event types', () => {
  assert.deepEqual(validateLivePolicy({
    providers: ['6551', '6551'],
    event_types: ['Reply', 'follow'],
    chains: ['SOL', 'base'],
    whitelist_ids: [4, '2', 4],
    max_signal_age_seconds: 30
  }), {
    providers: ['6551'],
    event_types: ['reply', 'follow'],
    chains: ['sol', 'base'],
    whitelist_ids: [2, 4],
    max_signal_age_seconds: 30
  });
  assert.throws(() => validateLivePolicy({
    providers: ['twitterapi'], event_types: [], chains: [], whitelist_ids: []
  }), { code: 'CONFIG_VALUE_INVALID' });
});

test('chain configuration uses the same positive and ordered limits as the frontend', () => {
  assert.throws(() => validateChainConfigs({ polygon: {} }), { code: 'CONFIG_VALUE_INVALID' });
  assert.throws(() => validateChainConfigs({
    sol: {
      enabled: false,
      dailyBudget: 1,
      weeklyBudget: 2,
      maxPerTrade: 0,
      maxOpenPositions: 1,
      dailyLossLimit: 1
    }
  }), { code: 'CONFIG_VALUE_INVALID' });
  assert.throws(() => validateChainConfigs({
    bsc: {
      enabled: true,
      dailyBudget: 0.01,
      weeklyBudget: 0.02,
      maxPerTrade: 0.02,
      maxOpenPositions: 2,
      dailyLossLimit: 0.01
    }
  }), /maxPerTrade <= dailyBudget <= weeklyBudget/);
  assert.throws(() => validateChainConfigs({
    base: {
      enabled: true,
      dailyBudget: 0.001,
      weeklyBudget: 0.002,
      maxPerTrade: 0.0002,
      maxOpenPositions: 1.5,
      dailyLossLimit: 0.001
    }
  }), /maxOpenPositions must be an integer/);
  assert.deepEqual(validateChainConfigs({
    eth: {
      enabled: false,
      dailyBudget: 0.5,
      weeklyBudget: 2,
      maxPerTrade: 0.1,
      maxOpenPositions: 3,
      dailyLossLimit: 0.3
    }
  }).eth, {
    enabled: false,
    dailyBudget: 0.5,
    weeklyBudget: 2,
    maxPerTrade: 0.1,
    maxOpenPositions: 3,
    dailyLossLimit: 0.3
  });
});

test('risk configuration rejects unknown fields and unsafe ranges', () => {
  const valid = validateRiskConfig({
    security_check_enabled: false,
    max_buy_tax: 5,
    max_sell_tax: 10,
    max_rug_ratio: 0.3,
    consecutive_failure_lock: 3,
    reject_cooldown_ms: 600000,
    min_liquidity_usd: 10000,
    max_slippage_pct: 15,
    consecutive_loss_limit: 5,
    ca_cooldown_min: 30
  });
  assert.equal(valid.security_check_enabled, true);
  assert.throws(() => validateRiskConfig({ ...valid, typo_limit: 1 }), /Unsupported risk_config field/);
  assert.throws(() => validateRiskConfig({ ...valid, max_rug_ratio: 1.1 }), /max_rug_ratio/);
});
