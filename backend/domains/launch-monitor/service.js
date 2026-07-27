const db = require('../../lib/db');
const queries = require('./queries');
const { normalizeXHandle } = require('../../lib/x-handles');
const {
  DIRECT_SOURCE_EVENT_TYPES,
  findOrCreateActor,
  normalizeEventTypes
} = require('../whitelist/relations');
const whitelistService = require('../whitelist/service');
const { enqueueWatchSyncForHandles } = require('../x-monitor/6551/watch-sync-outbox');

const HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;
const LAUNCH_RELATION_EVENTS = ['retweet', 'quote', 'reply'];

function validationError(message, code = 'LAUNCH_RULE_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeSources(values) {
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values) {
    const actorHandle = normalizeXHandle(value?.actor_handle ?? value?.handle);
    if (!HANDLE_PATTERN.test(actorHandle)) {
      throw validationError(`Invalid project X handle: ${actorHandle || '(empty)'}`);
    }
    unique.set(actorHandle, {
      actor_handle: actorHandle,
      role: String(value?.role || 'project').trim().slice(0, 40) || 'project',
      event_types: normalizeEventTypes(
        value?.event_types,
        DIRECT_SOURCE_EVENT_TYPES,
        'Launch source'
      )
    });
  }
  return [...unique.values()];
}

function normalizeRelations(values, projectHandles) {
  if (!Array.isArray(values)) return [];
  const unique = new Map();
  for (const value of values) {
    const actorHandle = normalizeXHandle(value?.actor_handle);
    const targetHandle = normalizeXHandle(value?.target_x_handle);
    if (!HANDLE_PATTERN.test(actorHandle) || !HANDLE_PATTERN.test(targetHandle)) {
      throw validationError('Launch interaction requires valid ecosystem and project handles');
    }
    if (actorHandle === targetHandle) {
      throw validationError('Ecosystem and project accounts must be different');
    }
    if (!projectHandles.has(targetHandle)) {
      throw validationError(`Launch interaction target must be a project source: @${targetHandle}`);
    }
    unique.set(`${actorHandle}:${targetHandle}`, {
      actor_handle: actorHandle,
      target_x_handle: targetHandle,
      event_types: normalizeEventTypes(
        value?.event_types,
        LAUNCH_RELATION_EVENTS,
        'Launch relation'
      )
    });
  }
  return [...unique.values()];
}

function triggerHandles(sources = [], relations = []) {
  return [...new Set([
    ...sources.map((source) => source.actor_handle),
    ...relations.map((relation) => relation.actor_handle)
  ])].sort();
}

async function inTransaction(action) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function prepareInput(data, existing = null) {
  if (existing && data.chain_id
      && String(data.chain_id).trim().toLowerCase() !== String(existing.chain_id).toLowerCase()) {
    throw validationError('Launch monitor chain cannot be changed', 'LAUNCH_RULE_CHAIN_IMMUTABLE');
  }
  const sources = normalizeSources(data.sources ?? existing?.sources);
  if (sources.length === 0) {
    throw validationError('At least one project source account is required');
  }
  const projectHandles = new Set(sources.map((source) => source.actor_handle));
  const relations = normalizeRelations(data.relations ?? existing?.relations, projectHandles);
  const budgets = whitelistService.validateBudgetValues(data, existing || {});
  const strategy = whitelistService.prepareStrategy(data, existing);
  return {
    ...budgets,
    ...strategy,
    project_name: String(data.project_name ?? existing?.project_name ?? '').trim().slice(0, 120),
    expires_at: data.expires_at ?? existing?.expires_at ?? null,
    sources,
    relations
  };
}

