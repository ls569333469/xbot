const assert = require('node:assert/strict');
const test = require('node:test');
const {
  fetchHotSearches,
  fetchRank,
  fetchTopHolders,
  verifyCandidate
} = require('../domains/dynamic-signal/gmgn-market-source');

const CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';

test('GMGN market sources call only read endpoints and expose schema coverage', async () => {
  const calls = [];
  const http = {
    getMarketRank: async (...args) => {
      calls.push(['rank', ...args]);
      return { rank: [{ chain: 'robinhood', address: CA, symbol: 'PONS' }] };
    },
    getMarketHotSearches: async (...args) => {
      calls.push(['hot', ...args]);
      return [{ chain: 'robinhood', interval: '24h', tokens: [{ address: CA, symbol: 'PONS' }] }];
    },
    getTokenTopHolders: async (...args) => {
      calls.push(['holders', ...args]);
      return { list: [{ address: 'wallet', buy_volume_cur: '100', balance: '2', transfer_in: false }] };
    }
  };
  const rank = await fetchRank({ chain: 'robinhood' }, { http });
  const hot = await fetchHotSearches({ params: [{ chain: 'robinhood' }] }, { http });
  const holders = await fetchTopHolders({ chain: 'robinhood', address: CA }, { http });
  assert.equal(rank.coverage.complete, true);
  assert.equal(hot.candidates[0].chainId, 'robinhood');
  assert.equal(holders.holders[0].activeBuyer, true);
  assert.deepEqual(calls.map((call) => call[0]), ['rank', 'hot', 'holders']);
});

test('candidate verification distinguishes unknown provider fields from zero', async () => {
  const http = {
    getTokenInfo: async () => ({
      address: CA,
      name: 'Pons',
      symbol: 'PONS',
      decimals: 18,
      liquidity: null,
      wallet_tags_stat: {}
    }),
    getTokenSecurity: async () => { throw Object.assign(new Error('down'), { code: 'GMGN_UNAVAILABLE' }); },
    getTokenPoolInfo: async () => ({ liquidity: null })
  };
  const result = await verifyCandidate({ chainId: 'robinhood', contractAddress: CA }, { http });
  assert.equal(result.providerStatus, 'verified');
  assert.equal(result.tradableStatus, 'unknown');
  assert.equal(result.renownedWallets, null);
  assert.equal(result.fieldAvailability.renowned_wallets, 'unknown');
});

test('candidate verification propagates GMGN rate bans from security or pool endpoints', async () => {
  const http = {
    getTokenInfo: async () => ({ address: CA, name: 'Pons', symbol: 'PONS', decimals: 18 }),
    getTokenSecurity: async () => {
      throw Object.assign(new Error('temporarily banned'), {
        code: 'RATE_LIMIT_BANNED', status: 429, resetAt: Date.now() + 240_000
      });
    },
    getTokenPoolInfo: async () => ({ liquidity: 1000 })
  };
  await assert.rejects(
    verifyCandidate({ chainId: 'robinhood', contractAddress: CA }, { http }),
    { code: 'RATE_LIMIT_BANNED' }
  );
});

test('candidate verification rejects a provider response for a different CA', async () => {
  const http = {
    getTokenInfo: async () => ({
      address: '0x49dbed3a2bd333467115de45665cc57f813c4571', decimals: 18,
      symbol: 'OTHER'
    }),
    getTokenSecurity: async () => ({}),
    getTokenPoolInfo: async () => ({ liquidity: 1000 })
  };
  await assert.rejects(
    verifyCandidate({ chainId: 'robinhood', contractAddress: CA }, { http }),
    { code: 'GMGN_ADDRESS_MISMATCH' }
  );
});
