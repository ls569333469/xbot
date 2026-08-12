const db = require('../../lib/db');

function policyStatus(mode, enabled, blockers = []) {
  if (blockers.length > 0) return { status: 'unknown', blockers };
  if (!enabled || mode !== 'live') return { status: 'record_only', blockers: [] };
  return { status: 'auto_allowed', blockers: [] };
}

async function projectCurrentAuthorization(signals, fixedPolicy, chainRows, executor = db) {
  if (!Array.isArray(signals) || signals.length === 0) return new Map();
  const dynamicIds = [...new Set(signals.map((row) => row.actor_policy_id).filter(Boolean).map(Number))];
  const followIds = [...new Set(signals.map((row) => row.follow_discovery_policy_id).filter(Boolean).map(Number))];
  const [dynamicRows, followRows] = await Promise.all([
    dynamicIds.length ? executor.query(
      `SELECT policy.id, policy.enabled, policy.mode, policy.revision, policy.context_hash,
              kol.enabled AS kol_enabled
       FROM x_actor_dynamic_policies policy
       JOIN x_kol_accounts kol ON kol.id = policy.kol_id
       WHERE policy.id = ANY($1::bigint[])`, [dynamicIds]
    ) : { rows: [] },
    followIds.length ? executor.query(
      `SELECT policy.id, policy.enabled, policy.mode, policy.revision, policy.context_hash,
              policy.archived_at, kol.enabled AS kol_enabled
       FROM follow_discovery_policies policy
       JOIN x_kol_accounts kol ON kol.id = policy.kol_id
       WHERE policy.id = ANY($1::bigint[])`, [followIds]
    ) : { rows: [] }
  ]);
  const dynamic = new Map(dynamicRows.rows.map((row) => [Number(row.id), row]));
  const follow = new Map(followRows.rows.map((row) => [Number(row.id), row]));
  const chains = new Map((chainRows || []).map((row) => [row.chain, row]));
  const output = new Map();
  for (const signal of signals) {
    if (signal.strategy_type === 'dynamic_policy') {
      const policy = dynamic.get(Number(signal.actor_policy_id));
      const blockers = [];
      if (!policy) blockers.push('DYNAMIC_POLICY_NOT_FOUND');
      if (policy && (!policy.enabled || !policy.kol_enabled)) blockers.push('DYNAMIC_POLICY_NOT_LIVE');
      if (policy && (Number(policy.revision) !== Number(signal.actor_policy_revision)
          || policy.context_hash !== signal.dynamic_policy_context_hash)) blockers.push('DYNAMIC_POLICY_CHANGED');
      output.set(String(signal.id), policyStatus(policy?.mode, policy?.enabled && policy?.kol_enabled, blockers));
      continue;
    }
    if (signal.strategy_type === 'follow_discovery') {
      const policy = follow.get(Number(signal.follow_discovery_policy_id));
      const blockers = [];
      if (!policy) blockers.push('FOLLOW_POLICY_NOT_FOUND');
      if (policy && (policy.archived_at || !policy.enabled || !policy.kol_enabled)) blockers.push('FOLLOW_POLICY_NOT_LIVE');
      if (policy && (Number(policy.revision) !== Number(signal.follow_discovery_policy_revision)
          || policy.context_hash !== signal.follow_discovery_context_hash)) blockers.push('FOLLOW_POLICY_CHANGED');
      output.set(String(signal.id), policyStatus(policy?.mode, policy?.enabled && policy?.kol_enabled, blockers));
      continue;
    }
    const matched = fixedPolicy.providers.includes(String(signal.provider || '').toLowerCase())
      && fixedPolicy.eventTypes.includes(String(signal.activity_type || '').toLowerCase())
      && fixedPolicy.chains.includes(String(signal.chain_id || '').toLowerCase())
      && fixedPolicy.whitelistIds.includes(Number(signal.whitelist_id))
      && Array.isArray(signal.matched_relation_ids) && signal.matched_relation_ids.length > 0;
    const chain = chains.get(signal.chain_id);
    const automatic = matched
      && fixedPolicy.verifiedEventTypes.includes(String(signal.activity_type || '').toLowerCase())
      && chain?.implemented && (chain?.contract_tested || chain?.live_enabled);
    output.set(String(signal.id), {
      status: automatic ? 'auto_allowed' : matched ? 'manual_allowed' : 'record_only',
      blockers: []
    });
  }
  return output;
}

module.exports = { policyStatus, projectCurrentAuthorization };
