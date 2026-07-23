const db = require('../../../lib/db');
const { normalizeXHandle } = require('../../../lib/x-handles');
const { normalizeWatchFlags } = require('../../../lib/x-client-6551');

function mergeFlags(left, right) {
  const merged = normalizeWatchFlags();
  Object.keys(merged).forEach((key) => {
    merged[key] = left?.[key] === true || right?.[key] === true;
  });
  return merged;
}

function flagsEqual(left, right) {
  const normalizedLeft = normalizeWatchFlags(left);
  const normalizedRight = normalizeWatchFlags(right);
  return Object.keys(normalizedLeft).every((key) => normalizedLeft[key] === normalizedRight[key]);
}

function roleFlags(role, options = {}) {
  const flags = normalizeWatchFlags();
  if (role === 'kol') {
    flags.newTweetBol = true;
    flags.newTweetReplyBol = true;
    flags.newTweetQuoteBol = true;
    flags.newRetweetBol = true;
    flags.newCaBol = true;
    flags.newFlwBol = true;
    flags.newUnFlwBol = options.observeUnfollow === true;
  } else if (role === 'project') {
    // 6551 forces Tweet monitoring on every Watch, even when addWatch sends false.
    flags.newTweetBol = true;
  }
  return flags;
}

function addDesiredRole(map, usernameValue, role, options) {
  const username = normalizeXHandle(usernameValue);
  if (!username) return;
  const current = map.get(username) || {
    username,
    roles: [],
    flags: normalizeWatchFlags()
  };
  if (!current.roles.includes(role)) current.roles.push(role);
  current.flags = mergeFlags(current.flags, roleFlags(role, options));
  map.set(username, current);
}

async function loadDesiredWatches(executor = db) {
  const desired = new Map();
  const options = {
    observeUnfollow: String(process.env.X_6551_WATCH_UNFOLLOW_ENABLED || 'false').toLowerCase() === 'true'
  };
  const [kols, projects] = await Promise.all([
    executor.query(
      `SELECT DISTINCT actor.x_handle
       FROM x_signal_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
       JOIN ca_whitelist AS whitelist ON whitelist.id = relation.whitelist_id
       WHERE relation.enabled = true
         AND actor.enabled = true
         AND whitelist.status = 'active'`
    ),
    executor.query(
      `SELECT DISTINCT relation.target_x_handle AS x_handle
       FROM x_signal_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
       JOIN ca_whitelist AS whitelist ON whitelist.id = relation.whitelist_id
       WHERE relation.enabled = true
         AND actor.enabled = true
         AND whitelist.status = 'active'`
    )
  ]);
  kols.rows.forEach((row) => addDesiredRole(desired, row.x_handle, 'kol', options));
  projects.rows.forEach((row) => addDesiredRole(desired, row.x_handle, 'project', options));
  return [...desired.values()].sort((left, right) => left.username.localeCompare(right.username));
}

function buildWatchPlan({ desired = [], remote = [], local = [] }) {
  const desiredMap = new Map(desired.map((item) => [normalizeXHandle(item.username), item]));
  const remoteMap = new Map(remote.map((item) => [normalizeXHandle(item.username), item]));
  const localMap = new Map(local.map((item) => [normalizeXHandle(item.username), item]));
  const usernames = [...new Set([...desiredMap.keys(), ...remoteMap.keys(), ...localMap.keys()])].sort();
  const entries = [];

  for (const username of usernames) {
    const desiredItem = desiredMap.get(username);
    const remoteItem = remoteMap.get(username);
    const localItem = localMap.get(username);
    const managed = localItem?.managed === true;
    let action = 'none';
    let blocker = null;
    let estimatedPoints = 0;

    if (desiredItem && !remoteItem) {
      action = 'add';
      estimatedPoints = 10;
    } else if (desiredItem && remoteItem && flagsEqual(desiredItem.flags, remoteItem.flags)) {
      if (!managed) action = 'adopt_required';
    } else if (desiredItem && remoteItem && !flagsEqual(desiredItem.flags, remoteItem.flags)) {
      if (managed) {
        action = 'update';
        estimatedPoints = 10;
      } else {
        action = 'blocked_unmanaged_conflict';
        blocker = 'Remote Watch exists with different flags and is not owned by XBOT';
      }
    } else if (!desiredItem && remoteItem && managed) {
      action = 'delete';
    } else if (!desiredItem && !remoteItem && managed) {
      action = 'mark_removed';
    }

    entries.push({
      username,
      remoteUsername: remoteItem?.providerUsername || remoteItem?.raw?.twAccount || remoteItem?.username || null,
      roles: desiredItem?.roles || localItem?.roles || [],
      desiredFlags: desiredItem?.flags || normalizeWatchFlags(),
      remoteFlags: remoteItem?.flags || null,
      remotePresent: Boolean(remoteItem),
      managed,
      action,
      blocker,
      estimatedPoints
    });
  }

  return {
    provider: '6551',
    entries,
    actions: entries.filter((entry) => !['none', 'adopt_required', 'blocked_unmanaged_conflict'].includes(entry.action)),
    adoptionRequired: entries.filter((entry) => entry.action === 'adopt_required'),
    blockers: entries.filter((entry) => entry.blocker),
    estimatedPoints: entries.reduce((total, entry) => total + entry.estimatedPoints, 0),
    desiredCount: desiredMap.size,
    remoteCount: remoteMap.size,
    managedCount: entries.filter((entry) => entry.managed).length
  };
}

