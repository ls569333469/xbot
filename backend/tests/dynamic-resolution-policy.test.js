const assert = require('node:assert/strict');
const test = require('node:test');
const { extractContent } = require('../domains/dynamic-signal/content-extractor');
const {
  RESOLUTION_CODES,
  applyResolutionPolicy
} = require('../domains/dynamic-signal/resolution-policy');

const ORIGINAL = '0xd0bc8ab397851ecfa58009d03bbc1a41fc764444';
const RELAUNCH = '0xe9337dde3dd9e97f1f45a56412767ce5098e7777';

function candidate(address, launchpad, extra = {}) {
  return {
    chainId: 'bsc',
    contractAddress: address,
    symbol: '币有',
    name: '何必东奔西走',
    assetFamilyKey: 'biyou',
    launchpad,
    providerStatus: 'verified',
    tradableStatus: 'tradable',
    liquidityUsd: 100000,
    ...extra
  };
}

test('two real variants remain ambiguous when the post provides no version context', () => {
  const result = applyResolutionPolicy([
    candidate(ORIGINAL, 'fourmeme'),
    candidate(RELAUNCH, 'flap')
  ], {
    extraction: extractContent({ text: 'Buy #币有', approvedAliases: ['币有'] }),
    allowedChains: ['bsc']
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.failureCode, RESOLUTION_CODES.AMBIGUOUS);
});

test('explicit Flap context selects only the Flap relaunch variant', () => {
  const result = applyResolutionPolicy([
    candidate(ORIGINAL, 'fourmeme'),
    candidate(RELAUNCH, 'flap')
  ], {
    extraction: extractContent({ text: 'Buy 币有 on Flap', approvedAliases: ['币有'] }),
    allowedChains: ['bsc']
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.selectedCandidate.contractAddress, RELAUNCH);
  assert.deepEqual(result.reasonCodes, ['UNIQUE_LAUNCHPAD_CONTEXT']);
});

test('an explicit unmatched platform fails as context mismatch before market ranking', () => {
  const result = applyResolutionPolicy([
    candidate(ORIGINAL, 'fourmeme', { renownedWallets: 4, marketCapUsd: 1000000 }),
    candidate(RELAUNCH, 'flap', { renownedWallets: 3, marketCapUsd: 500000 })
  ], {
    extraction: extractContent({ text: 'Buy 币有 on Pump.fun', approvedAliases: ['币有'] }),
    allowedChains: ['bsc'],
    marketDominanceMinRatio: 2
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.CONTEXT_MISMATCH);
});

test('an author-owned full CA overrides market support evidence', () => {
  const result = applyResolutionPolicy([
    candidate(ORIGINAL, 'fourmeme', { marketCapUsd: 10000 }),
    candidate(RELAUNCH, 'flap', { marketCapUsd: 1000000 })
  ], {
    extraction: extractContent({ text: `Buy ${ORIGINAL}` }),
    allowedChains: ['bsc']
  });
  assert.equal(result.selectedCandidate.contractAddress, ORIGINAL);
  assert.deepEqual(result.reasonCodes, ['AUTHOR_FULL_CA']);
});

test('a launchpad URL containing the full CA remains an exact URL anchor', () => {
  const result = applyResolutionPolicy([
    candidate(ORIGINAL, 'fourmeme'),
    candidate(RELAUNCH, 'flap')
  ], {
    extraction: extractContent({ text: `https://gmgn.ai/bsc/token/${RELAUNCH}` }),
    allowedChains: ['bsc']
  });
  assert.equal(result.selectedCandidate.contractAddress, RELAUNCH);
  assert.deepEqual(result.reasonCodes, ['AUTHOR_URL_CA']);
});

test('market dominance requires known KOL fields and a shared market/liquidity winner', () => {
  const dominant = candidate(RELAUNCH, 'flap', {
    renownedWallets: 12, marketCapUsd: 900000, liquidityUsd: 300000
  });
  const copy = candidate(ORIGINAL, 'fourmeme', {
    renownedWallets: 0, marketCapUsd: 1200000, liquidityUsd: 400000
  });
  const result = applyResolutionPolicy([dominant, copy], {
    extraction: extractContent({ text: 'Buy 币有', approvedAliases: ['币有'] }),
    allowedChains: ['bsc'],
    marketDominanceMinRatio: 2
  });
  assert.equal(result.selectedCandidate.contractAddress, RELAUNCH);
  assert.deepEqual(result.reasonCodes, ['MARKET_DOMINANT_VARIANT']);

  const unknownKol = applyResolutionPolicy([dominant, { ...copy, renownedWallets: null }], {
    extraction: extractContent({ text: 'Buy 币有', approvedAliases: ['币有'] }),
    allowedChains: ['bsc'],
    marketDominanceMinRatio: 2
  });
  assert.equal(unknownKol.status, 'ambiguous');
});

test('unknown provider or tradability fields fail closed', () => {
  const result = applyResolutionPolicy([candidate(ORIGINAL, 'fourmeme', {
    providerStatus: 'unknown', tradableStatus: 'unknown'
  })], {
    extraction: extractContent({ text: 'Buy 币有', approvedAliases: ['币有'] }),
    allowedChains: ['bsc']
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.PROVIDER_UNKNOWN);
});
