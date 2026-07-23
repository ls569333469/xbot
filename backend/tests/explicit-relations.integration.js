const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const { matchActivity } = require('../domains/signal/matcher');

test('explicit relations reject unconfigured actor-target cross matches', async () => {
  const suffix = String(Date.now()).slice(-7);
  const handles = {
    actorA: `actora${suffix}`,
    actorB: `actorb${suffix}`,
    targetA: `targeta${suffix}`,
    targetB: `targetb${suffix}`
  };
  const ids = { kols: [], whitelists: [], activities: [] };
  const previousMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'signal';

  try {
    for (const actorHandle of [handles.actorA, handles.actorB]) {
      const result = await db.query(
        `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
         VALUES ($1, $1, $1, true) RETURNING id`,
        [actorHandle]
      );
      ids.kols.push(result.rows[0].id);
    }

    for (const [ca, targetHandle, kolId] of [
      [`RELCA${suffix}A`, handles.targetA, ids.kols[0]],
      [`RELCA${suffix}B`, handles.targetB, ids.kols[1]]
    ]) {
      const whitelist = await db.query(
        `INSERT INTO ca_whitelist
          (contract_address, chain_id, symbol, project_name, project_x_handles,
           budget_per_trade, total_budget, status)
         VALUES ($1, 'sol', $1, 'Explicit Relation Test', ARRAY[$2], 0.001, 0.01, 'active')
         RETURNING id`,
        [ca, targetHandle]
      );
      ids.whitelists.push(whitelist.rows[0].id);
      await db.query(
        `INSERT INTO x_signal_relations (whitelist_id, kol_id, target_x_handle)
         VALUES ($1, $2, $3)`,
        [whitelist.rows[0].id, kolId, targetHandle]
      );
    }

    const insertActivity = async (kolIndex, targetHandle, eventId) => {
      const activity = await db.query(
        `INSERT INTO x_activities
          (kol_id, kol_handle, activity_type, target_x_handle, target_x_handles,
           provider_event_id, provider, processed)
         VALUES ($1, $2, 'follow', $3, ARRAY[$3], $4, 'test', false)
         RETURNING *`,
        [ids.kols[kolIndex], kolIndex === 0 ? handles.actorA : handles.actorB, targetHandle, eventId]
      );
      ids.activities.push(activity.rows[0].id);
      return activity.rows[0];
    };

    const wrongCross = await insertActivity(0, handles.targetB, `wrong-${suffix}`);
    assert.equal(await matchActivity(wrongCross), 0);

    const correct = await insertActivity(0, handles.targetA, `correct-${suffix}`);
    assert.equal(await matchActivity(correct), 1);

    const signals = await db.query(
      `SELECT matched_project_handles, matched_relation_ids
       FROM trade_signals WHERE activity_id = $1`,
      [correct.id]
    );
    assert.deepEqual(signals.rows[0].matched_project_handles, [handles.targetA]);
    assert.equal(signals.rows[0].matched_relation_ids.length, 1);
  } finally {
    if (ids.activities.length > 0) {
      await db.query('DELETE FROM trade_signals WHERE activity_id = ANY($1::int[])', [ids.activities]);
      await db.query('DELETE FROM x_activities WHERE id = ANY($1::int[])', [ids.activities]);
    }
    if (ids.kols.length > 0) {
      await db.query('DELETE FROM x_follow_signal_once WHERE kol_id = ANY($1::int[])', [ids.kols]);
    }
    if (ids.whitelists.length > 0) {
      await db.query('DELETE FROM ca_whitelist WHERE id = ANY($1::int[])', [ids.whitelists]);
    }
    if (ids.kols.length > 0) {
      await db.query('DELETE FROM x_kol_accounts WHERE id = ANY($1::int[])', [ids.kols]);
    }
    process.env.TRADING_MODE = previousMode;
  }
});

test.after(async () => {
  await db.pool.end();
});
