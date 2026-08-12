const { extractTextTerms } = require('../dynamic-signal/content-extractor');
const { normalizeXHandle } = require('../../lib/x-handles');
const { resolveContractChain } = require('../../lib/contract-chain-resolver');
const { candidateHasExplicitChainEvidence, researchFollowTarget } = require('./grok-researcher');
const { followError } = require('./errors');

const EVM_CHAINS = new Set(['bsc', 'base', 'eth', 'robinhood']);
const PERSONNEL_ROLE_TYPES = new Set([
  'founder', 'co_founder', 'ceo', 'executive', 'core_contributor', 'team_member'
]);

function rejected(code, message) {
  const error = followError(code, message);
  error.rejected = true;
  return error;
}

function isPersonnelIdentity(classification = {}) {
  return classification.classification === 'person'
    && (classification.role_types || []).some((role) => PERSONNEL_ROLE_TYPES.has(role));
}

function isProjectIdentity(classification = {}) {
  return classification.classification === 'project'
    || (classification.role_types || []).includes('official_project');
}

function providerWait(error) {
  const code = String(error?.code || '');
  return error?.retryable === true || code.includes('RATE_LIMIT') || code.includes('DEADLINE')
    || code.includes('TIMEOUT') || code.includes('UNAVAILABLE');
}

function websiteOrigin(value) {
  try { return new URL(String(value)).origin.toLowerCase(); } catch { return null; }
}

