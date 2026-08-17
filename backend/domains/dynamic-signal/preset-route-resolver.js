const {
  extractContent,
  normalizeApprovedNameMatchKey,
  normalizeName
} = require('./content-extractor');

function routeAssetKey(route) {
  return `variant:${Number(route.variant_id)}`;
}

function withPreviewRouteEvidence(routes = []) {
  const usedRouteIds = new Set((routes || []).map((route) => Number(route.route_id))
    .filter((id) => Number.isInteger(id) && id > 0));
  let nextRouteId = 1;
  const allocateRouteId = () => {
    while (usedRouteIds.has(nextRouteId)) nextRouteId += 1;
    const allocated = nextRouteId;
    usedRouteIds.add(allocated);
    nextRouteId += 1;
    return allocated;
  };
  return (routes || []).map((route, index) => ({
    ...route,
    route_id: route.route_id || allocateRouteId(),
    variant_id: index + 1,
    asset_family_id: index + 1,
    verification: null
  }));
}

function routeAliasRecords(routes = []) {
  return (routes || []).filter((route) => route.enabled !== false).flatMap((route) => (
    (route.aliases || []).map((alias) => ({
      value: alias,
      assetKey: routeAssetKey(route),
      assetFamilyId: route.asset_family_id,
      presetRouteId: route.route_id,
      routeLabel: route.label,
      variantId: route.variant_id,
      chainId: route.chain_id,
      contractAddress: route.contract_address,
      localPresetRoute: true
    }))
  ));
}

function legacyAliasRecords(aliases = []) {
  return (aliases || []).map((alias) => ({
    ...(typeof alias === 'string' ? { value: alias } : alias),
    legacyUnbound: true
  }));
}

function routeSnapshot(route, matchedAliases = []) {
  return {
    route_id: Number(route.route_id),
    label: route.label,
    matched_aliases: [...new Set(matchedAliases)],
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    variant_id: Number(route.variant_id),
    asset_family_id: Number(route.asset_family_id),
    verification: route.verification || null
  };
}

function presetCandidate(route, matchedTerms = []) {
  const matchedAliases = matchedTerms.map((term) => term.value).filter(Boolean);
  return {
    id: Number(route.variant_id),
    variantId: Number(route.variant_id),
    assetFamilyId: Number(route.asset_family_id),
    assetKey: routeAssetKey(route),
    chainId: route.chain_id,
    contractAddress: route.contract_address,
    name: route.label,
    normalizedName: normalizeName(route.label),
    sources: ['preset_route'],
    providerStatus: 'local_rpc',
    tradableStatus: 'unknown',
    localPresetRoute: true,
    presetRouteId: Number(route.route_id),
    routeLabel: route.label,
    matchedAliases: [...new Set(matchedAliases)],
    presetRouteSnapshot: routeSnapshot(route, matchedAliases)
  };
}

function withTerms(extraction, mapper) {
  const observedTerms = (extraction.observedTerms || []).map(mapper);
  const byIdentity = new Map(observedTerms.map((term) => [
    `${term.source}:${term.type}:${term.start}:${term.end}:${term.normalized}`,
    term
  ]));
  const mapExisting = (term) => byIdentity.get(
    `${term.source}:${term.type}:${term.start}:${term.end}:${term.normalized}`
  ) || mapper(term);
  const authorOwnedTerms = (extraction.authorOwnedTerms || []).map(mapExisting);
  const quotedTerms = (extraction.quotedTerms || []).map(mapExisting);
  return {
    ...extraction,
    observedTerms,
    authorOwnedTerms,
    quotedTerms,
    assetTerms: observedTerms.filter((term) => (
      ['ca', 'cashtag', 'hashtag', 'approved_name'].includes(term.type)
    ))
  };
}

function overlappingPresetAlias(term, presetTerms = []) {
  if (!['cashtag', 'hashtag'].includes(term.type)) return null;
  const termKey = normalizeApprovedNameMatchKey(term.normalized || term.value);
  return presetTerms.find((presetTerm) => (
    presetTerm.source === term.source
      && term.start <= presetTerm.start
      && term.end >= presetTerm.end
      && termKey === presetTerm.matchKey
  )) || null;
}

