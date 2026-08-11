const crypto = require('crypto');
const db = require('../../lib/db');
const readinessService = require('../trade/readiness-service');
const livePolicy = require('../signal/live-policy');
const engineState = require('../../lib/engine-state');
const logger = require('../../lib/logger');
const runtimeScopeService = require('../trade/runtime-scope-service');
const { executionGateService } = require('../trade/execution-gate-service');

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function currentPolicyContext(executor = db, scopeInput = {}) {
  const manifest = await runtimeScopeService.resolveScope(scopeInput, executor);
  const includesFixed = ['fixed_ca', 'combined'].includes(manifest.scope_type);
  const policy = includesFixed ? await livePolicy.getPolicy(executor) : {
    providers: [], eventTypes: [], verifiedEventTypes: [], chains: [], whitelistIds: []
  };
  const fixedWhitelistIds = includesFixed ? manifest.whitelist_ids : [];
  const dynamicPolicyIds = manifest.dynamic_policy_ids || [];
  const followPolicyIds = manifest.follow_policy_ids || [];
  const hasOwnedWhitelists = fixedWhitelistIds.length > 0
    || dynamicPolicyIds.length > 0 || followPolicyIds.length > 0;
  const scope = hasOwnedWhitelists
    ? await executor.query(
      `SELECT whitelist.id, whitelist.activation_version,
              whitelist.source, whitelist.live_activation_state,
              whitelist.actor_policy_id, whitelist.follow_discovery_policy_id,
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
       WHERE whitelist.status = 'active'
         AND whitelist.live_activation_state = 'live_ready'
         AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
         AND (
           whitelist.id = ANY($1::int[])
           OR whitelist.actor_policy_id = ANY($2::bigint[])
           OR whitelist.follow_discovery_policy_id = ANY($3::bigint[])
         )
       ORDER BY whitelist.id`,
      [fixedWhitelistIds, dynamicPolicyIds, followPolicyIds]
    ) : { rows: [] };
  const activationVersions = Object.fromEntries(scope.rows.map((item) => [
    String(item.id), Number(item.activation_version)
  ]));
  const scopeWhitelistIds = scope.rows.map((item) => Number(item.id));
  return {
    policy: includesFixed ? {
      ...policy,
      chains: manifest.chains,
      whitelistIds: scopeWhitelistIds
    } : { providers: [], eventTypes: [], verifiedEventTypes: [],
      chains: manifest.chains, whitelistIds: scopeWhitelistIds },
    manifest,
    activationVersions,
    fingerprint: hash({ manifest, scope: scope.rows })
  };
}

