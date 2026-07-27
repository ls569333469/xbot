const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env'), quiet: true });
require('./integration-guard');
const db = require('../lib/db');
const launchService = require('../domains/launch-monitor/service');
const whitelistService = require('../domains/whitelist/service');
const { matchActivity } = require('../domains/signal/matcher');

const created = {
  ruleIds: [],
  activityIds: [],
  actorHandles: new Set(),
  whitelistIds: new Set(),
  logRuleIds: []
};

function fixtureSuffix() {
  return Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
}

function evmAddress(seed) {
  return `0x${seed.repeat(40).slice(0, 40)}`;
}

function launchPayload(chainId, projectHandle, overrides = {}) {
  created.actorHandles.add(projectHandle);
  for (const relation of overrides.relations || []) created.actorHandles.add(relation.actor_handle);
  return {
    chain_id: chainId,
    project_name: `Launch ${projectHandle}`,
    sources: [{ actor_handle: projectHandle, role: 'official', event_types: ['tweet'] }],
    relations: overrides.relations || [],
    budget_per_trade: 0.001,
    total_budget: 0.01,
    slippage: 10,
    allow_repeat_buy: false,
    max_repeat_buys: 1,
    exit_strategy: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [{ type: 'take_profit', trigger_pct: 100, sell_pct: 100 }]
    },
    ...overrides
  };
}

async function createLaunch(payload) {
  const item = await launchService.create(payload);
  created.ruleIds.push(item.id);
  return item;
}

async function actorId(handle) {
  const result = await db.query(
    "SELECT id FROM x_kol_accounts WHERE lower(regexp_replace(x_handle, '^@+', '')) = $1",
    [handle.toLowerCase()]
  );
  assert.equal(result.rows.length, 1, `missing actor @${handle}`);
  return result.rows[0].id;
}

async function createActivity({ actorHandle, activityType = 'tweet', cas = [], targetHandle = null }) {
  const suffix = fixtureSuffix();
  const result = await db.query(
    `INSERT INTO x_activities(
       kol_id, kol_handle, activity_type, tweet_id, tweet_text,
       target_x_handle, target_x_handles, extracted_cas, semantic_key,
       provider, processed
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'6551',true)
     RETURNING *`,
    [
      await actorId(actorHandle), actorHandle, activityType,
      `launch-${suffix}`, `launch fixture ${cas.join(' ')}`,
      targetHandle, targetHandle ? [targetHandle] : [], cas,
      `tweet:${actorHandle}:launch-${suffix}`
    ]
  );
  created.activityIds.push(result.rows[0].id);
  return result.rows[0];
}

