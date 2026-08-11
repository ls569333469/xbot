const crypto = require('crypto');
const db = require('../../lib/db');
const livePolicy = require('../signal/live-policy');

const SCOPE_TYPES = Object.freeze(['combined', 'fixed_ca', 'dynamic_policy', 'follow_discovery']);
const CHAIN_IDS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood']);

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeChainIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => CHAIN_IDS.has(item)))].sort();
}

function normalizeInput(input = {}) {
  const scopeType = String(input.scope_type || input.type || 'combined').trim().toLowerCase();
  if (!SCOPE_TYPES.includes(scopeType)) {
    const error = new Error(`Unsupported runtime scope type: ${scopeType}`);
    error.code = 'RUNTIME_SCOPE_INVALID';
    throw error;
  }
  const rawId = input.scope_id ?? input.id ?? null;
  const scopeId = rawId === null || rawId === '' ? null : Number(rawId);
  if (rawId !== null && (!Number.isInteger(scopeId) || scopeId < 1)) {
    const error = new Error('Runtime scope id is invalid');
    error.code = 'RUNTIME_SCOPE_INVALID';
    throw error;
  }
  return { scopeType, scopeId, chainIds: normalizeChainIds(input.chain_ids || input.chainIds) };
}

function uniqueNumbers(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(Number).filter(Number.isInteger))].sort((a, b) => a - b);
}

function makeManifest(input, data = {}) {
  const chains = normalizeChainIds(data.chains);
  const whitelistIds = uniqueNumbers(data.whitelistIds);
  const dynamicPolicyIds = uniqueNumbers(
    data.dynamicPolicyIds || (data.dynamicPolicyId ? [data.dynamicPolicyId] : [])
  );
  const followPolicyIds = uniqueNumbers(
    data.followPolicyIds || (data.followPolicyId ? [data.followPolicyId] : [])
  );
  const manifest = {
    scope_type: input.scopeType,
    scope_id: input.scopeId,
    policy_revision: data.policyRevision ?? null,
    context_hash: data.contextHash || null,
    chains,
    whitelist_ids: whitelistIds,
    dynamic_policy_id: data.dynamicPolicyId ?? null,
    dynamic_policy_ids: dynamicPolicyIds,
    follow_policy_id: data.followPolicyId ?? null,
    follow_policy_ids: followPolicyIds,
    kol_id: data.kolId ?? null,
    kol_handle: data.kolHandle || null,
    display_name: data.displayName || null,
    mode: data.mode || null,
    enabled: data.enabled !== false,
    watch_sync: data.watchSync || null,
    template: data.template || null,
    counts: {
      chains: chains.length,
      whitelists: whitelistIds.length,
      dynamic_policies: dynamicPolicyIds.length,
      follow_policies: followPolicyIds.length,
      watches: Number(data.counts?.watches || 0),
      relations: Number(data.counts?.relations || 0)
    }
  };
  manifest.manifest_hash = hash(manifest);
  return manifest;
}

async function fixedManifest(input, executor) {
  const policy = await livePolicy.getPolicy(executor);
  const requestedChains = input.chainIds.length > 0
    ? input.chainIds.filter((chain) => policy.chains.includes(chain))
    : policy.chains;
  const candidateWhitelistIds = policy.whitelistIds.filter((id) => {
    if (input.scopeId === null) return true;
    return Number(id) === input.scopeId;
  });
  const whitelistIds = candidateWhitelistIds.length === 0 || requestedChains.length === 0
    ? []
    : (input.chainIds.length === 0
      ? candidateWhitelistIds
      : (await executor.query(
        `SELECT id
         FROM ca_whitelist
         WHERE id = ANY($1::bigint[])
           AND chain_id = ANY($2::text[])
           AND status = 'active'
           AND live_activation_state = 'live_ready'
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY id`,
        [candidateWhitelistIds, requestedChains]
      )).rows.map((row) => Number(row.id)));
  if (input.scopeId !== null && whitelistIds.length === 0) {
    const error = new Error('Fixed CA scope was not found in the active live policy');
    error.code = 'RUNTIME_SCOPE_NOT_FOUND';
    throw error;
  }
  return makeManifest(input, {
    chains: requestedChains,
    whitelistIds,
    contextHash: hash({ policy, requestedChains, whitelistIds }),
    mode: 'live',
    enabled: true,
    counts: await relationCounts(whitelistIds, executor)
  });
}