function uniqueCaTerms(sources) {
  const seen = new Set();
  const output = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    for (const term of extractTextTerms(source.text, source.type).filter((item) => item.type === 'ca')) {
      const key = `${term.addressType}:${term.normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      output.push({
        ...term,
        source: source.type,
        source_ref: source.ref,
        owner_owned: source.owner_owned !== false,
        association: source.association || null
      });
    }
  }
  return output;
}

function candidateInputs(term, allowedChains, preferredChain = '') {
  const allowed = Array.isArray(allowedChains) ? allowedChains : [];
  if (preferredChain && !allowed.includes(preferredChain)) return [];
  if (term.addressType === 'sol') {
    return allowed.includes('sol') && (!preferredChain || preferredChain === 'sol')
      ? [{ chainId: 'sol', contractAddress: term.normalized }]
      : [];
  }
  return allowed.filter((chain) => EVM_CHAINS.has(chain)
    && (!preferredChain || preferredChain === chain))
    .map((chainId) => ({ chainId, contractAddress: term.normalized }));
}

function sourceRef(source) {
  return source?.url || (source?.tweet_id ? `https://x.com/i/status/${source.tweet_id}` : null);
}

function sourceMatchesCandidate(candidate, evidence) {
  if (!candidate || !evidence) return false;
  if (candidate.source_url && evidence.url && candidate.source_url !== evidence.url) return false;
  if (candidate.source_tweet_id && evidence.tweet_id
      && candidate.source_tweet_id !== evidence.tweet_id) return false;
  if (['original_post', 'x_post'].includes(evidence.source_type)) {
    try {
      const parsed = new URL(evidence.url);
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (!['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(parsed.hostname.toLowerCase())
          || parts.length < 3
          || parts[1].toLowerCase() !== 'status' || parts[2] !== String(evidence.tweet_id)) return false;
    } catch {
      return false;
    }
  }
  const terms = extractTextTerms(`${candidate.source_excerpt || ''}\n${evidence.excerpt || ''}`, 'grok_x_search')
    .filter((term) => term.type === 'ca');
  const address = String(candidate.address || '').trim();
  return terms.some((term) => term.addressType === 'sol'
    ? term.normalized === address
    : term.normalized === address.toLowerCase())
    && candidate.evidence_ids.includes(evidence.evidence_id);
}

function parsePublishedAt(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeResearchEvidence(research) {
  return (Array.isArray(research?.evidence) ? research.evidence : [])
    .map((item) => ({
      type: ['original_post', 'x_post'].includes(item.source_type) ? 'grok_original_post' : `grok_${item.source_type}`,
      ref: sourceRef(item),
      tweet_id: item.tweet_id || null,
      handle: item.handle || null,
      published_at: item.published_at || null,
      excerpt: item.excerpt || null
    }))
    .filter((item) => item.ref || item.excerpt);
}

function candidateSources(research, candidate) {
  const evidence = Array.isArray(research?.evidence) ? research.evidence : [];
  const ids = new Set(Array.isArray(candidate?.evidence_ids) ? candidate.evidence_ids : []);
  const matches = evidence.filter((item) => ids.has(item.evidence_id));
  return matches.sort((left, right) => {
    const leftPrimary = candidate.source_url && left.url === candidate.source_url ? 2 : 0;
    const rightPrimary = candidate.source_url && right.url === candidate.source_url ? 2 : 0;
    const leftTweet = candidate.source_tweet_id && left.tweet_id === candidate.source_tweet_id ? 1 : 0;
    const rightTweet = candidate.source_tweet_id && right.tweet_id === candidate.source_tweet_id ? 1 : 0;
    return (rightPrimary + rightTweet) - (leftPrimary + leftTweet);
  });
}

function normalizeResearchCandidates(research, event, acceptedHandles, options = {}) {
  const followedAt = parsePublishedAt(event.provider_created_at);
  const output = [];
  for (const candidate of Array.isArray(research?.candidates) ? research.candidates : []) {
    const owner = normalizeXHandle(candidate.owner_handle);
    if (!owner || !acceptedHandles.has(owner)) continue;
    if (options.requireChainEvidence !== false
        && !candidateHasExplicitChainEvidence(candidate, research.evidence)) continue;
    for (const evidence of candidateSources(research, candidate)) {
      if (!sourceMatchesCandidate(candidate, evidence)) continue;
      const publishedAt = parsePublishedAt(candidate.published_at || evidence.published_at);
      if (followedAt !== null && publishedAt !== null && publishedAt > followedAt) continue;
      const extracted = uniqueCaTerms([{ type: 'grok_x_search', ref: sourceRef(evidence),
        text: `${candidate.source_excerpt || ''}\n${evidence.excerpt || ''}`,
        owner_owned: true, association: { owner_handle: owner, evidence_id: evidence.evidence_id } }]);
      const exact = extracted.find((term) => term.addressType === 'sol'
        ? term.normalized === String(candidate.address).trim()
        : term.normalized === String(candidate.address).trim().toLowerCase());
      if (!exact) continue;
      output.push({ ...exact, chain_id: candidate.chain_id, owner_handle: owner,
        evidence_id: evidence.evidence_id, published_at: publishedAt });
      break;
    }
  }
  return output;
}

async function resolveFollowEvent(event, dependencies = {}) {
  const onStage = dependencies.onStage || (async () => {});
  await onStage('grok_search');
  const research = await (dependencies.researchFollowTarget || researchFollowTarget)({
    target_handle: event.target_handle,
    target_user_id: event.target_user_id,
    followed_at: event.provider_created_at,
    allowed_chain_ids: event.allowed_chain_ids || []
  }, dependencies.xaiOptions || {});
  const classification = research.target_identity || { classification: 'uncertain', confidence: 'low', role_types: [] };
  const relatedAccounts = (research.related_project_accounts || []).map((account) => ({
    handle: account.handle,
    profile: { handle: account.handle, name: account.display_name, description: '' },
    classification: { classification: 'project', role_types: ['official_project'], confidence: account.confidence,
      reasons: [`Grok x_search relationship: ${account.relationship}`] },
    relationship: { type: 'grok_verified_person_project', target_handle: normalizeXHandle(event.target_handle),
      evidence_ids: account.evidence_ids, relationship: account.relationship }
  }));
  const acceptedHandles = new Set([
    normalizeXHandle(event.target_handle), ...relatedAccounts.map((account) => normalizeXHandle(account.handle))
  ]);
  const personnel = isPersonnelIdentity(classification);
  if (!isProjectIdentity(classification) && !personnel) {
    throw rejected('FOLLOW_ACCOUNT_NOT_PROJECT', 'Grok did not verify the target as a project or project personnel account');
  }
  if (personnel && relatedAccounts.length === 0) {
    throw rejected('FOLLOW_PROJECT_RELATION_NOT_VERIFIED', 'Grok did not find a verified official project account for the personnel target');
  }
  const addressBackedCandidates = normalizeResearchCandidates(
    research, event, acceptedHandles, { requireChainEvidence: false }
  );
  if (!addressBackedCandidates.length) {
    throw rejected('FOLLOW_CA_NOT_FOUND', 'Grok x_search found no author-owned full contract address');
  }
  const uniqueAddresses = [...new Map(addressBackedCandidates.map((term) => (
    [`${term.addressType}:${term.normalized}`, term]
  ))).values()];
  if (uniqueAddresses.length > 1) {
    throw rejected('FOLLOW_CA_AMBIGUOUS', 'Multiple Grok contract candidates remain');
  }

  await onStage('chain_resolution');
  const term = uniqueAddresses[0];
  const chainResolution = await (dependencies.resolveContractChain || resolveContractChain)(
    term.normalized,
    event.allowed_chain_ids || [],
    dependencies.chainResolverOptions || {}
  );
  if (chainResolution.status === 'unavailable') {
    const error = followError('FOLLOW_CHAIN_RPC_UNAVAILABLE',
      'One or more chain RPCs could not prove the contract chain', { retryable: true });
    error.details = chainResolution;
    throw error;
  }
  if (chainResolution.status === 'ambiguous') {
    throw rejected('FOLLOW_CA_CHAIN_AMBIGUOUS', 'The contract is deployed on multiple allowed chains');
  }
  if (chainResolution.status !== 'resolved') {
    throw rejected('FOLLOW_CA_CHAIN_UNRESOLVED', 'No allowed chain RPC contains the discovered contract');
  }

  const selected = {
    chainId: chainResolution.chainId,
    contractAddress: chainResolution.contractAddress,
    source: 'grok_x_search',
    sources: ['grok_x_search', chainResolution.source],
    source_ref: `evidence:${term.evidence_id}`,
    owner_handle: term.owner_handle,
    published_at: term.published_at,
    evidence_id: term.evidence_id,
    providerStatus: 'local_event',
    tradableStatus: 'unknown',
    localEventCa: true,
    accepted: true,
    localEvidence: {
      source: 'grok_x_search',
      evidence_id: term.evidence_id,
      owner_handle: term.owner_handle,
      published_at: term.published_at,
      grok_chain_hint: term.chain_id || null,
      chain_resolution: chainResolution
    }
  };
  const candidateAudit = [selected];
  const personnelAssociation = relatedAccounts.length > 0 && personnel;
  const projectAccount = relatedAccounts[0] || null;
  return {
    profile: { handle: normalizeXHandle(event.target_handle), id: String(event.target_user_id),
      classification, research_summary: research.summary,
      project_name: projectAccount?.profile?.name || research.project_name || null,
      project_handle: projectAccount?.handle || normalizeXHandle(event.target_handle) },
    relatedAccounts: relatedAccounts.map((account) => ({
      handle: account.handle, profile: account.profile, classification: account.classification,
      relationship: account.relationship
    })),
    classification: { ...classification,
      deterministic: personnelAssociation ? 'personnel_associated_project' : 'project',
      deterministic_reason: personnelAssociation
        ? 'grok_person_project_search_with_rpc_chain_resolution'
        : 'grok_project_search_with_rpc_chain_resolution' },
    evidence: normalizeResearchEvidence(research),
    websiteEvidence: (research.citations || []).filter((url) => !/^(?:https?:\/\/)?(?:www\.)?x\.com\//i.test(url)),
    candidates: candidateAudit,
    selected,
    research
  };
}

module.exports = { candidateInputs, providerWait, resolveFollowEvent, uniqueCaTerms, websiteOrigin,
  normalizeResearchCandidates, sourceMatchesCandidate };
