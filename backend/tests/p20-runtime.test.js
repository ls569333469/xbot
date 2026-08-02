const test = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveMode, errorMessage, fail, renew
} = require('../domains/dynamic-signal/event-queue');
const {
  normalizeApprovedAliases, normalizePolicyInput, contextHash, remove
} = require('../domains/dynamic-signal/policy-service');
const { validateP20Runtime } = require('../lib/p20-features');
const { normalizeKline } = require('../lib/gmgn-adapter');
const { DynamicSignalWorker } = require('../domains/dynamic-signal/event-worker');
const { DynamicLaunchWindowWorker } = require('../jobs/dynamic-launch-window');
const { DynamicPaperSessionWorker } = require('../domains/dynamic-signal/paper-worker');
const { ensureSession } = require('../domains/dynamic-signal/paper-worker');
const { approve: approveDynamicLive } = require('../domains/dynamic-signal/dynamic-authorization');
const {
  boundedGmgnCandidateTtlMs,
  upsertCandidate
} = require('../domains/dynamic-signal/candidate-repository');

const DISABLED_RUNTIME = Object.freeze({
  P20_DYNAMIC_RESOLUTION_ENABLED: false,
  P20_RECORD_ENABLED: false,
  P20_PAPER_ENABLED: false,
  P20_LIVE_ENABLED: false
});

test('P20 runtime stages stay dependency ordered and live remains opt-in', () => {
  assert.equal(effectiveMode('record', {
    P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
    P20_PAPER_ENABLED: false, P20_LIVE_ENABLED: false
  }), 'record');
  assert.equal(effectiveMode('paper', {
    P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
    P20_PAPER_ENABLED: true, P20_LIVE_ENABLED: false
  }), 'paper');
  assert.equal(effectiveMode('live', {
    P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
    P20_PAPER_ENABLED: true, P20_LIVE_ENABLED: false
  }), 'paper');
  assert.throws(() => validateP20Runtime({ P20_LIVE_ENABLED: 'true' }), { code: 'P20_LIVE_REQUIRES_PAPER' });
});

test('dynamic Live approval rejects a policy without same-revision seven-day Paper acceptance', async () => {
  const calls = [];
  const executor = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT * FROM x_actor_dynamic_policies')) {
        return { rows: [{ id: 8, mode: 'live', enabled: true, revision: 3, context_hash: 'ctx-3' }] };
      }
      if (sql.includes('FROM dynamic_paper_sessions')) return { rows: [] };
      assert.fail('approval persistence must not run without Paper acceptance');
    }
  };
  await assert.rejects(
    approveDynamicLive(8, { confirmation: 'APPROVE P20 DYNAMIC LIVE' }, executor),
    (error) => error.code === 'DYNAMIC_PAPER_ACCEPTANCE_REQUIRED'
  );
  assert.equal(calls.length, 2);
});

test('dynamic policy revision hash changes with safety-critical limits', () => {
  const first = normalizePolicyInput({ allowed_chain_ids: ['bsc'], budget_per_trade: 1 });
  const second = normalizePolicyInput({ allowed_chain_ids: ['bsc'], budget_per_trade: 2 });
  assert.notEqual(first.context_hash, second.context_hash);
  const { context_hash: ignored, ...firstConfig } = first;
  assert.equal(first.context_hash, contextHash(firstConfig));
});

test('dynamic job errors serialize objects without falling back to object internals', () => {
  assert.equal(errorMessage({ code: 'GMGN_FAILED', detail: 'rate limited' }), '{"code":"GMGN_FAILED","detail":"rate limited"}');
  assert.equal(errorMessage({}), 'Unknown dynamic job error');
});

test('dynamic job lease renewal and failure updates stay owner guarded', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 22 }] };
    }
  };
  assert.equal(await renew(22, 'worker-a', executor), true);
  await fail(22, Object.assign(new Error('provider timeout'), {
    code: 'GMGN_TIMEOUT', attemptCount: 1
  }), executor, 'worker-a');
  assert.match(calls[0].sql, /worker_id = \$2/);
  assert.match(calls[1].sql, /status = 'processing'/);
  assert.match(calls[1].sql, /worker_id = \$5/);
  assert.equal(calls[1].params[4], 'worker-a');
});