async function dynamicManifest(input, executor) {
  if (input.scopeId === null) {
    const error = new Error('Dynamic policy scope id is required');
    error.code = 'RUNTIME_SCOPE_ID_REQUIRED';
    throw error;
  }
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name, kol.enabled AS kol_enabled
     FROM x_actor_dynamic_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     WHERE policy.id = $1`, [input.scopeId]
  );
  const row = result.rows[0];
  if (!row) {
    const error = new Error('Dynamic policy scope was not found');
    error.code = 'RUNTIME_SCOPE_NOT_FOUND';
    throw error;
  }
  const chains = normalizeChainIds(row.allowed_chain_ids).filter((chain) => (
    input.chainIds.length === 0 || input.chainIds.includes(chain)
  ));
  return makeManifest(input, {
    chains,
    dynamicPolicyId: Number(row.id),
    kolId: Number(row.kol_id),
    kolHandle: row.x_handle,
    displayName: row.display_name,
    policyRevision: Number(row.revision),
    contextHash: row.context_hash,
    mode: row.mode,
    enabled: Boolean(row.enabled && row.kol_enabled),
    counts: { watches: row.kol_enabled ? 1 : 0, relations: 0 }
  });
}

async function followManifest(input, executor) {
  if (input.scopeId === null) {
    const error = new Error('Follow discovery policy scope id is required');
    error.code = 'RUNTIME_SCOPE_ID_REQUIRED';
    throw error;
  }
  const result = await executor.query(
    `SELECT policy.*, kol.x_handle, kol.display_name, kol.enabled AS kol_enabled,
            kol.profile_status, template.name AS trade_template_name,
            watch.status AS watch_sync_status, watch.last_error AS watch_sync_error,
            watch.synced_at AS watch_synced_at, watch.desired_version AS watch_desired_version
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     LEFT JOIN dynamic_policy_templates template ON template.id = policy.trade_template_id
     LEFT JOIN LATERAL (
       SELECT status, last_error, synced_at, desired_version
       FROM x_watch_sync_outbox
       WHERE actor_handle = lower(regexp_replace(kol.x_handle, '^@+', ''))
       ORDER BY updated_at DESC, desired_version DESC LIMIT 1
     ) watch ON true
     WHERE policy.id = $1`, [input.scopeId]
  );
  const row = result.rows[0];
  if (!row || row.archived_at) {
    const error = new Error('Follow discovery scope was not found');
    error.code = 'RUNTIME_SCOPE_NOT_FOUND';
    throw error;
  }
  const configuredChains = normalizeChainIds(row.allowed_chain_ids);
  const chains = configuredChains.filter((chain) => (
    input.chainIds.length === 0 || input.chainIds.includes(chain)
  ));
  const watchSync = {
    status: row.watch_sync_status || 'missing',
    error: row.watch_sync_error || null,
    synced_at: row.watch_synced_at || null,
    desired_version: row.watch_desired_version ?? null
  };
  return makeManifest(input, {
    chains,
    followPolicyId: Number(row.id),
    kolId: Number(row.kol_id),
    kolHandle: row.x_handle,
    displayName: row.display_name,
    policyRevision: Number(row.revision),
    contextHash: row.context_hash,
    mode: row.mode,
    enabled: Boolean(row.enabled && row.kol_enabled && row.profile_status === 'verified'),
    watchSync,
    template: row.trade_template_id ? {
      id: Number(row.trade_template_id),
      name: row.trade_template_name || null,
      version: Number(row.trade_template_version || 0)
    } : null,
    counts: { watches: row.kol_enabled ? 1 : 0, relations: 0 }
  });
}

async function relationCounts(whitelistIds, executor) {
  if (!whitelistIds.length) return { watches: 0, relations: 0 };
  const result = await executor.query(
    `WITH triggers AS (
       SELECT relation.whitelist_id, relation.kol_id
       FROM x_signal_relations relation
       JOIN x_kol_accounts actor ON actor.id = relation.kol_id AND actor.enabled = true
       WHERE relation.enabled = true AND relation.whitelist_id = ANY($1::int[])
       UNION ALL
       SELECT rule.whitelist_id, rule.actor_id
       FROM x_signal_source_rules rule
       JOIN x_kol_accounts actor ON actor.id = rule.actor_id AND actor.enabled = true
       WHERE rule.enabled = true AND rule.whitelist_id = ANY($1::int[])
     )
     SELECT COUNT(*)::int AS relations, COUNT(DISTINCT kol_id)::int AS watches FROM triggers`, [whitelistIds]
  );
  return {
    relations: Number(result.rows[0]?.relations || 0),
    watches: Number(result.rows[0]?.watches || 0)
  };
}

async function resolveScope(input = {}, executor = db) {
  const normalized = normalizeInput(input);
  if (normalized.scopeType === 'combined') {
    const [policy, dynamic, follow] = await Promise.all([
      livePolicy.getPolicy(executor),
      executor.query(
        `SELECT policy.id, policy.allowed_chain_ids, policy.revision, policy.context_hash
         FROM x_actor_dynamic_policies policy
         JOIN x_kol_accounts kol ON kol.id = policy.kol_id AND kol.enabled = true
         WHERE policy.enabled = true AND policy.mode = 'live'
         ORDER BY policy.id`
      ),
      executor.query(
        `SELECT policy.id, policy.allowed_chain_ids, policy.revision, policy.context_hash
         FROM follow_discovery_policies policy
         JOIN x_kol_accounts kol ON kol.id = policy.kol_id AND kol.enabled = true
         WHERE policy.archived_at IS NULL AND policy.enabled = true AND policy.mode = 'live'
         ORDER BY policy.id`
      )
    ]);
    const dynamicChains = dynamic.rows.flatMap((row) => normalizeChainIds(row.allowed_chain_ids));
    const followChains = follow.rows.flatMap((row) => normalizeChainIds(row.allowed_chain_ids));
    const allChains = [...new Set([...policy.chains, ...dynamicChains, ...followChains])].sort();
    const chains = normalized.chainIds.length > 0
      ? allChains.filter((chain) => normalized.chainIds.includes(chain))
      : allChains;
    return makeManifest(normalized, {
      chains,
      whitelistIds: policy.whitelistIds,
      dynamicPolicyIds: dynamic.rows.map((row) => Number(row.id)),
      followPolicyIds: follow.rows.map((row) => Number(row.id)),
      contextHash: hash({ policy, dynamic: dynamic.rows, follow: follow.rows }),
      counts: await relationCounts(policy.whitelistIds, executor)
    });
  }
  if (normalized.scopeType === 'fixed_ca') return fixedManifest(normalized, executor);
  if (normalized.scopeType === 'dynamic_policy') return dynamicManifest(normalized, executor);
  return followManifest(normalized, executor);
}

async function listActiveScopes(executor = db) {
  const [dynamic, follow, fixed] = await Promise.all([
    executor.query(
      `SELECT policy.id, policy.kol_id, policy.revision, policy.context_hash,
              policy.allowed_chain_ids,
              policy.mode, policy.enabled, kol.x_handle, kol.display_name
       FROM x_actor_dynamic_policies policy
       JOIN x_kol_accounts kol ON kol.id = policy.kol_id
       WHERE policy.enabled = true AND policy.mode = 'live' AND kol.enabled = true
       ORDER BY policy.id`
    ),
    executor.query(
      `SELECT policy.id, policy.kol_id, policy.revision, policy.context_hash,
              policy.allowed_chain_ids,
              policy.mode, policy.enabled, kol.x_handle, kol.display_name
       FROM follow_discovery_policies policy
       JOIN x_kol_accounts kol ON kol.id = policy.kol_id
       WHERE policy.archived_at IS NULL AND policy.enabled = true
         AND policy.mode = 'live' AND kol.enabled = true
       ORDER BY policy.id`
    ),
    livePolicy.getPolicy(executor)
  ]);
  return [
    { scope_type: 'combined', scope_id: null, label: '全部已启用策略', chains: [], revision: null },
    ...dynamic.rows.map((row) => ({
      scope_type: 'dynamic_policy', scope_id: Number(row.id), label: `动态 · @${String(row.x_handle).replace(/^@+/, '')}`,
      chains: normalizeChainIds(row.allowed_chain_ids), revision: Number(row.revision), context_hash: row.context_hash
    })),
    ...follow.rows.map((row) => ({
      scope_type: 'follow_discovery', scope_id: Number(row.id), label: `关注发现 · @${String(row.x_handle).replace(/^@+/, '')}`,
      chains: normalizeChainIds(row.allowed_chain_ids), revision: Number(row.revision), context_hash: row.context_hash
    })),
    { scope_type: 'fixed_ca', scope_id: null, label: '固定 CA · 当前生产范围', chains: fixed.chains, revision: null,
      context_hash: hash({ policy: fixed }) }
  ];
}

module.exports = {
  CHAIN_IDS,
  SCOPE_TYPES,
  hash,
  listActiveScopes,
  makeManifest,
  normalizeChainIds,
  normalizeInput,
  relationCounts,
  resolveScope
};
