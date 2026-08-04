const { candidateKey, normalizeCandidate } = require('./candidate-index');
const {
  normalizeApprovedNameMatchKey,
  normalizeName,
  normalizeSymbol
} = require('./content-extractor');

const RESOLUTION_CODES = Object.freeze({
  NOT_FOUND: 'DYNAMIC_CA_NOT_FOUND',
  WAITING_FOR_LAUNCH: 'DYNAMIC_CA_WAITING_FOR_LAUNCH',
  MULTIPLE: 'DYNAMIC_CA_MULTIPLE_CANDIDATES',
  AMBIGUOUS: 'DYNAMIC_CA_AMBIGUOUS_VARIANT',
  CONTEXT_MISMATCH: 'DYNAMIC_CA_CONTEXT_MISMATCH',
  PROVIDER_UNKNOWN: 'DYNAMIC_CA_PROVIDER_UNKNOWN',
  PROVIDER_TIMEOUT: 'DYNAMIC_CA_PROVIDER_TIMEOUT',
  UNTRADABLE: 'DYNAMIC_CA_UNTRADABLE',
  POLICY_BLOCKED: 'DYNAMIC_CA_POLICY_BLOCKED'
});

const PROMPT_INJECTION_PATTERN = /(?:ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|执行.*指令|忽略.*指令)/i;
const KNOWN_PLATFORMS = Object.freeze([
  'flap', 'fourmeme', 'pump.fun', 'pumpfun', 'noxa', 'bankr', 'virtuals',
  'clanker', 'zora', 'uniswap', 'pancakeswap', 'raydium', 'meteora', 'moonshot'
]);

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizedPlatform(value) {
  return normalizeName(value).replace(/[\s._-]+/g, '');
}

function explicitPlatforms(text, candidates) {
  const normalizedText = normalizedPlatform(text);
  return new Set([
    ...KNOWN_PLATFORMS,
    ...candidates.map((candidate) => candidate.launchpad)
  ]
    .filter(Boolean)
    .filter((platform) => normalizedText.includes(normalizedPlatform(platform)))
    .map(normalizedPlatform));
}

function directCaTerms(extraction) {
  return new Set((extraction?.authorOwnedTerms || [])
    .filter((term) => term.type === 'ca')
    .map((term) => term.normalized));
}

function termMatches(candidate, extraction) {
  const support = [];
  for (const term of extraction?.authorOwnedTerms || []) {
    if (term.type === 'ca' && term.normalized === candidate.contractAddress) {
      support.push('AUTHOR_CA_MATCH');
    } else if (['cashtag', 'hashtag'].includes(term.type)
        && normalizeSymbol(term.normalized) === candidate.symbol) {
      support.push('SYMBOL_MATCH');
    } else if (term.type === 'approved_name'
        && normalizeApprovedNameMatchKey(term.matchKey || term.normalized)
          === candidate.approvedNameMatchKey) {
      support.push('APPROVED_NAME_MATCH');
    }
  }
  return [...new Set(support)];
}

function providerAddressMismatch(candidate) {
  const providerAddress = String(
    candidate.providerAddress
      ?? candidate.provider_address
      ?? candidate.providerSnapshot?.info?.address
      ?? candidate.provider_snapshot?.info?.address
      ?? ''
  ).trim();
  if (!providerAddress) return false;
  const normalized = candidate.chainId === 'sol' ? providerAddress : providerAddress.toLowerCase();
  return normalized !== candidate.contractAddress;
}

