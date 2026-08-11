const assert = require('node:assert/strict');
const test = require('node:test');
const {
  loadCachedContext,
  requiredCacheKeys
} = require('../domains/trade/fast-path-context');

const TOKEN = '0x1111111111111111111111111111111111111111';
const WALLET = '0x2222222222222222222222222222222222222222';

test('P24 fast path reads the persisted local execution profile without GMGN', async () => {
  let queryCount = 0;
  const context = await loadCachedContext({
    chain_id: 'base',
    contract_address: TOKEN
  }, {
    executor: {
      async query(sql, params) {
        queryCount += 1;
        assert.match(sql, /FROM chain_live_readiness/);
        assert.deepEqual(params, ['base']);
        return { rows: [{
          chain: 'base',
          wallet_address: WALLET,
          balances_json: [],
          native_balance: '0.25',
          last_checked_at: new Date()
        }] };
      }
    },
    verificationSnapshot: {
      info: { address: TOKEN, decimals: 18, symbol: 'LOCAL' },
      security: {},
      pool: {}
    }
  });

  assert.equal(queryCount, 1);
  assert.equal(context.wallet.address, WALLET);
  assert.deepEqual(context.wallet.balances, [{ symbol: 'ETH', balance: '0.25' }]);
  assert.equal(context.token.symbol, 'LOCAL');
  assert.equal(context.nativeToken.symbol, 'ETH');
  assert.equal(context.cacheMeta.wallet.source, 'chain_live_readiness');
  assert.deepEqual(requiredCacheKeys(), []);
});

test('P24 execution reuses a local verification snapshot without token, security, pool, or gas reads', async () => {
  const context = await loadCachedContext({
    chain_id: 'robinhood',
    contract_address: TOKEN
  }, {
    executionProfile: {
      wallet: {
        chain: 'robinhood',
        address: WALLET,
        balances: [{ symbol: 'ETH', balance: '1', usd_value: '3000' }]
      },
      readiness: { native_balance: '1' }
    },
    verificationSnapshot: {
      info: { address: TOKEN, decimals: 18, symbol: 'IF' },
      security: { is_honeypot: false, can_not_sell: false },
      pool: { address: '0x3333333333333333333333333333333333333333', liquidity: 1000 }
    },
    gasSnapshot: { source: 'local_test' }
  });

  assert.equal(context.token.symbol, 'IF');
  assert.equal(context.security.isHoneypot, false);
  assert.equal(context.pool.liquidityUsd, 1000);
  assert.deepEqual(context.gas, { source: 'local_test' });
  assert.equal(context.nativeToken.priceUsd, 3000);
});
