const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendPolicyHealth,
  contractApprovalReady,
  configurationFingerprintChains,
  followLivePolicyState,
  followWatchReadiness,
  jsonb,
  loadTradeAttemptReadiness,
  normalizeTradeEvidence,
  providerHistoryReadiness,
  strategyChainReady,
  splitChainReadiness,
  tradeAttemptReadiness
} = require('../domains/trade/readiness-service');

test('combined scope keeps policy-local configuration faults out of the global stop path', () => {
  const combined = { blockers: [], advisories: [] };
  appendPolicyHealth(combined, 'FOLLOW_POLICY_CONFIG_INVALID', false);
  assert.deepEqual(combined, {
    blockers: [], advisories: ['FOLLOW_POLICY_CONFIG_INVALID']
  });

  const explicitPolicy = { blockers: [], advisories: [] };
  appendPolicyHealth(explicitPolicy, 'FOLLOW_POLICY_CONFIG_INVALID', true);
  assert.deepEqual(explicitPolicy, {
    blockers: ['FOLLOW_POLICY_CONFIG_INVALID'], advisories: []
  });
});

test('recent GMGN 429 history is advisory and does not block a fresh readiness check', () => {
  assert.deepEqual(providerHistoryReadiness(true), {
    blockers: [],
    advisories: ['GMGN_RECENT_429']
  });
  assert.deepEqual(providerHistoryReadiness(false), { blockers: [], advisories: [] });
});

test('ordinary receipt reconciliation is observable without blocking live trading', () => {
  assert.deepEqual(tradeAttemptReadiness({
    unresolved_attempts: 0,
    reconciling_attempts: 1
  }), {
    unresolvedAttempts: 0,
    reconcilingAttempts: 1,
    blockers: []
  });
});

test('submission uncertainty remains a global readiness blocker', async () => {
  let sql = '';
  const readiness = await loadTradeAttemptReadiness({
    query: async (statement) => {
      sql = statement;
      return { rows: [{ unresolved_attempts: 1, reconciling_attempts: 0 }] };
    }
  });

  assert.match(sql, /status = 'submission_uncertain'/);
  assert.deepEqual(readiness.blockers, ['UNRESOLVED_TRADE_ATTEMPTS']);
});

test('manual-review reconciliation remains a global readiness blocker', async () => {
  let sql = '';
  const readiness = await loadTradeAttemptReadiness({
    query: async (statement) => {
      sql = statement;
      return { rows: [{ unresolved_attempts: 1, reconciling_attempts: 0 }] };
    }
  });

  assert.match(
    sql,
    /status = 'reconciliation_required' AND requires_manual_review = true/
  );
  assert.match(
    sql,
    /status = 'reconciliation_required' AND requires_manual_review = false/
  );
  assert.deepEqual(readiness.blockers, ['UNRESOLVED_TRADE_ATTEMPTS']);
});

test('chain readiness separates fixed CA contract evidence from shared infrastructure', () => {
  assert.deepEqual(splitChainReadiness([]), { fixedReady: true, infrastructureReady: true });
  assert.deepEqual(splitChainReadiness(['CHAIN_CONTRACT_NOT_TESTED']), {
    fixedReady: false,
    infrastructureReady: true
  });
  assert.deepEqual(splitChainReadiness(['CHAIN_RPC_UNAVAILABLE']), {
    fixedReady: false,
    infrastructureReady: false
  });
});

test('P21 can use an infrastructure-ready chain while fixed CA evidence remains pending', () => {
  const readiness = splitChainReadiness(['CHAIN_CONTRACT_NOT_TESTED']);
  assert.equal(strategyChainReady(readiness, { followEnabled: true }), true);
  assert.equal(strategyChainReady(readiness, { dynamicEnabled: true }), true);
  assert.equal(strategyChainReady(readiness), false);
});

test('production approval survives a later transient readiness failure', () => {
  assert.equal(contractApprovalReady({ contract_tested: false, live_enabled: true }), true);
  assert.equal(contractApprovalReady({ contract_tested: false, live_enabled: false }), false);
});

