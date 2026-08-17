const test = require('node:test');
const assert = require('node:assert/strict');
const {
  effectiveMode, errorMessage, fail, renew
} = require('../domains/dynamic-signal/event-queue');
const {
  chainBudgetFor, normalizeApprovedAliases, normalizePolicyInput, contextHash, remove, upsert
} = require('../domains/dynamic-signal/policy-service');
const {
  normalizeTemplateConfig, updateTemplateTransactional
} = require('../domains/dynamic-signal/templates');
const { validateP20Runtime } = require('../lib/p20-features');
const { normalizeKline } = require('../lib/gmgn-adapter');
const { DynamicSignalWorker } = require('../domains/dynamic-signal/event-worker');
const { DynamicPaperSessionWorker } = require('../domains/dynamic-signal/paper-worker');
const { ensureSession } = require('../domains/dynamic-signal/paper-worker');
const {
  boundedGmgnCandidateTtlMs,
  upsertCandidate
} = require('../domains/dynamic-signal/candidate-repository');
const { dynamicLivePolicyState } = require('../domains/trade/readiness-service');
const { usesWhitelistLifetimeBudget } = require('../domains/trade/trade-repository');

const DISABLED_RUNTIME = Object.freeze({
  P20_DYNAMIC_RESOLUTION_ENABLED: false,
  P20_RECORD_ENABLED: false,
  P20_PAPER_ENABLED: false,
  P20_LIVE_ENABLED: false
});

test('P20 runtime never silently changes an explicitly configured stage', () => {
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
  }), null);
  assert.equal(effectiveMode('paper', {
    P20_DYNAMIC_RESOLUTION_ENABLED: true, P20_RECORD_ENABLED: true,
    P20_PAPER_ENABLED: false, P20_LIVE_ENABLED: true
  }), null);
  const liveOnly = validateP20Runtime({
    P20_RECORD_ENABLED: 'true', P20_LIVE_ENABLED: 'true', P20_PAPER_ENABLED: 'false'
  });
  assert.equal(liveOnly.P20_LIVE_ENABLED, true);
  assert.equal(liveOnly.P20_PAPER_ENABLED, false);
});

test('dynamic readiness accepts a standalone live policy only when its runtime and budgets are valid', () => {
  const rows = [{
    id: 1,
    allowed_chain_ids: ['bsc', 'sol'],
    chain_budgets: {
      bsc: { budget_per_trade: 0.01, daily_budget: 0.05 },
      sol: { budget_per_trade: 0.05, daily_budget: 0.25 }
    },
    daily_new_token_limit: 2,
    slippage: 10
  }];
  const enabledState = dynamicLivePolicyState(rows, {
    P20_DYNAMIC_RESOLUTION_ENABLED: true,
    P20_RECORD_ENABLED: true,
    P20_LIVE_ENABLED: true
  });
  assert.equal(enabledState.configured, true);
  assert.deepEqual(enabledState.chains, ['bsc', 'sol']);
  assert.equal(enabledState.maxTradeByChain.sol, 0.05);

  const disabledState = dynamicLivePolicyState(rows, {
    P20_DYNAMIC_RESOLUTION_ENABLED: true,
    P20_RECORD_ENABLED: true,
    P20_LIVE_ENABLED: false
  });
  assert.equal(disabledState.configured, false);
  assert.equal(disabledState.validRows, 1);
});

test('dynamic signals use the per-chain daily ledger instead of fixed whitelist lifetime budget', () => {
  assert.equal(usesWhitelistLifetimeBudget({ whitelist_id: 1 }), true);
  assert.equal(usesWhitelistLifetimeBudget({
    whitelist_id: 2,
    actor_policy_id: 3,
    dynamic_target_id: 4
  }), false);
});

test('dynamic policy revision hash changes with safety-critical limits', () => {
  const first = normalizePolicyInput({ allowed_chain_ids: ['bsc'], budget_per_trade: 1 });
  const second = normalizePolicyInput({ allowed_chain_ids: ['bsc'], budget_per_trade: 2 });
  assert.notEqual(first.context_hash, second.context_hash);
  const { context_hash: ignored, ...firstConfig } = first;
  assert.equal(first.context_hash, contextHash(firstConfig));
});

