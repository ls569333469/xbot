const assert = require('node:assert/strict');
const test = require('node:test');
const {
  classifyProviderOrder,
  classifyWriteError
} = require('../domains/trade/gmgn-write-error-classifier');

function httpError(status, code = `HTTP_${status}`) {
  return Object.assign(new Error(`HTTP ${status}`), { status, code });
}

test('post-boundary timeout, 408, unknown 4xx, and 5xx are uncertain and never retry eligible', () => {
  for (const error of [
    Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }),
    httpError(408),
    httpError(409),
    httpError(502)
  ]) {
    assert.deepEqual(classifyWriteError(error, { writeStarted: true }), {
      kind: 'uncertain', code: error.code, retryEligible: false, quarantine: true
    });
  }
});

test('429 is blocked and known validation errors are definitive pre-submit rejections', () => {
  assert.deepEqual(classifyWriteError(httpError(429, 'ERROR_RATE_LIMIT_BLOCKED'), { writeStarted: true }), {
    kind: 'blocked', code: 'ERROR_RATE_LIMIT_BLOCKED', retryEligible: false, quarantine: false
  });
  assert.deepEqual(classifyWriteError(httpError(422, 'INVALID_SWAP_PARAMS'), { writeStarted: true }), {
    kind: 'rejected', code: 'INVALID_SWAP_PARAMS', retryEligible: false, quarantine: false
  });
});

test('provider failed or expired enters evidence verification before a retry decision', () => {
  assert.deepEqual(classifyProviderOrder({ status: 'failed', errorCode: 'ROUTE_FAILED' }), {
    kind: 'failure_verifying', code: 'ROUTE_FAILED'
  });
  assert.deepEqual(classifyProviderOrder({ status: 'expired' }), {
    kind: 'failure_verifying', code: 'GMGN_ORDER_EXPIRED'
  });
  assert.deepEqual(classifyProviderOrder({ status: 'confirmed' }), {
    kind: 'chain_verifying', code: null
  });
});
