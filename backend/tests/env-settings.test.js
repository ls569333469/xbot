const assert = require('node:assert/strict');
const test = require('node:test');
const { validateValue } = require('../domains/system/env-settings');

test('environment settings enforce local binding and valid ports', () => {
  assert.equal(validateValue('BACKEND_HOST', '127.0.0.1'), '127.0.0.1');
  assert.throws(() => validateValue('BACKEND_HOST', '0.0.0.0'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('BACKEND_PORT', '70000'), { code: 'ENV_VALUE_INVALID' });
});

test('environment settings validate GMGN and RPC contracts without exposing values', () => {
  assert.equal(validateValue('GMGN_API_KEY', 'gmgn-test-value'), 'gmgn-test-value');
  assert.throws(() => validateValue('GMGN_API_KEY', 'invalid'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('SOLANA_RPC_URL', 'https://rpc.example.test'), 'https://rpc.example.test');
  assert.throws(() => validateValue('BASE_RPC_URL', 'file:///tmp/rpc'), { code: 'ENV_VALUE_INVALID' });
});

test('environment settings enforce signal age and provider timing bounds', () => {
  assert.throws(() => validateValue('SIGNAL_MAX_AGE_SECONDS', '301'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('X_6551_HEARTBEAT_MS', '4999'), { code: 'ENV_VALUE_INVALID' });
  assert.throws(() => validateValue('TWITTERAPI_IO_FOLLOW_INTERVAL_MS', '29999'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('P8_VERIFIED_LIVE_EVENT_TYPES', 'Reply, tweet,reply'), 'reply,tweet');
  assert.throws(() => validateValue('P8_VERIFIED_LIVE_EVENT_TYPES', 'follow,like'), { code: 'ENV_VALUE_INVALID' });
  assert.equal(validateValue('XBOT_PROCESS_ROLE', 'execution'), 'execution');
  assert.throws(() => validateValue('XBOT_PROCESS_ROLE', 'worker'), { code: 'ENV_VALUE_INVALID' });
});