test('multiple pre-launch rules discovering the same CA create one whitelist and one Signal', async () => {
  const suffix = fixtureSuffix();
  const project = `lp${suffix}`;
  const ca = evmAddress(`${suffix}1`);
  const left = await createLaunch(launchPayload('base', project));
  const right = await createLaunch(launchPayload('base', project));
  const activity = await createActivity({ actorHandle: project, cas: [ca] });

  const result = await matchActivity(activity, db, { notify: false, returnSignals: true });
  assert.equal(result.count, 1);
  assert.equal(result.signals.length, 1);

  const rules = await db.query(
    'SELECT id, status, discovery_count FROM project_launch_rules WHERE id = ANY($1::bigint[]) ORDER BY id',
    [[left.id, right.id]]
  );
  assert.deepEqual(rules.rows.map((row) => [row.status, row.discovery_count]), [
    ['triggered', 1], ['triggered', 1]
  ]);
  const discoveries = await db.query(
    `SELECT COUNT(*)::int AS count,
            COUNT(DISTINCT whitelist_id)::int AS whitelist_count,
            COUNT(DISTINCT signal_id)::int AS signal_count
     FROM project_launch_discoveries WHERE launch_rule_id = ANY($1::bigint[])`,
    [[left.id, right.id]]
  );
  assert.deepEqual(discoveries.rows[0], { count: 2, whitelist_count: 1, signal_count: 1 });
  const whitelist = await db.query(
    `SELECT whitelist.launch_rule_id,
            whitelist.live_activation_state, whitelist.activation_version,
            signal.activation_wait_version,
            (SELECT COUNT(*)::int FROM x_signal_source_rules AS source
             WHERE source.whitelist_id = whitelist.id AND source.source_kind = 'launch') AS launch_source_count,
            (SELECT COUNT(*)::int FROM whitelist_x_accounts AS account
             WHERE account.whitelist_id = whitelist.id AND account.usage = 'identity') AS identity_count
     FROM ca_whitelist AS whitelist
     JOIN trade_signals AS signal ON signal.whitelist_id = whitelist.id
     WHERE whitelist.chain_id = 'base' AND lower(whitelist.contract_address) = lower($1)`,
    [ca]
  );
  assert.equal(whitelist.rows.length, 1);
  assert.equal(whitelist.rows[0].launch_source_count, 1);
  assert.equal(whitelist.rows[0].identity_count, 1);
  assert.equal(whitelist.rows[0].live_activation_state, 'syncing');
  assert.equal(
    Number(whitelist.rows[0].activation_wait_version),
    Number(whitelist.rows[0].activation_version)
  );
});

test('ecosystem interaction discovers CA only when actor, target and event all match', async () => {
  const suffix = fixtureSuffix();
  const project = `pr${suffix}`;
  const ecosystem = `ec${suffix}`;
  const ca = evmAddress(`${suffix}2`);
  const rule = await createLaunch(launchPayload('eth', project, {
    relations: [{
      actor_handle: ecosystem,
      target_x_handle: project,
      event_types: ['quote', 'reply']
    }]
  }));
  const activity = await createActivity({
    actorHandle: ecosystem,
    activityType: 'quote',
    cas: [ca],
    targetHandle: project
  });

  const result = await matchActivity(activity, db, { notify: false, returnSignals: true });
  assert.equal(result.count, 1);
  const discovery = await db.query(
    `SELECT discovery.trigger_kind, signal.matched_relation_ids
     FROM project_launch_discoveries AS discovery
     JOIN trade_signals AS signal ON signal.id = discovery.signal_id
     WHERE discovery.launch_rule_id = $1`,
    [rule.id]
  );
  assert.equal(discovery.rows[0].trigger_kind, 'ecosystem_relation');
  assert.equal(discovery.rows[0].matched_relation_ids.length, 1);
});

test('missing, invalid and multiple CAs fail closed without consuming the launch rule', async () => {
  const suffix = fixtureSuffix();
  const project = `fc${suffix}`;
  const rule = await createLaunch(launchPayload('base', project));
  created.logRuleIds.push(rule.id);
  const activities = [
    await createActivity({ actorHandle: project, cas: [] }),
    await createActivity({ actorHandle: project, cas: ['not-an-address'] }),
    await createActivity({
      actorHandle: project,
      cas: [evmAddress(`${suffix}3`), evmAddress(`${suffix}4`)]
    })
  ];
  for (const activity of activities) {
    const result = await matchActivity(activity, db, { notify: false, returnSignals: true });
    assert.equal(result.count, 0);
  }
  const state = await db.query(
    `SELECT status, discovery_count,
            (SELECT COUNT(*)::int FROM project_launch_discoveries WHERE launch_rule_id = $1) AS discoveries
     FROM project_launch_rules WHERE id = $1`,
    [rule.id]
  );
  assert.deepEqual(state.rows[0], { status: 'active', discovery_count: 0, discoveries: 0 });
  const skipped = await db.query(
    `SELECT COUNT(*)::int AS count FROM system_logs
     WHERE module = 'launch-monitor' AND message = 'LAUNCH_EVENT_MULTIPLE_CA'
       AND (meta->>'launch_rule_id')::bigint = $1`,
    [rule.id]
  );
  assert.equal(skipped.rows[0].count, 1);
});

