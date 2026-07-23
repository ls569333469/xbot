const assert = require('node:assert/strict');
const test = require('node:test');
const { LiveExecutionQueue } = require('../domains/trade/live-execution-queue');

function fakeDb() {
  const calls = [];
  let claimed = false;
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes("status = 'pending'") && sql.includes('RETURNING')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: params[0], execution_mode: 'live', status: 'pending' }] };
      }
      return { rows: [] };
    }
  };
}

test('live execution queue deduplicates a committed signal and submits once', async () => {
  const db = fakeDb();
  const executions = [];
  const queue = new LiveExecutionQueue({
    db,
    engine: { getArmed: () => true, getArmedAt: () => new Date(0) },
    modeProvider: () => 'live',
    execution: {
      prepare: async (signalId) => ({ prepare_token: `prepare-${signalId}` }),
      execute: async (signalId, token) => {
        executions.push([signalId, token]);
        return { attempt_id: 91, status: 'submitted' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  assert.equal(queue.enqueue([
    { id: 41, execution_mode: 'live' },
    { id: 41, execution_mode: 'live' }
  ]), 1);
  await queue.waitForIdle();
  assert.deepEqual(executions, [[41, 'prepare-41']]);
});

test('live execution queue never claims while signal-only or locked', async () => {
  const db = fakeDb();
  const queue = new LiveExecutionQueue({
    db,
    engine: { getArmed: () => false },
    modeProvider: () => 'signal',
    execution: {
      prepare: async () => { throw new Error('should not prepare'); },
      execute: async () => { throw new Error('should not execute'); }
    },
    logger: { error() {}, warn() {} }
  });
  queue.enqueue([{ id: 42, execution_mode: 'live' }]);
  await queue.waitForIdle();
  assert.equal(db.calls.some((call) => call.sql.includes("status = 'pending'") && call.sql.includes('RETURNING')), false);
  assert.equal(db.calls.some((call) => call.sql.includes("status = 'signal_only'")), true);
});

test('live execution queue scans durable recorded signals only after the arm boundary', async () => {
  const calls = [];
  let claimed = false;
  const armedAt = new Date('2026-07-22T00:00:00Z');
  const db = {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM trade_signals') && sql.includes('ORDER BY created_at')) {
        return { rows: [{ id: 43, execution_mode: 'live' }] };
      }
      if (sql.includes("status = 'pending'") && sql.includes('RETURNING')) {
        if (claimed) return { rows: [] };
        claimed = true;
        return { rows: [{ id: 43, execution_mode: 'live', status: 'pending' }] };
      }
      return { rows: [] };
    }
  };
  const executions = [];
  const queue = new LiveExecutionQueue({
    db,
    engine: { getArmed: () => true, getArmedAt: () => armedAt },
    modeProvider: () => 'live',
    execution: {
      prepare: async () => ({ prepare_token: 'prepare-43' }),
      execute: async (signalId) => {
        executions.push(signalId);
        return { attempt_id: 93, status: 'submitted' };
      }
    },
    logger: { error() {}, warn() {} }
  });

  const result = await queue.scanOnce();
  await queue.waitForIdle();
  assert.deepEqual(result, { status: 'completed', found: 1, enqueued: 1 });
  assert.deepEqual(executions, [43]);
  assert.equal(calls.find((call) => call.sql.includes('ORDER BY created_at')).params[0], armedAt);
});

test('live execution queue accepts committed signal notifications from the ingestion process', async () => {
  const db = fakeDb();
  const executions = [];
  const queue = new LiveExecutionQueue({
    db,
    engine: { getArmed: () => true, getArmedAt: () => new Date(0) },
    modeProvider: () => 'live',
    execution: {
      prepare: async () => ({ prepare_token: 'prepare-44' }),
      execute: async (signalId) => {
        executions.push(signalId);
        return { attempt_id: 94, status: 'submitted' };
      }
    },
    logger: { error() {}, warn() {} }
  });
  assert.equal(queue.handleNotification({
    channel: 'xbot_live_signal',
    payload: JSON.stringify([{ id: 44, execution_mode: 'live' }])
  }), 1);
  await queue.waitForIdle();
  assert.deepEqual(executions, [44]);
  assert.ok(queue.getStatus().lastNotificationAt);
});
