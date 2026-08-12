const assert = require('node:assert/strict');
const test = require('node:test');

const {
  AssetMetadataWorker,
  normalize,
  retryAt,
  sameAddress
} = require('../domains/asset-metadata/worker');

const EVM_ADDRESS = '0xbd957cc9f1e94617792f37bc40f2f299e78acf3e';

function asset(overrides = {}) {
  return {
    id: 1,
    chain_id: 'robinhood',
    contract_address: EVM_ADDRESS,
    contract_address_key: EVM_ADDRESS,
    attempt_count: 1,
    ...overrides
  };
}

test('shared metadata validates EVM case-insensitively and Solana case-sensitively', () => {
  assert.equal(sameAddress('robinhood', EVM_ADDRESS, EVM_ADDRESS.toUpperCase()), true);
  assert.equal(sameAddress('sol', 'AbCd', 'abcd'), false);
  assert.throws(() => normalize(asset(), {
    address: '0x1111111111111111111111111111111111111111', decimals: 18
  }), (error) => error.code === 'GMGN_TOKEN_ADDRESS_MISMATCH');
});

test('shared metadata accepts official GMGN token info fields', () => {
  const result = normalize(asset(), {
    address: EVM_ADDRESS,
    name: 'Crude Cat',
    symbol: 'CRUDECAT',
    decimals: 18,
    logo: 'https://gmgn.ai/token.webp'
  });
  assert.deepEqual({
    name: result.name,
    symbol: result.symbol,
    decimals: result.decimals,
    logoUrl: result.logoUrl
  }, {
    name: 'Crude Cat', symbol: 'CRUDECAT', decimals: 18,
    logoUrl: 'https://gmgn.ai/token.webp'
  });
});

test('429 retry honors GMGN reset time and normal failures use controlled backoff', () => {
  const now = 1_800_000_000_000;
  assert.equal(retryAt({ resetAt: now + 300_000 }, 1, now).getTime(), now + 301_000);
  assert.equal(retryAt({}, 1, now).getTime(), now + 60_000);
  assert.equal(retryAt({}, 3, now).getTime(), now + 30 * 60_000);
});

test('worker performs one low-priority GMGN call and never invokes a fallback provider', async () => {
  const calls = [];
  const claimed = asset();
  const repository = {
    claimNext: async () => claimed,
    complete: async (...args) => calls.push(['complete', ...args]),
    fail: async (...args) => calls.push(['fail', ...args])
  };
  const worker = new AssetMetadataWorker({
    workerId: 'metadata-test',
    repository,
    isEnabled: () => true,
    gmgnAccess: {
      scheduler: { getStatus: () => ({ state: 'healthy' }) },
      getTokenInfo: async (chain, address, options) => {
        calls.push(['gmgn', chain, address, options]);
        return { address, name: 'Crude Cat', symbol: 'CRUDECAT', decimals: 18 };
      }
    },
    logger: { warn() {}, error() {} }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(calls.filter(([kind]) => kind === 'gmgn').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'fail').length, 0);
  assert.equal(calls[0][1], 'robinhood');
  assert.equal(calls[0][3].requestContext.source, 'asset_metadata');
});

test('worker stores failure for retry without a second network provider', async () => {
  const calls = [];
  const repository = {
    claimNext: async () => asset(),
    complete: async () => calls.push('complete'),
    fail: async () => calls.push('fail')
  };
  const worker = new AssetMetadataWorker({
    repository,
    isEnabled: () => true,
    gmgnAccess: {
      scheduler: { getStatus: () => ({ state: 'healthy' }) },
      getTokenInfo: async () => {
      calls.push('gmgn');
      const error = new Error('rate limited');
      error.code = 'RATE_LIMIT_BANNED';
      throw error;
      }
    },
    logger: { warn() {}, error() {} }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'deferred');
  assert.deepEqual(calls, ['gmgn', 'fail']);
});

test('worker does not claim metadata while a trade owns GMGN capacity', async () => {
  let claimed = false;
  const worker = new AssetMetadataWorker({
    repository: { claimNext: async () => { claimed = true; } },
    isEnabled: () => true,
    gmgnAccess: {
      scheduler: { getStatus: () => ({ state: 'healthy', reservedWeight: 5 }) },
      getTokenInfo: async () => { throw new Error('must not run'); }
    }
  });
  assert.deepEqual(await worker.runOnce(), { status: 'skipped', reason: 'gmgn_busy' });
  assert.equal(claimed, false);
});
