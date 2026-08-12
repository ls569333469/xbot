const db = require('../../lib/db');
const { enqueueEntityEvent } = require('../../lib/entity-outbox');

const DEFAULT_LEASE_MS = 30_000;

async function claimNext(workerId, options = {}) {
  const executor = options.db || db;
  const leaseMs = Math.max(5_000, Number(options.leaseMs || DEFAULT_LEASE_MS));
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `WITH due AS (
         SELECT id FROM asset_metadata
         WHERE next_attempt_at <= NOW()
           AND (
             status IN ('pending','failed')
             OR (status = 'processing'
               AND locked_at < NOW() - ($1::bigint * INTERVAL '1 millisecond'))
           )
         ORDER BY next_attempt_at ASC, id ASC
         FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE asset_metadata AS asset
       SET status = 'processing', locked_at = NOW(), locked_by = $2,
           attempt_count = attempt_count + 1, updated_at = NOW()
       FROM due WHERE asset.id = due.id
       RETURNING asset.*`,
      [leaseMs, workerId]
    );
    await client.query('COMMIT');
    return result.rows[0] || null;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function complete(asset, metadata, workerId, options = {}) {
  const executor = options.db || db;
  const client = await executor.pool.connect();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE asset_metadata
       SET name = $3, symbol = $4, logo_url = $5, decimals = $6,
           status = 'completed', provider_snapshot = $7, fetched_at = NOW(),
           last_error = NULL, locked_at = NULL, locked_by = NULL, updated_at = NOW()
       WHERE id = $1 AND status = 'processing' AND locked_by = $2
       RETURNING *`,
      [asset.id, workerId, metadata.name, metadata.symbol, metadata.logoUrl,
        metadata.decimals, metadata.raw || {}]
    );
    if (!updated.rows[0]) {
      const error = new Error('Asset metadata lease was lost before completion');
      error.code = 'ASSET_METADATA_LEASE_LOST';
      throw error;
    }
    const signals = await client.query(
      `SELECT signal.id FROM trade_signals AS signal
       JOIN ca_whitelist AS whitelist ON whitelist.id = signal.whitelist_id
       WHERE lower(whitelist.chain_id) = $1
         AND CASE WHEN lower(whitelist.chain_id) = 'sol'
           THEN whitelist.contract_address = $2
           ELSE lower(whitelist.contract_address) = $2 END`,
      [asset.chain_id, asset.contract_address_key]
    );
    const positions = await client.query(
      `SELECT id FROM positions
       WHERE lower(chain_id) = $1
         AND CASE WHEN lower(chain_id) = 'sol'
           THEN contract_address = $2 ELSE lower(contract_address) = $2 END`,
      [asset.chain_id, asset.contract_address_key]
    );
    const transitionKey = `gmgn-metadata:${asset.id}:${asset.attempt_count}`;
    for (const row of signals.rows) {
      await enqueueEntityEvent(client, 'signal', row.id, 'updated', transitionKey);
    }
    for (const row of positions.rows) {
      await enqueueEntityEvent(client, 'position', row.id, 'updated', transitionKey);
    }
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function fail(asset, error, workerId, nextAttemptAt, options = {}) {
  const executor = options.db || db;
  await executor.query(
    `UPDATE asset_metadata
     SET status = 'failed', last_error = $3, next_attempt_at = $4,
         locked_at = NULL, locked_by = NULL, updated_at = NOW()
     WHERE id = $1 AND status = 'processing' AND locked_by = $2`,
    [asset.id, workerId, String(error.code || error.message || 'GMGN_METADATA_FAILED').slice(0, 500),
      nextAttemptAt]
  );
}

module.exports = { DEFAULT_LEASE_MS, claimNext, complete, fail };
