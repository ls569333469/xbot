const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildTrenchesBody,
  fetchHotSearches,
  fetchRank,
  fetchTopHolders,
  fetchTrenches,
  verifyCandidate
} = require('../domains/dynamic-signal/gmgn-market-source');

const CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';

test('GMGN market source builds bounded v2 trenches sections', () => {
  assert.deepEqual(buildTrenchesBody({ types: ['new_creation'], limit: 25 }), {
    version: 'v2',
    new_creation: {
      filters: ['offchain', 'onchain'],
      launchpad_platform_v2: true,
      limit: 25
    }
  });
  assert.throws(() => buildTrenchesBody({ limit: 81 }), (error) => (
    error.code === 'GMGN_MARKET_ARGUMENT_INVALID'
  ));
  const protectedBody = buildTrenchesBody({
    limit: 25,
    filters: { limit: 1000, filters: ['unsafe'], min_liquidity: 1000 }
  });
  assert.equal(protectedBody.new_creation.limit, 25);
  assert.deepEqual(protectedBody.new_creation.filters, ['offchain', 'onchain']);
  assert.equal(protectedBody.new_creation.min_liquidity, 1000);
});

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
    getMarketTrenches: async (...args) => {
      calls.push(['trenches', ...args]);
      return { new_creation: [{ address: CA, symbol: 'PONS' }] };
    },
    getTokenTopHolders: async (...args) => {
      calls.push(['holders', ...args]);
      return { list: [{ address: 'wallet', buy_volume_cur: '100', balance: '2', transfer_in: false }] };
    }
  };
  const rank = await fetchRank({ chain: 'robinhood' }, { http });
  const hot = await fetchHotSearches({ params: [{ chain: 'robinhood' }] }, { http });
  const trenches = await fetchTrenches({ chain: 'robinhood', types: ['new_creation'] }, { http });
  const holders = await fetchTopHolders({ chain: 'robinhood', address: CA }, { http });
  assert.equal(rank.coverage.complete, true);
  assert.equal(hot.candidates[0].chainId, 'robinhood');
  assert.equal(trenches.candidates[0].lifecycle, 'new_creation');
  assert.equal(holders.holders[0].activeBuyer, true);
  assert.deepEqual(calls.map((call) => call[0]), ['rank', 'hot', 'trenches', 'holders']);
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
