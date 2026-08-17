const db = require('../../lib/db');
const assetRegistry = require('./asset-registry');
const { routeError, routeFingerprint } = require('./preset-route-schema');

function rowToRoute(row) {
  const aliasRows = Array.isArray(row.alias_rows) ? row.alias_rows : [];
  return {
    route_id: Number(row.id),
    label: row.label,
    aliases: aliasRows.map((alias) => alias.alias_text),
    normalized_aliases: aliasRows.map((alias) => ({
      text: alias.alias_text,
      normalized_key: alias.normalized_key,
      sort_order: Number(alias.sort_order)
    })),
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    variant_id: Number(row.variant_id),
    asset_family_id: Number(row.asset_family_id),
    enabled: row.enabled,
    verification: {
      status: 'verified',
      source: row.verification_source,
      verified_at: row.verified_at,
      error_code: null,
      snapshot: row.verification_snapshot || {}
    }
  };
}

async function listForPolicies(policyIds, executor = db, options = {}) {
  const ids = [...new Set((policyIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return new Map();
  const result = await executor.query(
    `SELECT route.*, variant.chain_id, variant.contract_address, variant.asset_family_id,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'alias_text', alias.alias_text,
                'normalized_key', alias.normalized_key,
                'sort_order', alias.sort_order
              ) ORDER BY alias.sort_order, alias.id)
              FROM dynamic_policy_asset_aliases alias
              WHERE alias.route_id = route.id AND alias.archived_at IS NULL
            ), '[]'::jsonb) AS alias_rows
     FROM dynamic_policy_asset_routes route
     JOIN dynamic_asset_variants variant ON variant.id = route.variant_id
     WHERE route.actor_policy_id = ANY($1::bigint[])
       AND route.archived_at IS NULL
       ${options.enabledOnly ? 'AND route.enabled = true' : ''}
     ORDER BY route.actor_policy_id, route.id`,
    [ids]
  );
  const byPolicy = new Map(ids.map((id) => [id, []]));
  for (const row of result.rows) byPolicy.get(Number(row.actor_policy_id))?.push(rowToRoute(row));
  return byPolicy;
}

async function listForPolicy(policyId, executor = db, options = {}) {
  return (await listForPolicies([policyId], executor, options)).get(Number(policyId)) || [];
}

async function attachRoutes(policies, executor = db) {
  const byPolicy = await listForPolicies(policies.map((policy) => policy.id), executor);
  return policies.map((policy) => ({
    ...policy,
    preset_asset_routes: byPolicy.get(Number(policy.id)) || []
  }));
}

async function ensureRouteVariants(routes, executor = db) {
  const variantByAsset = new Map();
  const unresolved = routes.filter((route) => !route.variant_id)
    .sort((left, right) => routeFingerprint(left).localeCompare(routeFingerprint(right)));
  for (const route of routes) {
    if (route.variant_id) variantByAsset.set(routeFingerprint(route), Number(route.variant_id));
  }
  for (const route of unresolved) {
    const variant = await assetRegistry.ensureVariant({
      chainId: route.chain_id,
      contractAddress: route.contract_address,
      sources: ['preset_route'],
      providerStatus: 'local_rpc',
      tradableStatus: 'unknown'
    }, 'preset_route', executor, {
      fetchedAt: route.verification?.verified_at ? new Date(route.verification.verified_at) : new Date(),
      expiresAt: null,
      identityOnly: true
    });
    if (!variant) throw routeError('DYNAMIC_ROUTE_VARIANT_REQUIRED', 'Verified asset route could not be registered');
    variantByAsset.set(routeFingerprint(route), Number(variant.id));
  }
  return variantByAsset;
}

async function sync(policyId, routes, executor = db) {
  const id = Number(policyId);
  const variantByAsset = await ensureRouteVariants(routes, executor);
  const current = await listForPolicy(id, executor);
  const currentIds = new Set(current.map((route) => Number(route.route_id)));
  const incomingIds = new Set(routes.map((route) => Number(route.route_id))
    .filter((routeId) => Number.isInteger(routeId) && routeId > 0));
  for (const routeId of incomingIds) {
    if (!currentIds.has(routeId)) {
      throw routeError('DYNAMIC_ROUTE_POLICY_MISMATCH', 'Asset route does not belong to this policy', {
        route_id: routeId
      });
    }
  }

  await executor.query(
    `UPDATE dynamic_policy_asset_aliases SET archived_at = NOW(), updated_at = NOW()
     WHERE actor_policy_id = $1 AND archived_at IS NULL`, [id]
  );
  await executor.query(
    `UPDATE dynamic_policy_asset_routes SET archived_at = NOW(), updated_at = NOW()
     WHERE actor_policy_id = $1 AND archived_at IS NULL
       AND NOT (id = ANY($2::bigint[]))`,
    [id, [...incomingIds]]
  );

  for (const route of routes) {
    const variantId = variantByAsset.get(routeFingerprint(route));
    const verification = route.verification;
    let routeRow;
    if (route.route_id) {
      const result = await executor.query(
        `UPDATE dynamic_policy_asset_routes SET
           label = $3, variant_id = $4, enabled = $5,
           verification_source = 'local_rpc', verification_snapshot = $6,
           verified_at = $7, archived_at = NULL, updated_at = NOW()
         WHERE id = $1 AND actor_policy_id = $2 RETURNING *`,
        [Number(route.route_id), id, route.label, variantId, route.enabled !== false,
          JSON.stringify(verification?.snapshot || {}), verification?.verified_at]
      );
      routeRow = result.rows[0];
    } else {
      const result = await executor.query(
        `INSERT INTO dynamic_policy_asset_routes
          (actor_policy_id, label, variant_id, enabled, verification_source,
           verification_snapshot, verified_at)
         VALUES ($1,$2,$3,$4,'local_rpc',$5,$6) RETURNING *`,
        [id, route.label, variantId, route.enabled !== false,
          JSON.stringify(verification?.snapshot || {}), verification?.verified_at]
      );
      routeRow = result.rows[0];
    }
    if (!routeRow) throw routeError('DYNAMIC_ROUTE_POLICY_MISMATCH', 'Asset route update was rejected');
    for (const alias of route.normalized_aliases) {
      await executor.query(
        `INSERT INTO dynamic_policy_asset_aliases
          (route_id, actor_policy_id, alias_text, normalized_key, sort_order)
         VALUES ($1,$2,$3,$4,$5)`,
        [routeRow.id, id, alias.text, alias.normalized_key, alias.sort_order]
      );
    }
  }
  return listForPolicy(id, executor);
}

module.exports = {
  attachRoutes,
  ensureRouteVariants,
  listForPolicies,
  listForPolicy,
  rowToRoute,
  sync
};
