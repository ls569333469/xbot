const db = require('../../lib/db');
const dynamicAuthorization = require('../dynamic-signal/dynamic-authorization');
const followAuthorization = require('../follow-discovery/authorization');

function kind(signal) {
  if (signal?.actor_policy_id && signal?.dynamic_target_id) return 'dynamic';
  if (signal?.follow_discovery_policy_id && signal?.follow_discovery_event_id) return 'follow_discovery';
  return null;
}

function scoped(signal) {
  return kind(signal) !== null;
}

async function evaluateSignal(signal, executor = db, options = {}) {
  if (kind(signal) === 'dynamic') return dynamicAuthorization.evaluateSignal(signal, executor, options);
  if (kind(signal) === 'follow_discovery') return followAuthorization.evaluateSignal(signal, executor, options);
  return { allowed: true, blockers: [], policy: null };
}

async function reserveUsage(signal, executor = db) {
  if (kind(signal) === 'dynamic') return dynamicAuthorization.reserveUsage(signal, executor);
  if (kind(signal) === 'follow_discovery') return followAuthorization.reserveUsage(signal, executor);
  return null;
}

async function signalKind(signalId, executor = db) {
  const result = await executor.query(
    `SELECT actor_policy_id, dynamic_target_id,
            follow_discovery_policy_id, follow_discovery_event_id
     FROM trade_signals WHERE id = $1`, [Number(signalId)]
  );
  return kind(result.rows[0]);
}

async function commitUsage(signalId, amount, executor = db) {
  const value = await signalKind(signalId, executor);
  if (value === 'dynamic') return dynamicAuthorization.commitUsage(signalId, amount, executor);
  if (value === 'follow_discovery') return followAuthorization.commitUsage(signalId, amount, executor);
  return false;
}

async function releaseUsage(signalId, executor = db) {
  const value = await signalKind(signalId, executor);
  if (value === 'dynamic') return dynamicAuthorization.releaseUsage(signalId, executor);
  if (value === 'follow_discovery') return followAuthorization.releaseUsage(signalId, executor);
  return false;
}

async function releaseUsageByAttempt(attemptId, executor = db) {
  const result = await executor.query('SELECT signal_id FROM trade_attempts WHERE id = $1', [Number(attemptId)]);
  return result.rows[0]?.signal_id ? releaseUsage(result.rows[0].signal_id, executor) : false;
}

module.exports = {
  commitUsage, evaluateSignal, kind, releaseUsage, releaseUsageByAttempt, reserveUsage, scoped
};
