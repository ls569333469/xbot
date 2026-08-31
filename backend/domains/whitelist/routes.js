const express = require('express');
const router = express.Router();
const service = require('./service');
const templates = require('./templates');
const templateSync = require('./template-sync');

router.post('/template-sync/preview', async (req, res) => {
  try {
    const data = await templateSync.preview(req.body);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.post('/template-sync', async (req, res) => {
  try {
    const data = await templateSync.execute(req.body, undefined, {
      createdBy: req.headers['x-operator'] || null
    });
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.get('/templates', async (req, res) => {
  try {
    const items = await templates.listTemplates(req.query.chain_id);
    res.json({ ok: true, data: items });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.post('/templates', async (req, res) => {
  try {
    const item = await templates.createTemplate(req.body);
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.put('/templates/:id', async (req, res) => {
  try {
    const item = await templates.updateTemplate(req.params.id, req.body);
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.delete('/templates/:id', async (req, res) => {
  try {
    res.json({ ok: true, data: { success: await templates.deleteTemplate(req.params.id) } });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.post('/watch-impact', async (req, res) => {
  try {
    const data = await service.previewWatchImpact(req.body);
    res.json({ ok: true, data });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.get('/', async (req, res) => {
  try {
    const filters = {
      chain_id: req.query.chain_id,
      status: req.query.status,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize,
      summary: req.query.summary === 'true'
    };
    const result = await service.getWhitelists(filters);
    res.json({ ok: true, data: result.rows, total: result.total, page: result.page, pageSize: result.pageSize });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const item = await service.getWhitelist(req.params.id);
    if (!item) return res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.post('/', async (req, res) => {
  try {
    const result = await service.addWhitelist(req.body);
    res.json({
      ok: true,
      data: result.item,
      meta: {
        merged_into_existing: result.mergedIntoExisting,
        added_relations: result.addedRelations,
        added_sources: result.addedSources
      }
    });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.put('/:id', async (req, res) => {
  try {
    const item = await service.updateWhitelist(req.params.id, req.body);
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.patch('/:id/status', async (req, res) => {
  try {
    const item = await service.changeStatus(req.params.id, req.body.status);
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

router.post('/:id/activation/retry', async (req, res) => {
  try {
    const item = await service.retryActivation(req.params.id);
    res.json({ ok: true, data: item });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: err.code || 'BAD_REQUEST' });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    await service.deleteWhitelist(req.params.id);
    res.json({ ok: true, data: { success: true } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
