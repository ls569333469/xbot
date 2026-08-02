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

function remoteFlagsCoverDesired(desired, remote) {
  const normalizedDesired = normalizeWatchFlags(desired);
  const normalizedRemote = normalizeWatchFlags(remote);
  return Object.keys(normalizedDesired).every(
    (key) => normalizedDesired[key] !== true || normalizedRemote[key] === true
  );
}

function roleFlags(role, options = {}) {
  const flags = normalizeWatchFlags();
  if (role === 'kol') {
    const eventTypes = new Set(Array.isArray(options.eventTypes)
      ? options.eventTypes
      : ['tweet', 'retweet', 'quote', 'reply', 'follow']);
    flags.newTweetBol = eventTypes.has('tweet');
    flags.newTweetReplyBol = eventTypes.has('reply');
    flags.newTweetQuoteBol = eventTypes.has('quote');
    flags.newRetweetBol = eventTypes.has('retweet');
    flags.newCaBol = ['tweet', 'reply', 'quote'].some((eventType) => eventTypes.has(eventType));
    flags.newFlwBol = eventTypes.has('follow');
    flags.newUnFlwBol = eventTypes.has('follow') && options.observeUnfollow === true;
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
  const kols = await executor.query(
    `SELECT x_handle, array_agg(DISTINCT event_type ORDER BY event_type) AS event_types
     FROM (
       SELECT actor.x_handle, event_type
       FROM x_signal_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
       JOIN ca_whitelist AS whitelist ON whitelist.id = relation.whitelist_id
       CROSS JOIN LATERAL unnest(relation.event_types) AS event_type
        WHERE relation.enabled = true
          AND actor.enabled = true
          AND whitelist.status = 'active'
          AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
       UNION ALL
       SELECT actor.x_handle, event_type
       FROM x_signal_source_rules AS rule
       JOIN x_kol_accounts AS actor ON actor.id = rule.actor_id
       JOIN ca_whitelist AS whitelist ON whitelist.id = rule.whitelist_id
       CROSS JOIN LATERAL unnest(rule.event_types) AS event_type
        WHERE rule.enabled = true
          AND actor.enabled = true
          AND rule.source_kind = 'ecosystem'
          AND whitelist.status = 'active'
          AND (whitelist.expires_at IS NULL OR whitelist.expires_at > NOW())
        UNION ALL
        SELECT actor.x_handle, event_type
        FROM x_actor_dynamic_policies AS policy
        JOIN x_kol_accounts AS actor ON actor.id = policy.kol_id
        CROSS JOIN LATERAL unnest(policy.allowed_event_types) AS event_type
        WHERE policy.enabled = true
          AND policy.mode <> 'paused'
          AND actor.enabled = true
      UNION ALL
       SELECT actor.x_handle, event_type
       FROM project_launch_sources AS source
       JOIN x_kol_accounts AS actor ON actor.id = source.actor_id
       JOIN project_launch_rules AS rule ON rule.id = source.launch_rule_id
       CROSS JOIN LATERAL unnest(source.event_types) AS event_type
       WHERE source.enabled = true
         AND actor.enabled = true
         AND rule.status = 'active'
         AND rule.discovery_count = 0
         AND (rule.expires_at IS NULL OR rule.expires_at > NOW())
       UNION ALL
       SELECT actor.x_handle, event_type
       FROM project_launch_relations AS relation
       JOIN x_kol_accounts AS actor ON actor.id = relation.actor_id
       JOIN project_launch_rules AS rule ON rule.id = relation.launch_rule_id
       CROSS JOIN LATERAL unnest(relation.event_types) AS event_type
       WHERE relation.enabled = true
         AND actor.enabled = true
         AND rule.status = 'active'
         AND rule.discovery_count = 0
         AND (rule.expires_at IS NULL OR rule.expires_at > NOW())
     ) AS desired
     GROUP BY x_handle`
  );
  kols.rows.forEach((row) => addDesiredRole(desired, row.x_handle, 'kol', {
    ...options,
    eventTypes: row.event_types
  }));
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
  const adopt = new Set((options.adopt || []).map(normalizeXHandle).filter(Boolean));
  const unresolvedBlockers = plan.blockers.filter((entry) => !adopt.has(entry.username));
  if (unresolvedBlockers.length > 0 && options.allowUnresolvedBlockers !== true) {
    const error = new Error('Watch plan contains unmanaged flag conflicts');
    error.code = 'X6551_WATCH_PLAN_BLOCKED';
    error.plan = { ...plan, blockers: unresolvedBlockers };
    throw error;
  }

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

  // An unmanaged Watch with different flags requires an explicit takeover.
  // Delete and recreate it so the remote flags are known to match XBOT's desired state.
  for (const entry of plan.blockers) {
    if (!adopt.has(entry.username)) continue;
    try {
      await client.deleteWatch(entry.remoteUsername || entry.username);
      await client.addWatch(entry.username, entry.desiredFlags);
      await setWatchResult(entry.username, {
        managed: true,
        status: 'in_sync',
        remoteFlags: entry.desiredFlags
      }, executor);
      results.push({ username: entry.username, action: 'takeover_update', status: 'completed' });
    } catch (error) {
      await setWatchResult(entry.username, {
        managed: false,
        status: 'error',
        remoteFlags: entry.remoteFlags || {},
        error: error.message
      }, executor);
      error.code ||= 'X6551_WATCH_APPLY_FAILED';
      error.results = results;
      throw error;
    }
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
  remoteFlagsCoverDesired,
  roleFlags
};
