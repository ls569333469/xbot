const assert = require('node:assert/strict');
const test = require('node:test');
const { resolveHistorical, runActor } = require('../domains/actor-screening/backtest');
const { createRun, getRun, listRuns, retryFailedRun } = require('../domains/actor-screening/service');
const { ActorScreeningWorker, deriveRunStatus } = require('../domains/actor-screening/worker');

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
    analyzeActor: async () => ({ status: 'analyzed', summary: 'fixture' }),
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

test('actor screening backtests one explicit Solana CA without a candidate index', async () => {
  const address = 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta';
  const summary = await runActor('explicit-ca', {
    xClient: { getUserTweets: async () => [{
      id: 'sol-call',
      created_at: '2026-07-18T12:28:47.000Z',
      text: `$CRED 可以留意 ${address}`
    }] },
    executor: { query: async () => assert.fail('explicit CA must not need the candidate index') },
    analyzeActor: async () => ({ status: 'analyzed', summary: 'fixture' }),
    fetchKline: async ({ chain, address: requested }) => {
      assert.equal(chain, 'sol');
      assert.equal(requested, address);
      return { rows: [{ open: 1, high: 2, close: 1.5 }] };
    }
  });

  assert.equal(summary.metrics.explicit_ca_posts, 1);
  assert.equal(summary.metrics.resolved, 1);
  assert.equal(summary.metrics.return_samples, 1);
  assert.equal(summary.ca_resolution_rate, 1);
  assert.equal(summary.executable_win_rate, 1);
  assert.equal(summary.recommendation, 'insufficient_data');
});

test('actor screening reports insufficient data instead of watch when coverage is empty', async () => {
  const summary = await runActor('no-assets', {
    xClient: { getUserTweets: async () => [{
      id: 'plain', created_at: '2026-07-31T00:00:00.000Z', text: 'gm'
    }] },
    executor: { query: async () => assert.fail('non-actionable content must not query the index') },
    analyzeActor: async () => ({ status: 'insufficient', summary: 'no crypto evidence' })
  });

  assert.equal(summary.status, 'completed');
  assert.equal(summary.recommendation, 'insufficient_data');
  assert.equal(summary.reason_codes.includes('ACTOR_CA_RESOLUTION_EMPTY'), true);
  assert.equal(summary.reason_codes.includes('ACTOR_KLINE_SAMPLE_EMPTY'), true);
});

test('actor screening preserves local evidence and marks a Grok failure partial', async () => {
  const xaiError = Object.assign(new Error('xAI timed out'), { code: 'XAI_SEARCH_TIMEOUT' });
  const summary = await runActor('partial-grok', {
    xClient: { getUserTweets: async () => [{
      id: 'ca',
      created_at: '2026-07-31T00:00:00.000Z',
      text: 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta'
    }] },
    analyzeActor: async () => { throw xaiError; },
    fetchKline: async () => ({ rows: [{ open: 1, high: 1.2, close: 1.1 }] })
  });

  assert.equal(summary.status, 'partial');
  assert.equal(summary.metrics.return_samples, 1);
  assert.equal(summary.error_code, 'XAI_SEARCH_TIMEOUT');
  assert.equal(summary.reason_codes.includes('XAI_SEARCH_TIMEOUT'), true);
});

test('actor screening captures an early Grok rejection while local evidence is still running', async () => {
  const xaiError = Object.assign(new Error('xAI network failed'), {
    code: 'XAI_SEARCH_NETWORK_ERROR'
  });
  let releaseKline;
  const klineGate = new Promise((resolve) => { releaseKline = resolve; });
  const resultPromise = runActor('early-grok-error', {
    xClient: { getUserTweets: async () => [{
      id: 'ca', created_at: '2026-07-31T00:00:00.000Z',
      text: 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta'
    }] },
    analyzeActor: async () => { throw xaiError; },
    fetchKline: async () => {
      await klineGate;
      return { rows: [{ open: 1, high: 1.2, close: 1.1 }] };
    }
  });

  await new Promise((resolve) => setImmediate(resolve));
  releaseKline();
  const summary = await resultPromise;
  assert.equal(summary.status, 'partial');
  assert.equal(summary.error_code, 'XAI_SEARCH_NETWORK_ERROR');
  assert.equal(summary.metrics.return_samples, 1);
});

test('actor screening limits K-line calls by attempts even when every request fails', async () => {
  const address = 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta';
  let calls = 0;
  const summary = await runActor('bounded-failures', {
    xClient: { getUserTweets: async () => [1, 2, 3, 4].map((id) => ({
      id: String(id), created_at: `2026-07-31T00:0${id}:00.000Z`, text: address
    })) },
    analyzeActor: async () => ({ status: 'analyzed', summary: 'fixture' }),
    maxReturnSamples: 2,
    fetchKline: async () => {
      calls += 1;
      const error = new Error('fixture failure');
      error.code = 'GMGN_SCHEMA_INVALID';
      throw error;
    }
  });

  assert.equal(calls, 2);
  assert.equal(summary.metrics.kline_attempts, 2);
  assert.equal(summary.metrics.kline_skipped, 2);
  assert.equal(summary.status, 'partial');
});

