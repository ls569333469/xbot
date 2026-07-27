const express = require('express');
const router = express.Router();
const service = require('./service');

router.get('/', async (req, res) => {
  try {
    const kols = await service.getKols(req.query);
    res.json({ ok: true, data: kols });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.post('/', async (req, res) => {
  try {
    const kol = await service.addKol(req.body);
    res.json({ ok: true, data: kol });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const kol = await service.updateKol(req.params.id, req.body);
    res.json({ ok: true, data: kol });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.patch('/:id/toggle', async (req, res) => {
  try {
    const kol = await service.toggleKol(req.params.id);
    res.json({ ok: true, data: kol });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.post('/:id/profile/retry', async (req, res) => {
  try {
    const kol = await service.retryKolProfile(req.params.id);
    res.json({ ok: true, data: kol });
  } catch (err) {
    const notFound = err.message === 'KOL account not found';
    res.status(notFound ? 404 : 400).json({
      ok: false,
      error: err.message,
      code: notFound ? 'NOT_FOUND' : 'BAD_REQUEST'
    });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await service.deleteKol(req.params.id);
    res.json({ ok: true, data: { success: true, ...result } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.get('/:id/activities', async (req, res) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit) : 20;
    const activities = await service.getKolActivities(req.params.id, limit);
    res.json({ ok: true, data: activities });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
