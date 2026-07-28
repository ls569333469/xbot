const assert = require('node:assert/strict');
const test = require('node:test');
const { finalProductionAuthorization } = require('../domains/trade/trade-repository');

test('final production gate accepts an enabled production chain without an acceptance scope', () => {
  assert.deepEqual(finalProductionAuthorization({
    has_scope: false,
    live_enabled: true
  }), {
    allowed: true,
    errorCode: 'CHAIN_PRODUCTION_NOT_APPROVED'
  });
});

test('final production gate accepts only a current in-scope acceptance context', () => {
  assert.deepEqual(finalProductionAuthorization({
    has_scope: true,
    scope_allowed: true,
    scope_context_hash: 'context-1'
  }, 'context-1'), {
    allowed: true,
    errorCode: 'ACCEPTANCE_SCOPE_MISMATCH'
  });
});

test('final production gate rejects an expired or out-of-scope acceptance', () => {
  assert.equal(finalProductionAuthorization({
    has_scope: true,
    scope_allowed: false,
    scope_context_hash: 'context-1'
  }, 'context-1').allowed, false);
});

test('final production gate rejects acceptance context drift', () => {
  assert.equal(finalProductionAuthorization({
    has_scope: true,
    scope_allowed: true,
    scope_context_hash: 'context-1'
  }, 'context-2').allowed, false);
});
