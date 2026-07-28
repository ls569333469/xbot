const db = require('../../lib/db');

function normalizedWallet(chain, walletAddress) {
  const value = String(walletAddress || '').trim();
  return chain === 'sol' ? value : value.toLowerCase();
}

function laneKey(chain, walletAddress) {
  return `wallet_lane:${String(chain).toLowerCase()}:${normalizedWallet(chain, walletAddress)}`;
}

function laneError(code, message, details) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

class WalletWriteLane {
  constructor(options = {}) {
    this.db = options.db || db;
    this.leaseMs = Math.max(5000, Number(options.leaseMs || 30000));
  }

  async acquireInTransaction(executor, { chain, walletAddress, attemptId }) {
    const address = normalizedWallet(chain, walletAddress);
    const key = laneKey(chain, address);
    await executor.query(
      `INSERT INTO wallet_write_lanes(chain, wallet_address, lane_key)
       VALUES ($1,$2,$3) ON CONFLICT (chain, wallet_address) DO NOTHING`,
      [chain, address, key]
    );
    const result = await executor.query(
      `SELECT * FROM wallet_write_lanes
       WHERE chain = $1 AND wallet_address = $2 FOR UPDATE`,
      [chain, address]
    );
    const current = result.rows[0];
    if (current.state === 'quarantined') {
      throw laneError('WALLET_QUARANTINED', 'Wallet funds writes are quarantined', current);
    }
    if (current.state !== 'idle'
        && Number(current.owner_attempt_id) !== Number(attemptId)) {
      throw laneError('WALLET_WRITE_LANE_BUSY', 'Another funds write owns this wallet lane', current);
    }
    const acquired = await executor.query(
      `UPDATE wallet_write_lanes
       SET state = 'submitting', owner_attempt_id = $3, reason_code = NULL,
           evidence_json = '{}'::jsonb, released_at = NULL, released_by = NULL,
           release_reason = NULL,
           lease_expires_at = NOW() + ($4::double precision * interval '1 millisecond'),
           updated_at = NOW()
       WHERE chain = $1 AND wallet_address = $2 RETURNING *`,
      [chain, address, attemptId, this.leaseMs]
    );
    return acquired.rows[0];
  }

