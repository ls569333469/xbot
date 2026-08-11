const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseArgs,
  strategyLabel,
  strategyPredicate,
  strategyForSignal,
  verifyEvidence,
  verifyGlobalAudit
} = require('../scripts/run-p25-live-acceptance');

test('P26 manual runner defaults to fixed, dynamic, then follow and clamps polling controls', () => {
  assert.deepEqual(parseArgs([]), {
    timeoutSeconds: 900,
    pollMs: 1000,
    strategies: ['fixed', 'dynamic', 'follow']
  });
  assert.deepEqual(parseArgs([
    '--timeout-seconds=10', '--poll-ms=100', '--strategies=follow,dynamic,unknown'
  ]), {
    timeoutSeconds: 30,
    pollMs: 250,
    strategies: ['follow', 'dynamic']
  });
});

test('P26 global GMGN acceptance fails on 429, unknown, unauthorized, or duplicate swap calls', () => {
  assert.equal(verifyGlobalAudit({
    audit_truncated: false,
    rate_limited_count: 0,
    unknown_requests: [],
    unauthorized_buy_requests: [],
    missing_swap_attempts: [],
    invalid_swap_sessions: [],
    duplicate_swap_attempts: []
  }).passed, true);
  const failed = verifyGlobalAudit({
    audit_truncated: true,
    rate_limited_count: 1,
    unknown_requests: [{}],
    unauthorized_buy_requests: [{}],
    missing_swap_attempts: [{}],
    invalid_swap_sessions: [{}],
    duplicate_swap_attempts: [{}]
  });
  assert.equal(failed.passed, false);
  assert.match(failed.errors.join(','), /TRUNCATED.*429.*UNKNOWN.*UNAUTHORIZED.*ATTEMPT_MISSING.*SESSION_INVALID.*DUPLICATE/s);
});

test('P25 runner selects only real live strategy signals', () => {
  assert.match(strategyPredicate('fixed'), /actor_policy_id IS NULL.*follow_discovery_policy_id IS NULL/);
  assert.match(strategyPredicate('dynamic'), /actor_policy_id/);
  assert.match(strategyPredicate('follow'), /follow_discovery_policy_id/);
  assert.equal(strategyLabel('fixed'), 'Fixed CA');
  assert.equal(strategyLabel('dynamic'), 'P20 dynamic');
  assert.equal(strategyLabel('follow'), 'P21 follow discovery');
  assert.equal(strategyForSignal({}), 'fixed');
  assert.equal(strategyForSignal({ actor_policy_id: 1 }), 'dynamic');
  assert.equal(strategyForSignal({ follow_discovery_policy_id: 2 }), 'follow');
});

test('P25 runner requires one complete provider execution and settlement path', () => {
  const evidence = {
    path: {
      signal_id: 900,
      signal_status: 'executed',
      chain_id: 'robinhood',
      contract_address: '0xabc',
      attempts: [{ id: 1, status: 'confirmed', trace_id: 'trace-900' }],
      orders: [{ id: 2, provider_order_id: 'od-900', tx_hash: '0xtx', status: 'confirmed' }],
      receipts: [{ id: 3, tx_hash: '0xtx', status: 'confirmed' }],
      position_count: 1,
      lot_count: 1,
      position_modes: ['live']
    },
    provider: [
      { stage: 'swap', trace_id: 'trace-900', execution_session_id: 'signal:900', rate_scope: 'test-scope' }
    ]
  };
  assert.equal(verifyEvidence(evidence, 'test-scope').passed, true);
  const duplicateSwap = { ...evidence, provider: [...evidence.provider, { ...evidence.provider[0] }] };
  assert.equal(verifyEvidence(duplicateSwap, 'test-scope').passed, false);
  assert.match(verifyEvidence(duplicateSwap, 'test-scope').errors.join(','), /SWAP/);

  const boundedPolling = {
    ...evidence,
    provider: [
      ...evidence.provider,
      ...Array.from({ length: 4 }, () => ({
        stage: 'order_query',
        trace_id: 'trace-900',
        execution_session_id: 'signal:900',
        rate_scope: 'test-scope'
      })),
      {
        stage: 'strategy_association',
        trace_id: 'trace-900',
        execution_session_id: 'signal:900',
        rate_scope: 'test-scope'
      }
    ]
  };
  assert.equal(verifyEvidence(boundedPolling, 'test-scope').passed, true);
  const excessivePolling = {
    ...boundedPolling,
    provider: [...boundedPolling.provider, { ...boundedPolling.provider[1] }]
  };
  assert.equal(verifyEvidence(excessivePolling, 'test-scope').passed, true);
  assert.match(verifyEvidence(excessivePolling, 'test-scope').warnings.join(','), /ORDER_QUERY/);
});