test('readiness probe serializes GMGN balance arrays as JSON for jsonb columns', () => {
  const value = jsonb([{ symbol: 'SOL', balance: '0.5' }]);
  assert.equal(value, '[{"symbol":"SOL","balance":"0.5"}]');
  assert.deepEqual(JSON.parse(value), [{ symbol: 'SOL', balance: '0.5' }]);
});

test('P21 readiness derives its balance requirement from each configured chain budget', () => {
  const state = followLivePolicyState([{
    id: 2,
    enabled: true,
    mode: 'live',
    kol_enabled: true,
    profile_status: 'verified',
    trade_template_id: 3,
    allowed_chain_ids: ['sol', 'bsc'],
    watch_sync_status: 'succeeded',
    trade_config_snapshot: {
      slippage: 10,
      chain_budgets: {
        sol: { budget_per_trade: 0.2, daily_budget: 1 },
        bsc: { budget_per_trade: 0.05, daily_budget: 0.5 }
      }
    }
  }], true);

  assert.equal(state.configured, true);
  assert.deepEqual(state.chains, ['sol', 'bsc']);
  assert.deepEqual(state.maxTradeByChain, { sol: 0.2, bsc: 0.05 });
  assert.equal(state.unsyncedRows, 0);
  assert.deepEqual(state.watchStatusCounts, {
    succeeded: 1, pending: 0, processing: 0, failed: 0, missing: 0
  });
});

test('a newly saved Follow Watch remains policy-local and never blocks the global engine', () => {
  const state = followLivePolicyState([{
    id: 3,
    enabled: true,
    mode: 'live',
    kol_enabled: true,
    profile_status: 'verified',
    trade_template_id: 4,
    allowed_chain_ids: ['bsc'],
    watch_sync_status: 'pending',
    trade_config_snapshot: {
      slippage: 10,
      chain_budgets: { bsc: { budget_per_trade: 0.01, daily_budget: 0.05 } }
    }
  }], true);

  assert.equal(state.unsyncedRows, 1);
  assert.deepEqual(state.watchStatusCounts, {
    succeeded: 0, pending: 1, processing: 0, failed: 0, missing: 0
  });
  assert.deepEqual(followWatchReadiness(state), {
    blockers: [], advisories: ['FOLLOW_WATCH_NOT_SYNCED']
  });
  assert.deepEqual(followWatchReadiness(state, { strict: true }), {
    blockers: ['FOLLOW_WATCH_NOT_SYNCED'], advisories: []
  });
});

test('combined engine fingerprint covers stable infrastructure rather than the hot policy chain list', () => {
  const baseline = configurationFingerprintChains('combined', new Set(['bsc']));
  const afterPolicyAdd = configurationFingerprintChains('combined', new Set(['bsc', 'sol']));
  assert.deepEqual(afterPolicyAdd, baseline);
  assert.deepEqual(configurationFingerprintChains('follow_discovery', new Set(['bsc'])), ['bsc']);
});

test('readiness exposes confirmed orders and RPC receipts as per-chain evidence', () => {
  assert.deepEqual(normalizeTradeEvidence({
    confirmed_buy_attempts: '1',
    confirmed_sell_attempts: '1',
    confirmed_orders: '2',
    confirmed_receipts: '2',
    last_confirmed_at: '2026-07-22T00:00:00.000Z'
  }), {
    confirmedBuys: 1,
    confirmedSells: 1,
    confirmedOrders: 2,
    confirmedReceipts: 2,
    lastConfirmedAt: '2026-07-22T00:00:00.000Z'
  });

  assert.deepEqual(normalizeTradeEvidence(), {
    confirmedBuys: 0,
    confirmedSells: 0,
    confirmedOrders: 0,
    confirmedReceipts: 0,
    lastConfirmedAt: null
  });
});

test('unprotected positions are advisory and do not become a global new-order blocker', () => {
  const source = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '../domains/trade/readiness-service.js'),
    'utf8'
  );
  assert.match(source, /advisories\.push\('UNPROTECTED_LIVE_POSITIONS'\)/);
  assert.doesNotMatch(source, /blockers\.push\('UNPROTECTED_LIVE_POSITIONS'\)/);
});
