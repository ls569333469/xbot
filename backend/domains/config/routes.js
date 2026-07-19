const express = require('express');
const router = express.Router();
const service = require('./service');

router.get('/chains', async (req, res) => {
  try {
    const config = await service.get('chain_configs');
    res.json({ ok: true, data: config || {} });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.put('/chains/:chainId', async (req, res) => {
  try {
    const chains = await service.get('chain_configs') || {};
    chains[req.params.chainId] = { ...chains[req.params.chainId], ...req.body };
    const result = await service.set('chain_configs', chains);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.get('/:key', async (req, res) => {
  try {
    const config = await service.get(req.params.key);
    res.json({ ok: true, data: config });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.put('/:key', async (req, res) => {
  try {
    const result = await service.set(req.params.key, req.body);
    res.json({ ok: true, data: result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