function syncStatusFor(entry) {
  if (entry.blocker) return 'error';
  if (entry.action === 'add') return 'pending_add';
  if (entry.action === 'update') return 'pending_update';
  if (entry.action === 'delete') return 'pending_delete';
  if (entry.action === 'none' && entry.managed) return 'in_sync';
  return 'observed';
}

async function persistPlan(plan, executor = db) {
  for (const entry of plan.entries) {
    await executor.query(
      `INSERT INTO x_provider_watches
        (provider, username, roles, desired_flags, remote_flags, managed, sync_status,
         last_seen_remote_at, last_error, updated_at)
       VALUES ('6551', $1, $2, $3, $4, $5, $6,
         CASE WHEN $7 THEN NOW() ELSE NULL END, $8, NOW())
       ON CONFLICT (provider, username)
       DO UPDATE SET
         roles = EXCLUDED.roles,
         desired_flags = EXCLUDED.desired_flags,
         remote_flags = EXCLUDED.remote_flags,
         sync_status = EXCLUDED.sync_status,
         last_seen_remote_at = CASE
           WHEN $7 THEN NOW() ELSE x_provider_watches.last_seen_remote_at END,
         last_error = EXCLUDED.last_error,
         updated_at = NOW()`,
      [
        entry.username,
        entry.roles,
        entry.desiredFlags,
        entry.remoteFlags || {},
        entry.managed,
        syncStatusFor(entry),
        entry.remotePresent,
        entry.blocker
      ]
    );
  }
}

async function getWatchPlan(client, executor = db) {
  const [desired, remote, localResult] = await Promise.all([
    loadDesiredWatches(executor),
    client.listWatches(),
    executor.query("SELECT * FROM x_provider_watches WHERE provider = '6551'")
  ]);
  const plan = buildWatchPlan({ desired, remote, local: localResult.rows });
  await persistPlan(plan, executor);
  return plan;
}

async function setWatchResult(username, values, executor = db) {
  await executor.query(
    `UPDATE x_provider_watches
     SET managed = $1, sync_status = $2, remote_flags = $3,
         last_synced_at = NOW(), last_error = $4, updated_at = NOW()
     WHERE provider = '6551' AND username = $5`,
    [values.managed, values.status, values.remoteFlags || {}, values.error || null, username]
  );
}

async function applyWatchPlan(client, options = {}, executor = db) {
  if (String(process.env.X_6551_WATCH_APPLY_ENABLED || 'false').toLowerCase() !== 'true') {
    const error = new Error('6551 Watch apply is disabled by configuration');
    error.code = 'X6551_WATCH_APPLY_DISABLED';
    throw error;
  }
  if (options.confirmation !== 'APPLY 6551 WATCH CHANGES') {
    const error = new Error('Explicit Watch apply confirmation is required');
    error.code = 'X6551_WATCH_CONFIRMATION_REQUIRED';
    throw error;
  }

  const plan = await getWatchPlan(client, executor);
  if (plan.blockers.length > 0) {
    const error = new Error('Watch plan contains unmanaged flag conflicts');
    error.code = 'X6551_WATCH_PLAN_BLOCKED';
    error.plan = plan;
    throw error;
  }

  const adopt = new Set((options.adopt || []).map(normalizeXHandle));
  const results = [];
  for (const entry of plan.adoptionRequired) {
    if (!adopt.has(entry.username)) continue;
    await setWatchResult(entry.username, {
      managed: true,
      status: 'in_sync',
      remoteFlags: entry.remoteFlags
    }, executor);
    results.push({ username: entry.username, action: 'adopt', status: 'completed' });
  }

  for (const entry of plan.actions) {
    try {
      if (entry.action === 'add') {
        await client.addWatch(entry.username, entry.desiredFlags);
        await setWatchResult(entry.username, {
          managed: true,
          status: 'in_sync',
          remoteFlags: entry.desiredFlags
        }, executor);
      } else if (entry.action === 'update') {
        await client.deleteWatch(entry.remoteUsername || entry.username);
        await client.addWatch(entry.username, entry.desiredFlags);
        await setWatchResult(entry.username, {
          managed: true,
          status: 'in_sync',
          remoteFlags: entry.desiredFlags
        }, executor);
      } else if (entry.action === 'delete') {
        await client.deleteWatch(entry.remoteUsername || entry.username);
        await setWatchResult(entry.username, {
          managed: false,
          status: 'observed',
          remoteFlags: {}
        }, executor);
      } else if (entry.action === 'mark_removed') {
        await setWatchResult(entry.username, {
          managed: false,
          status: 'observed',
          remoteFlags: {}
        }, executor);
      }
      results.push({ username: entry.username, action: entry.action, status: 'completed' });
    } catch (error) {
      await setWatchResult(entry.username, {
        managed: entry.managed,
        status: 'error',
        remoteFlags: entry.remoteFlags || {},
        error: error.message
      }, executor);
      error.code ||= 'X6551_WATCH_APPLY_FAILED';
      error.results = results;
      throw error;
    }
  }
  return { plan, results };
}

module.exports = {
  applyWatchPlan,
  buildWatchPlan,
  flagsEqual,
  getWatchPlan,
  loadDesiredWatches,
  mergeFlags,
  roleFlags
};
