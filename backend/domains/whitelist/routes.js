const express = require('express');
const router = express.Router();
const service = require('./service');

router.get('/', async (req, res) => {
  try {
    const filters = {
      chain_id: req.query.chain_id,
      status: req.query.status,
      search: req.query.search,
      page: req.query.page,
      pageSize: req.query.pageSize
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
        added_relations: result.addedRelations
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

router.delete('/:id', async (req, res) => {
  try {
    await service.deleteWhitelist(req.params.id);
    res.json({ ok: true, data: { success: true } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
