const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const labelService = require('../domains/kol/label-service');
const kolService = require('../domains/kol/service');

test('P36 custom labels persist transactionally without profile or outbox side effects', async () => {
  const suffix = String(Date.now()).slice(-9);
  const handle = `p36${suffix}`;
  const createdLabelIds = [];
  let kolId = null;

  try {
    const project = await labelService.createLabel(`项目方 ${suffix}`, { operator: 'p36-test' });
    const exchange = await labelService.createLabel(`交易所 ${suffix}`, { operator: 'p36-test' });
    createdLabelIds.push(project.id, exchange.id);

    const created = await kolService.addKol({
      x_handle: handle,
      display_name: 'P36 标签测试账号',
      chain_ids: ['bsc'],
      custom_label_ids: [project.id, exchange.id],
      weight: 7
    });
    kolId = created.id;
    assert.deepEqual(created.custom_labels.map((label) => label.id).sort(), [...createdLabelIds].sort());

    await db.query(
      `UPDATE x_kol_accounts
          SET x_user_id = $1, profile_status = 'verified', profile_verified_at = NOW()
        WHERE id = $2`,
      [`p36-user-${suffix}`, kolId]
    );
    const beforeOutboxes = await db.query(
      `SELECT
        (SELECT COUNT(*)::int FROM x_watch_sync_outbox) AS watch_count,
        (SELECT COUNT(*)::int FROM whitelist_activation_outbox) AS activation_count`
    );

    const updated = await kolService.updateKol(kolId, { custom_label_ids: [project.id] });
    assert.equal(updated.profile_status, 'verified');
    assert.equal(updated.x_user_id, `p36-user-${suffix}`);
    assert.deepEqual(updated.custom_labels, [{ id: project.id, name: project.name }]);

    const afterOutboxes = await db.query(
      `SELECT
        (SELECT COUNT(*)::int FROM x_watch_sync_outbox) AS watch_count,
        (SELECT COUNT(*)::int FROM whitelist_activation_outbox) AS activation_count`
    );
    assert.deepEqual(afterOutboxes.rows[0], beforeOutboxes.rows[0]);

    const filtered = await kolService.getKols({ label_id: project.id });
    assert.equal(filtered.filter((item) => String(item.id) === String(kolId)).length, 1);
    assert.equal((await kolService.getKols({ tag: 'bsc', label_id: project.id }))
      .filter((item) => String(item.id) === String(kolId)).length, 1);
    assert.equal((await kolService.getKols({ search: project.name }))
      .filter((item) => String(item.id) === String(kolId)).length, 1);

    const legacyUpdate = await kolService.updateKol(kolId, { weight: 8 });
    assert.deepEqual(legacyUpdate.custom_labels, [{ id: project.id, name: project.name }]);
    assert.equal(legacyUpdate.profile_status, 'verified');

    await assert.rejects(
      labelService.deleteLabel(project.id),
      { code: 'KOL_LABEL_IN_USE', status: 409 }
    );

    await assert.rejects(
      kolService.updateKol(kolId, { display_name: '不得提交', custom_label_ids: ['999999999999'] }),
      { code: 'KOL_LABEL_NOT_FOUND' }
    );
    const rolledBack = await kolService.getKol(kolId);
    assert.equal(rolledBack.display_name, 'P36 标签测试账号');
    assert.deepEqual(rolledBack.custom_labels, [{ id: project.id, name: project.name }]);

    const renamed = await labelService.renameLabel(project.id, `项目团队 ${suffix}`);
    assert.equal((await kolService.getKol(kolId)).custom_labels[0].name, renamed.name);

    await kolService.updateKol(kolId, { custom_label_ids: [] });
    assert.deepEqual((await kolService.getKol(kolId)).custom_labels, []);
    assert.deepEqual(await labelService.deleteLabel(project.id), { deleted: true, id: project.id });
    createdLabelIds.splice(createdLabelIds.indexOf(project.id), 1);
  } finally {
    if (kolId) await db.query('DELETE FROM x_kol_accounts WHERE id = $1', [kolId]);
    if (createdLabelIds.length) {
      await db.query('DELETE FROM x_kol_labels WHERE id::text = ANY($1::text[])', [createdLabelIds]);
    }
  }
});

test.after(async () => {
  await db.pool.end();
});
