const db = require('../../lib/db');
const notifier = require('../../lib/notifier');
const { getTradingMode } = require('../../lib/runtime-mode');
const {
  assetSnapshot,
  authorizationSnapshot,
  strategyType,
  tradeConfigSnapshot
} = require('./contract-snapshot');
const { enqueueEntityEvent } = require('../../lib/entity-outbox');

async function getSignals(filters) {
  let query = 'SELECT * FROM trade_signals WHERE 1=1';
  let params = [];
  let paramIndex = 1;

  if (filters.status) {
    query += ` AND status = $${paramIndex++}`;
    params.push(filters.status);
  }
  
  query += ' ORDER BY created_at DESC LIMIT 50';
  const res = await db.query(query, params);
  return res.rows;
}

async function insertSignal(data, executor) {
  const executionMode = data.execution_mode || getTradingMode();
  const status = executionMode === 'signal' ? 'signal_only' : (data.status || 'recorded');
  const snapshotInput = { ...data, execution_mode: executionMode };
  const signalStrategyType = strategyType(snapshotInput);
  const configSnapshot = tradeConfigSnapshot(
    snapshotInput,
    data.trade_config_snapshot_source || `${signalStrategyType}_signal`
  );
  const params = [
    data.activity_id,
    data.whitelist_id,
    data.kol_id,
    data.kol_handle,
    data.signal_type,
    data.match_detail,
    executionMode,
    status,
    data.canonical_key,
    data.matched_project_handles || [],
    data.matched_whitelist_ids || [data.whitelist_id],
    data.matched_relation_ids || [],
    data.matched_source_rule_ids || [],
    data.reject_reason || null,
    data.activation_wait_version || null,
    data.trace_id || null,
    signalStrategyType,
    assetSnapshot(snapshotInput),
    authorizationSnapshot(snapshotInput, signalStrategyType)
  ];

  if (data.follow_once) {
    const onceRes = await executor.query(
      `INSERT INTO x_follow_signal_once
        (kol_id, ca_id, source_target_x_handle, first_activity_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (kol_id, ca_id) DO NOTHING
       RETURNING id`,
      [data.kol_id, data.whitelist_id, data.match_detail, data.activity_id]
    );
    if (onceRes.rows.length === 0) return null;

    const res = await executor.query(
      `INSERT INTO trade_signals
        (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail,
         execution_mode, status, canonical_key, matched_project_handles, matched_whitelist_ids,
         matched_relation_ids, matched_source_rule_ids, reject_reason, activation_wait_version, trace_id,
         strategy_type, trade_config_snapshot, asset_snapshot, authorization_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
         $17, $18, $19, $20)
       ON CONFLICT DO NOTHING
       RETURNING *`,
      [
        ...params.slice(0, 17),
        configSnapshot,
        ...params.slice(17)
      ]
    );
    const signal = res.rows[0] || null;
    if (signal) {
      await executor.query(
        'UPDATE x_follow_signal_once SET signal_id = $1 WHERE id = $2',
        [signal.id, onceRes.rows[0].id]
      );
      await enqueueEntityEvent(executor, 'signal', signal.id, 'created', `created:${signal.status}`);
    }
    return signal;
  }

  const res = await executor.query(
    `INSERT INTO trade_signals
      (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail,
       execution_mode, status, canonical_key, matched_project_handles, matched_whitelist_ids,
       matched_relation_ids, matched_source_rule_ids, reject_reason, activation_wait_version, trace_id,
       strategy_type, trade_config_snapshot, asset_snapshot, authorization_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
       $17, $18, $19, $20)
     ON CONFLICT DO NOTHING
     RETURNING *`,
     [
       ...params.slice(0, 17),
       configSnapshot,
       ...params.slice(17)
     ]
  );
  const signal = res.rows[0] || null;
  if (signal) await enqueueEntityEvent(executor, 'signal', signal.id, 'created', `created:${signal.status}`);
  return signal;
}

async function createSignal(data, executor = db, options = {}) {
  let signal;
  if (data.follow_once && executor === db) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      signal = await insertSignal(data, client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  } else {
    signal = await insertSignal(data, executor);
  }

  const hydratedSignal = signal ? {
    ...signal,
    contract_address: data.contract_address,
    chain_id: data.chain_id
  } : null;
  if (hydratedSignal && options.notify !== false) notifier.signalMatched(hydratedSignal);
  return hydratedSignal;
}

async function getStats() {
  const res = await db.query('SELECT status, COUNT(*) as count FROM trade_signals GROUP BY status');
  return res.rows;
}

module.exports = { getSignals, createSignal, getStats };