test('fixed-CA and pre-launch matches on the same event reuse the existing Signal', async () => {
  const suffix = fixtureSuffix();
  const actor = `fx${suffix}`;
  const ca = evmAddress(`${suffix}5`);
  const rule = await createLaunch(launchPayload('base', actor));
  const fixed = await whitelistService.addWhitelist({
    contract_address: ca,
    chain_id: 'base',
    symbol: `FX${suffix}`,
    project_name: 'Fixed dedup fixture',
    budget_per_trade: 0.001,
    total_budget: 0.01,
    direct_sources: [{
      actor_handle: actor,
      event_types: ['tweet'],
      match_mode: 'ca_only',
      source_kind: 'ecosystem'
    }]
  });
  created.whitelistIds.add(fixed.item.id);
  const activity = await createActivity({ actorHandle: actor, cas: [ca] });
  const result = await matchActivity(activity, db, { notify: false, returnSignals: true });
  assert.equal(result.count, 1);
  assert.equal(result.signals.length, 1);

  const evidence = await db.query(
    `SELECT discovery.whitelist_id, discovery.signal_id,
            (SELECT COUNT(*)::int FROM trade_signals WHERE activity_id = $2) AS activity_signals,
            (SELECT COUNT(*)::int FROM ca_whitelist
             WHERE chain_id = 'base' AND lower(contract_address) = lower($3)) AS whitelist_count
     FROM project_launch_discoveries AS discovery
     WHERE discovery.launch_rule_id = $1`,
    [rule.id, activity.id, ca]
  );
  assert.equal(String(evidence.rows[0].whitelist_id), String(fixed.item.id));
  assert.equal(String(evidence.rows[0].signal_id), String(result.signals[0].id));
  assert.equal(evidence.rows[0].activity_signals, 1);
  assert.equal(evidence.rows[0].whitelist_count, 1);
});

test.after(async () => {
  try {
    if (created.ruleIds.length) {
      await db.query(
        'DELETE FROM project_launch_discoveries WHERE launch_rule_id = ANY($1::bigint[])',
        [created.ruleIds]
      );
    }
    if (created.activityIds.length) {
      await db.query('DELETE FROM trade_signals WHERE activity_id = ANY($1::int[])', [created.activityIds]);
    }
    if (created.ruleIds.length) {
      const generatedWhitelistIds = (await db.query(
        'SELECT id FROM ca_whitelist WHERE launch_rule_id = ANY($1::bigint[])',
        [created.ruleIds]
      )).rows.map((row) => row.id);
      generatedWhitelistIds.forEach((id) => created.whitelistIds.add(id));
      if (created.whitelistIds.size) await db.query(
        'DELETE FROM ca_whitelist WHERE id = ANY($1::int[])',
        [[...created.whitelistIds]]
      );
      await db.query('DELETE FROM project_launch_rules WHERE id = ANY($1::bigint[])', [created.ruleIds]);
    }
    if (created.activityIds.length) {
      await db.query('DELETE FROM x_activities WHERE id = ANY($1::int[])', [created.activityIds]);
    }
    if (created.logRuleIds.length) {
      await db.query(
        `DELETE FROM system_logs WHERE module = 'launch-monitor'
         AND (meta->>'launch_rule_id')::bigint = ANY($1::bigint[])`,
        [created.logRuleIds]
      );
    }
    const handles = [...created.actorHandles];
    if (handles.length) {
      await db.query('DELETE FROM x_watch_sync_outbox WHERE actor_handle = ANY($1::text[])', [handles]);
      await db.query(
        "DELETE FROM x_kol_accounts WHERE lower(regexp_replace(x_handle, '^@+', '')) = ANY($1::text[])",
        [handles]
      );
    }
  } finally {
    await db.pool.end();
  }
});