function evaluateCandidate(value, context) {
  const candidate = normalizeCandidate(value);
  if (!candidate) return null;
  const rejectionReasonCodes = [];
  const supportReasonCodes = termMatches(candidate, context.extraction);
  const strongAnchorCodes = [...new Set(value.strongAnchorCodes || value.strong_anchor_codes || [])];

  if (context.allowedChains.size > 0 && !context.allowedChains.has(candidate.chainId)) {
    rejectionReasonCodes.push('CHAIN_NOT_ALLOWED');
  }
  if (providerAddressMismatch(candidate)) rejectionReasonCodes.push('PROVIDER_ADDRESS_MISMATCH');
  if (String(candidate.providerStatus || candidate.provider_status || 'unknown') !== 'verified') {
    rejectionReasonCodes.push('PROVIDER_NOT_VERIFIED');
  }
  const tradableStatus = String(candidate.tradableStatus || candidate.tradable_status || 'unknown');
  if (tradableStatus === 'untradable') rejectionReasonCodes.push('UNTRADABLE');
  if (tradableStatus === 'unknown') rejectionReasonCodes.push('TRADABILITY_UNKNOWN');
  if (candidate.security?.isHoneypot === true || candidate.security?.is_honeypot === true) {
    rejectionReasonCodes.push('HONEYPOT');
  }
  if (context.minLiquidityUsd !== null) {
    const liquidity = numberOrNull(candidate.liquidityUsd ?? candidate.liquidity_usd);
    if (liquidity === null) rejectionReasonCodes.push('LIQUIDITY_UNKNOWN');
    else if (liquidity < context.minLiquidityUsd) rejectionReasonCodes.push('LIQUIDITY_BELOW_POLICY');
  }
  const untrustedText = [candidate.name, candidate.symbol, candidate.description]
    .filter(Boolean).join(' ');
  if (PROMPT_INJECTION_PATTERN.test(untrustedText)) rejectionReasonCodes.push('METADATA_INSTRUCTION_TEXT');

  const directCas = context.directCas;
  if (directCas.has(candidate.contractAddress)) {
    const directTerm = (context.extraction?.authorOwnedTerms || []).find((term) => (
      term.type === 'ca' && term.normalized === candidate.contractAddress
    ));
    strongAnchorCodes.push(directTerm?.via === 'url' ? 'AUTHOR_URL_CA' : 'AUTHOR_FULL_CA');
  }
  const candidatePlatform = normalizedPlatform(candidate.launchpad);
  if (candidatePlatform && context.explicitPlatforms.has(candidatePlatform)) {
    supportReasonCodes.push('LAUNCHPAD_CONTEXT_MATCH');
  } else if (context.explicitPlatforms.size > 0) {
    rejectionReasonCodes.push('LAUNCHPAD_CONTEXT_MISMATCH');
  }
  const score = (strongAnchorCodes.includes('AUTHOR_FULL_CA') ? 100 : 0)
    + (strongAnchorCodes.includes('AUTHOR_URL_CA') ? 95 : 0)
    + (supportReasonCodes.includes('LAUNCHPAD_CONTEXT_MATCH') ? 40 : 0)
    + (supportReasonCodes.includes('SYMBOL_MATCH') ? 15 : 0)
    + (supportReasonCodes.includes('APPROVED_NAME_MATCH') ? 15 : 0);

  return {
    ...candidate,
    providerStatus: String(candidate.providerStatus || candidate.provider_status || 'unknown'),
    tradableStatus,
    strongAnchorCodes: [...new Set(strongAnchorCodes)],
    supportReasonCodes: [...new Set(supportReasonCodes)],
    rejectionReasonCodes: [...new Set(rejectionReasonCodes)],
    score
  };
}

function marketDominantCandidate(candidates, minimumLeadRatio) {
  if (!Number.isFinite(minimumLeadRatio) || minimumLeadRatio <= 1) return null;
  const candidatesWithKnownKol = candidates.filter((candidate) => (
    numberOrNull(candidate.renownedWallets ?? candidate.renowned_wallets) !== null
  ));
  if (candidatesWithKnownKol.length !== candidates.length) return null;
  const eligible = candidates.filter((candidate) => {
    const renowned = numberOrNull(candidate.renownedWallets ?? candidate.renowned_wallets);
    const marketCap = numberOrNull(candidate.marketCapUsd ?? candidate.market_cap_usd ?? candidate.market_cap);
    const liquidity = numberOrNull(candidate.liquidityUsd ?? candidate.liquidity_usd ?? candidate.liquidity);
    return renowned !== null && renowned >= 3
      && marketCap !== null && marketCap > 0
      && liquidity !== null && liquidity > 0;
  });
  if (eligible.length === 1) return eligible[0];
  if (eligible.length < 2) return null;
  const byMarketCap = [...eligible].sort((left, right) => (
    Number(right.marketCapUsd ?? right.market_cap_usd ?? right.market_cap)
      - Number(left.marketCapUsd ?? left.market_cap_usd ?? left.market_cap)
  ));
  const byLiquidity = [...eligible].sort((left, right) => (
    Number(right.liquidityUsd ?? right.liquidity_usd ?? right.liquidity)
      - Number(left.liquidityUsd ?? left.liquidity_usd ?? left.liquidity)
  ));
  if (candidateKey(byMarketCap[0]) !== candidateKey(byLiquidity[0])) return null;
  const marketLead = Number(byMarketCap[0].marketCapUsd ?? byMarketCap[0].market_cap_usd ?? byMarketCap[0].market_cap)
    / Number(byMarketCap[1].marketCapUsd ?? byMarketCap[1].market_cap_usd ?? byMarketCap[1].market_cap);
  const liquidityLead = Number(byLiquidity[0].liquidityUsd ?? byLiquidity[0].liquidity_usd ?? byLiquidity[0].liquidity)
    / Number(byLiquidity[1].liquidityUsd ?? byLiquidity[1].liquidity_usd ?? byLiquidity[1].liquidity);
  return marketLead >= minimumLeadRatio && liquidityLead >= minimumLeadRatio
    ? byMarketCap[0]
    : null;
}

