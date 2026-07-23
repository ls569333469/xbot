const configService = require('../config/service');
const db = require('../../lib/db');

const EVENT_TYPES = new Set(['tweet', 'retweet', 'quote', 'reply', 'follow']);

function parseVerifiedEventTypes(value = process.env.P8_VERIFIED_LIVE_EVENT_TYPES) {
  return [...new Set(String(value || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => EVENT_TYPES.has(item)))];
}

async function getPolicy() {
  const configured = await configService.get('live_policy');
  return {
    providers: Array.isArray(configured?.providers) ? configured.providers : [],
    eventTypes: Array.isArray(configured?.event_types) ? configured.event_types : [],
    verifiedEventTypes: parseVerifiedEventTypes(),
    chains: Array.isArray(configured?.chains) ? configured.chains : [],
    whitelistIds: Array.isArray(configured?.whitelist_ids) ? configured.whitelist_ids.map(Number) : [],
    maxSignalAgeSeconds: Math.max(1, Number(configured?.max_signal_age_seconds || process.env.SIGNAL_MAX_AGE_SECONDS || 300))
  };
}

async function evaluate(signal, options = {}) {
  const policy = await getPolicy();
  const blockers = [];
  const provider = String(signal.provider || '').toLowerCase();
  const eventType = String(signal.activity_type || '').toLowerCase();
  const chain = String(signal.chain_id || '').toLowerCase();
  const ageMs = Date.now() - new Date(signal.signal_created_at).getTime();

  if (!policy.providers.includes(provider)) blockers.push('LIVE_PROVIDER_NOT_ALLOWED');
  if (!policy.eventTypes.includes(eventType)) blockers.push('LIVE_EVENT_NOT_ALLOWED');
  if (!policy.verifiedEventTypes.includes(eventType)) blockers.push('LIVE_EVENT_NOT_VERIFIED');
  if (!policy.chains.includes(chain)) blockers.push('LIVE_CHAIN_NOT_ALLOWED');
  if (!policy.whitelistIds.includes(Number(signal.whitelist_id))) blockers.push('LIVE_WHITELIST_NOT_ALLOWED');
  if (!Array.isArray(signal.matched_relation_ids) || signal.matched_relation_ids.length === 0) {
    blockers.push('LIVE_EXPLICIT_RELATION_REQUIRED');
  }
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > policy.maxSignalAgeSeconds * 1000) {
    blockers.push('SIGNAL_EXPIRED');
  }

  const readinessResult = await db.query(
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

module.exports = { evaluate, getPolicy, parseVerifiedEventTypes };
