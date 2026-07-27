const crypto = require('crypto');
const db = require('../../lib/db');
const readinessService = require('../trade/readiness-service');
const livePolicy = require('../signal/live-policy');
const engineState = require('../../lib/engine-state');
const logger = require('../../lib/logger');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function currentPolicyContext(executor = db) {
  const policy = await livePolicy.getPolicy(executor);
  const scope = policy.whitelistIds.length > 0
    ? await executor.query(
      `SELECT whitelist.id, whitelist.activation_version,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', relation.id, 'actor_id', relation.kol_id,
                  'target', relation.target_x_handle, 'events', relation.event_types
                ) ORDER BY relation.id)
                FROM x_signal_relations AS relation
                JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id AND actor.enabled = true
                WHERE relation.whitelist_id = whitelist.id AND relation.enabled = true
              ), '[]'::jsonb) AS relations,
              COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                  'id', rule.id, 'actor_id', rule.actor_id,
                  'events', rule.event_types, 'kind', rule.source_kind
                ) ORDER BY rule.id)
                FROM x_signal_source_rules AS rule
                JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id AND actor.enabled = true
                WHERE rule.whitelist_id = whitelist.id AND rule.enabled = true
              ), '[]'::jsonb) AS sources
       FROM ca_whitelist AS whitelist
       WHERE whitelist.id = ANY($1::int[])
         AND whitelist.status = 'active'
         AND whitelist.live_activation_state = 'live_ready'
       ORDER BY whitelist.id`,
      [policy.whitelistIds]
    ) : { rows: [] };
  const activationVersions = Object.fromEntries(scope.rows.map((item) => [
    String(item.id), Number(item.activation_version)
  ]));
  return {
    policy,
    activationVersions,
    fingerprint: hash({ policy, scope: scope.rows })
  };
}

function compactSummary(readiness, context) {
  const relations = Array.isArray(readiness.relations) ? readiness.relations : [];
  return {
    readyToArm: Boolean(readiness.readyToArm),
    blockers: readiness.blockers || [],
    advisories: readiness.advisories || [],
    counts: {
      chains: context.policy.chains.length,
      whitelists: context.policy.whitelistIds.length,
      watches: new Set(relations.map((item) => String(item.actorHandle).toLowerCase())).size,
      relations: relations.length
    },
    chains: (readiness.chains || [])
      .filter((chain) => context.policy.chains.includes(chain.chain))
      .map((chain) => ({
        chain: chain.chain,
        ready: Boolean(chain.ready),
        blockers: chain.blockers || [],
        nativeBalance: chain.native_balance ?? null
      }))
  };
}

