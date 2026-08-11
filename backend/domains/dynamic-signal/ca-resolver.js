const { extractContent } = require('./content-extractor');
const { classifyIntent } = require('./intent-gate');
const {
  candidateKey,
  mergeCandidate,
  normalizeCandidate,
  normalizeChain
} = require('./candidate-index');
const { RESOLUTION_CODES, applyResolutionPolicy } = require('./resolution-policy');
const { resolveContractChain } = require('../../lib/contract-chain-resolver');

const RESOLVER_REVISION = 'p25-deterministic-chain-v1';
const DEFAULT_MAX_CANDIDATES = 25;
const DEFAULT_VERIFY_CONCURRENCY = 4;
const DEFAULT_MARKET_DOMINANCE_MIN_RATIO = 2;

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

function transientCandidates(extraction, allowedChains, options = {}) {
  const chains = [...new Set((allowedChains || []).map(normalizeChain).filter(Boolean))];
  const evmChains = chains.filter((chain) => chain !== 'sol');
  const candidates = [];
  for (const term of extraction.authorOwnedTerms.filter((item) => item.type === 'ca')) {
    if (term.addressType === 'sol' && chains.includes('sol')) {
      candidates.push({ chainId: 'sol', contractAddress: term.normalized, sources: ['tweet_ca'],
        localEventCa: true, providerStatus: 'local_event', tradableStatus: 'unknown' });
    } else if (options.includeEvm !== false && term.addressType === 'evm' && evmChains.length === 1) {
      candidates.push({ chainId: evmChains[0], contractAddress: term.normalized, sources: ['tweet_ca'],
        localEventCa: true, providerStatus: 'local_event', tradableStatus: 'unknown' });
    }
  }
  return candidates;
}

function directEvmTerms(extraction) {
  return [...new Set((extraction.authorOwnedTerms || [])
    .filter((term) => term.type === 'ca' && term.addressType === 'evm')
    .map((term) => term.normalized))];
}

function chainFailureCode(resolutions = []) {
  if (resolutions.some((item) => item.status === 'unavailable')) {
    return RESOLUTION_CODES.CHAIN_UNAVAILABLE;
  }
  if (resolutions.some((item) => item.status === 'ambiguous')) {
    return RESOLUTION_CODES.CHAIN_AMBIGUOUS;
  }
  if (resolutions.some((item) => item.status === 'not_allowed')) {
    return RESOLUTION_CODES.POLICY_BLOCKED;
  }
  return RESOLUTION_CODES.NOT_FOUND;
}

async function resolveUnknownEvmCandidates(extraction, allowedChains, indexedCandidates, dependencies) {
  const candidates = [];
  const resolutions = [];
  const resolver = dependencies.resolveContractChain || resolveContractChain;
  for (const address of directEvmTerms(extraction)) {
    const indexed = indexedCandidates.filter((candidate) => candidate.contractAddress === address);
    if (indexed.length > 0) continue;
    const resolution = await resolver(address, allowedChains, dependencies.chainResolutionOptions || {});
    resolutions.push(resolution);
    if (resolution.status === 'resolved') {
      candidates.push({
        chainId: resolution.chainId,
        contractAddress: resolution.contractAddress,
        sources: ['tweet_ca', 'rpc_contract_code'],
        localEventCa: true,
        chainResolutionSource: resolution.source,
        providerStatus: 'local_rpc',
        tradableStatus: 'unknown'
      });
    }
  }
  return { candidates, resolutions };
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
  const fastLive = String(input.executionMode || input.mode || '').toLowerCase() === 'live'
    && input.fullVerification !== true;
  const resolutionExtraction = filterResolutionTerms(
    extraction,
    input.allowedTermTypes ?? input.allowed_term_types
  );
  const indexResult = dependencies.candidateIndex
    ? dependencies.candidateIndex.lookupTerms(resolutionExtraction.authorOwnedTerms, { allowedChains })
    : { candidates: [], coverage: {} };
  const indexedCandidates = (indexResult.candidates || []).map((candidate) => ({
    ...candidate,
    ...(fastLive ? {
      localIndexCandidate: true,
      chainResolutionSource: 'candidate_index'
    } : {})
  }));
  const chainResolution = fastLive
    ? await resolveUnknownEvmCandidates(
      resolutionExtraction,
      allowedChains,
      indexedCandidates,
      dependencies
    )
    : { candidates: [], resolutions: [] };
  const candidates = mergeCandidates([
    ...indexedCandidates,
    ...transientCandidates(resolutionExtraction, allowedChains, { includeEvm: !fastLive }),
    ...chainResolution.candidates
  ]);
  const maxCandidates = Math.max(1, Number(input.maxCandidates || DEFAULT_MAX_CANDIDATES));
  if (candidates.length === 0) {
    return {
      ...base,
      status: 'not_found',
      failureCode: chainFailureCode(chainResolution.resolutions),
      candidates: [],
      selectedCandidate: null,
      chainResolution: chainResolution.resolutions,
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

  if (fastLive) {
    const policy = applyResolutionPolicy(candidates, {
      extraction: resolutionExtraction,
      allowedChains,
      allowDeterministicLocalCandidate: true
    });
    return {
      ...base,
      mode: 'live',
      canTrade: policy.status === 'resolved',
      ...policy,
      chainResolution: chainResolution.resolutions,
      candidateCoverage: {
        ...indexResult.coverage,
        candidate_count: candidates.length,
        provider_verified_count: 0,
        local_event_ca_count: candidates.filter((candidate) => candidate.localEventCa).length
      },
      timing: { total_ms: Date.now() - startedAt }
    };
  }

  const verifier = dependencies.verifyCandidate;
  if (typeof verifier !== 'function') {
    const policy = applyResolutionPolicy(candidates, {
      extraction: resolutionExtraction,
      allowedChains,
      allowDeterministicLocalCandidate: true
    });
    return {
      ...base,
      ...policy,
      canTrade: false,
      candidateCoverage: {
        ...indexResult.coverage,
        candidate_count: candidates.length,
        provider_verified_count: 0,
        local_event_ca_count: candidates.filter((candidate) => candidate.localEventCa).length
      },
      timing: { total_ms: Date.now() - startedAt }
    };
  }
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
        const verifiedCandidate = normalizeCandidate(
          await verifier(candidate, input.verificationOptions || {})
        );
        if (!verifiedCandidate) {
          const error = new Error('Provider returned an invalid dynamic candidate');
          error.code = 'GMGN_SCHEMA_INVALID';
          throw error;
        }
        return verifiedCandidate;
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
      ?? DEFAULT_MARKET_DOMINANCE_MIN_RATIO
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
  DEFAULT_MARKET_DOMINANCE_MIN_RATIO,
  DEFAULT_VERIFY_CONCURRENCY,
  RESOLVER_REVISION,
  mapConcurrent,
  mergeCandidates,
  providerFailureCode,
  chainFailureCode,
  directEvmTerms,
  filterResolutionTerms,
  resolveUnknownEvmCandidates,
  resolveDynamicSignal,
  transientCandidates
};
