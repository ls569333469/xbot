const { candidateKey, normalizeCandidate } = require('./candidate-index');

const RELATION_TYPES = new Set([
  'original', 'relaunch', 'migration', 'cross_chain', 'cto', 'unknown'
]);

function familyIdentity(candidate) {
  if (candidate.assetFamilyId !== null && candidate.assetFamilyId !== undefined) {
    return `id:${candidate.assetFamilyId}`;
  }
  if (candidate.assetFamilyKey) return `key:${String(candidate.assetFamilyKey).trim().toLowerCase()}`;
  return `variant:${candidateKey(candidate)}`;
}

function buildAssetFamilies(values = []) {
  const families = new Map();
  for (const value of values) {
    const candidate = normalizeCandidate(value);
    if (!candidate) continue;
    const identity = familyIdentity(candidate);
    if (!families.has(identity)) {
      families.set(identity, {
        identityKey: identity,
        assetFamilyId: candidate.assetFamilyId,
        name: candidate.name || null,
        symbol: candidate.symbol || null,
        variants: []
      });
    }
    const family = families.get(identity);
    if (!family.variants.some((variant) => candidateKey(variant) === candidateKey(candidate))) {
      family.variants.push(candidate);
    }
  }
  return [...families.values()];
}

function normalizeVariantRelations(relations = [], candidates = []) {
  const known = new Set(candidates.map(normalizeCandidate).filter(Boolean).map(candidateKey));
  return (Array.isArray(relations) ? relations : []).map((relation) => {
    const from = normalizeCandidate(relation.from || relation.fromVariant || relation.from_variant);
    const to = normalizeCandidate(relation.to || relation.toVariant || relation.to_variant);
    const type = String(relation.type || relation.relationType || relation.relation_type || 'unknown').toLowerCase();
    if (!from || !to || !RELATION_TYPES.has(type)) return null;
    const fromKey = candidateKey(from);
    const toKey = candidateKey(to);
    if (fromKey === toKey || !known.has(fromKey) || !known.has(toKey)) return null;
    return {
      fromKey,
      toKey,
      type,
      evidence: relation.evidence && typeof relation.evidence === 'object' ? relation.evidence : {}
    };
  }).filter(Boolean);
}

module.exports = {
  RELATION_TYPES,
  buildAssetFamilies,
  familyIdentity,
  normalizeVariantRelations
};