test('GMGN verified candidates receive a bounded expiry instead of permanent trust', async () => {
  const calls = [];
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO dynamic_asset_families')) return { rows: [{ id: 1 }] };
      if (sql.includes('INSERT INTO dynamic_asset_variants')) return { rows: [{ id: 2 }] };
      return { rows: [] };
    }
  };
  const fetchedAt = new Date('2026-08-01T00:00:00.000Z');
  await upsertCandidate({
    chainId: 'bsc', contractAddress: '0x0000000000000000000000000000000000000002',
    symbol: 'TTL', providerStatus: 'verified', tradableStatus: 'tradable'
  }, 'gmgn_info', executor, { fetchedAt });
  const variantCall = calls.find((item) => item.sql.includes('INSERT INTO dynamic_asset_variants'));
  assert.equal(new Date(variantCall.params[14]).toISOString(), '2026-08-01T00:05:00.000Z');
});

test('invalid GMGN candidate TTL configuration falls back to the safe default', () => {
  assert.equal(boundedGmgnCandidateTtlMs('not-a-number'), 5 * 60_000);
  assert.equal(boundedGmgnCandidateTtlMs('1'), 60_000);
  assert.equal(boundedGmgnCandidateTtlMs(String(2 * 60 * 60_000)), 60 * 60_000);
});

test('dynamic policies persist the same default no-stop exit template as the workspace', () => {
  const policy = normalizePolicyInput({ allowed_chain_ids: ['bsc'] });
  assert.equal(policy.exit_strategy.version, 1);
  assert.deepEqual(policy.exit_strategy.legs, [
    { type: 'take_profit', trigger_pct: 100, sell_pct: 50 }
  ]);
});

test('paper runtime rejects zero-budget policies before materialization', () => {
  assert.throws(
    () => normalizePolicyInput({ mode: 'paper', allowed_chain_ids: ['bsc'] }),
    { code: 'DYNAMIC_POLICY_PAPER_LIMITS_REQUIRED' }
  );
  assert.throws(
    () => normalizePolicyInput({
      mode: 'paper', allowed_chain_ids: ['bsc'], budget_per_trade: 0.1,
      daily_budget: 1, slippage: 0
    }),
    { code: 'DYNAMIC_POLICY_SLIPPAGE_REQUIRED' }
  );
});

test('dynamic aliases are bounded, normalized, and deduplicated', () => {
  assert.deepEqual(normalizeApprovedAliases([' 何必东奔西走 ', '何必东奔西走', 'PONS']), [
    '何必东奔西走', 'PONS'
  ]);
  assert.throws(() => normalizeApprovedAliases(Array.from({ length: 51 }, (_, index) => `alias-${index}`)), {
    code: 'DYNAMIC_POLICY_INVALID'
  });
});

test('removing a dynamic policy preserves audit rows and cancels future execution', async () => {
  const queries = [];
  const executor = {
    async query(sql, params) {
      queries.push({ sql, params });
      if (sql.startsWith('SELECT policy.*')) {
        return { rows: [{
          id: 9, kol_id: 3, x_handle: 'testactor', mode: 'live', enabled: true,
          allowed_chain_ids: ['bsc'], allowed_event_types: ['tweet'],
          allowed_term_types: ['cashtag'], approved_aliases: [], budget_per_trade: 0.1,
          daily_budget: 1, daily_new_token_limit: 2, per_token_buy_limit: 1,
          slippage: 10, exit_strategy: {
            version: 1, sell_ratio_type: 'buy_amount',
            legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
          }, resolver_options: {}, revision: 4, context_hash: 'old'
        }] };
      }
      return { rows: [] };
    }
  };
  assert.equal(await remove(9, executor), true);
  assert.equal(queries.some((item) => /^DELETE FROM x_actor_dynamic_policies/.test(item.sql)), false);
  assert.ok(queries.some((item) => item.sql.includes("mode = 'paused', enabled = false")));
  assert.ok(queries.some((item) => item.sql.includes("failure_code = 'DYNAMIC_POLICY_REMOVED'")));
  assert.ok(queries.some((item) => item.sql.includes("dynamic_live_approvals SET status = 'revoked'")));
});

