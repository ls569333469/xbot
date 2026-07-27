const express = require('express');
const service = require('./service');

const router = express.Router();

function failure(res, error, fallback = 400) {
  const status = error.code === 'LAUNCH_RULE_NOT_FOUND' ? 404 : fallback;
  res.status(status).json({
    ok: false,
    error: error.message,
    code: error.code || (status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST')
  });
}

router.get('/', async (req, res) => {
  try {
    const result = await service.list(req.query);
    res.json({ ok: true, data: result.rows, total: result.total, page: result.page, pageSize: result.pageSize });
  } catch (error) {
    failure(res, error, 500);
  }
});

router.post('/watch-impact', async (req, res) => {
  try {
    res.json({ ok: true, data: await service.previewWatchImpact(req.body) });
  } catch (error) {
    failure(res, error);
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await service.get(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
    res.json({ ok: true, data: item });
  } catch (error) {
    failure(res, error, 500);
  }
});

router.post('/', async (req, res) => {
  try {
    res.json({ ok: true, data: await service.create(req.body) });
  } catch (error) {
    failure(res, error);
  }
});

router.put('/:id', async (req, res) => {
  try {
    res.json({ ok: true, data: await service.update(req.params.id, req.body) });
  } catch (error) {
    failure(res, error);
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    res.json({ ok: true, data: await service.changeStatus(req.params.id, req.body?.status) });
  } catch (error) {
    failure(res, error);
  }
});

router.delete('/:id', async (req, res) => {
  try {
    res.json({ ok: true, data: { success: await service.remove(req.params.id) } });
  } catch (error) {
    failure(res, error);
  }
});

module.exports = router;
