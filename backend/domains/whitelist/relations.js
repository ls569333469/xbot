const { normalizeXHandle } = require('../../lib/x-handles');

const X_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const RELATION_EVENT_TYPES = ['retweet', 'quote', 'reply', 'follow'];
const DIRECT_SOURCE_EVENT_TYPES = ['tweet', 'retweet', 'quote', 'reply'];
const DIRECT_SOURCE_MATCH_MODES = ['ca_only'];
const DIRECT_SOURCE_KINDS = ['project', 'ecosystem', 'launch'];

function normalizeEventTypes(values, allowed = RELATION_EVENT_TYPES, label = 'Relation') {
  const source = values === undefined || values === null ? allowed : values;
  if (!Array.isArray(source)) throw new Error('Relation event_types must be an array');
  const normalized = [...new Set(source
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean))];
  const invalid = normalized.find((value) => !allowed.includes(value));
  if (invalid) throw new Error(`Unsupported relation event type: ${invalid}`);
  if (normalized.length === 0) throw new Error(`At least one ${label.toLowerCase()} event type is required`);
  return allowed.filter((value) => normalized.includes(value));
}

function normalizeSourceInputs(values) {
  if (!Array.isArray(values)) return [];
  const deduplicated = new Map();
  for (const value of values) {
    const actorHandle = normalizeXHandle(value?.actor_handle ?? value?.handle ?? value?.actorHandle);
    if (!X_HANDLE_PATTERN.test(actorHandle)) {
      throw new Error(`Invalid direct source X handle: ${actorHandle || '(empty)'}`);
    }
    const matchMode = String(value?.match_mode ?? value?.matchMode ?? 'ca_only')
      .trim().toLowerCase();
    if (!DIRECT_SOURCE_MATCH_MODES.includes(matchMode)) {
      throw new Error(`Unsupported direct source match mode: ${matchMode}`);
    }
    const sourceKind = String(value?.source_kind ?? value?.sourceKind ?? 'project')
      .trim().toLowerCase();
    if (!DIRECT_SOURCE_KINDS.includes(sourceKind)) {
      throw new Error(`Unsupported direct source kind: ${sourceKind}`);
    }
    deduplicated.set(actorHandle, {
      actor_handle: actorHandle,
      event_types: normalizeEventTypes(
        value?.event_types ?? value?.eventTypes,
        DIRECT_SOURCE_EVENT_TYPES,
        'Direct source'
      ),
      match_mode: matchMode,
      source_kind: sourceKind,
      role: String(value?.role || 'project').trim().slice(0, 40) || 'project'
    });
  }
  return [...deduplicated.values()];
}

function normalizeRelationInputs(values) {
  if (!Array.isArray(values)) return [];

  const deduplicated = new Map();
  for (const value of values) {
    const actorHandle = normalizeXHandle(value?.actor_handle ?? value?.actorHandle);
    const targetHandle = normalizeXHandle(value?.target_x_handle ?? value?.targetHandle);
    if (!X_HANDLE_PATTERN.test(actorHandle)) {
      throw new Error(`Invalid actor X handle: ${actorHandle || '(empty)'}`);
    }
    if (!X_HANDLE_PATTERN.test(targetHandle)) {
      throw new Error(`Invalid target X handle: ${targetHandle || '(empty)'}`);
    }
    if (actorHandle === targetHandle) {
      throw new Error(`Actor and target must be different: @${actorHandle}`);
    }
    deduplicated.set(`${actorHandle}:${targetHandle}`, {
      actor_handle: actorHandle,
      target_x_handle: targetHandle,
      event_types: normalizeEventTypes(value?.event_types ?? value?.eventTypes)
    });
  }
  return [...deduplicated.values()];
}

