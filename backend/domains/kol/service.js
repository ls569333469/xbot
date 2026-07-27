const queries = require('./queries');
const db = require('../../lib/db');
const { createXClient } = require('../../lib/x-client');
const { normalizeXHandle } = require('../../lib/x-handles');
const logger = require('../../lib/logger');
const { enqueueWatchSyncForHandles } = require('../x-monitor/6551/watch-sync-outbox');
const { enqueueWhitelistActivation } = require('../whitelist/activation-outbox');

const KOL_TAGS = new Set(['sol', 'bsc', 'base', 'eth', 'robinhood', 'cross_chain']);
const X_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;

function normalizeKolFields(data, options = {}) {
  const result = { ...data };
  if (data.x_handle !== undefined || options.requireHandle) {
    result.x_handle = normalizeXHandle(data.x_handle);
    if (!X_HANDLE_PATTERN.test(result.x_handle)) throw new Error('x_handle is invalid');
  }
  if (data.chain_ids !== undefined) {
    if (!Array.isArray(data.chain_ids)) throw new Error('chain_ids must be an array');
    result.chain_ids = [...new Set(data.chain_ids.map((value) => String(value).trim().toLowerCase()))];
    const invalid = result.chain_ids.find((value) => !KOL_TAGS.has(value));
    if (invalid) throw new Error(`Unsupported ecosystem tag: ${invalid}`);
  }
  if (data.weight !== undefined) {
    result.weight = Number(data.weight);
    if (!Number.isSafeInteger(result.weight) || result.weight < 1 || result.weight > 10) {
      throw new Error('weight must be an integer between 1 and 10');
    }
  }
  return result;
}

async function getKols(filters = {}) {
  return await queries.getAll(filters);
}

async function getKol(id) {
  return await queries.getById(id);
}

async function resolveProfile(data, options = {}) {
  try {
    const profile = await fetchVerifiedProfile(data.x_handle, options);
    return {
      profile: { ...profile, name: profile.name || data.display_name || data.x_handle },
      profile_status: 'verified'
    };
  } catch (error) {
    const code = String(error.code || 'X_PROFILE_UNAVAILABLE').slice(0, 80);
    (options.logger || logger).warn('kol', 'X profile enrichment deferred', {
      handle: data.x_handle,
      code
    });
    return {
      profile: {
        id: data.x_handle,
        handle: data.x_handle,
        name: data.display_name || data.x_handle
      },
      profile_status: 'pending',
      profile_warning: '账号已保存；6551 Profile 暂未核验'
    };
  }
}

async function fetchVerifiedProfile(handle, options = {}) {
  const client = options.xClient || (options.createXClient || createXClient)();
  const profile = await client.getUserProfile(handle);
  const profileId = String(profile?.id ?? '').trim();
  if (!profileId || ['undefined', 'null'].includes(profileId.toLowerCase())) {
    const error = new Error('X profile is missing a valid user ID');
    error.code = 'X_PROFILE_ID_INVALID';
    throw error;
  }
  return {
    id: profileId,
    handle: normalizeXHandle(profile.handle || handle),
    name: profile.name || ''
  };
}

async function addKol(data, options = {}) {
  if (!data.x_handle) {
    throw new Error('x_handle is required');
  }

  const normalized = normalizeKolFields(data, { requireHandle: true });
  const repository = options.queries || queries;
  const saved = await repository.create({
    ...normalized,
    x_user_id: normalized.x_handle,
    display_name: data.display_name || normalized.x_handle,
    profile_status: 'pending',
    profile_attempt_count: 0,
    profile_next_retry_at: new Date()
  });
  return {
    ...saved,
    profile_warning: saved.profile_status === 'pending'
      ? '账号已保存，后台将在约 5 秒内开始核验 6551 Profile'
      : undefined
  };
}

async function updateKol(id, data, options = {}) {
  const normalized = normalizeKolFields(data);
  const repository = options.queries || queries;
  if (!options.queries) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await queries.getById(id, client, { forUpdate: true });
      if (!existing) throw new Error('KOL account not found');
      const identityReset = data.x_handle !== undefined
        && normalizeXHandle(existing.x_handle) !== normalized.x_handle;
      if (identityReset) normalized.x_user_id = normalized.x_handle;
      const impact = identityReset ? await queries.getDependencyImpact(id, client) : null;
      const saved = await queries.update(
        id,
        { ...normalized, identity_reset: identityReset },
        client
      );
      if (identityReset) {
        await enqueueWatchSyncForHandles([existing.x_handle, saved.x_handle], client);
        for (const whitelistId of impact.whitelist_ids || []) {
          await enqueueWhitelistActivation(whitelistId, client);
        }
      }
      await client.query('COMMIT');
      return {
        ...saved,
        ...(identityReset ? { profile_status: 'pending' } : {}),
        ...(identityReset ? { profile_warning: '账号已更新，后台将在约 5 秒内重新核验 6551 Profile' } : {})
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  let identityReset = false;
  if (data.x_handle !== undefined) {
    const existing = await repository.getById(id);
    if (!existing) throw new Error('KOL account not found');
    identityReset = normalizeXHandle(existing.x_handle) !== normalized.x_handle;
    if (identityReset) normalized.x_user_id = normalized.x_handle;
  }
  const saved = await repository.update(id, { ...normalized, identity_reset: identityReset });
  return {
    ...saved,
    ...(identityReset ? { profile_status: 'pending' } : {}),
    ...(identityReset ? { profile_warning: '账号已更新，后台将在约 5 秒内重新核验 6551 Profile' } : {})
  };
}

async function retryKolProfile(id, options = {}) {
  const repository = options.queries || queries;
  const saved = await repository.scheduleProfileRetry(id);
  if (!saved) throw new Error('KOL account not found');
  return {
    ...saved,
    profile_warning: '已安排立即核验，页面会自动更新结果'
  };
}

async function toggleKol(id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await queries.getById(id, client, { forUpdate: true });
    if (!current) throw new Error('KOL account not found');
    const impact = await queries.getDependencyImpact(id, client);
    const saved = await queries.toggle(id, client);
    await enqueueWatchSyncForHandles([current.x_handle], client);
    if (saved.enabled) {
      for (const whitelistId of impact.whitelist_ids || []) {
        await enqueueWhitelistActivation(whitelistId, client);
      }
    }
    await client.query('COMMIT');
    return saved;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function deleteKol(id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await queries.getById(id, client, { forUpdate: true });
    if (!current) {
      await client.query('COMMIT');
      return { deleted: true, missing: true };
    }
    const impact = await queries.getDependencyImpact(id, client);
    let result;
    if (Number(impact.activity_count || 0) > 0) {
      if (current.enabled) await queries.toggle(id, client);
      result = { deleted: false, disabled: true, reason: 'KOL_HISTORY_PRESERVED' };
    } else {
      await queries.remove(id, client);
      for (const whitelistId of impact.whitelist_ids || []) {
        await enqueueWhitelistActivation(whitelistId, client);
      }
      result = { deleted: true, disabled: false };
    }
    await enqueueWatchSyncForHandles([current.x_handle], client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getKolActivities(id, limit) {
  return await queries.getActivities(id, limit);
}

module.exports = {
  KOL_TAGS,
  addKol,
  deleteKol,
  getKol,
  getKolActivities,
  getKols,
  normalizeKolFields,
  fetchVerifiedProfile,
  resolveProfile,
  retryKolProfile,
  toggleKol,
  updateKol
};