function failureFromCandidates(candidates) {
  const rejections = new Set(candidates.flatMap((candidate) => candidate.rejectionReasonCodes));
  if (rejections.has('PROVIDER_ADDRESS_MISMATCH')) return RESOLUTION_CODES.CONTEXT_MISMATCH;
  if (rejections.has('LAUNCHPAD_CONTEXT_MISMATCH')) return RESOLUTION_CODES.CONTEXT_MISMATCH;
  if (rejections.has('UNTRADABLE') || rejections.has('HONEYPOT')
      || rejections.has('LIQUIDITY_BELOW_POLICY')) return RESOLUTION_CODES.UNTRADABLE;
  if (rejections.has('PROVIDER_NOT_VERIFIED') || rejections.has('TRADABILITY_UNKNOWN')
      || rejections.has('LIQUIDITY_UNKNOWN')) return RESOLUTION_CODES.PROVIDER_UNKNOWN;
  if (rejections.has('CHAIN_NOT_ALLOWED')) return RESOLUTION_CODES.POLICY_BLOCKED;
  return RESOLUTION_CODES.NOT_FOUND;
}

function applyResolutionPolicy(values = [], input = {}) {
  const candidates = (Array.isArray(values) ? values : []).map(normalizeCandidate).filter(Boolean);
  const context = {
    extraction: input.extraction || {},
    allowedChains: new Set((input.allowedChains || []).map((value) => String(value).toLowerCase())),
    directCas: directCaTerms(input.extraction),
    explicitPlatforms: explicitPlatforms(input.extraction?.actorText || '', candidates),
    minLiquidityUsd: input.minLiquidityUsd === undefined || input.minLiquidityUsd === null
      ? null
      : Number(input.minLiquidityUsd)
  };
  const evaluated = candidates.map((candidate) => evaluateCandidate(candidate, context)).filter(Boolean);
  const survivors = evaluated.filter((candidate) => candidate.rejectionReasonCodes.length === 0);
  if (survivors.length === 0) {
    return {
      status: evaluated.length === 0 ? 'not_found' : 'rejected',
      failureCode: evaluated.length === 0 ? RESOLUTION_CODES.NOT_FOUND : failureFromCandidates(evaluated),
      selectedCandidate: null,
      confidence: 'unknown',
      reasonCodes: [],
      candidates: evaluated
    };
  }

  const direct = survivors.filter((candidate) => (
    candidate.strongAnchorCodes.includes('AUTHOR_FULL_CA')
      || candidate.strongAnchorCodes.includes('AUTHOR_URL_CA')
  ));
  if (direct.length === 1) {
    const reason = direct[0].strongAnchorCodes.includes('AUTHOR_URL_CA')
      ? 'AUTHOR_URL_CA'
      : 'AUTHOR_FULL_CA';
    return {
      status: 'resolved',
      failureCode: null,
      selectedCandidate: direct[0],
      confidence: 'verified',
      reasonCodes: [reason],
      candidates: evaluated
    };
  }

  const platformMatches = survivors.filter((candidate) => (
    candidate.supportReasonCodes.includes('LAUNCHPAD_CONTEXT_MATCH')
  ));
  if (platformMatches.length === 1) {
    return {
      status: 'resolved',
      failureCode: null,
      selectedCandidate: platformMatches[0],
      confidence: 'high',
      reasonCodes: ['UNIQUE_LAUNCHPAD_CONTEXT'],
      candidates: evaluated
    };
  }

  if (survivors.length === 1) {
    return {
      status: 'resolved',
      failureCode: null,
      selectedCandidate: survivors[0],
      confidence: 'medium',
      reasonCodes: ['UNIQUE_VERIFIED_VARIANT'],
      candidates: evaluated
    };
  }

  const dominant = marketDominantCandidate(survivors, Number(input.marketDominanceMinRatio));
  if (dominant) {
    return {
      status: 'resolved',
      failureCode: null,
      selectedCandidate: dominant,
      confidence: 'low',
      reasonCodes: ['MARKET_DOMINANT_VARIANT'],
      candidates: evaluated
    };
  }
  return {
    status: 'ambiguous',
    failureCode: RESOLUTION_CODES.AMBIGUOUS,
    selectedCandidate: null,
    confidence: 'unknown',
    reasonCodes: ['MULTIPLE_LEGAL_VARIANTS'],
    candidates: evaluated
  };
}

module.exports = {
  PROMPT_INJECTION_PATTERN,
  KNOWN_PLATFORMS,
  RESOLUTION_CODES,
  applyResolutionPolicy,
  evaluateCandidate,
  marketDominantCandidate,
  normalizedPlatform
};