test('GMGN Kline adapter preserves only timestamped price rows', () => {
  const rows = normalizeKline({ list: [[1700000000, '1', '2', '0.5', '1.5', '10'], { time: 1700000300, open: 1.5, high: 2, low: 1, close: 1.8 }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].high, 2);
  assert.equal(rows[1].close, 1.8);
});

test('P20 workers do not claim queued work while the runtime is disabled', async () => {
  const rejectingDb = {
    query: async () => { throw new Error('disabled worker touched the database'); },
    pool: { connect: async () => { throw new Error('disabled worker claimed a connection'); } }
  };
  const dynamic = new DynamicSignalWorker({
    db: rejectingDb,
    getFeatureState: () => DISABLED_RUNTIME
  });
  const launch = new DynamicLaunchWindowWorker({
    db: rejectingDb,
    getFeatureState: () => DISABLED_RUNTIME
  });
  assert.deepEqual(await dynamic.runOnce(), { status: 'skipped', reason: 'p20_disabled' });
  assert.deepEqual(await launch.runOnce(), { status: 'skipped', reason: 'p20_disabled' });
});

test('dynamic worker cancels a job when its policy revision is stale', async () => {
  const calls = [];
  const worker = new DynamicSignalWorker({
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('WITH candidate AS')) {
          return { rows: [{ id: 22, attempt_count: 1 }] };
        }
        if (sql.includes('SELECT job.*, activity')) {
          return { rows: [{ policy_enabled: false, policy_revision: 1, current_policy_revision: 1 }] };
        }
        return { rows: [] };
      }
    },
    logger: { error() {} },
    getFeatureState: () => ({
      P20_DYNAMIC_RESOLUTION_ENABLED: true,
      P20_RECORD_ENABLED: true,
      P20_PAPER_ENABLED: false,
      P20_LIVE_ENABLED: false
    })
  });

  const result = await worker.runOnce();
  assert.deepEqual(result, { status: 'cancelled', jobId: 22, reason: 'dynamic_policy_changed' });
  const cancellation = calls.find((item) => item.sql.includes("SET status = 'cancelled'"));
  assert.equal(cancellation.params[1], 'DYNAMIC_POLICY_CHANGED');
});

