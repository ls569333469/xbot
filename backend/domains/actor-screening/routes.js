const express = require('express');
const db = require('../../lib/db');
const service = require('./service');
const { actorScreeningWorker } = require('./worker');
const router = express.Router();
router.get('/', async (req, res) => res.json({ ok: true, data: await service.listRuns(req.query.limit) }));
router.get('/:id', async (req, res) => {
  try {
    const run = await service.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Screening run not found', code: 'NOT_FOUND' });
    return res.json({ ok: true, data: run });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});
router.post('/', async (req, res) => {
  try { return res.json({ ok: true, data: await service.createRun(req.body) }); }
  catch (error) { return res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' }); }
});
router.post('/:id/retry', async (req, res) => {
  try {
    const queued = await service.retryFailedRun(req.params.id, db);
    if (!queued) return res.status(404).json({ ok: false, error: 'No failed screening result found', code: 'NOT_FOUND' });
    void actorScreeningWorker.runOnce().catch(() => {});
    return res.json({ ok: true, data: { queued: true } });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});
module.exports = router;
