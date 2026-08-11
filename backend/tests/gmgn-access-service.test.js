const assert = require('node:assert/strict');
const test = require('node:test');
const service = require('../lib/gmgn-access-service');
const { scopeKey } = require('../lib/gmgn-shared-rate-limit');

test('GMGN access service always attaches non-secret request provenance', () => {
  const value = service.context({ requestContext: { source: 'p21', policyId: 2, traceId: 'trace-1' } }, { stage: 'verify' });
  assert.deepEqual(value, {
    source: 'p21', processRole: process.env.XBOT_PROCESS_ROLE || 'all', policyId: 2,
    whitelistId: null, signalId: null, traceId: 'trace-1', executionSessionId: null,
    rateScope: scopeKey(), stage: 'verify'
  });
  assert.equal('privateKey' in value, false);
});

test('GMGN access service exposes a scenario-scoped adapter', () => {
  const access = service.accessFor('p21_follow_discovery_verify');
  assert.equal(access.scenario, 'p21_follow_discovery_verify');
  assert.equal(typeof access.getTokenInfo, 'function');
  assert.equal(typeof access.getTokenSecurity, 'function');
  assert.equal(typeof access.getTokenPoolInfo, 'function');
});
