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

test('scheduler readiness still blocks real cooldowns while allowing a swap-sized bucket', () => {
  assert.deepEqual(schedulerReadiness({
    state: 'cooling',
    configuredCapacity: 5,
    availableWeight: 5
  }).blockers, ['GMGN_SCHEDULER_NOT_HEALTHY']);
});

test('readiness monitor reports transient blockers without changing Engine state', async () => {
  let armed = true;
  let status = 'running';
  const alerts = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => armed,
      getStatus: () => ({ status, desiredRunning: true }),
      pauseTransient: async () => { armed = false; status = 'paused_transient'; },
      setFaulted: async () => { armed = false; status = 'fault_protected'; }
    },
    snapshotProvider: async () => ({
      readyToArm: true,
      blockers: [],
      healthIssues: [{ code: 'GMGN_SCHEDULER_NOT_HEALTHY', severity: 'warning' }],
      snapshotHash: 'snapshot-1'
    }),
    onHealthChange: async (details) => alerts.push(details)
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'degraded');
  assert.equal(armed, true);
  assert.equal(status, 'running');
  assert.deepEqual(alerts[0].issues[0].code, 'GMGN_SCHEDULER_NOT_HEALTHY');
});

test('readiness monitor keeps running when a newly saved Follow Watch is only advisory', async () => {
  let faulted = 0;
  let paused = 0;
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => true,
      getStatus: () => ({ status: 'running', desiredRunning: true }),
      setFaulted: async () => { faulted += 1; },
      pauseTransient: async () => { paused += 1; }
    },
    snapshotProvider: async () => ({
      readyToArm: true,
      blockers: [],
      advisories: ['FOLLOW_WATCH_NOT_SYNCED'],
      snapshotHash: 'follow-watch-pending'
    }),
    onHealthChange: async () => {}
  });

  assert.equal((await monitor.checkOnce()).status, 'degraded');
  assert.equal(faulted, 0);
  assert.equal(paused, 0);
});

test('readiness monitor refreshes an authorized scope before accepting a hot policy revision', async () => {
  const calls = [];
  const snapshot = {
    readyToArm: true,
    blockers: [],
    snapshotHash: 'dynamic-revision-9',
    configurationFingerprint: 'config-1',
    scope: {
      scope_type: 'dynamic_policy',
      scope_id: 1,
      policy_revision: 9,
      manifest_hash: 'manifest-9',
      chains: ['bsc']
    }
  };
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => true,
      getStatus: () => ({ status: 'running', desiredRunning: true }),
      getScopeInput: () => ({ scope_type: 'dynamic_policy', scope_id: 1, chain_ids: ['bsc'] }),
      refreshAuthorizedScope: async (value) => {
        calls.push(value.snapshotHash);
        return { updated: true, reason: 'scope_refreshed' };
      }
    },
    snapshotProvider: async () => snapshot,
    onHealthChange: async () => {}
  });

  const result = await monitor.checkOnce();
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['dynamic-revision-9']);
  assert.equal(result.scopeRefresh.updated, true);
});

test('readiness monitor reports critical blockers without faulting Engine', async () => {
  let armed = true;
  const alerts = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => armed,
      getStatus: () => ({ status: armed ? 'running' : 'fault_protected', desiredRunning: true }),
      setArmed: async (value) => { armed = value; },
      setFaulted: async () => { armed = false; }
    },
    snapshotProvider: async () => ({
      readyToArm: false,
      blockers: ['MIGRATION_NOT_CURRENT'],
      healthIssues: [{ code: 'MIGRATION_NOT_CURRENT', severity: 'critical' }],
      snapshotHash: 'snapshot-critical'
    }),
    onHealthChange: async (details) => alerts.push(details)
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'blocked');
  assert.equal(armed, true);
  assert.equal(alerts[0].issues[0].code, 'MIGRATION_NOT_CURRENT');
});

test('readiness monitor treats undersized trade capacity as a critical observation', async () => {
  let faulted = 0;
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => true,
      getStatus: () => ({ status: 'running', desiredRunning: true }),
      setFaulted: async () => { faulted += 1; }
    },
    snapshotProvider: async () => ({
      readyToArm: false,
      blockers: ['GMGN_TRADE_WEIGHT_UNAVAILABLE'],
      snapshotHash: 'snapshot-misconfigured'
    }),
    onHealthChange: async () => {}
  });

  assert.equal((await monitor.checkOnce()).status, 'blocked');
  assert.equal(faulted, 0);
});

test('readiness monitor does not automatically recover a legacy transient pause', async () => {
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
    onHealthChange: async (details) => recoveredEvents.push(details)
  });
  assert.equal((await monitor.checkOnce()).status, 'ready');
  assert.equal((await monitor.checkOnce()).status, 'ready');
  assert.equal(recovered, 0);
  assert.equal(recoveredEvents.length, 1);
});

test('readiness monitor emits one health edge while a transient blocker persists', async () => {
  let faulted = 0;
  const healthChanges = [];
  const monitor = new ReadinessMonitor({
    engine: {
      getArmed: () => false,
      getStatus: () => ({
        status: 'paused_transient',
        desiredRunning: true,
        transientStartedAt: '2026-08-05T00:00:00.000Z'
      }),
      setFaulted: async () => { faulted += 1; }
    },
    snapshotProvider: async () => ({
      readyToArm: false,
      blockers: ['GMGN_SCHEDULER_NOT_HEALTHY'],
      healthIssues: [{ code: 'GMGN_SCHEDULER_NOT_HEALTHY', severity: 'warning' }],
      snapshotHash: 'snapshot-cooling'
    }),
    onHealthChange: async (details) => healthChanges.push(details)
  });

  const first = await monitor.checkOnce();
  assert.equal(first.status, 'blocked');
  assert.equal(healthChanges.length, 1);
  assert.equal(faulted, 0);

  assert.equal((await monitor.checkOnce()).status, 'blocked');
  assert.equal(healthChanges.length, 1);
  assert.equal(faulted, 0);
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