  async acquire({ chain, walletAddress, attemptId }) {
    const client = await this.db.pool.connect();
    const address = normalizedWallet(chain, walletAddress);
    const key = laneKey(chain, address);
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO wallet_write_lanes(chain, wallet_address, lane_key)
         VALUES ($1,$2,$3) ON CONFLICT (chain, wallet_address) DO NOTHING`,
        [chain, address, key]
      );
      const result = await client.query(
        `SELECT * FROM wallet_write_lanes
         WHERE chain = $1 AND wallet_address = $2 FOR UPDATE`,
        [chain, address]
      );
      const current = result.rows[0];
      if (current.state === 'quarantined') {
        throw laneError('WALLET_QUARANTINED', 'Wallet funds writes are quarantined', current);
      }
      if (current.state === 'submitting' && Number(current.owner_attempt_id) !== Number(attemptId)) {
        if (current.lease_expires_at && new Date(current.lease_expires_at).getTime() <= Date.now()) {
          const owner = await client.query(
            `SELECT attempt.status,
                    EXISTS(
                      SELECT 1 FROM trade_orders AS orders
                      WHERE orders.attempt_id = attempt.id
                        AND orders.provider_order_id IS NOT NULL
                    ) AS order_persisted
             FROM trade_attempts AS attempt WHERE attempt.id = $1`,
            [current.owner_attempt_id]
          );
          const ownerResolved = !current.owner_attempt_id
            || Boolean(owner.rows[0]?.order_persisted)
            || ['confirmed', 'definitive_failed_no_fill', 'rejected', 'failed', 'superseded']
              .includes(owner.rows[0]?.status);
          if (ownerResolved) {
            await client.query(
              `UPDATE wallet_write_lanes
               SET state = 'idle', owner_attempt_id = NULL, lease_expires_at = NULL,
                   released_at = NOW(), released_by = 'system',
                   release_reason = 'STALE_LEASE_WITH_PERSISTED_RESULT',
                   reason_code = NULL, evidence_json = '{}'::jsonb, updated_at = NOW()
               WHERE chain = $1 AND wallet_address = $2`,
              [chain, address]
            );
          } else {
          const quarantined = await client.query(
            `UPDATE wallet_write_lanes
             SET state = 'quarantined', reason_code = 'STALE_WRITE_LEASE',
                 evidence_json = evidence_json || $3::jsonb, quarantined_at = NOW(),
                 lease_expires_at = NULL, updated_at = NOW()
             WHERE chain = $1 AND wallet_address = $2 RETURNING *`,
            [chain, address, { previous_owner_attempt_id: current.owner_attempt_id }]
          );
          await client.query('COMMIT');
          throw laneError('WALLET_QUARANTINED', 'A stale funds write was quarantined', quarantined.rows[0]);
          }
        } else {
          throw laneError('WALLET_WRITE_LANE_BUSY', 'Another funds write owns this wallet lane', current);
        }
      }
      const acquired = await client.query(
        `UPDATE wallet_write_lanes
         SET state = 'submitting', owner_attempt_id = $3, reason_code = NULL,
             evidence_json = '{}'::jsonb, released_at = NULL, released_by = NULL,
             release_reason = NULL,
             lease_expires_at = NOW() + ($4::double precision * interval '1 millisecond'),
             updated_at = NOW()
         WHERE chain = $1 AND wallet_address = $2 RETURNING *`,
        [chain, address, attemptId, this.leaseMs]
      );
      await client.query('COMMIT');
      return acquired.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async release(attemptId, reason = 'WRITE_RESPONSE_PERSISTED') {
    const result = await this.db.query(
      `UPDATE wallet_write_lanes
       SET state = 'idle', owner_attempt_id = NULL, lease_expires_at = NULL,
           released_at = NOW(), released_by = 'system', release_reason = $2,
           reason_code = NULL, evidence_json = '{}'::jsonb, updated_at = NOW()
       WHERE owner_attempt_id = $1 AND state = 'submitting' RETURNING *`,
      [attemptId, reason]
    );
    return result.rows[0] || null;
  }

  async quarantine(attempt, reasonCode, evidence = {}) {
    const chain = attempt.chain;
    const address = normalizedWallet(chain, attempt.wallet_address || attempt.walletAddress);
    const key = laneKey(chain, address);
    const result = await this.db.query(
      `INSERT INTO wallet_write_lanes(
         chain, wallet_address, lane_key, state, owner_attempt_id,
         reason_code, evidence_json, quarantined_at
       ) VALUES ($1,$2,$3,'quarantined',$4,$5,$6,NOW())
       ON CONFLICT (chain, wallet_address) DO UPDATE
       SET state = 'quarantined', owner_attempt_id = EXCLUDED.owner_attempt_id,
           reason_code = EXCLUDED.reason_code, evidence_json = EXCLUDED.evidence_json,
           quarantined_at = COALESCE(wallet_write_lanes.quarantined_at, NOW()),
           lease_expires_at = NULL, updated_at = NOW()
       WHERE wallet_write_lanes.state <> 'quarantined'
          OR wallet_write_lanes.owner_attempt_id = EXCLUDED.owner_attempt_id
       RETURNING *`,
      [chain, address, key, attempt.id, reasonCode, evidence]
    );
    if (result.rows[0]) return result.rows[0];
    const current = await this.db.query(
      `SELECT * FROM wallet_write_lanes WHERE chain = $1 AND wallet_address = $2`,
      [chain, address]
    );
    return current.rows[0] || null;
  }

  async settleSubmittedOrder(attempt, normalizedOrder) {
    const terminalWithoutHash = ['failed', 'expired'].includes(normalizedOrder?.status)
      && !normalizedOrder?.txHash;
    if (terminalWithoutHash) {
      return this.quarantine(attempt, 'NO_HASH_FAILURE_EVIDENCE_PENDING', {
        provider_status: normalizedOrder.providerStatus || normalizedOrder.status,
        provider_order_id: normalizedOrder.providerOrderId || null
      });
    }
    return this.release(attempt.id);
  }

  async resolveEvidenceQuarantine(attemptId, executor = this.db) {
    const result = await executor.query(
      `UPDATE wallet_write_lanes
       SET state = 'idle', owner_attempt_id = NULL, reason_code = NULL,
           evidence_json = '{}'::jsonb, lease_expires_at = NULL,
           released_at = NOW(), released_by = 'system',
           release_reason = 'DEFINITIVE_FAILURE_EVIDENCE_COMPLETE', updated_at = NOW()
       WHERE owner_attempt_id = $1 AND state = 'quarantined'
         AND reason_code = 'NO_HASH_FAILURE_EVIDENCE_PENDING'
       RETURNING *`,
      [attemptId]
    );
    return result.rows[0] || null;
  }

  async releaseQuarantine({ chain, walletAddress, operator, reason, evidence }) {
    if (!String(operator || '').trim() || !String(reason || '').trim() || !evidence) {
      throw laneError('WALLET_QUARANTINE_AUDIT_REQUIRED', 'Operator, reason, and evidence are required');
    }
    const client = await this.db.pool.connect();
    const address = normalizedWallet(chain, walletAddress);
    try {
      await client.query('BEGIN');
      const current = await client.query(
        `SELECT * FROM wallet_write_lanes
         WHERE chain = $1 AND wallet_address = $2 AND state = 'quarantined'
         FOR UPDATE`,
        [chain, address]
      );
      if (!current.rows[0]) throw laneError('WALLET_QUARANTINE_NOT_FOUND', 'Active wallet quarantine not found');
      const released = await client.query(
        `UPDATE wallet_write_lanes
         SET state = 'idle', owner_attempt_id = NULL, reason_code = NULL,
             evidence_json = $4, lease_expires_at = NULL, released_at = NOW(),
             released_by = $3, release_reason = $5, updated_at = NOW()
         WHERE chain = $1 AND wallet_address = $2 AND state = 'quarantined'
         RETURNING *`,
        [chain, address, operator, evidence, reason]
      );
      await client.query(
        `INSERT INTO trade_reconciliation_incidents(
           attempt_id, intent_id, incident_type, severity, status, details_json,
           resolved_at, resolved_by, resolution
         )
         VALUES (
           $1,
           (SELECT intent_id FROM trade_attempts WHERE id = $1),
           'manual_lane_release','high','resolved',$2,NOW(),$3,$4
         )`,
        [current.rows[0].owner_attempt_id, evidence, operator, reason]
      );
      await client.query('COMMIT');
      return released.rows[0];
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async recoverStaleSubmissions() {
    await this.db.query(
      `UPDATE wallet_write_lanes AS lane
       SET state = 'idle', owner_attempt_id = NULL, lease_expires_at = NULL,
           released_at = NOW(), released_by = 'system',
           release_reason = 'STALE_LEASE_WITH_PERSISTED_RESULT',
           reason_code = NULL, evidence_json = '{}'::jsonb, updated_at = NOW()
       FROM trade_attempts AS attempt
       WHERE lane.owner_attempt_id = attempt.id
         AND lane.state = 'submitting' AND lane.lease_expires_at <= NOW()
         AND (
           attempt.status IN('confirmed','definitive_failed_no_fill','rejected','failed','superseded')
           OR EXISTS(
             SELECT 1 FROM trade_orders AS orders
             WHERE orders.attempt_id = attempt.id AND orders.provider_order_id IS NOT NULL
           )
         )`
    );
    const result = await this.db.query(
      `WITH stale AS (
         UPDATE wallet_write_lanes
         SET state = 'quarantined', reason_code = 'STALE_WRITE_LEASE',
             evidence_json = evidence_json || jsonb_build_object('recovered_at', NOW()),
             quarantined_at = COALESCE(quarantined_at, NOW()),
             lease_expires_at = NULL, updated_at = NOW()
         WHERE state = 'submitting' AND lease_expires_at <= NOW()
         RETURNING owner_attempt_id
       )
       UPDATE trade_attempts AS attempt
       SET status = 'submission_uncertain', error_code = 'STALE_WRITE_LEASE',
           requires_manual_review = true, updated_at = NOW()
       FROM stale WHERE attempt.id = stale.owner_attempt_id
         AND attempt.status IN('reserved','preparing','submitting','submission_uncertain')
       RETURNING attempt.*`
    );
    if (result.rows.length > 0) {
      await this.db.query(
        `UPDATE trade_intents AS intent
         SET status = 'uncertain', last_error_code = 'STALE_WRITE_LEASE', updated_at = NOW()
         FROM trade_attempts AS attempt
         WHERE attempt.intent_id = intent.id AND attempt.id = ANY($1::bigint[])`,
        [result.rows.map((row) => row.id)]
      );
    }
    return result.rows;
  }

  async list() {
    const result = await this.db.query(
      `SELECT *, CASE WHEN length(wallet_address) > 14
        THEN left(wallet_address, 6) || '...' || right(wallet_address, 4)
        ELSE wallet_address END AS wallet_masked
       FROM wallet_write_lanes ORDER BY updated_at DESC`
    );
    return result.rows;
  }
}

const walletWriteLane = new WalletWriteLane();

module.exports = { WalletWriteLane, laneKey, normalizedWallet, walletWriteLane };
