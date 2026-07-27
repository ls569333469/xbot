const assert = require('node:assert/strict');
const test = require('node:test');
const {
  claimActivationBatch,
  completeActivation,
  discardActivation,
  enqueueWhitelistActivation,
  failActivation
} = require('../domains/whitelist/activation-outbox');

test('whitelist Activation Outbox deduplicates versions and reclaims abandoned leases', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('RETURNING id, activation_version')) {
        return { rows: [{ id: 12, activation_version: 4 }] };
      }
      if (sql.includes('RETURNING item.*')) {
        return { rows: [{ whitelist_id: 12, desired_version: 4, attempt_count: 0 }] };
      }
      return { rows: [] };
    }
  };

  assert.deepEqual(await enqueueWhitelistActivation(12, executor), {
    id: 12,
    activation_version: 4
  });
  assert.match(calls[0].sql, /activation_version = activation_version \+ CASE/);
  assert.match(calls[1].sql, /ON CONFLICT \(whitelist_id\) DO UPDATE/);
  assert.match(calls[1].sql, /desired_version = EXCLUDED\.desired_version/);

  const claimed = await claimActivationBatch(2, executor);
  assert.equal(claimed.length, 1);
  assert.match(calls[2].sql, /status = 'processing'.*INTERVAL '2 minutes'/s);
});

test('activation completion, failure, and discard are guarded by desired version', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SET live_activation_state = 'live_ready'")) return { rows: [] };
      return { rows: [] };
    }
  };
  const row = { whitelist_id: 9, desired_version: 7, attempt_count: 2 };

  assert.equal(await completeActivation(row, 'context', executor), false);
  await failActivation(row, Object.assign(new Error('old failure'), { code: 'OLD_FAILURE' }), executor);
  await discardActivation(row, executor);

  const completion = calls.find((item) => item.sql.includes("THEN 'succeeded'") && item.params.length === 3);
  assert.match(completion.sql, /last_error_code = CASE WHEN desired_version = \$2 AND \$3/);
  const failure = calls.find((item) => item.sql.includes("THEN 'failed'"));
  assert.match(failure.sql, /last_error_code = CASE WHEN desired_version = \$2 THEN \$3 ELSE NULL END/);
  const discarded = calls.find((item) => item.sql.includes("THEN 'succeeded'") && item.params.length === 2);
  assert.ok(discarded);
  assert.match(discarded.sql, /completed_at = CASE WHEN desired_version = \$2 THEN NOW\(\)/);
});
