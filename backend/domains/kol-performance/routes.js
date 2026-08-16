const express = require('express');
const service = require('./service');
const { kolPerformanceWorker, kolProfileWorker } = require('./worker');

const performanceRouter = express.Router();
const profileRouter = express.Router();

function route(handler) {
  return async (req, res) => {
    try { await handler(req, res); }
    catch (error) {
      res.status(error.code?.endsWith('_INVALID') || error.code?.includes('WINDOW') ? 400 : 500)
        .json({ ok: false, error: error.message, code: error.code || 'KOL_PERFORMANCE_FAILED' });
    }
  };
}

performanceRouter.post('/post-runs', route(async (req, res) => {
  const run = await service.createPerformanceRun({ ...req.body, mode: 'post_calls' });
  void kolPerformanceWorker.runOnce().catch(() => {});
  res.json({ ok: true, data: run });
}));

performanceRouter.post('/follow-runs', route(async (req, res) => {
  const run = await service.createPerformanceRun({ ...req.body, mode: 'follow_discovery' });
  void kolPerformanceWorker.runOnce().catch(() => {});
  res.json({ ok: true, data: run });
}));

performanceRouter.get('/runs', route(async (req, res) => {
  res.json({ ok: true, data: await service.listPerformanceRuns(req.query.mode, req.query.limit) });
}));

performanceRouter.get('/runs/:id', route(async (req, res) => {
  const run = await service.getPerformanceRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'KOL performance run not found', code: 'NOT_FOUND' });
  return res.json({ ok: true, data: run });
}));

performanceRouter.post('/runs/:id/retry-price', route(async (req, res) => {
  const queued = await service.retryPerformancePrices(req.params.id);
  if (!queued) return res.status(409).json({ ok: false, error: 'No retryable price replay exists', code: 'PRICE_RETRY_NOT_AVAILABLE' });
  void kolPerformanceWorker.runOnce().catch(() => {});
  return res.json({ ok: true, data: { queued: true } });
}));

profileRouter.post('/profile-runs', route(async (req, res) => {
  const run = await service.createProfileRun(req.body);
  void kolProfileWorker.runOnce().catch(() => {});
  res.json({ ok: true, data: run });
}));

profileRouter.get('/profile-runs', route(async (req, res) => {
  res.json({ ok: true, data: await service.listProfileRuns(req.query.limit) });
}));

profileRouter.get('/profile-runs/:id', route(async (req, res) => {
  const run = await service.getProfileRun(req.params.id);
  if (!run) return res.status(404).json({ ok: false, error: 'KOL profile run not found', code: 'NOT_FOUND' });
  return res.json({ ok: true, data: run });
}));

module.exports = { performanceRouter, profileRouter };
