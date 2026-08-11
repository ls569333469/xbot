const assert = require('node:assert/strict');
const test = require('node:test');
const { impactForKeys, validateValue } = require('../domains/system/env-settings');

test('environment settings enforce local binding and valid ports', () => {
  assert.equal(validateValue('BACKEND_HOST', '127.0.0.1'), '127.0.0.1');
  assert.throws(() => validateValue('BACKEND_HOST', '0.0.0.0'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('BACKEND_PORT', '70000'), { code: 'ENV_VALUE_INVALID' });
});

test('environment settings validate GMGN and RPC contracts without exposing values', () => {
  assert.equal(validateValue('GMGN_API_KEY', 'gmgn-test-value'), 'gmgn-test-value');
  assert.equal(validateValue('GMGN_TEST_API_KEY', 'gmgn-test-value'), 'gmgn-test-value');
  assert.equal(validateValue('GMGN_CREDENTIAL_PROFILE', 'test'), 'test');
  assert.throws(() => validateValue('GMGN_CREDENTIAL_PROFILE', 'staging'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('GMGN_API_KEY', 'invalid'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('XAI_API_KEY', 'xai-test-value'), 'xai-test-value');
  assert.equal(validateValue('XAI_BASE_URL', 'https://api.apikey.fun/v1/'), 'https://api.apikey.fun/v1');
  assert.equal(validateValue('XAI_MODEL', 'grok-4.5'), 'grok-4.5');
  assert.throws(() => validateValue('XAI_BASE_URL', 'http://api.example.com/v1'), {
    code: 'ENV_VALUE_INVALID'
  });
  assert.equal(validateValue('SOLANA_RPC_URL', 'https://rpc.example.test'), 'https://rpc.example.test');
  assert.equal(validateValue('ROBINHOOD_RPC_URL', 'https://rpc.mainnet.chain.robinhood.com'), 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(validateValue('GMGN_MAX_FEE_RESERVE_ROBINHOOD', '0.002'), '0.002');
  assert.equal(validateValue('GMGN_MIN_GAS_RESERVE_ROBINHOOD', '0.01'), '0.01');
  assert.throws(() => validateValue('GMGN_MIN_GAS_RESERVE_ROBINHOOD', '-1'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('BASE_RPC_URL', 'file:///tmp/rpc'), { code: 'ENV_VALUE_INVALID' });
});

test('production settings keep the live provider and mode contract narrow', () => {
  assert.throws(() => validateValue('SIGNAL_MAX_AGE_SECONDS', '301'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('X_6551_HEARTBEAT_MS', '4999'), { code: 'ENV_KEY_NOT_ALLOWED' });
  assert.throws(() => validateValue('X_DATA_PROVIDER', '6551'), { code: 'ENV_KEY_NOT_ALLOWED' });
  assert.throws(() => validateValue('TRADING_MODE', 'paper'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('XBOT_PROCESS_ROLE', 'execution'), 'execution');
  assert.throws(() => validateValue('XBOT_PROCESS_ROLE', 'worker'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('XBOT_STRATEGY_SYNC_GROUP_BUDGET', '1'), '1');
  assert.equal(validateValue('XBOT_STRATEGY_SYNC_GROUP_BUDGET', '4'), '4');
  assert.throws(() => validateValue('XBOT_STRATEGY_SYNC_GROUP_BUDGET', '5'), {
    code: 'ENV_VALUE_INVALID'
  });
});

test('configuration impact registry keeps research hot and scopes monitoring restarts', () => {
  assert.deepEqual(impactForKeys(['XAI_API_KEY', 'XAI_MODEL']), {
    impact_scope: 'research_only',
    impact_scopes: ['research_only'],
    changed_keys: ['XAI_API_KEY', 'XAI_MODEL'],
    restart_required: false,
    restart_roles: [],
    manual_rearm_required: false
  });
  const monitoring = impactForKeys(['OPENNEWS_TOKEN']);
  assert.equal(monitoring.impact_scope, 'monitoring_critical');
  assert.deepEqual(monitoring.restart_roles, ['ingestion']);
  assert.equal(monitoring.manual_rearm_required, false);
  assert.equal(validateValue('P21_FOLLOW_DISCOVERY_ENABLED', 'true'), 'true');
  assert.throws(() => validateValue('GMGN_CACHE_WARMER_ENABLED', 'false'), {
    code: 'ENV_KEY_NOT_ALLOWED'
  });
  assert.throws(() => validateValue('P20_CANDIDATE_WARMUP_ENABLED', 'false'), {
    code: 'ENV_KEY_NOT_ALLOWED'
  });
  const followDiscovery = impactForKeys(['P21_FOLLOW_DISCOVERY_ENABLED']);
  assert.equal(followDiscovery.impact_scope, 'monitoring_critical');
  assert.deepEqual(followDiscovery.restart_roles, ['ingestion']);
  assert.equal(followDiscovery.manual_rearm_required, false);
  const chain = impactForKeys(['ROBINHOOD_RPC_URL']);
  assert.equal(chain.impact_scope, 'chain_scoped');
  assert.equal(chain.restart_required, false);
  assert.equal(chain.manual_rearm_required, false);
  const execution = impactForKeys(['GMGN_API_KEY']);
  assert.deepEqual(execution.restart_roles, ['execution']);
  assert.equal(execution.manual_rearm_required, true);
});
