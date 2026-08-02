const db = require('../../lib/db');
const { getExecutionChains } = require('../../lib/chain-config');
const dynamicAuthorization = require('../dynamic-signal/dynamic-authorization');

const EVENT_TYPES = new Set(['tweet', 'retweet', 'quote', 'reply', 'follow']);
const VERIFIED_6551_EVENT_TYPES = Object.freeze([...EVENT_TYPES]);

function getVerifiedEventTypes() {
  return [...VERIFIED_6551_EVENT_TYPES];
}

async function resolveActiveWhitelistIds(chains, executor = db) {
  const allowedChains = [...new Set((Array.isArray(chains) ? chains : [])
    .map((chain) => String(chain || '').trim().toLowerCase())
    .filter(Boolean))];
  if (allowedChains.length === 0) return [];
  const result = await executor.query(
    `SELECT id
     FROM ca_whitelist
     WHERE status = 'active'
       AND live_activation_state = 'live_ready'
       AND chain_id = ANY($1::text[])
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY id`,
    [allowedChains]
  );
  return result.rows.map((row) => Number(row.id));
}

async function resolveActivePolicy(executor = db) {
  const executionChains = getExecutionChains().map((chain) => chain.id);
  const result = await executor.query(
    `WITH acceptance_scope AS (
       SELECT chain, whitelist_id, expires_at
       FROM live_acceptance_scopes
       WHERE status = 'active'
       ORDER BY id DESC LIMIT 1
     )
      SELECT whitelist.id, whitelist.chain_id, trigger.event_types
      FROM ca_whitelist AS whitelist
      JOIN LATERAL (
        SELECT relation.event_types
        FROM x_signal_relations AS relation
        JOIN x_kol_accounts AS actor
          ON actor.id = relation.kol_id AND actor.enabled = true
        WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
        UNION ALL
        SELECT rule.event_types
        FROM x_signal_source_rules AS rule
        JOIN x_kol_accounts AS actor
          ON actor.id = rule.actor_id AND actor.enabled = true
        WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
      ) AS trigger ON true
     JOIN chain_live_readiness AS readiness
       ON readiness.chain = whitelist.chain_id
     WHERE whitelist.status = 'active'
       AND whitelist.live_activation_state = 'live_ready'
       AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
       AND whitelist.chain_id = ANY($1::text[])
       AND (
         (
           EXISTS(SELECT 1 FROM acceptance_scope)
           AND whitelist.id = (SELECT whitelist_id FROM acceptance_scope)
           AND whitelist.chain_id = (SELECT chain FROM acceptance_scope)
           AND (SELECT expires_at FROM acceptance_scope) > NOW()
         )
         OR (
           NOT EXISTS(SELECT 1 FROM acceptance_scope)
           AND readiness.live_enabled = true
         )
       )
      ORDER BY whitelist.id`,
    [executionChains]
  );
  const whitelistIds = [...new Set(result.rows.map((row) => Number(row.id)))];
  const chains = [...new Set(result.rows.map((row) => String(row.chain_id).toLowerCase()))];
  const eventTypes = [...new Set(result.rows.flatMap((row) => row.event_types || []))]
    .filter((eventType) => EVENT_TYPES.has(eventType));
  return { whitelistIds, chains, eventTypes };
}

async function getPolicy(executor = db) {
  const active = await resolveActivePolicy(executor);
  const provider = String(process.env.X_DATA_PROVIDER || '').trim().toLowerCase();
  return {
    providers: provider === '6551' ? [provider] : [],
    eventTypes: active.eventTypes,
    verifiedEventTypes: getVerifiedEventTypes(),
    chains: active.chains,
    whitelistIds: active.whitelistIds,
    maxSignalAgeSeconds: Math.max(1, Number(process.env.SIGNAL_MAX_AGE_SECONDS || 300))
  };
}

async function relationAllowsSignal(signal, executor = db) {
  const relationIds = Array.isArray(signal.matched_relation_ids)
    ? signal.matched_relation_ids.map(Number).filter(Number.isFinite)
    : [];
  if (relationIds.length === 0) return false;
  const result = await executor.query(
    `SELECT 1
     FROM x_signal_relations AS relation
     JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id AND actor.enabled = true
     WHERE relation.id = ANY($1::bigint[])
       AND relation.whitelist_id = $2
       AND relation.enabled = true
       AND $3 = ANY(relation.event_types)
     LIMIT 1`,
    [relationIds, Number(signal.whitelist_id), String(signal.activity_type || '').toLowerCase()]
  );
  return result.rows.length > 0;
}