async function findOrCreateActor(actorHandle, executor) {
  const existing = await executor.query(
    `SELECT * FROM x_kol_accounts
     WHERE lower(regexp_replace(x_handle, '^@+', '')) = $1
     ORDER BY enabled DESC, id
     LIMIT 1
     FOR UPDATE`,
    [actorHandle]
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].enabled) {
      const enabled = await executor.query(
        `UPDATE x_kol_accounts
         SET enabled = true, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id]
      );
      return enabled.rows[0];
    }
    return existing.rows[0];
  }

  const created = await executor.query(
    `INSERT INTO x_kol_accounts
      (x_user_id, x_handle, display_name, chain_ids, weight, enabled)
     VALUES ($1, $1, $1, '{}', 5, true)
     ON CONFLICT (x_user_id) DO UPDATE
       SET x_handle = EXCLUDED.x_handle, enabled = true, updated_at = NOW()
     RETURNING *`,
    [actorHandle]
  );
  return created.rows[0];
}

async function syncWhitelistRelations(whitelistId, relations, executor) {
  const relationIds = [];
  for (const relation of relations) {
    const actor = await findOrCreateActor(relation.actor_handle, executor);
    const result = await executor.query(
      `INSERT INTO x_signal_relations
        (whitelist_id, kol_id, target_x_handle, event_types, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (whitelist_id, kol_id, target_x_handle) DO UPDATE
         SET event_types = EXCLUDED.event_types, enabled = true, updated_at = NOW()
       RETURNING id`,
      [whitelistId, actor.id, relation.target_x_handle, relation.event_types]
    );
    relationIds.push(result.rows[0].id);
  }

  await executor.query(
    `DELETE FROM x_signal_relations
     WHERE whitelist_id = $1
       AND NOT (id = ANY($2::bigint[]))`,
    [whitelistId, relationIds]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET project_x_handles = COALESCE((
       SELECT array_agg(DISTINCT target_x_handle ORDER BY target_x_handle)
       FROM x_signal_relations
       WHERE whitelist_id = $1 AND enabled = true
     ), '{}'::text[]), updated_at = NOW()
     WHERE id = $1`,
    [whitelistId]
  );
}

async function syncWhitelistSourceRules(whitelistId, sources, executor) {
  const ruleIds = [];
  for (const source of sources) {
    const actor = await findOrCreateActor(source.actor_handle, executor);
    const result = await executor.query(
      `INSERT INTO x_signal_source_rules
        (whitelist_id, actor_id, event_types, match_mode, source_kind, enabled)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (whitelist_id, actor_id) DO UPDATE
         SET event_types = EXCLUDED.event_types, match_mode = EXCLUDED.match_mode,
             source_kind = EXCLUDED.source_kind, enabled = true, updated_at = NOW()
       RETURNING id`,
      [whitelistId, actor.id, source.event_types, source.match_mode, source.source_kind]
    );
    ruleIds.push(result.rows[0].id);
  }

  await executor.query(
    `DELETE FROM x_signal_source_rules
     WHERE whitelist_id = $1
       AND NOT (id = ANY($2::bigint[]))`,
    [whitelistId, ruleIds]
  );
}

function normalizeProjectAccounts(values, relations = [], sources = []) {
  const deduplicated = new Map();
  const relationTargets = new Set(relations.map((relation) => (
    normalizeXHandle(relation.target_x_handle)
  )));
  const directSources = new Set(sources.filter((source) => source.source_kind !== 'ecosystem').map((source) => (
    normalizeXHandle(source.actor_handle)
  )));
  const add = (raw, defaults = {}) => {
    const handle = normalizeXHandle(raw?.handle ?? raw?.x_handle ?? raw?.target_x_handle);
    if (!X_HANDLE_PATTERN.test(handle)) return;
    const usage = String(raw?.usage || defaults.usage || 'identity').trim().toLowerCase();
    if (!['identity', 'direct_source', 'interaction_target'].includes(usage)) return;
    if (usage === 'direct_source' && !directSources.has(handle)) return;
    if (usage === 'interaction_target' && !relationTargets.has(handle)) return;
    const key = `${handle}:${usage}`;
    if (defaults.preserveExisting && deduplicated.has(key)) return;
    deduplicated.set(key, {
      handle,
      role: String(raw?.role || defaults.role || 'project').trim().slice(0, 40) || 'project',
      usage,
      evidence_snapshot: raw?.evidence_snapshot && typeof raw.evidence_snapshot === 'object'
        ? raw.evidence_snapshot
        : {}
    });
  };
  (Array.isArray(values) ? values : []).forEach((value) => add(value));
  relations.forEach((relation) => add(relation, {
    usage: 'interaction_target', role: 'project', preserveExisting: true
  }));
  sources.filter((source) => source.source_kind !== 'ecosystem').forEach((source) => add({ ...source, handle: source.actor_handle }, {
    usage: 'direct_source',
    role: source.role || 'project',
    preserveExisting: true
  }));
  return [...deduplicated.values()];
}

function retainRelevantProjectAccounts(values, relations = [], sources = []) {
  const relationTargets = new Set(relations.map((relation) => (
    normalizeXHandle(relation.target_x_handle)
  )));
  const directSources = new Set(sources.filter((source) => source.source_kind !== 'ecosystem').map((source) => (
    normalizeXHandle(source.actor_handle)
  )));
  return (Array.isArray(values) ? values : []).filter((account) => {
    const handle = normalizeXHandle(account?.handle);
    if (account?.usage === 'identity') return true;
    if (account?.usage === 'interaction_target') return relationTargets.has(handle);
    if (account?.usage === 'direct_source') return directSources.has(handle);
    return false;
  });
}

async function syncWhitelistProjectAccounts(whitelistId, accounts, executor) {
  const accountIds = [];
  for (const account of accounts) {
    const result = await executor.query(
      `INSERT INTO whitelist_x_accounts
        (whitelist_id, handle, role, usage, evidence_snapshot)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (whitelist_id, handle, usage) DO UPDATE
         SET role = EXCLUDED.role, evidence_snapshot = EXCLUDED.evidence_snapshot,
             updated_at = NOW()
       RETURNING id`,
      [whitelistId, account.handle, account.role, account.usage, account.evidence_snapshot]
    );
    accountIds.push(result.rows[0].id);
  }
  await executor.query(
    `DELETE FROM whitelist_x_accounts
     WHERE whitelist_id = $1
       AND NOT (id = ANY($2::bigint[]))`,
    [whitelistId, accountIds]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET project_x_handles = COALESCE((
       SELECT array_agg(DISTINCT handle ORDER BY handle)
       FROM whitelist_x_accounts
       WHERE whitelist_id = $1
     ), '{}'::text[]), updated_at = NOW()
     WHERE id = $1`,
    [whitelistId]
  );
}

async function hydrateWhitelistRelations(rows, executor) {
  if (rows.length === 0) return rows;
  const ids = rows.map((row) => Number(row.id));
  const result = await executor.query(
      `SELECT relation.id, relation.whitelist_id, relation.kol_id,
             actor.x_handle AS actor_handle,
             actor.display_name AS actor_display_name,
             relation.target_x_handle, relation.event_types, relation.enabled,
             COALESCE(sync.status, watch.sync_status, 'pending') AS watch_sync_status,
             COALESCE(sync.last_error, watch.last_error) AS watch_sync_error,
             COALESCE(sync.synced_at, watch.last_synced_at) AS watch_synced_at
     FROM x_signal_relations AS relation
     JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
     LEFT JOIN x_watch_sync_outbox AS sync
       ON sync.actor_handle = lower(regexp_replace(actor.x_handle, '^@+', ''))
     LEFT JOIN x_provider_watches AS watch
       ON watch.provider = '6551'
      AND watch.username = lower(regexp_replace(actor.x_handle, '^@+', ''))
     WHERE relation.whitelist_id = ANY($1::int[])
       AND relation.enabled = true
     ORDER BY lower(actor.x_handle), relation.target_x_handle`,
    [ids]
  );
  const sourceResult = await executor.query(
    `SELECT rule.id, rule.whitelist_id, rule.actor_id AS kol_id,
            actor.x_handle AS actor_handle, actor.display_name AS actor_display_name,
            rule.event_types, rule.match_mode, rule.source_kind, rule.enabled,
            COALESCE(sync.status, watch.sync_status, 'pending') AS watch_sync_status,
            COALESCE(sync.last_error, watch.last_error) AS watch_sync_error,
            COALESCE(sync.synced_at, watch.last_synced_at) AS watch_synced_at
     FROM x_signal_source_rules AS rule
     JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id
     LEFT JOIN x_watch_sync_outbox AS sync
       ON sync.actor_handle = lower(regexp_replace(actor.x_handle, '^@+', ''))
     LEFT JOIN x_provider_watches AS watch
       ON watch.provider = '6551'
      AND watch.username = lower(regexp_replace(actor.x_handle, '^@+', ''))
     WHERE rule.whitelist_id = ANY($1::int[])
       AND rule.enabled = true
     ORDER BY lower(actor.x_handle), rule.id`,
    [ids]
  );
  const accountResult = await executor.query(
    `SELECT * FROM whitelist_x_accounts
     WHERE whitelist_id = ANY($1::int[])
     ORDER BY whitelist_id, usage, handle`,
    [ids]
  );
  const grouped = new Map();
  for (const relation of result.rows) {
    const group = grouped.get(Number(relation.whitelist_id)) || [];
    group.push(relation);
    grouped.set(Number(relation.whitelist_id), group);
  }
  const groupedSources = new Map();
  for (const source of sourceResult.rows) {
    const group = groupedSources.get(Number(source.whitelist_id)) || [];
    group.push(source);
    groupedSources.set(Number(source.whitelist_id), group);
  }
  const groupedAccounts = new Map();
  for (const account of accountResult.rows) {
    const group = groupedAccounts.get(Number(account.whitelist_id)) || [];
    group.push(account);
    groupedAccounts.set(Number(account.whitelist_id), group);
  }
  return rows.map((row) => ({
    ...row,
    relations: grouped.get(Number(row.id)) || [],
    direct_sources: groupedSources.get(Number(row.id)) || [],
    project_accounts: groupedAccounts.get(Number(row.id)) || []
  }));
}

module.exports = {
  X_HANDLE_PATTERN,
  DIRECT_SOURCE_EVENT_TYPES,
  DIRECT_SOURCE_KINDS,
  DIRECT_SOURCE_MATCH_MODES,
  RELATION_EVENT_TYPES,
  findOrCreateActor,
  hydrateWhitelistRelations,
  normalizeEventTypes,
  normalizeProjectAccounts,
  normalizeRelationInputs,
  normalizeSourceInputs,
  retainRelevantProjectAccounts,
  syncWhitelistProjectAccounts,
  syncWhitelistRelations,
  syncWhitelistSourceRules
};
