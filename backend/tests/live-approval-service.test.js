const assert = require('node:assert/strict');
const test = require('node:test');
const approval = require('../domains/trade/live-approval-service');

const originalAcceptanceEnvironment = {
  ROBINHOOD_RPC_URL: process.env.ROBINHOOD_RPC_URL,
  GMGN_MAX_FEE_RESERVE_ROBINHOOD: process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD,
  GMGN_MIN_GAS_RESERVE_ROBINHOOD: process.env.GMGN_MIN_GAS_RESERVE_ROBINHOOD
};

test.before(() => {
  process.env.ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
  process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD = '0.002';
  process.env.GMGN_MIN_GAS_RESERVE_ROBINHOOD = '0.01';
});

test.after(() => {
  for (const [key, value] of Object.entries(originalAcceptanceEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test('acceptance environment requires RPC and explicit positive fee reserves', () => {
  const previous = {
    rpc: process.env.ROBINHOOD_RPC_URL,
    fee: process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD,
    gas: process.env.GMGN_MIN_GAS_RESERVE_ROBINHOOD
  };
  try {
    delete process.env.ROBINHOOD_RPC_URL;
    delete process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD;
    delete process.env.GMGN_MIN_GAS_RESERVE_ROBINHOOD;
    assert.throws(() => approval.assertAcceptanceEnvironment('robinhood'), {
      code: 'ACCEPTANCE_ENVIRONMENT_INCOMPLETE'
    });
    process.env.ROBINHOOD_RPC_URL = 'https://rpc.mainnet.chain.robinhood.com';
    process.env.GMGN_MAX_FEE_RESERVE_ROBINHOOD = '0.002';
    process.env.GMGN_MIN_GAS_RESERVE_ROBINHOOD = '0.01';
    assert.doesNotThrow(() => approval.assertAcceptanceEnvironment('robinhood'));
  } finally {
    for (const [key, value] of Object.entries({
      ROBINHOOD_RPC_URL: previous.rpc,
      GMGN_MAX_FEE_RESERVE_ROBINHOOD: previous.fee,
      GMGN_MIN_GAS_RESERVE_ROBINHOOD: previous.gas
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

const whitelist = {
  id: 901,
  chain_id: 'robinhood',
  contract_address: '0x0000000000000000000000000000000000000001',
  status: 'active'
};

test('contract evidence context changes with trading limits', () => {
  const original = approval.contractContext('robinhood', [{
    ...whitelist,
    budget_per_trade: '0.001',
    total_budget: '0.001',
    slippage: '10'
  }]);
  const changed = approval.contractContext('robinhood', [{
    ...whitelist,
    budget_per_trade: '0.002',
    total_budget: '0.002',
    slippage: '10'
  }]);
  assert.notEqual(original.contextHash, changed.contextHash);
});

test('contract evidence context changes with actor relation permissions', () => {
  const original = approval.contractContext('robinhood', [{
    ...whitelist,
    relations: [{ actor_handle: '@actor', target_x_handle: '@project', event_types: ['reply'] }]
  }]);
  const changed = approval.contractContext('robinhood', [{
    ...whitelist,
    relations: [{ actor_handle: '@actor', target_x_handle: '@project', event_types: ['quote'] }]
  }]);
  assert.notEqual(original.contextHash, changed.contextHash);
});

function startExecutor(options = {}) {
  const context = approval.contractContext('robinhood', [whitelist]);
  const calls = [];
  return {
    calls,
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM ca_whitelist AS whitelist')) return { rows: [whitelist] };
      if (sql.includes('FROM chain_live_readiness WHERE chain')) {
        return { rows: [{ implemented: true, contract_tested: true }] };
      }
      if (sql.includes("evidence.evidence_type = 'contract_probe'")) {
        return { rows: options.staleEvidence ? [] : [{ id: 77, context_hash: context.contextHash }] };
      }
      if (sql.includes("WHERE scope.status = 'active'")) {
        return { rows: options.activeScope ? [{
          id: 3,
          chain: 'sol',
          whitelist_id: 1,
          expires_at: new Date(Date.now() + 60_000)
        }] : [] };
      }
      if (sql.includes('INSERT INTO live_acceptance_scopes')) {
        return { rows: [{ id: 4, chain: 'robinhood', whitelist_id: 901, status: 'active' }] };
      }
      return { rows: [] };
    }
  };
}

test('limited live acceptance starts only for one explicit whitelist with current evidence', async () => {
  const executor = startExecutor();
  const scope = await approval.startAcceptanceScope({
    chain: 'robinhood', whitelistId: 901, operator: 'test'
  }, executor);
  assert.equal(scope.chain, 'robinhood');
  assert.equal(scope.whitelist_id, 901);
});

test('limited live acceptance rejects stale evidence and another active scope', async () => {
  await assert.rejects(
    approval.startAcceptanceScope({ chain: 'robinhood', whitelistId: 901 }, startExecutor({ staleEvidence: true })),
    { code: 'CONTRACT_EVIDENCE_STALE' }
  );
  await assert.rejects(
    approval.startAcceptanceScope({ chain: 'robinhood', whitelistId: 901 }, startExecutor({ activeScope: true })),
    { code: 'ACCEPTANCE_SCOPE_ALREADY_ACTIVE' }
  );
});

test('production approval refuses an unfinished acceptance scope', async () => {
  const executor = {
    async query(sql) {
      if (sql.includes("WHERE scope.status = 'active'")) {
        return { rows: [{ id: 9, expires_at: new Date(Date.now() + 60_000) }] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  await assert.rejects(
    approval.approveProduction('robinhood', 'test', executor),
    { code: 'ACCEPTANCE_SCOPE_STILL_ACTIVE' }
  );
});
