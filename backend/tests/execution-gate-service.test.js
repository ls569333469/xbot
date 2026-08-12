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

test('execution gate permits infrastructure-ready chains only for strategy scope', () => {
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
    gate.assertReady('bsc', { strategyScope: true }).configurationFingerprint,
    'config-1'
  );
});

test('execution gate rejects a readiness snapshot from another runtime scope', () => {
  const scopedEngine = {
    getArmed: () => true,
    getStatus: () => ({
      status: 'running', configurationFingerprint: 'config-1',
      scope: { scope_type: 'follow_discovery', scope_id: 2 }
    })
  };
  const gate = new ExecutionGateService({ engine: scopedEngine });
  gate.update({
    readyToArm: true,
    blockers: [],
    configurationFingerprint: 'config-1',
    scope: { scope_type: 'dynamic_policy', scope_id: 2 },
    chains: [{ chain: 'sol', ready: true, infrastructure_ready: true, blockers: [] }]
  });
  assert.throws(
    () => gate.assertReady('sol', { strategyScope: true }),
    { code: 'LIVE_SCOPE_SNAPSHOT_MISMATCH' }
  );
});

test('execution gate ignores the position-local unprotected advisory', () => {
  const gate = new ExecutionGateService({ engine: engine(), maxAgeMs: 1500 });
  gate.update({
    readyToArm: false,
    blockers: [],
    advisories: ['UNPROTECTED_LIVE_POSITIONS'],
    configurationFingerprint: 'config-1',
    chains: [{ chain: 'robinhood', ready: true, blockers: [] }]
  });
  assert.equal(gate.assertReady('robinhood').configurationFingerprint, 'config-1');
});
