const { normalizeApprovedNameMatchKey } = require('./content-extractor');
const { normalizeAddress, normalizeChain } = require('./candidate-index');

const MAX_PRESET_ROUTES = 20;
const MAX_ROUTE_ALIASES = 10;
const MAX_TOTAL_ALIASES = 50;

function routeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function routeId(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route id is invalid');
  }
  return parsed;
}

function routeLabel(value, index) {
  const label = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!label || label.length > 40) {
    throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route label must contain 1-40 characters', {
      route_index: index
    });
  }
  return label;
}

function aliasText(value, routeIndex, aliasIndex) {
  const raw = typeof value === 'string' ? value : value?.alias_text ?? value?.name ?? value?.value;
  const text = String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (!text || text.length > 80) {
    throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route keyword must contain 1-80 characters', {
      route_index: routeIndex,
      alias_index: aliasIndex
    });
  }
  const normalizedKey = normalizeApprovedNameMatchKey(text);
  if (!normalizedKey) {
    throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route keyword has no matchable characters', {
      route_index: routeIndex,
      alias_index: aliasIndex
    });
  }
  return { text, normalized_key: normalizedKey, sort_order: aliasIndex };
}

function legacyAliasKeys(values = []) {
  return new Map((Array.isArray(values) ? values : []).map((value, index) => {
    const raw = typeof value === 'string' ? value : value?.name ?? value?.value;
    const text = String(raw || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
    return [normalizeApprovedNameMatchKey(text), { text, index }];
  }).filter(([key]) => key));
}

function normalizePresetRoutes(value, options = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_PRESET_ROUTES) {
    throw routeError('DYNAMIC_ROUTE_LIMIT_EXCEEDED', `A policy supports at most ${MAX_PRESET_ROUTES} asset routes`);
  }
  const routes = [];
  const seenIds = new Map();
  const seenAssets = new Map();
  const seenAliases = new Map();
  const legacyKeys = legacyAliasKeys(options.legacyAliases);
  let totalAliases = 0;

  value.forEach((raw, routeIndex) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route must be an object', { route_index: routeIndex });
    }
    const id = routeId(raw.route_id ?? raw.id);
    if (id !== null && seenIds.has(id)) {
      throw routeError('DYNAMIC_ROUTE_INVALID', 'Asset route id is duplicated', {
        route_index: routeIndex,
        conflicting_route_index: seenIds.get(id)
      });
    }
    if (id !== null) seenIds.set(id, routeIndex);
    const chainId = normalizeChain(raw.chain_id ?? raw.chainId);
    const contractAddress = normalizeAddress(chainId, raw.contract_address ?? raw.contractAddress);
    if (!chainId || !contractAddress) {
      throw routeError('DYNAMIC_ROUTE_ADDRESS_INVALID', 'Asset route chain or contract address is invalid', {
        route_id: id, route_index: routeIndex
      });
    }
    const assetKey = `${chainId}:${contractAddress}`;
    if (seenAssets.has(assetKey)) {
      throw routeError('DYNAMIC_ROUTE_ASSET_DUPLICATE', 'The same asset can only appear once in a policy', {
        route_id: id,
        route_index: routeIndex,
        conflicting_route_index: seenAssets.get(assetKey)
      });
    }
    seenAssets.set(assetKey, routeIndex);
    if (!Array.isArray(raw.aliases) || raw.aliases.length < 1
        || raw.aliases.length > MAX_ROUTE_ALIASES) {
      throw routeError('DYNAMIC_ROUTE_LIMIT_EXCEEDED', `Each asset route requires 1-${MAX_ROUTE_ALIASES} keywords`, {
        route_id: id, route_index: routeIndex
      });
    }
    const aliases = raw.aliases.map((alias, aliasIndex) => aliasText(alias, routeIndex, aliasIndex));
    const routeAliasKeys = new Map();
    aliases.forEach((alias, aliasIndex) => {
      if (routeAliasKeys.has(alias.normalized_key)) {
        throw routeError('DYNAMIC_ROUTE_ALIAS_DUPLICATE', 'Two keywords in this route have the same match key', {
          route_id: id,
          route_index: routeIndex,
          alias_index: aliasIndex,
          conflicting_alias_index: routeAliasKeys.get(alias.normalized_key)
        });
      }
      routeAliasKeys.set(alias.normalized_key, aliasIndex);
      if (seenAliases.has(alias.normalized_key)) {
        const conflict = seenAliases.get(alias.normalized_key);
        throw routeError('DYNAMIC_ROUTE_ALIAS_CONFLICT', 'A keyword cannot be bound to two asset routes', {
          route_id: id,
          route_index: routeIndex,
          alias_index: aliasIndex,
          conflicting_route_id: conflict.route_id,
          conflicting_route_index: conflict.route_index,
          conflicting_alias_index: conflict.alias_index
        });
      }
      if (legacyKeys.has(alias.normalized_key)) {
        throw routeError('DYNAMIC_ROUTE_ALIAS_CONFLICT', 'A bound keyword must be removed from unbound legacy keywords', {
          route_id: id,
          route_index: routeIndex,
          alias_index: aliasIndex,
          legacy_alias_index: legacyKeys.get(alias.normalized_key).index
        });
      }
      seenAliases.set(alias.normalized_key, { route_id: id, route_index: routeIndex, alias_index: aliasIndex });
    });
    totalAliases += aliases.length;
    routes.push({
      route_id: id,
      label: routeLabel(raw.label, routeIndex),
      chain_id: chainId,
      contract_address: contractAddress,
      enabled: raw.enabled !== false,
      aliases: aliases.map((alias) => alias.text),
      normalized_aliases: aliases,
      ...(options.allowTrustedFields ? {
        variant_id: raw.variant_id ?? raw.variantId ?? null,
        asset_family_id: raw.asset_family_id ?? raw.assetFamilyId ?? null,
        verification: raw.verification || null
      } : {})
    });
  });

  if (totalAliases > MAX_TOTAL_ALIASES) {
    throw routeError('DYNAMIC_ROUTE_LIMIT_EXCEEDED', `A policy supports at most ${MAX_TOTAL_ALIASES} route keywords`);
  }
  return routes;
}

function routeFingerprint(route) {
  return `${route.chain_id}:${route.contract_address}`;
}

function hydrateRouteIds(routes, currentRoutes = []) {
  const currentByAsset = new Map(currentRoutes.map((route) => [routeFingerprint(route), route]));
  return routes.map((route) => route.route_id ? route : {
    ...route,
    route_id: currentByAsset.get(routeFingerprint(route))?.route_id || null
  });
}

function routeExecutionSnapshot(routes = []) {
  return routes.map((route) => ({
    enabled: route.enabled !== false,
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    aliases: (route.normalized_aliases || route.aliases.map((alias) => ({
      normalized_key: normalizeApprovedNameMatchKey(alias)
    }))).map((alias) => alias.normalized_key).sort()
  })).sort((left, right) => (
    `${left.chain_id}:${left.contract_address}`.localeCompare(`${right.chain_id}:${right.contract_address}`)
  ));
}

function templateRouteInputs(routes = []) {
  return routes.map((route) => ({
    label: route.label,
    aliases: [...route.aliases],
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    enabled: route.enabled !== false
  }));
}

module.exports = {
  MAX_PRESET_ROUTES,
  MAX_ROUTE_ALIASES,
  MAX_TOTAL_ALIASES,
  hydrateRouteIds,
  normalizePresetRoutes,
  routeError,
  routeExecutionSnapshot,
  routeFingerprint,
  templateRouteInputs
};