test('scheme A keeps native budgets independent for every allowed chain', () => {
  const policy = normalizePolicyInput({
    allowed_chain_ids: ['bsc', 'sol'],
    chain_budgets: {
      bsc: { budget_per_trade: 0.01, daily_budget: 0.05 },
      sol: { budget_per_trade: 0.05, daily_budget: 0.25 },
    },
  });
  assert.deepEqual(chainBudgetFor(policy, 'bsc'), { budget_per_trade: 0.01, daily_budget: 0.05 });
  assert.deepEqual(chainBudgetFor(policy, 'sol'), { budget_per_trade: 0.05, daily_budget: 0.25 });
  assert.equal(chainBudgetFor({ allowed_chain_ids: ['bsc'], budget_per_trade: 1, daily_budget: 2 }, 'bsc'), null);
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

test('dynamic aliases preserve distinct lines and reject silent normalized duplicates', () => {
  assert.deepEqual(normalizeApprovedAliases([' 何必东奔西走，币安全部都有。 ', '币有', 'PONS']), [
    '何必东奔西走，币安全部都有。', '币有', 'PONS'
  ]);
  assert.throws(
    () => normalizeApprovedAliases(['何必东奔西走，币安全部都有。', '何必东奔西走, 币安全部都有!']),
    { code: 'DYNAMIC_POLICY_ALIAS_DUPLICATE' }
  );
  assert.throws(() => normalizeApprovedAliases(Array.from({ length: 51 }, (_, index) => `alias-${index}`)), {
    code: 'DYNAMIC_POLICY_INVALID'
  });
});

test('dynamic account templates preserve exact aliases and exclude runtime switches', () => {
  const config = normalizeTemplateConfig({
    mode: 'live',
    enabled: false,
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['approved_name'],
    approved_aliases: ['何必东奔西走，币安全部都有。'],
    chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.1 } },
    daily_new_token_limit: 2,
    per_token_buy_limit: 1,
    slippage: 10,
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
    },
    resolver_options: {}
  });

  assert.deepEqual(config.approved_aliases, ['何必东奔西走，币安全部都有。']);
  assert.equal('mode' in config, false);
  assert.equal('enabled' in config, false);
  assert.deepEqual(config.chain_budgets.bsc, { budget_per_trade: 0.01, daily_budget: 0.1 });
});

test('dynamic template updates keep the row lock inside one database transaction', async () => {
  const calls = [];
  const currentConfig = normalizeTemplateConfig({
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['ca'],
    approved_aliases: [],
    chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.1 } },
    daily_new_token_limit: 2,
    per_token_buy_limit: 1,
    slippage: 10,
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
    },
    resolver_options: {}
  });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, name, config')) {
        return { rows: [{ id: 3, name: 'current', config: currentConfig }] };
      }
      if (sql.startsWith('UPDATE dynamic_policy_templates')) {
        return { rows: [{ id: 3, name: 'updated', version: 2 }] };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  const result = await updateTemplateTransactional(3, { name: 'updated' }, {
    async connect() { return client; }
  });

  assert.equal(result.version, 2);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.match(calls[1].sql, /FOR UPDATE/);
  assert.match(calls[2].sql, /^UPDATE dynamic_policy_templates/);
  assert.equal(calls[3].sql, 'COMMIT');
  assert.equal(calls[4].sql, 'RELEASE');
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
  assert.ok(queries.some((item) => item.sql.includes("source = 'dynamic_keyword'")
    && item.sql.includes("status = 'archived'")));
  assert.ok(queries.some((item) => item.sql.includes('UPDATE whitelist_activation_outbox')));
  assert.ok(queries.some((item) => item.sql.includes("reject_reason = 'DYNAMIC_POLICY_REMOVED'")));
  assert.equal(queries.some((item) => item.sql.includes('dynamic_live_approvals')), false);
});

test('saving a changed dynamic policy locks its revision and cancels stale queued work', async () => {
  const calls = [];
  const current = {
    id: 9,
    kol_id: 3,
    mode: 'live',
    enabled: true,
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['ca'],
    approved_aliases: [],
    chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.05 } },
    budget_per_trade: 0.01,
    daily_budget: 0.05,
    daily_new_token_limit: 2,
    per_token_buy_limit: 1,
    slippage: 10,
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 50 }]
    },
    resolver_options: {},
    revision: 6,
    context_hash: 'old-context'
  };
  const executor = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT * FROM x_actor_dynamic_policies')) return { rows: [current] };
      if (sql.startsWith('INSERT INTO x_actor_dynamic_policies')) {
        return { rows: [{ ...current, revision: 7, context_hash: params[16] }] };
      }
      return { rows: [] };
    }
  };

  const saved = await upsert(3, { slippage: 11 }, executor);
  assert.equal(saved.revision, 7);
  assert.match(calls[0].sql, /pg_advisory_xact_lock/);
  assert.match(calls[1].sql, /FOR UPDATE/);
  assert.ok(calls.some((item) => item.sql.includes("reject_reason = 'DYNAMIC_POLICY_CHANGED'")));
  assert.ok(calls.some((item) => item.sql.includes("source = 'dynamic_keyword'")
    && item.sql.includes("status = 'archived'")));
  const cancellation = calls.find((item) => item.sql.includes('UPDATE dynamic_signal_jobs'));
  assert.deepEqual(cancellation.params, [9, 7]);
  assert.match(cancellation.sql, /status IN\('pending','processing'\)/);
});

test('GMGN Kline adapter preserves only timestamped price rows', () => {
  const rows = normalizeKline({ list: [[1700000000, '1', '2', '0.5', '1.5', '10'], { time: 1700000300, open: 1.5, high: 2, low: 1, close: 1.8 }] });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].high, 2);
  assert.equal(rows[1].close, 1.8);
});

test('P20 worker does not claim queued work while the runtime is disabled', async () => {
  const rejectingDb = {
    query: async () => { throw new Error('disabled worker touched the database'); },
    pool: { connect: async () => { throw new Error('disabled worker claimed a connection'); } }
  };
  const dynamic = new DynamicSignalWorker({
    db: rejectingDb,
    getFeatureState: () => DISABLED_RUNTIME
  });
  assert.deepEqual(await dynamic.runOnce(), { status: 'skipped', reason: 'p20_disabled' });
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
            tweet_text: 'buy $TEST', approved_aliases: [], resolver_options: {}
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
