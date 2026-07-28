const assert = require('node:assert/strict');
const test = require('node:test');
const { ExecutionTrace } = require('../domains/trade/execution-trace');

test('execution trace stores bounded safe stage metadata', () => {
  const trace = new ExecutionTrace({ traceId: 'trace-1', startedEpochMs: Date.now() });
  trace.mark('claim', { signal_id: 12, apiKey: 'must-not-leak' });
  trace.mark('submitted', { http_ms: 181 });
  trace.mark('unknown-stage', { ignored: true });
  const snapshot = trace.snapshot();

  assert.equal(snapshot.trace_id, 'trace-1');
  assert.equal(snapshot.stages.claim.signal_id, 12);
  assert.equal(snapshot.stages.claim.apiKey, undefined);
  assert.equal(snapshot.stages.submitted.http_ms, 181);
  assert.equal(snapshot.stages['unknown-stage'], undefined);
});
