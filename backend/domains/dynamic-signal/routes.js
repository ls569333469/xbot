const express = require('express');
const db = require('../../lib/db');
const policyService = require('./policy-service');
const templates = require('./templates');
const resolutionStore = require('./resolution-store');
const { dynamicSignalWorker } = require('./event-worker');
const { dynamicPaperSessionWorker } = require('./paper-worker');
const { p20FeatureState } = require('../../lib/p20-features');
const { enqueueWatchSyncForHandles } = require('../x-monitor/6551/watch-sync-outbox');

const router = express.Router();

function sendError(res, error) {
  const status = error.code?.includes('NOT_FOUND') ? 404 : 400;
  res.status(status).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
}

router.get('/status', async (_req, res) => {
  const jobs = await db.query(
    `SELECT status, COUNT(*)::int AS count, MIN(created_at) AS oldest
     FROM dynamic_signal_jobs GROUP BY status ORDER BY status`
  );
  res.json({ ok: true, data: {
    features: p20FeatureState(),
    worker: dynamicSignalWorker.getStatus(),
    paperWorker: dynamicPaperSessionWorker.getStatus(),
    jobs: jobs.rows
  } });
});

router.get('/policies', async (req, res) => {
  try { res.json({ ok: true, data: await policyService.list(req.query) }); }
  catch (error) { sendError(res, error); }
});

router.get('/templates', async (_req, res) => {
  try { res.json({ ok: true, data: await templates.listTemplates() }); }
  catch (error) { sendError(res, error); }
});

router.post('/templates', async (req, res) => {
  try { res.json({ ok: true, data: await templates.createTemplate(req.body) }); }
  catch (error) { sendError(res, error); }
});

router.put('/templates/:id', async (req, res) => {
  try { res.json({ ok: true, data: await templates.updateTemplateTransactional(req.params.id, req.body) }); }
  catch (error) { sendError(res, error); }
});

router.delete('/templates/:id', async (req, res) => {
  try { res.json({ ok: true, data: { deleted: await templates.deleteTemplate(req.params.id) } }); }
  catch (error) { sendError(res, error); }
});

router.put('/policies/:kolId', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await policyService.upsert(req.params.kolId, req.body, client);
    const kolResult = await client.query(
      'SELECT x_handle FROM x_kol_accounts WHERE id = $1', [Number(req.params.kolId)]
    );
    await enqueueWatchSyncForHandles(kolResult.rows.map((row) => row.x_handle), client);
    const [policy] = await policyService.list({ kol_id: req.params.kolId }, client);
    await client.query('COMMIT');
    res.json({ ok: true, data: policy });
  } catch (error) {
    await client.query('ROLLBACK');
    sendError(res, error);
  } finally { client.release(); }
});

router.delete('/policies/:id', async (req, res) => {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const current = await policyService.getById(req.params.id, client, { forUpdate: true });
    const deleted = await policyService.remove(req.params.id, client);
    if (current?.x_handle) await enqueueWatchSyncForHandles([current.x_handle], client);
    await client.query('COMMIT');
    res.json({ ok: true, data: { deleted } });
  } catch (error) {
    await client.query('ROLLBACK');
    sendError(res, error);
  } finally { client.release(); }
});

router.get('/resolutions', async (req, res) => {
  try { res.json({ ok: true, data: await resolutionStore.list(req.query) }); }
  catch (error) { sendError(res, error); }
});

router.get('/resolutions/:id', async (req, res) => {
  try {
    const resolution = await resolutionStore.getById(req.params.id);
    if (!resolution) {
      return res.status(404).json({ ok: false, error: 'Dynamic resolution not found', code: 'NOT_FOUND' });
    }
    return res.json({ ok: true, data: resolution });
  } catch (error) { return sendError(res, error); }
});

router.get('/paper-sessions', async (req, res) => {
  const params = [];
  let where = '';
  if (req.query.actor_policy_id) {
    params.push(Number(req.query.actor_policy_id));
    where = 'WHERE session.actor_policy_id = $1';
  }
  const result = await db.query(
    `SELECT session.*, kol.x_handle,
      COALESCE((SELECT json_agg(e ORDER BY e.id) FROM dynamic_paper_evaluations e
       WHERE e.paper_session_id = session.id), '[]') AS evaluations
     FROM dynamic_paper_sessions session
     JOIN x_actor_dynamic_policies policy ON policy.id = session.actor_policy_id
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     ${where} ORDER BY session.created_at DESC LIMIT 50`, params
  );
  res.json({ ok: true, data: result.rows });
});

module.exports = router;
