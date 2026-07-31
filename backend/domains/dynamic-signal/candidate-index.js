const { normalizeName, normalizeSymbol } = require('./content-extractor');
const { normalizeXHandle } = require('../../lib/x-handles');

const CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood']);

function normalizeChain(value) {
  const chain = String(value || '').trim().toLowerCase();
  return CHAIN_IDS.has(chain) ? chain : null;
}

function normalizeAddress(chainId, value) {
  const address = String(value || '').trim();
  if (!address) return null;
  return chainId === 'sol' ? address : address.toLowerCase();
}

function candidateKey(candidate) {
  return `${candidate.chainId}:${candidate.contractAddress}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
}

function normalizeCandidate(value = {}) {
  const chainId = normalizeChain(value.chainId ?? value.chain_id ?? value.chain);
  const contractAddress = normalizeAddress(
    chainId,
    value.contractAddress ?? value.contract_address ?? value.address ?? value.token_address
  );
  if (!chainId || !contractAddress) return null;
  return {
    ...value,
    id: value.id ?? value.variantId ?? value.variant_id ?? null,
    variantId: value.variantId ?? value.variant_id ?? value.id ?? null,
    assetFamilyId: value.assetFamilyId ?? value.asset_family_id ?? null,
    assetFamilyKey: value.assetFamilyKey ?? value.asset_family_key ?? null,
    chainId,
    contractAddress,
    symbol: normalizeSymbol(value.symbol),
    name: String(value.name || '').normalize('NFKC').trim(),
    normalizedName: normalizeName(value.normalizedName || value.name),
    launchpad: normalizeName(value.launchpad ?? value.launchpad_platform),
    xHandles: [...new Set(asArray(
      value.xHandles ?? value.x_handles ?? value.officialXHandles ?? value.official_x_handles
    ).map(normalizeXHandle).filter(Boolean))],
    sourcePostIds: [...new Set(asArray(value.sourcePostIds ?? value.source_post_ids).map(String).filter(Boolean))],
    sources: [...new Set(asArray(value.sources ?? value.sourceTypes ?? value.source_types ?? value.source).map(String).filter(Boolean))],
    fetchedAt: value.fetchedAt ?? value.fetched_at ?? null,
    expiresAt: value.expiresAt ?? value.expires_at ?? null
  };
}

function mergeCandidate(left, right) {
  const rightIsNewer = Date.parse(right.fetchedAt || 0) > Date.parse(left.fetchedAt || 0);
  const preferred = rightIsNewer ? right : left;
  const fallback = rightIsNewer ? left : right;
  return {
    ...fallback,
    ...preferred,
    id: left.id ?? right.id,
    variantId: left.variantId ?? right.variantId,
    assetFamilyId: left.assetFamilyId ?? right.assetFamilyId,
    assetFamilyKey: left.assetFamilyKey ?? right.assetFamilyKey,
    sources: [...new Set([...left.sources, ...right.sources])],
    xHandles: [...new Set([...left.xHandles, ...right.xHandles])],
    sourcePostIds: [...new Set([...left.sourcePostIds, ...right.sourcePostIds])]
  };
}

function isFresh(candidate, now) {
  if (!candidate.expiresAt) return true;
  const expiresAt = Date.parse(candidate.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

class CandidateIndex {
  constructor(values = []) {
    this.candidates = new Map();
    this.index = new Map();
    this.replace(values);
  }

  replace(values) {
    this.candidates.clear();
    this.index.clear();
    for (const value of values) {
      const candidate = normalizeCandidate(value);
      if (!candidate) continue;
      const key = candidateKey(candidate);
      this.candidates.set(key, this.candidates.has(key)
        ? mergeCandidate(this.candidates.get(key), candidate)
        : candidate);
    }
    for (const candidate of this.candidates.values()) this._indexCandidate(candidate);
    return this;
  }

  _add(type, value, key) {
    if (!value) return;
    const indexKey = `${type}:${value}`;
    if (!this.index.has(indexKey)) this.index.set(indexKey, new Set());
    this.index.get(indexKey).add(key);
  }

  _indexCandidate(candidate) {
    const key = candidateKey(candidate);
    this._add('symbol', candidate.symbol, key);
    this._add('name', candidate.normalizedName, key);
    this._add('launchpad', candidate.launchpad, key);
    this._add('chain_ca', key, key);
    for (const handle of candidate.xHandles) this._add('x_handle', handle, key);
    for (const postId of candidate.sourcePostIds) this._add('source_post_id', postId, key);
  }

  _lookupKeys(type, value) {
    return [...(this.index.get(`${type}:${value}`) || [])];
  }

  getByChainAddress(chainId, address, options = {}) {
    const chain = normalizeChain(chainId);
    const normalized = normalizeAddress(chain, address);
    const candidate = chain && normalized ? this.candidates.get(`${chain}:${normalized}`) : null;
    return candidate && isFresh(candidate, options.now ?? Date.now()) ? candidate : null;
  }

  lookupTerms(terms = [], options = {}) {
    const now = options.now ?? Date.now();
    const allowedChains = new Set((options.allowedChains || []).map(normalizeChain).filter(Boolean));
    const selected = new Map();
    const matchedTermKeys = new Set();
    const indexedTerms = (Array.isArray(terms) ? terms : []).filter((term) => (
      ['ca', 'cashtag', 'hashtag', 'approved_name', 'x_handle'].includes(term.type)
    ));

    indexedTerms.forEach((term, termIndex) => {
      let keys = [];
      if (term.type === 'ca') {
        keys = [...this.candidates.keys()].filter((key) => key.endsWith(`:${term.normalized}`));
      } else if (['cashtag', 'hashtag'].includes(term.type)) {
        keys = this._lookupKeys('symbol', normalizeSymbol(term.normalized));
      } else if (term.type === 'approved_name') {
        keys = this._lookupKeys('name', normalizeName(term.normalized));
      } else if (term.type === 'x_handle') {
        keys = this._lookupKeys('x_handle', normalizeXHandle(term.normalized));
      }
      let matched = false;
      for (const key of keys) {
        const candidate = this.candidates.get(key);
        if (!candidate || !isFresh(candidate, now)) continue;
        if (allowedChains.size > 0 && !allowedChains.has(candidate.chainId)) continue;
        selected.set(key, candidate);
        matched = true;
      }
      if (matched) matchedTermKeys.add(`${termIndex}:${term.type}:${term.normalized}`);
    });

    const assetTermCount = indexedTerms.filter((term) => term.type !== 'x_handle').length;
    const matchedAssetCount = [...matchedTermKeys]
      .filter((key) => !key.includes(':x_handle:')).length;
    return {
      candidates: [...selected.values()],
      coverage: {
        indexed_term_count: indexedTerms.length,
        asset_term_count: assetTermCount,
        matched_asset_term_count: matchedAssetCount,
        candidate_count: selected.size,
        ratio: assetTermCount === 0 ? 0 : matchedAssetCount / assetTermCount,
        complete: assetTermCount > 0 && matchedAssetCount === assetTermCount
      }
    };
  }
}

module.exports = {
  CHAIN_IDS,
  CandidateIndex,
  candidateKey,
  isFresh,
  mergeCandidate,
  normalizeAddress,
  normalizeCandidate,
  normalizeChain
};