async function syncSources(ruleId, sources, executor) {
  const ids = [];
  for (const source of sources) {
    const actor = await findOrCreateActor(source.actor_handle, executor);
    const result = await executor.query(
      `INSERT INTO project_launch_sources(
         launch_rule_id, actor_id, role, event_types, enabled
       ) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (launch_rule_id, actor_id) DO UPDATE
         SET role = EXCLUDED.role, event_types = EXCLUDED.event_types,
             enabled = true, updated_at = NOW()
       RETURNING id`,
      [ruleId, actor.id, source.role, source.event_types]
    );
    ids.push(result.rows[0].id);
  }
  await executor.query(
    `DELETE FROM project_launch_sources
     WHERE launch_rule_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [ruleId, ids]
  );
}

async function syncRelations(ruleId, relations, executor) {
  const ids = [];
  for (const relation of relations) {
    const actor = await findOrCreateActor(relation.actor_handle, executor);
    const result = await executor.query(
      `INSERT INTO project_launch_relations(
         launch_rule_id, actor_id, target_x_handle, event_types, enabled
       ) VALUES ($1,$2,$3,$4,true)
       ON CONFLICT (launch_rule_id, actor_id, target_x_handle) DO UPDATE
         SET event_types = EXCLUDED.event_types, enabled = true, updated_at = NOW()
       RETURNING id`,
      [ruleId, actor.id, relation.target_x_handle, relation.event_types]
    );
    ids.push(result.rows[0].id);
  }
  await executor.query(
    `DELETE FROM project_launch_relations
     WHERE launch_rule_id = $1 AND NOT (id = ANY($2::bigint[]))`,
    [ruleId, ids]
  );
}

async function list(filters) {
  return queries.list(filters);
}

async function get(id) {
  return queries.getById(id);
}

async function previewWatchImpact(data) {
  const sources = normalizeSources(data.sources);
  const relations = normalizeRelations(
    data.relations,
    new Set(sources.map((source) => source.actor_handle))
  );
  const handles = triggerHandles(sources, relations);
  if (!handles.length) {
    return { unique_handles: 0, reused_watches: 0, new_watches: 0, handles: [] };
  }
  const result = await db.query(
    `SELECT username, sync_status
     FROM x_provider_watches
     WHERE provider = '6551' AND username = ANY($1::text[])`,
    [handles]
  );
  const existing = new Map(result.rows.map((row) => [row.username, row]));
  return {
    unique_handles: handles.length,
    reused_watches: handles.filter((handle) => existing.has(handle)).length,
    new_watches: handles.filter((handle) => !existing.has(handle)).length,
    handles: handles.map((handle) => ({
      handle,
      watch_status: existing.get(handle)?.sync_status || 'new'
    }))
  };
}

async function create(data) {
  const prepared = prepareInput(data);
  const ruleId = await inTransaction(async (client) => {
    const rule = await queries.create(prepared, client);
    await syncSources(rule.id, prepared.sources, client);
    await syncRelations(rule.id, prepared.relations, client);
    await enqueueWatchSyncForHandles(
      triggerHandles(prepared.sources, prepared.relations),
      client
    );
    return rule.id;
  });
  return queries.getById(ruleId);
}

async function update(id, data) {
  const ruleId = await inTransaction(async (client) => {
    const current = await queries.getById(id, client, { forUpdate: true });
    if (!current) throw validationError('Launch monitor not found', 'LAUNCH_RULE_NOT_FOUND');
    if (current.status === 'triggered' || Number(current.discovery_count) > 0) {
      throw validationError('Triggered launch monitors are immutable', 'LAUNCH_RULE_TRIGGERED');
    }
    const hydrated = await queries.getById(id, client);
    const prepared = prepareInput(data, hydrated);
    await queries.update(id, prepared, client);
    await syncSources(id, prepared.sources, client);
    await syncRelations(id, prepared.relations, client);
    await enqueueWatchSyncForHandles([
      ...triggerHandles(hydrated.sources, hydrated.relations),
      ...triggerHandles(prepared.sources, prepared.relations)
    ], client);
    return id;
  });
  return queries.getById(ruleId);
}

async function changeStatus(id, status) {
  if (!['active', 'paused'].includes(status)) {
    throw validationError('Launch monitor status must be active or paused');
  }
  return inTransaction(async (client) => {
    const current = await queries.getById(id, client, { forUpdate: true });
    if (!current) throw validationError('Launch monitor not found', 'LAUNCH_RULE_NOT_FOUND');
    if (current.status === 'triggered' || Number(current.discovery_count) > 0) {
      throw validationError('Triggered launch monitors cannot be reactivated', 'LAUNCH_RULE_TRIGGERED');
    }
    if (status === 'active' && current.expires_at
        && new Date(current.expires_at).getTime() <= Date.now()) {
      throw validationError('Expired launch monitors cannot be activated', 'LAUNCH_RULE_EXPIRED');
    }
    const hydrated = await queries.getById(id, client);
    const item = await queries.updateStatus(id, status, client);
    await enqueueWatchSyncForHandles(
      triggerHandles(hydrated.sources, hydrated.relations),
      client
    );
    return item;
  });
}

async function remove(id) {
  return inTransaction(async (client) => {
    const current = await queries.getById(id, client);
    if (!current) return true;
    const removed = await queries.remove(id, client);
    if (!removed) {
      throw validationError('Triggered launch monitors are retained for audit', 'LAUNCH_RULE_TRIGGERED');
    }
    await enqueueWatchSyncForHandles(
      triggerHandles(current.sources, current.relations),
      client
    );
    return true;
  });
}

module.exports = {
  LAUNCH_RELATION_EVENTS,
  changeStatus,
  create,
  get,
  list,
  normalizeRelations,
  normalizeSources,
  prepareInput,
  previewWatchImpact,
  remove,
  triggerHandles,
  update
};
