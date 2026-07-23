const assert = require('node:assert/strict');
const test = require('node:test');

test('live engine persists intent, restores matching configuration, and faults on drift', async () => {
  const db = require('../lib/db');
  const originalQuery = db.query;
  const originalMode = process.env.TRADING_MODE;
  let saved = null;
  let staleSignalsClosed = 0;
  db.query = async (sql, params = []) => {
    if (sql.includes('SELECT value_json FROM trade_runtime_state')) {
      return { rows: saved ? [{ value_json: saved }] : [] };
    }
    if (sql.includes('INSERT INTO trade_runtime_state')) {
      saved = structuredClone(params[1]);
      return { rows: [] };
    }
    if (sql.includes("UPDATE trade_signals")) {
      staleSignalsClosed += 1;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in engine-state test: ${sql}`);
  };
  process.env.TRADING_MODE = 'live';
  delete require.cache[require.resolve('../lib/engine-state')];
  const engine = require('../lib/engine-state');

  try {
    assert.equal((await engine.init()).status, 'stopped');
    const readiness = {
      readyToArm: true,
      snapshotHash: 'snapshot-1',
      configurationFingerprint: 'config-1'
    };
    const armed = await engine.arm({ operator: 'tester', readiness });
    assert.equal(armed.status, 'running');
    assert.equal(armed.desiredRunning, true);
    assert.equal(staleSignalsClosed, 1);

    await engine.setFaulted({ reason: 'TRANSIENT_FAILURE' });
    assert.equal(engine.getStatus().status, 'fault_protected');
    assert.equal(engine.getStatus().desiredRunning, true);
    const restored = await engine.restoreDesiredState(async () => readiness);
    assert.equal(restored.status, 'restored');
    assert.equal(engine.getArmed(), true);

    await engine.setFaulted({ reason: 'RESTART' });
    let recoveryChecks = 0;
    let recoverySleeps = 0;
    const retried = await engine.restoreDesiredState(async () => {
      recoveryChecks += 1;
      if (recoveryChecks === 1) {
        return {
          readyToArm: false,
          blockers: ['X_6551_INGESTION_UNHEALTHY'],
          snapshotHash: 'startup-wait',
          configurationFingerprint: 'config-1'
        };
      }
      return readiness;
    }, {
      maxAttempts: 3,
      retryDelayMs: 1,
      retryableBlockers: ['X_6551_INGESTION_UNHEALTHY'],
      sleep: async () => { recoverySleeps += 1; }
    });
    assert.equal(retried.status, 'restored');
    assert.equal(recoveryChecks, 2);
    assert.equal(recoverySleeps, 1);
    assert.equal(engine.getArmed(), true);
    assert.equal(engine.getStatus().lastErrorDetails, null);

    await engine.setFaulted({ reason: 'RESTART' });
    const drifted = await engine.restoreDesiredState(async () => ({
      ...readiness,
      snapshotHash: 'snapshot-2',
      configurationFingerprint: 'config-2'
    }));
    assert.equal(drifted.status, 'fault_protected');
    assert.equal(drifted.reason, 'configuration_changed');
    assert.equal(engine.getStatus().desiredRunning, false);
    assert.equal(engine.getStatus().lastError, 'LIVE_CONFIGURATION_CHANGED');
  } finally {
    db.query = originalQuery;
    if (originalMode === undefined) delete process.env.TRADING_MODE;
    else process.env.TRADING_MODE = originalMode;
    delete require.cache[require.resolve('../lib/engine-state')];
  }
});
