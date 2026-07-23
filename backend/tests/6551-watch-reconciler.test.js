const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildWatchPlan,
  mergeFlags,
  roleFlags
} = require('../domains/x-monitor/6551/watch-reconciler');

test('Watch role flags observe outgoing follow actions on actors', () => {
  const kol = roleFlags('kol', { observeUnfollow: true });
  const project = roleFlags('project', { observeUnfollow: true });
  assert.equal(kol.newFlwBol, true);
  assert.equal(kol.newUnFlwBol, true);
  assert.equal(project.newTweetBol, true);
  assert.equal(project.newFlwBol, false);
  assert.equal(project.newUnFlwBol, false);

  const merged = mergeFlags(kol, project);
  assert.equal(merged.newTweetBol, true);
  assert.equal(merged.newTweetReplyBol, true);
  assert.equal(merged.newFlwBol, true);
  assert.equal(merged.newUnFlwBol, true);
  assert.equal(merged.updateNameBol, false);
  assert.equal(merged.updateAvatarBol, false);
});

test('Watch plan protects unknown remote accounts and blocks unmanaged flag changes', () => {
  const desiredFlags = roleFlags('kol');
  const remoteFlags = roleFlags('project');
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
  const remoteFlags = roleFlags('project');
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
