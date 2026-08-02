const { extractContent } = require('./content-extractor');
const { classifyIntent } = require('./intent-gate');
const {
  candidateKey,
  mergeCandidate,
  normalizeCandidate,
  normalizeChain
} = require('./candidate-index');
const { RESOLUTION_CODES, applyResolutionPolicy } = require('./resolution-policy');

const RESOLVER_REVISION = 'p20.1-resolver-v1';
const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_VERIFY_CONCURRENCY = 4;

function filterResolutionTerms(extraction, allowedTermTypes) {
  if (!Array.isArray(allowedTermTypes)) return extraction;
  const allowed = new Set(allowedTermTypes.map((value) => String(value || '').toLowerCase()));
  const authorOwnedTerms = (extraction.authorOwnedTerms || [])
    .filter((term) => allowed.has(String(term.type || '').toLowerCase()));
  return {
    ...extraction,
    authorOwnedTerms,
    assetTerms: authorOwnedTerms.filter((term) => (
      ['ca', 'cashtag', 'hashtag', 'approved_name'].includes(term.type)
    ))
  };
}

function transientCandidates(extraction, allowedChains) {
  const chains = [...new Set((allowedChains || []).map(normalizeChain).filter(Boolean))];
  const evmChains = chains.filter((chain) => chain !== 'sol');
  const candidates = [];
  for (const term of extraction.authorOwnedTerms.filter((item) => item.type === 'ca')) {
    if (term.addressType === 'sol' && chains.includes('sol')) {
      candidates.push({ chainId: 'sol', contractAddress: term.normalized, sources: ['tweet_ca'] });
    } else if (term.addressType === 'evm' && evmChains.length === 1) {
      candidates.push({ chainId: evmChains[0], contractAddress: term.normalized, sources: ['tweet_ca'] });
    }
  }
  return candidates;
}

function mergeCandidates(values) {
  const merged = new Map();
  for (const value of values) {
    const candidate = normalizeCandidate(value);
    if (!candidate) continue;
    const key = candidateKey(candidate);
    merged.set(key, merged.has(key) ? mergeCandidate(merged.get(key), candidate) : candidate);
  }
  return [...merged.values()];
}

async function mapConcurrent(values, concurrency, mapper) {
  const results = new Array(values.length);
  let next = 0;
  async function worker() {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index], index);
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(Math.max(1, concurrency), Math.max(1, values.length)) },
    worker
  ));
  return results;
}

function providerFailureCode(error) {
  const code = String(error?.code || '').toUpperCase();
  if (code.includes('TIMEOUT')) return RESOLUTION_CODES.PROVIDER_TIMEOUT;
  return RESOLUTION_CODES.PROVIDER_UNKNOWN;
}

async function resolveDynamicSignal(input = {}, dependencies = {}) {
  const startedAt = Date.now();
  const extraction = dependencies.extractContent
    ? dependencies.extractContent(input)
    : extractContent(input);
  const intent = dependencies.classifyIntent
    ? dependencies.classifyIntent(extraction)
    : classifyIntent(extraction);
  const base = {
    mode: 'readonly',
    canTrade: false,
    resolverRevision: RESOLVER_REVISION,
    extraction,
    intent
  };
  if (!intent.canProceedToResolution) {
    return {
      ...base,
      status: 'rejected',
      failureCode: RESOLUTION_CODES.POLICY_BLOCKED,
      candidates: [],
      selectedCandidate: null,
      candidateCoverage: {
        indexed_term_count: 0,
        asset_term_count: extraction.authorOwnedTerms.filter((term) => term.type !== 'x_handle').length,
        matched_asset_term_count: 0,
        candidate_count: 0,
        ratio: 0,
        complete: false
      },
      timing: { total_ms: Date.now() - startedAt }
    };
  }

  const allowedChains = [...new Set((input.allowedChains || input.allowed_chain_ids || [])
    .map(normalizeChain).filter(Boolean))];
  const resolutionExtraction = filterResolutionTerms(
    extraction,
    input.allowedTermTypes ?? input.allowed_term_types
  );
  const indexResult = dependencies.candidateIndex
    ? dependencies.candidateIndex.lookupTerms(resolutionExtraction.authorOwnedTerms, { allowedChains })
    : { candidates: [], coverage: {} };
  const candidates = mergeCandidates([
    ...(indexResult.candidates || []),
    ...transientCandidates(resolutionExtraction, allowedChains)
  ]);
  const maxCandidates = Math.max(1, Number(input.maxCandidates || DEFAULT_MAX_CANDIDATES));
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'not_found',
      failureCode: RESOLUTION_CODES.NOT_FOUND,
      candidates: [],
      selectedCandidate: null,
      candidateCoverage: { ...indexResult.coverage, candidate_count: 0 },
      timing: { total_ms: Date.now() - startedAt }
    };
  }
  if (candidates.length > maxCandidates) {
    return {
      ...base,
      status: 'ambiguous',
      failureCode: RESOLUTION_CODES.MULTIPLE,
      candidates,
      selectedCandidate: null,
      candidateCoverage: { ...indexResult.coverage, candidate_count: candidates.length },
      timing: { total_ms: Date.now() - startedAt }
    };
  }

  const verifier = dependencies.verifyCandidate
    || require('./gmgn-market-source').verifyCandidate;
  const verificationStartedAt = Date.now();
  let firstProviderFailure = null;
  const verified = await mapConcurrent(
    candidates,
    Number(input.verifyConcurrency || DEFAULT_VERIFY_CONCURRENCY),
    async (candidate) => {
      if (candidate.providerStatus === 'verified' && candidate.tradableStatus !== 'unknown') {
        return candidate;
      }
      try {
        return mergeCandidates([candidate, await verifier(candidate, input.verificationOptions || {})])[0];
      } catch (error) {
        if (!firstProviderFailure) firstProviderFailure = error;
        return {
          ...candidate,
          providerStatus: 'error',
          tradableStatus: 'unknown',
          providerErrorCode: String(error.code || 'GMGN_PROVIDER_ERROR')
        };
      }
    }
  );
  const policy = applyResolutionPolicy(verified, {
    extraction: resolutionExtraction,
    allowedChains,
    minLiquidityUsd: input.minLiquidityUsd,
    marketDominanceMinRatio: input.marketDominanceMinRatio
  });
  const failureCode = policy.failureCode === RESOLUTION_CODES.PROVIDER_UNKNOWN && firstProviderFailure
    ? providerFailureCode(firstProviderFailure)
    : policy.failureCode;
  return {
    ...base,
    ...policy,
    failureCode,
    candidateCoverage: {
      ...indexResult.coverage,
      candidate_count: verified.length,
      provider_verified_count: verified.filter((candidate) => candidate.providerStatus === 'verified').length
    },
    timing: {
      verification_ms: Date.now() - verificationStartedAt,
      total_ms: Date.now() - startedAt
    }
  };
}

module.exports = {
  DEFAULT_MAX_CANDIDATES,
  DEFAULT_VERIFY_CONCURRENCY,
  RESOLVER_REVISION,
  mapConcurrent,
  mergeCandidates,
  providerFailureCode,
  filterResolutionTerms,
  resolveDynamicSignal,
  transientCandidates
};
