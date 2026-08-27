const assert = require('node:assert/strict');
const test = require('node:test');
const {
  describeTradeError,
  isExecutionBlocker
} = require('../domains/trade/trade-error-catalog');

test('P41 distinguishes local trade gates from health observations', () => {
  const gate = describeTradeError({ code: 'CA_BUY_LIMIT_REACHED' });
  assert.equal(gate.category, 'trade_gate');
  assert.equal(gate.user_message, '该 CA 已达到允许的买入次数上限，本次不会重复买入');
  assert.equal(gate.result, '未提交交易');
  assert.equal(isExecutionBlocker(gate.code), true);

  const health = describeTradeError({ code: 'WALLET_BALANCE_CACHE_STALE' });
  assert.equal(health.category, 'health_advisory');
  assert.equal(health.result, '仅记录观察');
  assert.equal(isExecutionBlocker(health.code), false);

  const rpc = describeTradeError({ code: 'CHAIN_RPC_TIMEOUT' });
  assert.equal(rpc.category, 'health_advisory');
  assert.equal(rpc.source, 'rpc_observer');
  assert.equal(isExecutionBlocker(rpc.code), false);
});

test('P41 preserves GMGN provider reason and maps common provider failures', () => {
  const insufficient = describeTradeError({
    code: 'GMGN_API_ERROR',
    last_response_json: {
      error: 'GEvmInsufficientFunds',
      message: 'insufficient native token balance'
    },
    http_status: 400
  });
  assert.equal(insufficient.category, 'provider_rejection');
  assert.equal(insufficient.user_message, '钱包余额不足，无法支付本次买入金额和交易手续费');
  assert.equal(insufficient.provider_code, 'GEvmInsufficientFunds');
  assert.equal(insufficient.provider_message, 'insufficient native token balance');
  assert.equal(insufficient.http_status, 400);
  assert.equal(insufficient.result, '未提交交易');

  const limited = describeTradeError({ code: 'GMGN_API_ERROR', http_status: 429 });
  assert.equal(limited.category, 'provider_rate_limited');
  assert.match(limited.user_message, /限流/);
  assert.match(limited.next_action, /不要重复/);
});

test('P41 treats post-submit transport and schema failures as uncertain', () => {
  for (const code of ['GMGN_REQUEST_TIMEOUT', 'GMGN_NON_JSON_RESPONSE', 'GMGN_SCHEMA_INVALID']) {
    const result = describeTradeError({ code, write_started: true });
    assert.equal(result.category, 'provider_uncertain', code);
    assert.equal(result.result, '提交结果待核验', code);
    assert.equal(result.order_created, false, code);
    assert.equal(result.retry_allowed, false, code);
  }
});

test('P41 keeps read-only GMGN failures separate from an in-flight Swap', () => {
  const nonJson = describeTradeError({ code: 'GMGN_NON_JSON_RESPONSE', write_started: false });
  assert.equal(nonJson.category, 'local_execution');
  assert.equal(nonJson.source, 'gmgn');
  assert.equal(nonJson.stage, 'GMGN 请求');
  assert.equal(nonJson.user_message, 'GMGN 数据格式异常，无法继续');
  assert.equal(nonJson.result, '未提交交易');

  const timeout = describeTradeError({ code: 'GMGN_REQUEST_TIMEOUT', write_started: false });
  assert.equal(timeout.category, 'local_execution');
  assert.match(timeout.user_message, /请求超时/);
  assert.equal(timeout.result, '未提交交易');
});

test('P41 classifies scheduler cooldown and local balance warnings correctly', () => {
  const cooldown = describeTradeError({ code: 'GMGN_RATE_LIMIT_COOLDOWN' });
  assert.equal(cooldown.category, 'provider_rate_limited');
  assert.match(cooldown.user_message, /限流冷却/);

  const balance = describeTradeError({ code: 'INSUFFICIENT_NATIVE_BALANCE' });
  assert.equal(balance.category, 'health_advisory');
  assert.equal(isExecutionBlocker(balance.code), false);
  assert.equal(balance.result, '仅记录观察');
});

test('P41 gives local GMGN configuration and scheduler failures readable messages', () => {
  const key = describeTradeError({ code: 'GMGN_KEY_MISSING' });
  assert.equal(key.category, 'local_execution');
  assert.match(key.user_message, /API 密钥未配置/);

  const scheduler = describeTradeError({ code: 'GMGN_RATE_DEADLINE_EXPIRED' });
  assert.equal(scheduler.category, 'provider_rate_limited');
  assert.match(scheduler.user_message, /超过本次交易时限/);
});