test('actor screening defers on GMGN cooldown and records a future retry', async () => {
  const now = Date.parse('2026-08-14T04:00:00.000Z');
  const grok = { status: 'analyzed', summary: 'fixture' };
  const summary = await runActor('cooldown', {
    xClient: { getUserTweets: async () => [{
      id: '1', created_at: '2026-07-31T00:00:00.000Z',
      text: 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta'
    }] },
    analyzeActor: async () => grok,
    now: () => now,
    fetchKline: async () => {
      const error = new Error('cooldown');
      error.code = 'GMGN_RATE_LIMIT_COOLDOWN';
      error.resetAt = now + 120_000;
      throw error;
    }
  });

  assert.equal(summary.status, 'pending');
  assert.equal(summary.metrics.retry_at, '2026-08-14T04:02:00.000Z');
  assert.equal(summary.metrics.attempt_count, 1);
  assert.equal(summary.metrics.grok, grok);
  assert.equal(summary.reason_codes.includes('ACTOR_GMGN_CAPACITY_WAIT'), true);
});

test('actor screening reuses Grok output and stops deferring after the retry limit', async () => {
  const previousGrok = { status: 'analyzed', summary: 'cached Grok result' };
  const summary = await runActor('retry-limit', {
    xClient: { getUserTweets: async () => [{
      id: '1', created_at: '2026-07-31T00:00:00.000Z',
      text: 'CREDBHvVqREBCAxMihzr8D1nepHMr2gmQoZWpmgGmeta'
    }] },
    previousMetrics: { grok: previousGrok, attempt_count: 3 },
    analyzeActor: async () => assert.fail('cached Grok result must be reused'),
    maxAttempts: 4,
    fetchKline: async () => {
      const error = new Error('rate limit');
      error.code = 'RATE_LIMIT_EXCEEDED';
      throw error;
    }
  });

  assert.equal(summary.status, 'partial');
  assert.equal(summary.metrics.grok, previousGrok);
  assert.equal(summary.metrics.grok_reused, true);
  assert.equal(summary.metrics.retry_at, null);
  assert.equal(summary.reason_codes.includes('ACTOR_GMGN_RETRY_EXHAUSTED'), true);
});

test('actor screening worker defers without busy looping and passes cached metrics to retries', async () => {
  const queries = [];
  const cachedMetrics = { grok: { status: 'analyzed', summary: 'cached' }, attempt_count: 1 };
  const db = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT run.id')) return { rows: [{
        id: 9, result_id: 11, x_handle: 'example', screening_revision: 'p32-screen-v2',
        sample_started_at: null, sample_ended_at: null, metrics: cachedMetrics
      }] };
      if (sql.includes('COUNT(*) FILTER')) return { rows: [{ pending_count: 1 }] };
      return { rows: [] };
    }
  };
  let receivedMetrics;
  const worker = new ActorScreeningWorker({
    db,
    logger: { info() {}, error() {} },
    xClientFactory: () => ({ getUserTweets: async () => [] }),
    backtest: {
      async runActor(_handle, options) {
        receivedMetrics = options.previousMetrics;
        return {
          x_handle: 'example', status: 'pending', recommendation: 'insufficient_data',
          sample_size: 100, metrics: { ...cachedMetrics, retry_at: '2026-08-14T05:00:00.000Z' }
        };
      },
      async persistResult() {}
    }
  });

  const result = await worker.runOnce();
  assert.equal(result.status, 'deferred');
  assert.equal(receivedMetrics, cachedMetrics);
  assert.match(queries[0], /metrics->>'retry_at'/);
  assert.equal(queries.some((sql) => sql.includes("SET status = 'running'")), true);
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
  assert.match(calls[0].sql, /status IN \('failed','partial'\)/);
  assert.match(calls[1].sql, /status = CASE WHEN status IN \('failed','partial'\) THEN 'pending'/);
  assert.deepEqual(calls[1].params, [12]);
});

test('screening creation deduplicates an identical active account batch', async () => {
  const active = { id: 19, input_handles: ['account'], status: 'running' };
  const executor = {
    async query(sql, params) {
      assert.match(sql, /input_handles @>/);
      assert.deepEqual(params, [['account']]);
      return { rows: [active] };
    }
  };
  const result = await createRun({ handles: ['@Account'] }, executor);
  assert.equal(result.id, 19);
  assert.equal(result.deduplicated, true);
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

test('screening lookup rejects an invalid run id before querying PostgreSQL', async () => {
  const executor = { query: async () => assert.fail('query must not run for an invalid id') };
  await assert.rejects(
    getRun('runs', executor),
    (error) => error.code === 'ACTOR_SCREENING_ID_INVALID'
  );
});

test('screening list falls back to the default limit for invalid input', async () => {
  let params;
  let query;
  const executor = {
    async query(sql, values) {
      query = sql;
      params = values;
      return { rows: [] };
    }
  };
  await listRuns('invalid', executor);
  assert.deepEqual(params, [50]);
  assert.match(query, /AS failed_count/);
  assert.match(query, /AS recommended_count/);
});

test('screening parent status distinguishes completed, failed, partial and running runs', () => {
  assert.equal(deriveRunStatus({ completed_count: 2 }), 'completed');
  assert.equal(deriveRunStatus({ failed_count: 2 }), 'failed');
  assert.equal(deriveRunStatus({ partial_count: 1 }), 'partial');
  assert.equal(deriveRunStatus({ completed_count: 1, failed_count: 1 }), 'partial');
  assert.equal(deriveRunStatus({ completed_count: 1, pending_count: 1 }), 'running');
  assert.equal(deriveRunStatus({ running_count: 1, failed_count: 1 }), 'running');
});
