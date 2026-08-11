const db = require('../../lib/db');
const engineState = require('../../lib/engine-state');
const { CHAIN_REGISTRY } = require('../../lib/chain-config');
const { getTradingMode } = require('../../lib/runtime-mode');
const livePolicy = require('../signal/live-policy');
const runtimeScopeService = require('./runtime-scope-service');

function positiveInteger(value, fallback, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function hasScopeFilter(filters = {}) {
  return Object.prototype.hasOwnProperty.call(filters, 'scope_type')
    || Object.prototype.hasOwnProperty.call(filters, 'scope_id')
    || Object.prototype.hasOwnProperty.call(filters, 'scope_chain_ids');
}

function parseScopeChainIds(value) {
  if (Array.isArray(value)) return value;
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function resolveDetailScope(filters, executor) {
  const manifest = await runtimeScopeService.resolveScope({
    scope_type: filters.scope_type || 'combined',
    scope_id: filters.scope_id ?? null,
    chain_ids: parseScopeChainIds(filters.scope_chain_ids)
  }, executor);
  const fixedWhitelistIds = manifest.whitelist_ids || [];
  const dynamicPolicyIds = manifest.dynamic_policy_ids || [];
  const followPolicyIds = manifest.follow_policy_ids || [];
  const result = await executor.query(
    `SELECT whitelist.id
     FROM ca_whitelist AS whitelist
     WHERE whitelist.status = 'active'
       AND whitelist.live_activation_state = 'live_ready'
       AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
       AND (
         whitelist.id = ANY($1::bigint[])
         OR whitelist.actor_policy_id = ANY($2::bigint[])
         OR whitelist.follow_discovery_policy_id = ANY($3::bigint[])
       )
     ORDER BY whitelist.id`,
    [fixedWhitelistIds.length ? fixedWhitelistIds : [-1],
      dynamicPolicyIds.length ? dynamicPolicyIds : [-1],
      followPolicyIds.length ? followPolicyIds : [-1]]
  );
  return {
    manifest,
    whitelistIds: result.rows.map((row) => Number(row.id))
  };
}

async function getRuntimeSummary(executor = db) {
  const policy = await livePolicy.getPolicy(executor);
  const whitelistIds = policy.whitelistIds.length > 0 ? policy.whitelistIds : [-1];
  const [triggerResult, activationResult, chainResult] = await Promise.all([
    executor.query(
      `WITH triggers AS (
         SELECT relation.whitelist_id, relation.kol_id AS actor_id
         FROM x_signal_relations AS relation
         JOIN x_kol_accounts AS actor
           ON actor.id = relation.kol_id AND actor.enabled = true
         WHERE relation.enabled = true AND relation.whitelist_id = ANY($1::int[])
         UNION ALL
         SELECT rule.whitelist_id, rule.actor_id
         FROM x_signal_source_rules AS rule
         JOIN x_kol_accounts AS actor
           ON actor.id = rule.actor_id AND actor.enabled = true
         WHERE rule.enabled = true AND rule.whitelist_id = ANY($1::int[])
       )
       SELECT COUNT(*)::int AS relation_count,
              COUNT(DISTINCT actor_id)::int AS watch_count
       FROM triggers`,
      [whitelistIds]
    ),
    executor.query(
      `SELECT live_activation_state, COUNT(*)::int AS count
       FROM ca_whitelist
       WHERE status = 'active'
       GROUP BY live_activation_state`
    ),
    executor.query(
      `SELECT chain, implemented, contract_tested,
              live_enabled AS production_approved
       FROM chain_live_readiness
       WHERE chain = ANY($1::text[])
       ORDER BY chain`,
      [policy.chains.length > 0 ? policy.chains : ['__none__']]
    )
  ]);
  const readinessByChain = new Map(chainResult.rows.map((row) => [row.chain, row]));
  const activation = Object.fromEntries(activationResult.rows.map((row) => [
    row.live_activation_state,
    Number(row.count)
  ]));
  const triggerCounts = triggerResult.rows[0] || {};
  const engine = { ...engineState.getStatus(), mode: getTradingMode() };
  return {
    generated_at: new Date().toISOString(),
    engine,
    counts: {
      chains: policy.chains.length,
      whitelists: policy.whitelistIds.length,
      watches: Number(triggerCounts.watch_count || 0),
      relations: Number(triggerCounts.relation_count || 0),
      syncing: Number(activation.syncing || 0),
      sync_failed: Number(activation.sync_failed || 0)
    },
    chains: policy.chains.map((chain) => {
      const readiness = readinessByChain.get(chain);
      return {
        chain,
        name: CHAIN_REGISTRY[chain]?.name || chain.toUpperCase(),
        ready: Boolean(readiness?.implemented
        && (readiness?.contract_tested || readiness?.production_approved)
          && readiness?.production_approved)
      };
    })
  };
}

async function getRuntimePolicyDetail(filters = {}, executor = db) {
  const scoped = hasScopeFilter(filters);
  const scope = scoped ? await resolveDetailScope(filters, executor) : null;
  const policy = scoped ? null : await livePolicy.getPolicy(executor);
  const page = positiveInteger(filters.page, 1, 1000000);
  const pageSize = positiveInteger(filters.page_size || filters.pageSize, 20, 100);
  const chain = String(filters.chain || '').trim().toLowerCase();
  if (chain && !CHAIN_REGISTRY[chain]) {
    const error = new Error(`Unsupported chain: ${chain}`);
    error.code = 'CHAIN_UNSUPPORTED';
    throw error;
  }
  const search = String(filters.search || '').trim();
  const whitelistIds = scoped ? scope.whitelistIds : policy.whitelistIds;
  const params = [whitelistIds.length > 0 ? whitelistIds : [-1]];
  let where = `WHERE whitelist.id = ANY($1::int[])
    AND whitelist.status = 'active'
    AND whitelist.live_activation_state = 'live_ready'`;
  if (chain) {
    params.push(chain);
    where += ` AND whitelist.chain_id = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    where += ` AND (whitelist.contract_address ILIKE $${params.length}
      OR whitelist.symbol ILIKE $${params.length}
      OR whitelist.project_name ILIKE $${params.length})`;
  }

  const countResult = await executor.query(
    `SELECT COUNT(*)::int AS count FROM ca_whitelist AS whitelist ${where}`,
    params
  );
  const queryParams = [...params, pageSize, (page - 1) * pageSize];
  const result = await executor.query(
    `SELECT whitelist.id, whitelist.chain_id, whitelist.contract_address,
            whitelist.symbol, whitelist.project_name, whitelist.token_logo_url,
            whitelist.budget_per_trade, whitelist.total_budget,
            whitelist.activation_version, whitelist.activated_at,
            COALESCE(trigger.relation_count, 0)::int AS relation_count,
            COALESCE(trigger.source_count, 0)::int AS source_count,
            COALESCE(trigger.unique_actor_count, 0)::int AS unique_actor_count,
            COALESCE(trigger.actor_handles, '{}'::text[]) AS actor_handles
     FROM ca_whitelist AS whitelist
     LEFT JOIN LATERAL (
       SELECT COUNT(*) FILTER (WHERE item.trigger_kind = 'interaction') AS relation_count,
              COUNT(*) FILTER (WHERE item.trigger_kind = 'direct_source') AS source_count,
              COUNT(DISTINCT item.actor_id) AS unique_actor_count,
              (ARRAY_AGG(DISTINCT item.actor_handle ORDER BY item.actor_handle))[1:5] AS actor_handles
       FROM (
         SELECT 'interaction'::text AS trigger_kind, relation.kol_id AS actor_id,
                actor.x_handle AS actor_handle
         FROM x_signal_relations AS relation
         JOIN x_kol_accounts AS actor
           ON actor.id = relation.kol_id AND actor.enabled = true
         WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
         UNION ALL
         SELECT 'direct_source'::text, rule.actor_id, actor.x_handle
         FROM x_signal_source_rules AS rule
         JOIN x_kol_accounts AS actor
           ON actor.id = rule.actor_id AND actor.enabled = true
         WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
       ) AS item
     ) AS trigger ON true
     ${where}
     ORDER BY whitelist.chain_id, lower(COALESCE(whitelist.symbol, whitelist.project_name, '')), whitelist.id
     LIMIT $${queryParams.length - 1} OFFSET $${queryParams.length}`,
    queryParams
  );
  return {
    items: result.rows,
    total: Number(countResult.rows[0]?.count || 0),
    page,
    page_size: pageSize,
    scope: scope?.manifest || null
  };
}

module.exports = {
  getRuntimePolicyDetail,
  getRuntimeSummary,
  positiveInteger
};
