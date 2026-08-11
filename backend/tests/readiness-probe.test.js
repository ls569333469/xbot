const assert = require('node:assert/strict');
const test = require('node:test');
const {
  contractApprovalReady,
  followLivePolicyState,
  jsonb,
  normalizeTradeEvidence,
  providerHistoryReadiness,
  strategyChainReady,
  splitChainReadiness
} = require('../domains/trade/readiness-service');

test('recent GMGN 429 history is advisory and does not block a fresh readiness check', () => {
  assert.deepEqual(providerHistoryReadiness(true), {
    blockers: [],
    advisories: ['GMGN_RECENT_429']
  });
  assert.deepEqual(providerHistoryReadiness(false), { blockers: [], advisories: [] });
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
