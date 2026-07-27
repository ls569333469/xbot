const test = require('node:test');
const assert = require('node:assert/strict');
const {
  applyWatchPlan,
  buildWatchPlan,
  loadDesiredWatches,
  mergeFlags,
  remoteFlagsCoverDesired,
  roleFlags
} = require('../domains/x-monitor/6551/watch-reconciler');

test('Watch role flags observe outgoing follow actions on actors', () => {
  const kol = roleFlags('kol', { observeUnfollow: true });
  assert.equal(kol.newFlwBol, true);
  assert.equal(kol.newUnFlwBol, true);
  assert.equal(kol.updateNameBol, false);
  assert.equal(kol.updateAvatarBol, false);
});

test('Watch flags are the union of relation event capabilities', () => {
  const tweet = roleFlags('kol', { eventTypes: ['tweet'] });
  const follow = roleFlags('kol', { eventTypes: ['follow'], observeUnfollow: true });
  const merged = mergeFlags(tweet, follow);
  assert.equal(merged.newTweetBol, true);
  assert.equal(merged.newTweetReplyBol, false);
  assert.equal(merged.newFlwBol, true);
  assert.equal(merged.newUnFlwBol, true);
});

test('remote Watch may expose extra provider events while covering all desired events', () => {
  const desired = roleFlags('kol', { eventTypes: ['quote', 'reply', 'retweet', 'follow'] });
  const remote = { ...desired, newTweetBol: true, newUnFlwBol: true };
  assert.equal(remoteFlagsCoverDesired(desired, remote), true);
  assert.equal(remoteFlagsCoverDesired(desired, { ...remote, newRetweetBol: false }), false);
});

test('desired Watch union includes active pre-launch project and ecosystem accounts', async () => {
  const executor = {
    async query(sql) {
      assert.match(sql, /project_launch_sources/);
      assert.match(sql, /project_launch_relations/);
      assert.match(sql, /rule\.discovery_count = 0/);
      return {
        rows: [
          { x_handle: '@LaunchProject', event_types: ['tweet'] },
          { x_handle: 'LaunchEcosystem', event_types: ['quote', 'reply'] }
        ]
      };
    }
  };
  const desired = await loadDesiredWatches(executor);
  assert.deepEqual(desired.map((item) => item.username), ['launchecosystem', 'launchproject']);
  assert.equal(desired[0].flags.newTweetQuoteBol, true);
  assert.equal(desired[0].flags.newTweetReplyBol, true);
  assert.equal(desired[1].flags.newTweetBol, true);
});

test('Watch plan protects unknown remote accounts and blocks unmanaged flag changes', () => {
  const desiredFlags = roleFlags('kol');
  const remoteFlags = roleFlags('kol', { eventTypes: ['tweet'] });
  const plan = buildWatchPlan({
    desired: [{ username: 'neet_sol', roles: ['kol'], flags: desiredFlags }],
    remote: [
      { username: 'neet_sol', flags: remoteFlags },
      { username: 'RootDataCrypto', flags: remoteFlags }
    ],
    local: []
  });

  const target = plan.entries.find((entry) => entry.username === 'neet_sol');
  const unknown = plan.entries.find((entry) => entry.username === 'rootdatacrypto');
  assert.equal(target.action, 'blocked_unmanaged_conflict');
  assert.ok(target.blocker);
  assert.equal(unknown.action, 'none');
  assert.equal(plan.actions.length, 0);
});

test('Watch plan only updates or deletes explicitly managed accounts', () => {
  const desiredFlags = roleFlags('kol');
  const remoteFlags = roleFlags('kol', { eventTypes: ['tweet'] });
  const plan = buildWatchPlan({
    desired: [{ username: 'neet_sol', roles: ['kol'], flags: desiredFlags }],
    remote: [
      { username: 'neet_sol', providerUsername: 'Neet_Sol', flags: remoteFlags },
      { username: 'old_project', flags: remoteFlags }
    ],
    local: [
      { username: 'neet_sol', managed: true, roles: ['kol'] },
      { username: 'old_project', managed: true, roles: ['project'] }
    ]
  });

  const update = plan.entries.find((entry) => entry.username === 'neet_sol');
  assert.equal(update.action, 'update');
  assert.equal(update.remoteUsername, 'Neet_Sol');
  assert.equal(plan.entries.find((entry) => entry.username === 'old_project').action, 'delete');
  assert.equal(plan.estimatedPoints, 10);
});

function createWatchApplyExecutor() {
  const updates = [];
  return {
    updates,
    async query(sql, params = []) {
      if (sql.includes('FROM x_signal_relations')) {
        return { rows: [{ x_handle: 'heyibinance', event_types: ['quote', 'reply', 'retweet', 'tweet'] }] };
      }
      if (sql.includes("FROM x_provider_watches WHERE provider = '6551'")) {
        return {
          rows: [{
            username: 'heyibinance',
            managed: false,
            roles: ['kol'],
            desired_flags: {},
            remote_flags: {},
            sync_status: 'error'
          }]
        };
      }
      if (sql.includes('INSERT INTO x_provider_watches')) {
        updates.push({ type: 'persist', params });
        return { rows: [] };
      }
      if (sql.includes('UPDATE x_provider_watches')) {
        updates.push({ type: 'result', params });
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
}

test('Watch apply keeps an unmanaged flag conflict blocked without explicit adoption', async () => {
  const previous = process.env.X_6551_WATCH_APPLY_ENABLED;
  process.env.X_6551_WATCH_APPLY_ENABLED = 'true';
  const executor = createWatchApplyExecutor();
  const client = {
    async listWatches() {
      return [{ username: 'heyibinance', flags: roleFlags('kol', { eventTypes: ['tweet'] }) }];
    }
  };

  await assert.rejects(
    applyWatchPlan(client, { confirmation: 'APPLY 6551 WATCH CHANGES' }, executor),
    (error) => error.code === 'X6551_WATCH_PLAN_BLOCKED'
  );
  assert.equal(executor.updates.some((item) => item.type === 'result'), false);
  if (previous === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
  else process.env.X_6551_WATCH_APPLY_ENABLED = previous;
});

test('Watch apply explicitly adopts an unmanaged flag conflict by replacing the remote Watch', async () => {
  const previous = process.env.X_6551_WATCH_APPLY_ENABLED;
  process.env.X_6551_WATCH_APPLY_ENABLED = 'true';
  const executor = createWatchApplyExecutor();
  const calls = [];
  const client = {
    async listWatches() {
      return [{ username: 'HeyiBinance', flags: roleFlags('kol', { eventTypes: ['tweet'] }) }];
    },
    async deleteWatch(username) {
      calls.push(['delete', username]);
    },
    async addWatch(username, flags) {
      calls.push(['add', username, flags]);
    }
  };

  const result = await applyWatchPlan(client, {
    confirmation: 'APPLY 6551 WATCH CHANGES',
    adopt: ['@heyibinance']
  }, executor);

  assert.deepEqual(calls.map((call) => call[0]), ['delete', 'add']);
  assert.equal(calls[0][1], 'HeyiBinance');
  assert.equal(calls[1][1], 'heyibinance');
  assert.equal(calls[1][2].newRetweetBol, true);
  assert.deepEqual(result.results.map((item) => item.action), ['takeover_update']);
  const finalUpdate = executor.updates.filter((item) => item.type === 'result').at(-1);
  assert.equal(finalUpdate.params[0], true);
  assert.equal(finalUpdate.params[1], 'in_sync');
  if (previous === undefined) delete process.env.X_6551_WATCH_APPLY_ENABLED;
  else process.env.X_6551_WATCH_APPLY_ENABLED = previous;
});