test('dynamic worker preserves the original failure message for retry diagnostics', async () => {
  const calls = [];
  const worker = new DynamicSignalWorker({
    db: {
      query: async (sql, params) => {
        calls.push({ sql, params });
        if (sql.includes('WITH candidate AS')) return { rows: [{ id: 22, attempt_count: 1 }] };
        if (sql.includes('SELECT job.*, activity')) {
          return { rows: [{
            policy_enabled: true, policy_revision: 1, current_policy_revision: 1,
            configured_mode: 'record', mode: 'record', allowed_event_types: ['tweet'],
            activity_type: 'tweet', allowed_chain_ids: ['bsc'], allowed_term_types: ['cashtag'],
            approved_aliases: [], resolver_options: {}
          }] };
        }
        if (sql.includes('FROM dynamic_asset_variants')) throw new Error('candidate index unavailable');
        return { rows: [] };
      }
    },
    logger: { error() {} },
    getFeatureState: () => ({
      P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
      P20_PAPER_ENABLED: false, P20_LIVE_ENABLED: false
    })
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'failed');
  const failure = calls.find((item) => item.sql.includes('UPDATE dynamic_signal_jobs SET status'));
  assert.equal(failure.params[2], 'DYNAMIC_JOB_FAILED');
  assert.match(failure.params[3], /candidate index unavailable/);
});

test('paper session creation is idempotent when another worker wins the insert race', async () => {
  const calls = [];
  let selectCount = 0;
  const executor = {
    async query(sql) {
      calls.push(sql);
      if (sql.startsWith('SELECT * FROM dynamic_paper_sessions')) {
        selectCount += 1;
        return selectCount === 1 ? { rows: [] } : {
          rows: [{ id: 44, actor_policy_id: 7, policy_revision: 2, status: 'running' }]
        };
      }
      if (sql.startsWith('INSERT INTO dynamic_paper_sessions')) return { rows: [] };
      return { rows: [] };
    }
  };
  const session = await ensureSession(7, 2, executor);
  assert.equal(session.id, 44);
  assert.match(calls[1], /ON CONFLICT \(actor_policy_id, policy_revision\) WHERE status = 'running'/);
});

test('P20 launch window cancels stale live work before any market request', async () => {
  const queries = [];
  const worker = new DynamicLaunchWindowWorker({
    db: {
      query: async (sql) => {
        queries.push(sql);
        if (sql.includes('WITH candidate AS')) {
          return { rows: [{ id: 11, dynamic_job_id: 22, job_mode: 'live' }] };
        }
        if (sql.includes('UPDATE dynamic_launch_windows')) return { rowCount: 1, rows: [{ id: 11 }] };
        if (sql.includes('UPDATE dynamic_signal_jobs')) return { rows: [{ id: 22 }] };
        return { rows: [] };
      }
    },
    getFeatureState: () => ({
      P20_DYNAMIC_RESOLUTION_ENABLED: true,
      P20_RECORD_ENABLED: true,
      P20_PAPER_ENABLED: true,
      P20_LIVE_ENABLED: false
    })
  });
  assert.deepEqual(await worker.runOnce(), {
    status: 'cancelled', reason: 'runtime_mode_changed', windowId: 11
  });
  assert.equal(queries.length, 3);
  assert.ok(queries.some((sql) => sql.includes('DYNAMIC_RUNTIME_MODE_CHANGED')));
});

test('P20 launch window can reclaim an abandoned processing lease', async () => {
  const queries = [];
  const worker = new DynamicLaunchWindowWorker({
    workerId: 'launch-test-worker',
    db: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('WITH candidate AS')) {
          assert.match(sql, /status = 'processing' AND lease_expires_at < NOW\(\)/);
          assert.equal(params[0], 'launch-test-worker');
          return { rows: [] };
        }
        return { rows: [] };
      }
    },
    getFeatureState: () => ({
      P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
      P20_PAPER_ENABLED: true, P20_LIVE_ENABLED: false
    })
  });
  assert.deepEqual(await worker.runOnce(), { status: 'idle' });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /UPDATE dynamic_launch_windows AS launch_window/);
  assert.doesNotMatch(queries[0].sql, /UPDATE dynamic_launch_windows window/);
});

test('P20 launch window writes keep the worker lease and job transition owner guarded', async () => {
  const queries = [];
  const worker = new DynamicLaunchWindowWorker({
    workerId: 'launch-owner',
    db: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        if (sql.includes('WITH candidate AS')) {
          return { rows: [{ id: 11, dynamic_job_id: 22, job_mode: 'record', allowed_chain_ids: [], observed_terms: [] }] };
        }
        if (sql.includes("SET status = 'resolved'")) return { rowCount: 1, rows: [{ id: 11 }] };
        return { rowCount: 1, rows: [] };
      }
    },
    getFeatureState: () => ({
      P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
      P20_PAPER_ENABLED: false, P20_LIVE_ENABLED: false
    })
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'waiting');
  const waiting = queries.find((item) => item.sql.includes("SET status = 'pending'"));
  assert.match(waiting.sql, /worker_id = \$2/);
  assert.match(waiting.sql, /lease_expires_at > NOW\(\)/);
});

test('P20 paper session worker completes eligible sessions through its bounded loop', async () => {
  const queries = [];
  const worker = new DynamicPaperSessionWorker({
    db: {
      query: async (sql) => {
        queries.push(sql);
        return { rows: [{ id: 1 }, { id: 2 }] };
      }
    },
    logger: { error: () => {} }
  });
  assert.deepEqual(await worker.runOnce(), { status: 'completed', completed: 2 });
  assert.equal(queries.length, 1);
  assert.match(queries[0], /ends_at <= NOW\(\)/);
});
