const assert = require('node:assert/strict');
const test = require('node:test');
const { ReadinessMonitor, schedulerReadiness } = require('../domains/trade/readiness-service');

test('scheduler readiness treats an in-flight reservation as busy rather than failed', () => {
  assert.deepEqual(schedulerReadiness({
    state: 'healthy',
    configuredCapacity: 14,
    availableWeight: 0,
    reservedWeight: 7
  }), {
    blockers: [],
    advisories: ['GMGN_TRADE_WEIGHT_REFILLING']
  });
  assert.deepEqual(schedulerReadiness({
    state: 'queued',
    configuredCapacity: 14,
    availableWeight: 4
  }), {
    blockers: [],
    advisories: ['GMGN_TRADE_WEIGHT_REFILLING', 'GMGN_SCHEDULER_BUSY']
  });
});

test('scheduler readiness still blocks real cooldowns and undersized capacity', () => {
  assert.deepEqual(schedulerReadiness({
    state: 'cooling',
    configuredCapacity: 5,
    availableWeight: 5
  }).blockers, [
    'GMGN_SCHEDULER_NOT_HEALTHY',
    'GMGN_TRADE_WEIGHT_UNAVAILABLE'
  ]);
});

test('readiness monitor pauses transient blockers and reports them once', async () => {
  let armed = true;
  let status = 'running';
  const alerts = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => armed,
      getStatus: () => ({ status, desiredRunning: true }),
      pauseTransient: async () => { armed = false; status = 'paused_transient'; }
    },
    snapshotProvider: async () => ({
      readyToArm: false,
      blockers: ['GMGN_RECENT_429'],
      snapshotHash: 'snapshot-1'
    }),
    onDisarm: async (details) => alerts.push(details)
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'paused_transient');
  assert.equal(armed, false);
  assert.deepEqual(alerts[0].blockers, ['GMGN_RECENT_429']);
});

test('readiness monitor automatically faults critical blockers', async () => {
  let armed = true;
  const alerts = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => armed,
      getStatus: () => ({ status: armed ? 'running' : 'fault_protected', desiredRunning: true }),
      setArmed: async (value) => { armed = value; }
    },
    snapshotProvider: async () => ({
      readyToArm: false,
      blockers: ['MIGRATION_NOT_CURRENT'],
      snapshotHash: 'snapshot-critical'
    }),
    onDisarm: async (details) => alerts.push(details)
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'disarmed');
  assert.equal(armed, false);
  assert.deepEqual(alerts[0].blockers, ['MIGRATION_NOT_CURRENT']);
});

test('readiness monitor requires three healthy checks before transient recovery', async () => {
  let recovered = 0;
  const recoveredEvents = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => false,
      getStatus: () => ({
        status: 'paused_transient', desiredRunning: true,
        transientStartedAt: new Date().toISOString()
      }),
      recoverTransient: async () => { recovered += 1; }
    },
    snapshotProvider: async () => ({
      readyToArm: true,
      blockers: [],
      snapshotHash: 'snapshot-ready'
    }),
    onDisarm: async () => {},
    onRecover: async (details) => recoveredEvents.push(details),
    recoveryHealthyChecks: 3
  });
  assert.equal((await monitor.checkOnce()).status, 'recovering');
  assert.equal((await monitor.checkOnce()).status, 'recovering');
  assert.equal((await monitor.checkOnce()).status, 'resumed');
  assert.equal(recovered, 1);
  assert.equal(recoveredEvents.length, 1);
});

test('readiness monitor does nothing while the new-order gate is locked', async () => {
  let checked = false;
  const monitor = new ReadinessMonitor({
    engine: { getArmed: () => false, setArmed: async () => {} },
    snapshotProvider: async () => { checked = true; return { readyToArm: true }; },
    onDisarm: async () => {}
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'skipped');
  assert.equal(checked, false);
});
