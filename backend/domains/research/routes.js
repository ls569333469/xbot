const express = require('express');
const service = require('./service');
const {
  cancelResearchJob,
  createResearchJob,
  getResearchJob,
  retryFailedItems
} = require('./queue');

const router = express.Router();

router.get('/token-metadata', async (req, res) => {
  try {
    const data = await service.getTokenMetadata(req.query.chain, req.query.address);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/token-reports', async (req, res) => {
  try {
    const data = await service.createReport(req.body);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.get('/token-reports/:id', async (req, res) => {
  try {
    const data = await service.getReport(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/token-reports/:id/expand', async (req, res) => {
  try {
    const data = await service.expandReport(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/token-reports/:id/whitelist-draft', async (req, res) => {
  try {
    const data = await service.reportToWhitelistDraft(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.get('/actors', async (req, res) => {
  try {
    const data = await service.listActors(req.query);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/jobs', async (req, res) => {
  try {
    const data = await createResearchJob(req.body || {});
    res.status(202).json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const data = await getResearchJob(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/jobs/:id/retry-failed', async (req, res) => {
  try {
    const data = await retryFailedItems(req.params.id);
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

router.post('/jobs/:id/cancel', async (req, res) => {
  try {
    const data = await cancelResearchJob(req.params.id);
    if (!data) return res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
    res.json({ ok: true, data });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message, code: error.code || 'BAD_REQUEST' });
  }
});

module.exports = router;