function compactSummary(readiness, context) {
  const relations = Array.isArray(readiness.relations) ? readiness.relations : [];
  const manifestCounts = context.manifest.counts || {};
  return {
    readyToArm: Boolean(readiness.readyToArm),
    blockers: readiness.blockers || [],
    advisories: readiness.advisories || [],
    scope: {
      type: context.manifest.scope_type,
      id: context.manifest.scope_id,
      revision: context.manifest.policy_revision,
      label: context.manifest.kol_handle
        ? `@${String(context.manifest.kol_handle).replace(/^@+/, '')}`
        : context.manifest.scope_type === 'fixed_ca' ? '固定 CA' : '全部已启用策略'
    },
    counts: {
      chains: context.policy.chains.length,
      whitelists: context.policy.whitelistIds.length,
      watches: Number.isFinite(Number(manifestCounts.watches))
        ? Number(manifestCounts.watches)
        : new Set(relations.map((item) => String(item.actorHandle).toLowerCase())).size,
      relations: Number.isFinite(Number(manifestCounts.relations))
        ? Number(manifestCounts.relations) : relations.length
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
  const scopeInput = options.scope || {};
  const probe = options.probe === true;
  const readiness = await (options.readinessProvider
    || (() => readinessService.getSnapshot({ probe, scope: scopeInput })))();
  const context = await currentPolicyContext(db, scopeInput);
  const summary = compactSummary(readiness, context);
  if (!readiness.readyToArm) {
    return {
      preparation_id: null,
      arm_token: null,
      expires_at: null,
      summary,
      scope: context.manifest
    };
  }
  const readinessSnapshot = {
    generatedAt: readiness.generatedAt,
    snapshotHash: readiness.snapshotHash,
    readyToArm: readiness.readyToArm,
    blockers: readiness.blockers || [],
    advisories: readiness.advisories || [],
    configurationFingerprint: readiness.configurationFingerprint,
    scope: readiness.scope || context.manifest,
    provider: readiness.provider || null,
    checks: readiness.checks || {},
    chains: (readiness.chains || []).filter((chain) => context.manifest.chains.includes(chain.chain))
      .map((chain) => ({
        chain: chain.chain,
        ready: Boolean(chain.ready),
        infrastructure_ready: Boolean(chain.infrastructure_ready),
        blockers: chain.blockers || [],
        native_balance: chain.native_balance ?? null
      }))
  };
  const token = crypto.randomBytes(32).toString('base64url');
  const result = await db.query(
    `INSERT INTO arm_preparations(
       token_hash, operator, configuration_fingerprint, policy_fingerprint,
       snapshot_hash, activation_versions, compact_summary, scope_type, scope_id,
       scope_chain_ids, scope_revision, scope_manifest_hash, readiness_snapshot,
       probe_requested, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW() + INTERVAL '60 seconds')
     RETURNING id, expires_at, created_at`,
    [
      tokenHash(token), String(operator || 'admin').slice(0, 128),
      readiness.configurationFingerprint, context.fingerprint,
      readiness.snapshotHash, context.activationVersions, summary,
      context.manifest.scope_type, context.manifest.scope_id, context.manifest.chains,
      context.manifest.policy_revision, context.manifest.manifest_hash, readinessSnapshot,
      probe
    ]
  );
  return {
    preparation_id: Number(result.rows[0].id),
    arm_token: token,
    expires_at: result.rows[0].expires_at,
    summary,
    scope: context.manifest
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
            failed_at, failure_code, failure_detail, created_at,
            scope_type, scope_id, scope_chain_ids, scope_revision, scope_manifest_hash
     FROM arm_preparations
     WHERE id = $1 AND operator = $2`,
    [preparationId, String(operator || 'admin').slice(0, 128)]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    preparation_id: Number(row.id),
    summary: row.compact_summary,
    scope: {
      scope_type: row.scope_type,
      scope_id: row.scope_id === null ? null : Number(row.scope_id),
      chain_ids: row.scope_chain_ids || [],
      revision: row.scope_revision,
      manifest_hash: row.scope_manifest_hash
    },
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
  const client = await db.pool.connect();
  let transactionOpen = false;
  let savedReadiness = null;
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
    const scopeInput = {
      scope_type: row.scope_type,
      scope_id: row.scope_id,
      chain_ids: row.scope_chain_ids || []
    };
    const context = await currentPolicyContext(client, scopeInput);
    savedReadiness = row.readiness_snapshot || {};
    const snapshotHashMatches = row.snapshot_hash === savedReadiness.snapshotHash;
    const snapshotScopeMatches = savedReadiness.scope?.manifest_hash === row.scope_manifest_hash;
    const stale = !savedReadiness.readyToArm
      || !snapshotHashMatches
      || !snapshotScopeMatches
      || row.scope_manifest_hash !== context.manifest.manifest_hash
      || Number(row.scope_revision || 0) !== Number(context.manifest.policy_revision || 0)
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
      error.code = row.scope_manifest_hash !== context.manifest.manifest_hash
        || Number(row.scope_revision || 0) !== Number(context.manifest.policy_revision || 0)
        ? 'ARM_SCOPE_CHANGED' : 'ARM_SNAPSHOT_STALE';
      error.details = { blockers: savedReadiness.blockers || [], scope: context.manifest };
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
    runtime = await engineState.arm({ operator, readiness: savedReadiness });
    executionGateService.update(savedReadiness);
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
