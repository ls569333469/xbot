const assert = require('node:assert/strict');
const test = require('node:test');
const { ShadowLiveEvaluator } = require('../jobs/shadow-live-evaluator');

test('shadow evaluator records read-only preparation without an execution path', async () => {
  const queries = [];
  const builderCalls = [];
  const evaluator = new ShadowLiveEvaluator({
    db: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('INSERT INTO shadow_trade_evaluations')) return { rows: [{ id: 1 }] };
        return { rows: [] };
      }
    },
    builder: async (signalId, options) => {
      builderCalls.push({ signalId, options });
      return {
        risk: { passed: true, reasons: [] },
        livePolicy: { allowed: true, blockers: [] },
        riskSnapshot: { passed: true },
        summary: { signal_id: signalId, estimated_output: '100' }
      };
    }
  });
  const result = await evaluator.evaluateSignal({ id: 10, chain_id: 'sol' });
  assert.equal(result.status, 'passed');
  assert.deepEqual(builderCalls, [{ signalId: 10, options: { policyPhase: 'shadow' } }]);
  assert.equal(queries.some((entry) => /swap|trade_attempts|trade_orders/i.test(entry.sql)), false);
});

test('disabled shadow evaluator does not create a polling timer', () => {
  const evaluator = new ShadowLiveEvaluator({ enabledProvider: () => false });
  assert.equal(evaluator.start({ intervalMs: 250 }), false);
  assert.equal(evaluator.getStatus().running, false);
});

test('shadow evaluator observes live-mode signals only while the engine is locked', async () => {
  const queries = [];
  const evaluator = new ShadowLiveEvaluator({
    db: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('INSERT INTO shadow_run_sessions')) {
          return { rows: [{ id: 8, started_at: new Date('2026-07-22T00:00:00.000Z') }] };
        }
        if (sql.includes('COUNT(*)::int AS total')) {
          return { rows: [{ total: 0, passed: 0, rejected: 0, failed: 0 }] };
        }
        return { rows: [] };
      }
    },
    modeProvider: () => 'live',
    engine: { getArmed: () => false },
    enabledProvider: () => true,
    policy: {
      getPolicy: async () => ({
        providers: ['6551'], eventTypes: ['reply'], chains: ['sol'],
        whitelistIds: [97], maxSignalAgeSeconds: 30
      })
    }
  });
  const result = await evaluator.runOnce();
  assert.equal(result.status, 'completed');
  const selection = queries.find((entry) => entry.sql.includes('FROM trade_signals AS signal'));
  assert.deepEqual(selection.params.slice(-2), ['recorded', 'live']);

  evaluator.engine = { getArmed: () => true };
  assert.equal((await evaluator.runOnce()).reason, 'live_engine_armed');
});