async function sourceRuleAllowsSignal(signal, executor = db) {
  const sourceRuleIds = Array.isArray(signal.matched_source_rule_ids)
    ? signal.matched_source_rule_ids.map(Number).filter(Number.isFinite)
    : [];
  if (sourceRuleIds.length === 0) return false;
  const result = await executor.query(
    `SELECT 1
     FROM x_signal_source_rules AS rule
     JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id AND actor.enabled = true
     WHERE rule.id = ANY($1::bigint[])
       AND rule.whitelist_id = $2
       AND rule.enabled = true
       AND $3 = ANY(rule.event_types)
     LIMIT 1`,
    [sourceRuleIds, Number(signal.whitelist_id), String(signal.activity_type || '').toLowerCase()]
  );
  return result.rows.length > 0;
}

async function triggerAllowsSignal(signal, executor = db) {
  return await relationAllowsSignal(signal, executor)
    || await sourceRuleAllowsSignal(signal, executor);
}

async function evaluate(signal, options = {}) {
  const executor = options.executor || db;
  if (signal.actor_policy_id && signal.dynamic_target_id) {
    const dynamic = await dynamicAuthorization.evaluateSignal(signal, executor, {
      flags: options.flags,
      skipUsage: Boolean(options.skipDynamicUsage)
    });
    const chain = String(signal.chain_id || '').toLowerCase();
    const readinessResult = await executor.query(
      'SELECT * FROM chain_live_readiness WHERE chain = $1', [chain]
    );
    const readiness = readinessResult.rows[0] || null;
    const blockers = [...dynamic.blockers];
    if (!readiness?.implemented) blockers.push('CHAIN_NOT_IMPLEMENTED');
    if (!readiness?.contract_tested) blockers.push('CHAIN_CONTRACT_NOT_TESTED');
    return { allowed: blockers.length === 0, blockers, policy: dynamic.policy, readiness, dynamic };
  }
  const policy = await getPolicy(executor);
  const blockers = [];
  const provider = String(signal.provider || '').toLowerCase();
  const eventType = String(signal.activity_type || '').toLowerCase();
  const chain = String(signal.chain_id || '').toLowerCase();
  const sourceCreatedAt = signal.source_created_at || signal.signal_source_created_at || null;
  const eventTimestamp = provider === '6551' ? sourceCreatedAt : (sourceCreatedAt || signal.signal_created_at);
  const ageMs = Date.now() - new Date(eventTimestamp).getTime();

  if (!policy.providers.includes(provider)) blockers.push('LIVE_PROVIDER_NOT_ALLOWED');
  if (!policy.eventTypes.includes(eventType)) blockers.push('LIVE_EVENT_NOT_ALLOWED');
  if (!policy.verifiedEventTypes.includes(eventType)) blockers.push('LIVE_EVENT_NOT_VERIFIED');
  if (!policy.chains.includes(chain)) blockers.push('LIVE_CHAIN_NOT_ALLOWED');
  if (!policy.whitelistIds.includes(Number(signal.whitelist_id))) blockers.push('LIVE_WHITELIST_NOT_ALLOWED');
  if (provider === '6551' && !sourceCreatedAt) blockers.push('SOURCE_EVENT_TIME_MISSING');
  const hasRelation = Array.isArray(signal.matched_relation_ids) && signal.matched_relation_ids.length > 0;
  const hasSourceRule = Array.isArray(signal.matched_source_rule_ids)
    && signal.matched_source_rule_ids.length > 0;
  if (!hasRelation && !hasSourceRule) {
    blockers.push('LIVE_EXPLICIT_TRIGGER_REQUIRED');
  } else if (!await triggerAllowsSignal(signal, executor)) {
    blockers.push('LIVE_TRIGGER_EVENT_NOT_ALLOWED');
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.maxSignalAgeSeconds * 1000) {
    blockers.push('SIGNAL_EXPIRED');
  }

  const readinessResult = await executor.query(
    'SELECT * FROM chain_live_readiness WHERE chain = $1',
    [chain]
  );
  const readiness = readinessResult.rows[0] || null;
  if (!readiness?.implemented) blockers.push('CHAIN_NOT_IMPLEMENTED');
  if (!readiness?.contract_tested) blockers.push('CHAIN_CONTRACT_NOT_TESTED');

  const result = { allowed: blockers.length === 0, blockers, policy, readiness, signalAgeMs: ageMs };
  if (options.throwOnFailure && blockers.length > 0) {
    const error = new Error(`Live policy rejected signal: ${blockers.join(', ')}`);
    error.code = blockers[0];
    error.details = result;
    throw error;
  }
  return result;
}

module.exports = {
  evaluate,
  getVerifiedEventTypes,
  getPolicy,
  relationAllowsSignal,
  sourceRuleAllowsSignal,
  triggerAllowsSignal,
  resolveActivePolicy,
  resolveActiveWhitelistIds
};
