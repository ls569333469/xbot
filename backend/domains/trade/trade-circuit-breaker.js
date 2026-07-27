const db = require('../../lib/db');

function normalizedThreshold(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 3;
}

class TradeCircuitBreaker {
  constructor(options = {}) {
    this.db = options.db || db;
  }

  async assertBuyAllowed(chain, executor = this.db) {
    const result = await executor.query(
      `SELECT * FROM chain_trade_circuits WHERE chain = $1 AND state = 'tripped'`,
      [chain]
    );
    if (result.rows[0]) {
      const error = new Error(`New ${chain} buys are paused by the consecutive failure circuit`);
      error.code = 'CHAIN_CONSECUTIVE_FAILURE_LOCK';
      error.details = result.rows[0];
      throw error;
    }
  }

  async recordDefinitiveFailure(chain, attemptId, thresholdValue, executor = this.db) {
    const threshold = normalizedThreshold(thresholdValue);
    await executor.query(
      `INSERT INTO chain_trade_circuits(chain, threshold)
       VALUES ($1,$2) ON CONFLICT (chain) DO NOTHING`,
      [chain, threshold]
    );
    const current = (await executor.query(
      `SELECT * FROM chain_trade_circuits WHERE chain = $1 FOR UPDATE`,
      [chain]
    )).rows[0];
    const failures = Number(current.consecutive_failures || 0) + 1;
    const tripped = failures >= threshold;
    const updated = (await executor.query(
      `UPDATE chain_trade_circuits
       SET state = CASE WHEN $2 THEN 'tripped' ELSE 'open' END,
           consecutive_failures = $3, threshold = $4,
           reason_code = CASE WHEN $2 THEN 'CONSECUTIVE_DEFINITIVE_FAILURES' ELSE reason_code END,
           last_failure_attempt_id = $5, last_failure_at = NOW(),
           tripped_at = CASE WHEN $2 THEN COALESCE(tripped_at, NOW()) ELSE NULL END,
           updated_at = NOW()
       WHERE chain = $1 RETURNING *`,
      [chain, tripped, failures, threshold, attemptId]
    )).rows[0];
    if (tripped && current.state !== 'tripped') {
      await executor.query(
        `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
         VALUES ('trade.chain_failure_circuit_tripped','chain',$1,$2)`,
        [chain, {
          chain,
          consecutive_failures: failures,
          threshold,
          last_failure_attempt_id: attemptId
        }]
      );
    }
    return updated;
  }

  async recordConfirmedTrade(chain, attemptId, executor = this.db) {
    const current = (await executor.query(
      `SELECT * FROM chain_trade_circuits WHERE chain = $1 FOR UPDATE`,
      [chain]
    )).rows[0];
    if (!current) return null;
    const updated = (await executor.query(
      `UPDATE chain_trade_circuits
       SET state = 'open', consecutive_failures = 0, reason_code = NULL,
           tripped_at = NULL, last_success_attempt_id = $2,
           last_success_at = NOW(), updated_at = NOW()
       WHERE chain = $1 RETURNING *`,
      [chain, attemptId]
    )).rows[0];
    if (current.state === 'tripped') {
      await executor.query(
        `INSERT INTO notification_outbox(topic, aggregate_type, aggregate_id, payload)
         VALUES ('trade.chain_failure_circuit_recovered','chain',$1,$2)`,
        [chain, { chain, confirmed_attempt_id: attemptId }]
      );
    }
    return updated;
  }

  async reset({ chain, operator, reason }) {
    if (!String(operator || '').trim() || !String(reason || '').trim()) {
      const error = new Error('Operator and reason are required to reset a chain failure circuit');
      error.code = 'CHAIN_CIRCUIT_AUDIT_REQUIRED';
      throw error;
    }
    const result = await this.db.query(
      `UPDATE chain_trade_circuits
       SET state = 'open', consecutive_failures = 0, reason_code = NULL,
           tripped_at = NULL, reset_at = NOW(), reset_by = $2,
           reset_reason = $3, updated_at = NOW()
       WHERE chain = $1 AND state = 'tripped' RETURNING *`,
      [chain, operator, reason]
    );
    if (!result.rows[0]) {
      const error = new Error('Active chain failure circuit was not found');
      error.code = 'CHAIN_CIRCUIT_NOT_TRIPPED';
      throw error;
    }
    return result.rows[0];
  }

  async list() {
    const result = await this.db.query(
      `SELECT * FROM chain_trade_circuits ORDER BY chain`
    );
    return result.rows;
  }
}

const tradeCircuitBreaker = new TradeCircuitBreaker();

module.exports = { TradeCircuitBreaker, normalizedThreshold, tradeCircuitBreaker };
