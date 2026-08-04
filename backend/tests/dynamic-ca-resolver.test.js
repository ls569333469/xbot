const assert = require('node:assert/strict');
const test = require('node:test');
const { CandidateIndex } = require('../domains/dynamic-signal/candidate-index');
const { resolveDynamicSignal } = require('../domains/dynamic-signal/ca-resolver');
const { RESOLUTION_CODES } = require('../domains/dynamic-signal/resolution-policy');

const CA = '0x39dbed3a2bd333467115de45665cc57f813c4571';

function verified(candidate) {
  return Promise.resolve({
    ...candidate,
    providerAddress: candidate.contractAddress,
    providerStatus: 'verified',
    tradableStatus: 'tradable',
    liquidityUsd: 100000
  });
}

test('resolver stops before provider calls when Intent Gate rejects the post', async () => {
  let calls = 0;
  const result = await resolveDynamicSignal({ text: 'Avoid $PONS', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: async () => { calls += 1; }
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.POLICY_BLOCKED);
  assert.equal(calls, 0);
  assert.equal(result.canTrade, false);
});

test('resolver verifies and resolves one exact symbol candidate without creating a trade', async () => {
  const result = await resolveDynamicSignal({ text: 'Buy $pons', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: verified
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.selectedCandidate.contractAddress, CA);
  assert.equal(result.candidateCoverage.provider_verified_count, 1);
  assert.equal(result.canTrade, false);
});

test('resolver handles a configured Chinese phrase with punctuation differences', async () => {
  const result = await resolveDynamicSignal({
    text: '何必东奔西走.币安全部都有!',
    approvedAliases: ['何必东奔西走，币安全部都有。'],
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name']
  }, {
    candidateIndex: new CandidateIndex([{
      chain: 'bsc', address: CA,
      name: '何必东奔西走 币安全部都有', symbol: '币有'
    }]),
    verifyCandidate: verified
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.intent.intentClass, 'approved_term_direct');
  assert.equal(result.selectedCandidate.contractAddress, CA);
  assert.ok(result.selectedCandidate.supportReasonCodes.includes('APPROVED_NAME_MATCH'));
  assert.equal(result.canTrade, false);
});

test('resolver defaults to the KOL-qualified market and liquidity dominance rule', async () => {
  const dominant = {
    chain: 'bsc', address: CA,
    name: '何必东奔西走 币安全部都有', symbol: '币有',
    renownedWallets: 72, marketCapUsd: 11_000_000, liquidityUsd: 400_000
  };
  const copy = {
    chain: 'bsc', address: '0xe9337dde3dd9e97f1f45a56412767ce5098e7777',
    name: '何必东奔西走 币安全部都有', symbol: '币有',
    renownedWallets: 20, marketCapUsd: 250_000, liquidityUsd: 80_000
  };
  const result = await resolveDynamicSignal({
    text: '何必东奔西走.币安全部都有!',
    approvedAliases: ['何必东奔西走，币安全部都有。'],
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name']
  }, {
    candidateIndex: new CandidateIndex([dominant, copy]),
    verifyCandidate: async (candidate) => ({
      ...candidate,
      providerAddress: candidate.contractAddress,
      providerStatus: 'verified',
      tradableStatus: 'tradable'
    })
  });
  assert.equal(result.status, 'resolved');
  assert.equal(result.selectedCandidate.contractAddress, CA);
  assert.deepEqual(result.reasonCodes, ['MARKET_DOMINANT_VARIANT']);
});

test('resolver keeps near-tied approved-name candidates ambiguous by default', async () => {
  const values = [
    { chain: 'bsc', address: CA, marketCapUsd: 1_000_000, liquidityUsd: 400_000 },
    { chain: 'bsc', address: '0xe9337dde3dd9e97f1f45a56412767ce5098e7777', marketCapUsd: 800_000, liquidityUsd: 300_000 }
  ].map((candidate) => ({
    ...candidate,
    name: '何必东奔西走 币安全部都有',
    symbol: '币有',
    renownedWallets: 5
  }));
  const result = await resolveDynamicSignal({
    text: '何必东奔西走.币安全部都有!',
    approvedAliases: ['何必东奔西走，币安全部都有。'],
    allowedChains: ['bsc'],
    allowedTermTypes: ['approved_name']
  }, {
    candidateIndex: new CandidateIndex(values),
    verifyCandidate: verified
  });
  assert.equal(result.status, 'ambiguous');
  assert.equal(result.failureCode, RESOLUTION_CODES.AMBIGUOUS);
});

test('resolver uses a direct EVM CA only when exactly one EVM chain is allowed', async () => {
  const exact = await resolveDynamicSignal({ text: CA, allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex(),
    verifyCandidate: verified
  });
  assert.equal(exact.status, 'resolved');
  assert.equal(exact.selectedCandidate.chainId, 'robinhood');

  const ambiguousChain = await resolveDynamicSignal({ text: CA, allowedChains: ['bsc', 'robinhood'] }, {
    candidateIndex: new CandidateIndex(),
    verifyCandidate: verified
  });
  assert.equal(ambiguousChain.status, 'not_found');
  assert.equal(ambiguousChain.failureCode, RESOLUTION_CODES.NOT_FOUND);
});

test('resolver maps provider timeouts to a fail-closed timeout code', async () => {
  const result = await resolveDynamicSignal({ text: 'Buy $PONS', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: async () => {
      const error = new Error('timeout');
      error.code = 'GMGN_REQUEST_TIMEOUT';
      throw error;
    }
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.PROVIDER_TIMEOUT);
  assert.equal(result.selectedCandidate, null);
});

test('fresh provider verification replaces a cached unknown candidate status', async () => {
  const result = await resolveDynamicSignal({ text: 'Buy $PONS', allowedChains: ['robinhood'] }, {
    candidateIndex: new CandidateIndex([{
      chain: 'robinhood', address: CA, symbol: 'PONS',
      providerStatus: 'unknown', tradableStatus: 'unknown',
      fetchedAt: '2026-08-02T12:00:00.000Z'
    }]),
    verifyCandidate: async (candidate) => ({
      ...candidate,
      providerAddress: candidate.contractAddress,
      providerStatus: 'verified',
      tradableStatus: 'untradable',
      security: { isSellable: false },
      liquidityUsd: 100000
    })
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.failureCode, RESOLUTION_CODES.UNTRADABLE);
  assert.equal(result.candidates[0].providerStatus, 'verified');
  assert.equal(result.candidates[0].tradableStatus, 'untradable');
  assert.deepEqual(result.candidates[0].rejectionReasonCodes, ['UNTRADABLE']);
});

test('resolver never uses a term type disabled by the actor policy', async () => {
  let calls = 0;
  const directCa = await resolveDynamicSignal({
    text: CA,
    allowedChains: ['robinhood'],
    allowedTermTypes: ['cashtag']
  }, {
    candidateIndex: new CandidateIndex(),
    verifyCandidate: async () => { calls += 1; return {}; }
  });
  assert.equal(directCa.status, 'not_found');
  assert.equal(directCa.selectedCandidate, null);

  const symbol = await resolveDynamicSignal({
    text: 'Buy $PONS',
    allowedChains: ['robinhood'],
    allowedTermTypes: ['ca']
  }, {
    candidateIndex: new CandidateIndex([{ chain: 'robinhood', address: CA, symbol: 'PONS' }]),
    verifyCandidate: async () => { calls += 1; return {}; }
  });
  assert.equal(symbol.status, 'not_found');
  assert.equal(symbol.selectedCandidate, null);
  assert.equal(calls, 0);
});
