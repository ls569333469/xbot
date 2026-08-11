const express = require('express');
const db = require('../../lib/db');
const policyService = require('./policy-service');
const repository = require('./repository');
const { promptService } = require('./prompt-service');
const { enqueueWatchSyncForHandles } = require('../x-monitor/6551/watch-sync-outbox');

const router = express.Router();

function sendError(res, error) {
  const status = error.code?.includes('NOT_FOUND') ? 404
    : ['FOLLOW_POLICY_EXISTS', 'FOLLOW_PROMPT_VERSION_CONFLICT'].includes(error.code) ? 409 : 400;
  res.status(status).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
}

function operatorId(req) {
  return String(req.get('x-operator-id') || 'admin').slice(0, 128);
}

router.get('/prompts', async (req, res) => {
  try {
    res.json({ ok: true, data: await promptService.getCurrent({ forceRefresh: true }) });
  } catch (error) { sendError(res, error); }
});

router.put('/prompts', async (req, res) => {
  try {
    const data = await promptService.update(req.body, { operator: operatorId(req) });
    res.json({ ok: true, data });
  } catch (error) { sendError(res, error); }
});

router.post('/prompts/reset', async (req, res) => {
  try {
    const data = await promptService.reset(req.body || {}, { operator: operatorId(req) });
    res.json({ ok: true, data });
  } catch (error) { sendError(res, error); }
});

router.get('/policies', async (req, res) => {
  try { res.json({ ok: true, data: await policyService.list(req.query) }); }
  catch (error) { sendError(res, error); }
});

router.post('/policies', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const policy = await policyService.create(req.body, client);
    const current = await policyService.getById(policy.id, client);
    await enqueueWatchSyncForHandles([current.x_handle], client);
    await client.query('COMMIT');
    res.json({ ok: true, data: current });
  } catch (error) {
    await client.query('ROLLBACK');
    sendError(res, error);
  } finally { client.release(); }
});

router.get('/policies/:id', async (req, res) => {
  try {
    const policy = await policyService.getById(req.params.id);
    if (!policy) return res.status(404).json({ ok: false, error: 'Follow discovery policy not found', code: 'FOLLOW_POLICY_NOT_FOUND' });
    return res.json({ ok: true, data: policy });
  } catch (error) { return sendError(res, error); }
});

router.patch('/policies/:id', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const before = await policyService.getById(req.params.id, client, { forUpdate: true });
    if (!before) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Follow discovery policy not found', code: 'FOLLOW_POLICY_NOT_FOUND' });
    }
    await policyService.update(req.params.id, req.body, client);
    await enqueueWatchSyncForHandles([before.x_handle], client);
    const current = await policyService.getById(req.params.id, client);
    await client.query('COMMIT');
    return res.json({ ok: true, data: current });
  } catch (error) {
    await client.query('ROLLBACK');
    return sendError(res, error);
  } finally { client.release(); }
});

router.delete('/policies/:id', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await policyService.getById(req.params.id, client, { forUpdate: true });
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ ok: false, error: 'Follow discovery policy not found', code: 'FOLLOW_POLICY_NOT_FOUND' });
    }
    await policyService.remove(req.params.id, client);
    await enqueueWatchSyncForHandles([current.x_handle], client);
    await client.query('COMMIT');
    return res.json({ ok: true, data: { archived: true } });
  } catch (error) {
    await client.query('ROLLBACK');
    return sendError(res, error);
  } finally { client.release(); }
});

router.post('/watch-impact', async (req, res) => {
  try {
    const kolId = Number(req.body?.kol_id);
    const result = await db.query(
      `SELECT kol.x_handle,
              EXISTS(SELECT 1 FROM x_provider_watches watch
                WHERE watch.provider = '6551'
                  AND watch.username = lower(regexp_replace(kol.x_handle, '^@+', ''))
                  AND watch.remote_flags->>'newFlwBol' = 'true') AS already_watched
       FROM x_kol_accounts kol WHERE kol.id = $1`, [kolId]
    );
    if (!result.rows[0]) return res.status(404).json({ ok: false, error: 'KOL account not found', code: 'FOLLOW_KOL_NOT_FOUND' });
    return res.json({ ok: true, data: {
      handle: result.rows[0].x_handle,
      new_watches: result.rows[0].already_watched ? 0 : 1,
      required_event: 'follow'
    } });
  } catch (error) { return sendError(res, error); }
});

router.get('/events', async (req, res) => {
  try { res.json({ ok: true, data: await repository.listEvents(req.query) }); }
  catch (error) { sendError(res, error); }
});

router.get('/events/:id', async (req, res) => {
  try {
    const event = await repository.getEvent(req.params.id);
    if (!event) return res.status(404).json({ ok: false, error: 'Follow discovery event not found', code: 'FOLLOW_EVENT_NOT_FOUND' });
    return res.json({ ok: true, data: event });
  } catch (error) { return sendError(res, error); }
});

module.exports = router;
