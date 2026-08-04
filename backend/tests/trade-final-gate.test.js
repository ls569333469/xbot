const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { finalProductionAuthorization } = require('../domains/trade/trade-repository');

test('final submission acceptance scope projects the context hash it validates', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '../domains/trade/trade-repository.js'),
    'utf8'
  );
  assert.match(
    source,
    /WITH acceptance_scope AS \(\s*SELECT chain, whitelist_id, expires_at, context_hash\s+FROM live_acceptance_scopes/
  );
});

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