async function prepare(operator, options = {}) {
  const readiness = await (options.readinessProvider
    || (() => readinessService.getSnapshot({ probe: true })))();
  const context = await currentPolicyContext();
  const summary = compactSummary(readiness, context);
  if (!readiness.readyToArm) {
    return {
      preparation_id: null,
      arm_token: null,
      expires_at: null,
      summary
    };
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const result = await db.query(
    `INSERT INTO arm_preparations(
       token_hash, operator, configuration_fingerprint, policy_fingerprint,
       snapshot_hash, activation_versions, compact_summary, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '60 seconds')
     RETURNING id, expires_at, created_at`,
    [
      tokenHash(token), String(operator || 'admin').slice(0, 128),
      readiness.configurationFingerprint, context.fingerprint,
      readiness.snapshotHash, context.activationVersions, summary
    ]
  );
  return {
    preparation_id: Number(result.rows[0].id),
    arm_token: token,
    expires_at: result.rows[0].expires_at,
    summary
  };
}

async function getPreparation(id, operator, executor = db) {
  const preparationId = Number(id);
  if (!Number.isInteger(preparationId) || preparationId < 1) {
    const error = new Error('Arm preparation id is invalid');
    error.code = 'ARM_PREPARATION_INVALID';
    throw error;
  }
  const result = await executor.query(
    `SELECT id, operator, compact_summary, status, expires_at, consumed_at,
            failed_at, failure_code, failure_detail, created_at
     FROM arm_preparations
     WHERE id = $1 AND operator = $2`,
    [preparationId, String(operator || 'admin').slice(0, 128)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    preparation_id: Number(row.id),
    summary: row.compact_summary,
    status: row.status,
    expires_at: row.expires_at,
    consumed_at: row.consumed_at,
    failed_at: row.failed_at,
    failure_code: row.failure_code,
    failure_detail: row.failure_detail,
    created_at: row.created_at
  };
}

async function confirm(input, operator, options = {}) {
  const token = String(input?.arm_token || '');
  const preparationId = Number(input?.preparation_id);
  if (!token || !Number.isInteger(preparationId)) {
    const error = new Error('Arm preparation token is required');
    error.code = 'ARM_PREPARATION_REQUIRED';
    throw error;
  }
  const currentReadiness = await (options.snapshotProvider || readinessService.getSnapshot)();
  const context = await currentPolicyContext();
  const client = await db.pool.connect();
  let transactionOpen = false;
  try {
    await client.query('BEGIN');
    transactionOpen = true;
    const result = await client.query(
      `SELECT * FROM arm_preparations WHERE id = $1 AND operator = $2 FOR UPDATE`,
      [preparationId, String(operator || 'admin').slice(0, 128)]
    );
    const row = result.rows[0];
    if (!row || row.token_hash !== tokenHash(token)) {
      const error = new Error('Arm preparation token is invalid');
      error.code = 'ARM_PREPARATION_INVALID';
      throw error;
    }
    if (row.status !== 'prepared') {
      const error = new Error('Arm preparation token has already been used');
      error.code = 'ARM_PREPARATION_REPLAYED';
      throw error;
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      await client.query(
        "UPDATE arm_preparations SET status = 'expired', updated_at = NOW() WHERE id = $1",
        [preparationId]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      const error = new Error('Arm preparation token has expired');
      error.code = 'ARM_PREPARATION_EXPIRED';
      throw error;
    }
    const stale = !currentReadiness.readyToArm
      || row.configuration_fingerprint !== currentReadiness.configurationFingerprint
      || row.policy_fingerprint !== context.fingerprint
      || hash(row.activation_versions || {}) !== hash(context.activationVersions);
    if (stale) {
      await client.query(
        "UPDATE arm_preparations SET status = 'stale', updated_at = NOW() WHERE id = $1",
        [preparationId]
      );
      await client.query('COMMIT');
      transactionOpen = false;
      const error = new Error('Live scope changed after the readiness check');
      error.code = 'ARM_PREPARATION_STALE';
      error.details = { blockers: currentReadiness.blockers || [] };
      throw error;
    }
    await client.query(
      `UPDATE arm_preparations
       SET status = 'arming', updated_at = NOW()
       WHERE id = $1`,
      [preparationId]
    );
    await client.query('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  let runtime;
  try {
    runtime = await engineState.arm({ operator, readiness: currentReadiness });
  } catch (error) {
    await db.query(
      `UPDATE arm_preparations
       SET status = 'failed', failed_at = NOW(), failure_code = $2,
           failure_detail = $3, updated_at = NOW()
       WHERE id = $1 AND status = 'arming'`,
      [preparationId, String(error.code || 'ENGINE_ARM_FAILED').slice(0, 128),
        String(error.message || 'Engine arm failed').slice(0, 2000)]
    ).catch(() => {});
    throw error;
  }
  await db.query(
    `UPDATE arm_preparations
     SET status = 'consumed', consumed_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status = 'arming'`,
    [preparationId]
  ).catch((error) => {
    logger.error('arm-preparation', `Engine started but preparation finalization failed: ${error.message}`);
  });
  return runtime;
}

module.exports = {
  compactSummary,
  confirm,
  currentPolicyContext,
  getPreparation,
  hash,
  prepare,
  tokenHash
};
