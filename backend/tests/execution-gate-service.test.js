const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutionGateService } = require('../domains/trade/execution-gate-service');

function engine(fingerprint = 'config-1') {
  return {
    getArmed: () => true,
    getStatus: () => ({ status: 'running', configurationFingerprint: fingerprint })
  };
}

test('execution gate accepts only a fresh matching target-chain snapshot', () => {
  const gate = new ExecutionGateService({ engine: engine(), maxAgeMs: 1500 });
  gate.update({
    readyToArm: true,
    blockers: [],
    configurationFingerprint: 'config-1',
    chains: [{ chain: 'robinhood', ready: true, blockers: [] }]
  });
  assert.equal(gate.assertReady('robinhood').configurationFingerprint, 'config-1');
  assert.throws(() => gate.assertReady('base'), { code: 'LIVE_CHAIN_READINESS_FAILED' });
});

test('execution gate fails closed on a configuration fingerprint mismatch', () => {
  const gate = new ExecutionGateService({ engine: engine('changed') });
  gate.update({
    readyToArm: true,
    blockers: [],
    configurationFingerprint: 'config-1',
    chains: [{ chain: 'robinhood', ready: true, blockers: [] }]
  });
  assert.throws(() => gate.assertReady('robinhood'), { code: 'LIVE_CONFIGURATION_CHANGED' });
});

test('execution gate permits infrastructure-ready chains only for dynamic scope', () => {
  const gate = new ExecutionGateService({ engine: engine(), maxAgeMs: 1500 });
  gate.update({
    readyToArm: true,
    blockers: [],
    configurationFingerprint: 'config-1',
    chains: [{
      chain: 'bsc',
      ready: false,
      infrastructure_ready: true,
      blockers: []
    }]
  });

  assert.throws(() => gate.assertReady('bsc'), { code: 'LIVE_CHAIN_READINESS_FAILED' });
  assert.equal(
    gate.assertReady('bsc', { dynamicScope: true }).configurationFingerprint,
    'config-1'
  );
});
