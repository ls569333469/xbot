const express = require('express');
const router = express.Router();
const queries = require('./queries');
const logger = require('../../lib/logger');

router.get('/activities', async (req, res) => {
  try {
    const filters = {
      kol_id: req.query.kol_id,
      activity_type: req.query.activity_type,
      page: parseInt(req.query.page) || 1,
      pageSize: parseInt(req.query.pageSize) || 20
    };
    const { rows, total } = await queries.getActivities(filters);
    res.json({ ok: true, data: rows, total, page: filters.page, pageSize: filters.pageSize });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.get('/status', async (req, res) => {
  try {
    const status = await queries.getStatus();
    res.json({ ok: true, data: status });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

router.post('/poll-now', async (req, res) => {
  try {
    const pollTimeline = require('../../jobs/x-poll-timeline');
    await pollTimeline.run({});
    const pollFollows = require('../../jobs/x-poll-follows');
    await pollFollows.run({});
    logger.info('x-monitor', '手动触发 poll-now 完成');
    res.json({ ok: true, data: { status: 'Poll completed' } });
  } catch (err) {
    logger.error('x-monitor', `poll-now 失败: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message, code: 'POLL_FAILED' });
  }
});

module.exports = router;
