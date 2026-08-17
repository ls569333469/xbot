const crypto = require('crypto');

const STRATEGY_TYPES = new Set(['fixed_ca', 'dynamic_policy', 'follow_discovery']);

function nullableText(value) {
  const text = String(value || '').trim();
  return text || null;
}

function strategyType(value = {}) {
  if (STRATEGY_TYPES.has(value.strategy_type)) return value.strategy_type;
  if (value.follow_discovery_policy_id) return 'follow_discovery';
  if (value.actor_policy_id) return 'dynamic_policy';
  return 'fixed_ca';
}

function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
}

function assetSnapshot(value = {}, source = 'signal_creation') {
  const body = {
    snapshot_version: 'p27.asset.v1',
    source,
    chain_id: nullableText(value.chain_id || value.chainId),
    contract_address: nullableText(value.contract_address || value.contractAddress),
    symbol: nullableText(value.symbol),
    name: nullableText(value.project_name || value.name),
    logo_url: nullableText(value.logo_url || value.logoUrl),
    project_handles: [...new Set([
      ...(Array.isArray(value.project_x_handles) ? value.project_x_handles : []),
      ...(Array.isArray(value.project_handles) ? value.project_handles : []),
      value.project_handle
    ].map(nullableText).filter(Boolean))]
  };
  return { ...body, snapshot_hash: hashSnapshot(body) };
}

function authorizationSnapshot(value = {}, type = strategyType(value)) {
  const policyId = type === 'follow_discovery'
    ? value.follow_discovery_policy_id
    : type === 'dynamic_policy' ? value.actor_policy_id : value.whitelist_id;
  const revision = type === 'follow_discovery'
    ? value.follow_discovery_policy_revision
    : type === 'dynamic_policy' ? value.actor_policy_revision : null;
  const contextHash = type === 'follow_discovery'
    ? value.follow_discovery_context_hash
    : type === 'dynamic_policy' ? value.dynamic_policy_context_hash : null;
  const body = {
    snapshot_version: 'p27.authorization.v1',
    source: 'signal_creation',
    strategy_type: type,
    signal_policy_snapshot: {
      mode: ['live', 'paper'].includes(value.execution_mode) ? value.execution_mode : 'record',
      policy_id: policyId ?? null,
      revision: revision ?? null,
      context_hash: nullableText(contextHash)
    },
    ...(value.asset_route_snapshot ? { asset_route_snapshot: value.asset_route_snapshot } : {}),
    execution_decision: { status: 'not_attempted', blockers: [] }
  };
  return { ...body, snapshot_hash: hashSnapshot(body) };
}

module.exports = { assetSnapshot, authorizationSnapshot, hashSnapshot, strategyType };
