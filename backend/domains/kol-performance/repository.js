const db = require('../../lib/db');
const { REPLAY_PROVIDER_VERSION, addressKey } = require('./constants');

function limit(value, fallback = 50) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(100, parsed) : fallback;
}

function createKolPerformanceRepository(executor = db) {
  return {
    async findActiveRun(mode, actorHandle) {
      const result = await executor.query(
        `SELECT * FROM kol_performance_runs
         WHERE mode = $1 AND actor_handle = $2
           AND status IN ('pending', 'extracting', 'pricing')
         ORDER BY created_at DESC LIMIT 1`,
        [mode, actorHandle]
      );
      return result.rows[0] || null;
    },

    async insertRun(input) {
      const result = await executor.query(
        `INSERT INTO kol_performance_runs
          (mode, actor_handle, sample_started_at, sample_ended_at, as_of_at)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [input.mode, input.actor_handle, input.sample_started_at || null,
          input.sample_ended_at || null, input.as_of_at]
      );
      return result.rows[0];
    },

    async listRuns(mode, requestedLimit) {
      const result = await executor.query(
        `SELECT run.*,
           COUNT(asset.id)::int AS unique_ca_count,
           COUNT(asset.id) FILTER (WHERE asset.price_status = 'completed')::int AS price_ready_count
         FROM kol_performance_runs AS run
         LEFT JOIN kol_performance_assets AS asset ON asset.run_id = run.id
         WHERE run.mode = $1
         GROUP BY run.id
         ORDER BY run.created_at DESC LIMIT $2`,
        [mode, limit(requestedLimit)]
      );
      return result.rows;
    },

    async getRun(runId) {
      const runResult = await executor.query(
        'SELECT * FROM kol_performance_runs WHERE id = $1', [Number(runId)]
      );
      const run = runResult.rows[0];
      if (!run) return null;
      const [eventsResult, assetsResult] = await Promise.all([
        executor.query(
          `SELECT * FROM kol_performance_events
           WHERE run_id = $1 ORDER BY source_occurred_at ASC, id ASC`, [run.id]
        ),
        executor.query(
          `SELECT asset.*, event.source_type, event.source_id, event.source_url,
                  event.target_handle, event.source_occurred_at, event.evidence_json
           FROM kol_performance_assets AS asset
           JOIN kol_performance_events AS event ON event.id = asset.first_event_id
           WHERE asset.run_id = $1 ORDER BY event.source_occurred_at ASC, asset.id ASC`, [run.id]
        )
      ]);
      return { ...run, events: eventsResult.rows, assets: assetsResult.rows };
    },

    async claimNextRun() {
      const result = await executor.query(
        `WITH candidate AS (
           SELECT id FROM kol_performance_runs
           WHERE status = 'pending'
           ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE kol_performance_runs AS run
         SET status = 'extracting', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         FROM candidate WHERE run.id = candidate.id
         RETURNING run.*`
      );
      return result.rows[0] || null;
    },

    async setRunStatus(runId, status, details = {}) {
      const terminal = [
        'completed', 'no_samples', 'partial', 'price_retry', 'price_unavailable', 'failed'
      ].includes(status);
      const result = await executor.query(
        `UPDATE kol_performance_runs
         SET status = $2, metrics = COALESCE($3::jsonb, metrics),
             reason_codes = COALESCE($4::text[], reason_codes), error_code = $5,
             last_error = $6, completed_at = CASE WHEN $7 THEN NOW() ELSE NULL END,
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [Number(runId), status, details.metrics === undefined ? null : JSON.stringify(details.metrics),
          details.reason_codes === undefined ? null : details.reason_codes, details.error_code || null,
          details.last_error || null, terminal]
      );
      return result.rows[0] || null;
    },

    async updateRunProgress(runId, progress = {}) {
      const result = await executor.query(
        `UPDATE kol_performance_runs
         SET metrics = jsonb_set(COALESCE(metrics, '{}'::jsonb), '{progress}', $2::jsonb, true),
             updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'extracting', 'pricing')
         RETURNING metrics, updated_at`,
        [Number(runId), JSON.stringify({ ...progress, updated_at: new Date().toISOString() })]
      );
      return result.rows[0] || null;
    },

    async insertEvent(event) {
      const result = await executor.query(
        `INSERT INTO kol_performance_events
          (run_id, source_type, source_id, source_url, target_handle, source_occurred_at,
           content_snapshot, extraction_status, chain_id, contract_address,
           contract_address_key, token_name, token_symbol, evidence_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (run_id, source_type, source_id, contract_address_key) DO NOTHING
         RETURNING *`,
        [event.run_id, event.source_type, event.source_id, event.source_url || null,
          event.target_handle || null, event.source_occurred_at,
          JSON.stringify(event.content_snapshot || {}), event.extraction_status,
          event.chain_id || null, event.contract_address || null,
          event.contract_address_key || null, event.token_name || null,
          event.token_symbol || null, JSON.stringify(event.evidence_json || {})]
      );
      return result.rows[0] || null;
    },

    async createAssetsFromResolvedEvents(runId) {
      const result = await executor.query(
        `INSERT INTO kol_performance_assets
          (run_id, first_event_id, chain_id, contract_address, contract_address_key,
           token_name, token_symbol)
         SELECT DISTINCT ON (event.chain_id, event.contract_address_key)
           event.run_id, event.id, event.chain_id, event.contract_address,
           event.contract_address_key, event.token_name, event.token_symbol
         FROM kol_performance_events AS event
         WHERE event.run_id = $1 AND event.extraction_status = 'resolved'
           AND event.chain_id IS NOT NULL AND event.contract_address_key IS NOT NULL
         ORDER BY event.chain_id, event.contract_address_key, event.source_occurred_at ASC, event.id ASC
         ON CONFLICT (run_id, chain_id, contract_address_key) DO UPDATE
           SET token_name = COALESCE(kol_performance_assets.token_name, EXCLUDED.token_name),
               token_symbol = COALESCE(kol_performance_assets.token_symbol, EXCLUDED.token_symbol),
               updated_at = NOW()
         RETURNING *`,
        [Number(runId)]
      );
      return result.rows;
    },

    async listAssets(runId) {
      const result = await executor.query(
        `SELECT asset.*, event.source_type, event.source_id, event.source_url,
                event.target_handle, event.source_occurred_at, event.evidence_json
         FROM kol_performance_assets AS asset
         JOIN kol_performance_events AS event ON event.id = asset.first_event_id
         WHERE asset.run_id = $1 ORDER BY event.source_occurred_at ASC, asset.id ASC`,
        [Number(runId)]
      );
      return result.rows;
    },

    async updateAssetPrice(assetId, price) {
      const result = await executor.query(
        `UPDATE kol_performance_assets
         SET entry_price = $2, entry_candle_at = $3, peak_price = $4,
             peak_candle_at = $5, peak_multiple = $6, price_status = $7,
             price_error_code = $8, price_error_detail = $9,
             price_attempt_count = price_attempt_count + 1, provider_snapshot = $10,
             updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [Number(assetId), price.entry_price ?? null, price.entry_candle_at || null,
          price.peak_price ?? null, price.peak_candle_at || null,
          price.peak_multiple ?? null, price.price_status, price.price_error_code || null,
          price.price_error_detail || null, JSON.stringify(price.provider_snapshot || {})]
      );
      return result.rows[0] || null;
    },

    async updateAssetMetadata(assetId, metadata = {}) {
      const result = await executor.query(
        `UPDATE kol_performance_assets
         SET token_name = COALESCE(token_name, $2), token_symbol = COALESCE(token_symbol, $3),
             updated_at = NOW() WHERE id = $1 RETURNING *`,
        [Number(assetId), metadata.name || null, metadata.symbol || null]
      );
      return result.rows[0] || null;
    },

    async retryPrices(runId) {
      const updated = await executor.query(
        `UPDATE kol_performance_assets SET price_status = 'pending', price_error_code = NULL,
             price_error_detail = NULL, updated_at = NOW()
         WHERE run_id = $1 AND price_status IN ('pending', 'retry', 'no_data', 'failed') RETURNING id`, [Number(runId)]
      );
      if (updated.rows.length === 0) return false;
      await executor.query(
        `UPDATE kol_performance_runs SET status = 'pending', error_code = NULL,
             last_error = NULL, completed_at = NULL, metrics = metrics - 'progress',
             updated_at = NOW() WHERE id = $1`, [Number(runId)]
      );
      return true;
    },

    async getReplayCache({ chain_id, contract_address, resolution, from_unix, to_unix }) {
      const result = await executor.query(
        `SELECT rows_json FROM kol_price_replay_cache
         WHERE chain_id = $1 AND contract_address_key = $2 AND resolution = $3
           AND from_unix = $4 AND to_unix = $5 AND provider_version = $6`,
        [chain_id, addressKey(chain_id, contract_address), resolution, from_unix, to_unix,
          REPLAY_PROVIDER_VERSION]
      );
      return result.rows[0]?.rows_json || null;
    },

    async putReplayCache({ chain_id, contract_address, resolution, from_unix, to_unix, rows }) {
      await executor.query(
        `INSERT INTO kol_price_replay_cache
          (chain_id, contract_address_key, resolution, from_unix, to_unix, provider_version, rows_json)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (chain_id, contract_address_key, resolution, from_unix, to_unix, provider_version)
         DO UPDATE SET rows_json = EXCLUDED.rows_json, fetched_at = NOW()`,
        [chain_id, addressKey(chain_id, contract_address), resolution, from_unix, to_unix,
          REPLAY_PROVIDER_VERSION, JSON.stringify(rows || [])]
      );
    },

    async findMetadata(chainId, contractAddress) {
      const result = await executor.query(
        `SELECT name, symbol FROM asset_metadata
         WHERE chain_id = $1 AND contract_address_key = $2 AND status = 'completed'`,
        [chainId, addressKey(chainId, contractAddress)]
      );
      return result.rows[0] || null;
    },

    async findActiveProfile(actorHandle) {
      const result = await executor.query(
        `SELECT * FROM kol_profile_runs WHERE actor_handle = $1
           AND status IN ('pending', 'running') ORDER BY created_at DESC LIMIT 1`, [actorHandle]
      );
      return result.rows[0] || null;
    },

    async insertProfileRun(actorHandle) {
      const result = await executor.query(
        'INSERT INTO kol_profile_runs(actor_handle) VALUES ($1) RETURNING *', [actorHandle]
      );
      return result.rows[0];
    },

    async getProfileRun(id) {
      const result = await executor.query('SELECT * FROM kol_profile_runs WHERE id = $1', [Number(id)]);
      return result.rows[0] || null;
    },

    async listProfileRuns(requestedLimit) {
      const result = await executor.query(
        `SELECT * FROM kol_profile_runs
         ORDER BY created_at DESC LIMIT $1`,
        [limit(requestedLimit, 20)]
      );
      return result.rows;
    },

    async claimNextProfileRun() {
      const result = await executor.query(
        `WITH candidate AS (
           SELECT id FROM kol_profile_runs WHERE status = 'pending'
           ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE kol_profile_runs AS run
         SET status = 'running', started_at = COALESCE(started_at, NOW()), updated_at = NOW()
         FROM candidate WHERE run.id = candidate.id RETURNING run.*`
      );
      return result.rows[0] || null;
    },

    async completeProfileRun(id, resultJson) {
      const result = await executor.query(
        `UPDATE kol_profile_runs SET status = 'completed', result_json = $2,
           error_code = NULL, last_error = NULL, completed_at = NOW(), updated_at = NOW()
         WHERE id = $1 RETURNING *`, [Number(id), JSON.stringify(resultJson || {})]
      );
      return result.rows[0] || null;
    },

    async failProfileRun(id, error) {
      const result = await executor.query(
        `UPDATE kol_profile_runs SET status = 'failed', error_code = $2, last_error = $3,
           completed_at = NOW(), updated_at = NOW() WHERE id = $1 RETURNING *`,
        [Number(id), String(error?.code || 'KOL_PROFILE_RESEARCH_FAILED').slice(0, 120),
          String(error?.message || 'KOL profile research failed').slice(0, 1000)]
      );
      return result.rows[0] || null;
    }
  };
}

module.exports = { createKolPerformanceRepository };
