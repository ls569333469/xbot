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
      blockers: ['GMGN_SCHEDULER_NOT_HEALTHY'],
      snapshotHash: 'snapshot-1'
    }),
    onDisarm: async (details) => alerts.push(details)
  });
  const result = await monitor.checkOnce();
  assert.equal(result.status, 'paused_transient');
  assert.equal(armed, false);
  assert.deepEqual(alerts[0].blockers, ['GMGN_SCHEDULER_NOT_HEALTHY']);
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
    onDisarm: async () => {}
  });

  assert.equal((await monitor.checkOnce()).status, 'ready');
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
    onDisarm: async () => {}
  });

  const result = await monitor.checkOnce();
  assert.equal(result.status, 'ready');
  assert.deepEqual(calls, ['dynamic-revision-9']);
  assert.equal(result.scopeRefresh.updated, true);
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

test('readiness monitor treats undersized trade capacity as a critical configuration error', async () => {
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
    onDisarm: async () => {}
  });

  assert.equal((await monitor.checkOnce()).status, 'disarmed');
  assert.equal(faulted, 1);
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

test('readiness monitor reminds but never faults while a transient blocker persists', async () => {
  let now = Date.parse('2026-08-05T00:01:00.000Z');
  let faulted = 0;
  const reminders = [];
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
      snapshotHash: 'snapshot-cooling'
    }),
    onDisarm: async () => {},
    onReminder: async (details) => reminders.push(details),
    transientReminderMs: 60_000,
    now: () => now
  });

  const first = await monitor.checkOnce();
  assert.equal(first.status, 'paused_transient');
  assert.equal(first.reminder, true);
  assert.equal(reminders.length, 1);
  assert.equal(faulted, 0);

  now += 30_000;
  assert.equal((await monitor.checkOnce()).reminder, false);
  now += 30_000;
  assert.equal((await monitor.checkOnce()).reminder, true);
  assert.equal(reminders.length, 2);
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
