const express = require('express');
const service = require('./service');
const router = express.Router();
router.get('/', async (req, res) => res.json({ ok: true, data: await service.listRuns(req.query.limit) }));
router.get('/:id', async (req, res) => {
  try {
    const run = await service.getRun(req.params.id);
    if (!run) return res.status(404).json({ ok: false, error: 'Account research run not found', code: 'NOT_FOUND' });
    return res.json({ ok: true, data: run });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});
router.post('/', async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'P32 account research is historical read-only. Use P33 KOL performance or profile research.',
    code: 'ACCOUNT_RESEARCH_LEGACY_READ_ONLY'
  });
});
router.post('/:id/retry', async (req, res) => {
  return res.status(410).json({
    ok: false,
    error: 'P32 account research is historical read-only. Retry prices through the P33 run.',
    code: 'ACCOUNT_RESEARCH_LEGACY_READ_ONLY'
  });
});
module.exports = router;
