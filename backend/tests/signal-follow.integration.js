const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const { matchActivity } = require('../domains/signal/matcher');

test('signal mode fans out distinct CAs and permanently deduplicates follow signals', async () => {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10000)}`;
  const handle = `p7kol${suffix}`;
  const projectOne = `p7projecta${suffix}`;
  const projectTwo = `p7projectb${suffix}`;
  const caOne = `P7CA1${suffix}`;
  const caTwo = `P7CA2${suffix}`;
  const ids = { activities: [], whitelists: [], kol: null };
  const previousMode = process.env.TRADING_MODE;
  process.env.TRADING_MODE = 'signal';

  try {
    const kolResult = await db.query(
      `INSERT INTO x_kol_accounts (x_user_id, x_handle, display_name, enabled)
       VALUES ($1, $2, 'P7 Test KOL', true) RETURNING id`,
      [`p7-user-${suffix}`, handle]
    );
    ids.kol = kolResult.rows[0].id;

    for (const [ca, symbol, handles] of [
      [caOne, `P7A${suffix}`, [projectOne, projectTwo]],
      [caTwo, `P7B${suffix}`, [projectOne]]
    ]) {
      const result = await db.query(
        `INSERT INTO ca_whitelist
          (contract_address, chain_id, symbol, project_name, project_x_handles,
           budget_per_trade, total_budget, status)
         VALUES ($1, 'sol', $2, 'P7 Test', $3, 0.001, 0.01, 'active')
         RETURNING id`,
        [ca, symbol, handles]
      );
      const whitelistId = result.rows[0].id;
      ids.whitelists.push(whitelistId);
      for (const targetHandle of handles) {
        await db.query(
          `INSERT INTO x_signal_relations (whitelist_id, kol_id, target_x_handle)
           VALUES ($1, $2, $3)`,
          [whitelistId, ids.kol, targetHandle]
        );
      }
    }

    const insertActivity = async (target, eventId) => {
      const result = await db.query(
        `INSERT INTO x_activities
          (kol_id, kol_handle, activity_type, target_x_handle, target_x_handles,
           provider_event_id, provider, processed)
         VALUES ($1, $2, 'follow', $3, ARRAY[$3], $4, 'test', false)
         RETURNING *`,
        [ids.kol, handle, target, eventId]
      );
      ids.activities.push(result.rows[0].id);
      return result.rows[0];
    };

    const firstActivity = await insertActivity(projectOne, `p7-follow-1-${suffix}`);
    assert.equal(await matchActivity(firstActivity), 2);
    assert.equal(await matchActivity(firstActivity), 0);

    const secondActivity = await insertActivity(projectTwo, `p7-follow-2-${suffix}`);
    assert.equal(await matchActivity(secondActivity), 0);

    const signals = await db.query(
      `SELECT status, execution_mode, whitelist_id
       FROM trade_signals WHERE activity_id = ANY($1::int[])
       ORDER BY whitelist_id`,
      [ids.activities]
    );
    assert.equal(signals.rows.length, 2);
    assert.ok(signals.rows.every((signal) => signal.status === 'signal_only'));
    assert.ok(signals.rows.every((signal) => signal.execution_mode === 'signal'));

    const positions = await db.query(
      `SELECT COUNT(*) FROM positions
       WHERE signal_id IN (
         SELECT id FROM trade_signals WHERE activity_id = ANY($1::int[])
       )`,
      [ids.activities]
    );
    assert.equal(Number(positions.rows[0].count), 0);

    const counters = await db.query(
      `SELECT spent_budget, current_buy_count, paper_spent_budget, paper_buy_count
       FROM ca_whitelist WHERE id = ANY($1::int[])`,
      [ids.whitelists]
    );
    assert.ok(counters.rows.every((row) => Number(row.spent_budget) === 0));
    assert.ok(counters.rows.every((row) => Number(row.current_buy_count) === 0));
    assert.ok(counters.rows.every((row) => Number(row.paper_spent_budget) === 0));
    assert.ok(counters.rows.every((row) => Number(row.paper_buy_count) === 0));
  } finally {
    if (ids.activities.length > 0) {
      await db.query('DELETE FROM trade_signals WHERE activity_id = ANY($1::int[])', [ids.activities]);
      await db.query('DELETE FROM x_activities WHERE id = ANY($1::int[])', [ids.activities]);
    }
    if (ids.kol) await db.query('DELETE FROM x_follow_signal_once WHERE kol_id = $1', [ids.kol]);
    if (ids.whitelists.length > 0) {
      await db.query('DELETE FROM ca_whitelist WHERE id = ANY($1::int[])', [ids.whitelists]);
    }
    if (ids.kol) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [ids.kol]);
    process.env.TRADING_MODE = previousMode;
  }
});

test.after(async () => {
  await db.pool.end();
});
