const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveHistorical, runActor } = require('../domains/actor-screening/backtest');
const { retryFailedRun } = require('../domains/actor-screening/service');

function candidate(address, symbol) {
  return {
    id: address,
    chain_id: 'bsc',
    contract_address: address,
    symbol,
    name: `${symbol} Token`
  };
}

test('actor screening returns coverage metrics without referencing an undefined candidate list', async () => {
  const tweets = [
    { id: 'direct', created_at: '2026-07-31T00:00:00.000Z', text: '$TEST buy now' },
    { id: 'ambiguous', created_at: '2026-07-31T00:01:00.000Z', text: '$AMB buy now' },
    { id: 'none', created_at: '2026-07-31T00:02:00.000Z', text: '$NONE buy now' },
    { id: 'neutral', created_at: '2026-07-31T00:03:00.000Z', text: 'watching $UNKNOWN' }
  ];
  const executor = {
    async query(_sql, params) {
      const normalized = params[1];
      if (normalized === 'TEST') return { rows: [candidate('0x0000000000000000000000000000000000000001', 'TEST')] };
      if (normalized === 'AMB') return { rows: [
        candidate('0x0000000000000000000000000000000000000002', 'AMB'),
        candidate('0x0000000000000000000000000000000000000003', 'AMB')
      ] };
      return { rows: [] };
    }
  };
  const summary = await runActor('example', {
    xClient: { getUserTweets: async () => tweets },
    executor,
    fetchKline: async () => ({ rows: [
      { open: 1, high: 2, close: 1.5 },
      { open: 1.5, high: 1.8, close: 1.25 }
    ] })
  });

  assert.equal(summary.sample_size, 4);
  assert.equal(summary.metrics.coverage, 2);
  assert.equal(summary.metrics.ambiguous, 1);
  assert.equal(summary.provider_coverage_rate, 0.5);
  assert.equal(summary.ca_resolution_rate, 0.25);
  assert.equal(summary.return_snapshot.samples.length, 1);
});

test('actor screening fails clearly when the 6551 client is unavailable', async () => {
  await assert.rejects(
    runActor('missing-client'),
    (error) => error.code === 'ACTOR_SCREENING_PROVIDER_UNAVAILABLE'
  );
});

test('historical full CA matching uses an exact chain address key', async () => {
  let query = '';
  const executor = {
    async query(sql) {
      query = sql;
      return { rows: [] };
    }
  };

  await resolveHistorical({
    authorOwnedTerms: [{ type: 'ca', normalized: '0x1111111111111111111111111111111111111111' }]
  }, '2026-07-31T00:00:00.000Z', executor);

  assert.match(query, /split_part\(idx\.normalized_key, ':', 2\)/);
  assert.doesNotMatch(query, /LIKE '%:'/);
});

test('screening retry reopens a partial parent run for the worker', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE x_actor_screening_results')) return { rows: [{ id: 7 }] };
      return { rows: [] };
    }
  };
  assert.equal(await retryFailedRun(12, executor), true);
  assert.match(calls[1].sql, /status = CASE WHEN status IN \('failed','partial'\) THEN 'pending'/);
  assert.deepEqual(calls[1].params, [12]);
});

test('screening retry does not reopen a cancelled run', async () => {
  const executor = {
    async query(sql) {
      assert.match(sql, /status <> 'cancelled'/);
      return { rows: [] };
    }
  };
  assert.equal(await retryFailedRun(13, executor), false);
});