function resolvePresetRouteState(extraction, routes = []) {
  const routeById = new Map((routes || []).map((route) => [Number(route.route_id), route]));
  const presetTerms = (extraction.authorOwnedTerms || []).filter((term) => (
    term.type === 'approved_name' && term.localPresetRoute === true
  ));
  const legacyTerms = (extraction.authorOwnedTerms || []).filter((term) => (
    term.type === 'approved_name' && term.legacyUnbound === true
  ));
  const matchedRouteIds = [...new Set(presetTerms.map((term) => Number(term.presetRouteId)))];

  if (legacyTerms.length > 0) {
    return {
      status: 'binding_required',
      failureCode: 'DYNAMIC_ROUTE_BINDING_REQUIRED',
      extraction,
      candidate: null,
      matchedRoutes: matchedRouteIds,
      legacyAliases: [...new Set(legacyTerms.map((term) => term.value))]
    };
  }
  if (matchedRouteIds.length > 1) {
    return {
      status: 'ambiguous',
      failureCode: 'DYNAMIC_ROUTE_AMBIGUOUS',
      extraction,
      candidate: null,
      matchedRoutes: matchedRouteIds
    };
  }
  if (matchedRouteIds.length === 0) {
    return { status: 'none', failureCode: null, extraction, candidate: null, matchedRoutes: [] };
  }

  const route = routeById.get(matchedRouteIds[0]);
  if (!route || !route.variant_id || !route.asset_family_id) {
    return {
      status: 'invalid',
      failureCode: 'DYNAMIC_ROUTE_EVIDENCE_MISSING',
      extraction,
      candidate: null,
      matchedRoutes: matchedRouteIds
    };
  }
  const directCas = (extraction.authorOwnedTerms || []).filter((term) => term.type === 'ca');
  if (directCas.some((term) => term.normalized !== route.contract_address)) {
    return {
      status: 'conflict',
      failureCode: 'DYNAMIC_ROUTE_CA_CONFLICT',
      extraction,
      candidate: null,
      matchedRoutes: matchedRouteIds
    };
  }
  const assetKey = routeAssetKey(route);
  const routePresetTerms = presetTerms.filter(
    (term) => Number(term.presetRouteId) === Number(route.route_id)
  );
  const enriched = withTerms(extraction, (term) => {
    if (term.localPresetRoute === true && Number(term.presetRouteId) === Number(route.route_id)
        || term.type === 'ca' && term.normalized === route.contract_address) {
      return { ...term, assetKey };
    }
    const overlap = overlappingPresetAlias(term, routePresetTerms);
    return overlap ? {
      ...term,
      assetKey,
      presetRouteId: Number(route.route_id),
      routeLabel: route.label,
      variantId: Number(route.variant_id),
      assetFamilyId: Number(route.asset_family_id),
      chainId: route.chain_id,
      contractAddress: route.contract_address,
      localPresetRouteAlias: true
    } : term;
  });
  return {
    status: 'matched',
    failureCode: null,
    extraction: enriched,
    candidate: presetCandidate(route, presetTerms),
    matchedRoutes: matchedRouteIds
  };
}

function extractWithPresetRoutes(input = {}) {
  const routes = Array.isArray(input.presetRoutes) ? input.presetRoutes : [];
  const aliases = [
    ...routeAliasRecords(routes),
    ...legacyAliasRecords(input.legacyApprovedAliases || [])
  ];
  const extraction = extractContent({ ...input, approvedAliases: aliases });
  return resolvePresetRouteState(extraction, routes);
}

module.exports = {
  extractWithPresetRoutes,
  legacyAliasRecords,
  presetCandidate,
  resolvePresetRouteState,
  routeAliasRecords,
  routeAssetKey,
  routeSnapshot,
  withPreviewRouteEvidence
};
