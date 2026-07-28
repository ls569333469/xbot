const express = require('express');
const router = express.Router();
const queries = require('./queries');
const logger = require('../../lib/logger');
const db = require('../../lib/db');
const { createXClient } = require('../../lib/x-client');
const providerUsage = require('../../lib/provider-usage');
const engineState = require('../../lib/engine-state');
const { getTradingMode } = require('../../lib/runtime-mode');
const { legacyXProvidersEnabled } = require('../../lib/legacy-features');
const { X6551Client } = require('../../lib/x-client-6551');
const { applyWatchPlan, getWatchPlan } = require('./6551/watch-reconciler');
const { get6551Status } = require('./6551/status');
const {
  authenticateWebhook,
  ingestTwitterApiEvent
} = require('./twitterapi-webhook');

function requireLegacyXProvider(_req, res, next) {
  if (!legacyXProvidersEnabled()) {
    return res.status(410).json({
      ok: false,
      error: 'Legacy X providers are isolated from the production runtime',
      code: 'LEGACY_X_PROVIDER_DISABLED'
    });
  }
  next();
}

router.post('/webhook/twitterapi', requireLegacyXProvider, async (req, res) => {
  if (!authenticateWebhook(req)) {
    return res.status(401).json({ ok: false, error: 'Invalid webhook secret', code: 'WEBHOOK_UNAUTHORIZED' });
  }
  try {
    const result = await ingestTwitterApiEvent(req.body);
    const wsBroadcast = req.app.get('wsBroadcast');
    if (result.inserted > 0 && wsBroadcast) {
      wsBroadcast({
        type: 'x:stream-event',
        payload: { inserted: result.inserted, matched: result.matched }
      });
    }
    res.json({ ok: true, data: { received: result.received, inserted: result.inserted, matched: result.matched } });
  } catch (err) {
    logger.error('twitterapi-webhook', `Webhook ingest failed: ${err.message}`);
    const status = ['WEBHOOK_STALE_EVENT', 'WEBHOOK_PROVIDER_INACTIVE'].includes(err.code) ? 409 : 400;
    res.status(status).json({ ok: false, error: err.message, code: err.code || 'WEBHOOK_INVALID' });
  }
});

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

router.post('/poll-now', requireLegacyXProvider, async (req, res) => {
  try {
    const provider = String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
    if (!['mock', 'socialdata'].includes(provider)) {
      return res.status(409).json({
        ok: false,
        error: `Timeline polling is unsupported for provider ${provider}`,
        code: 'TIMELINE_POLL_UNSUPPORTED'
      });
    }
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

router.post('/poll-follows-now', requireLegacyXProvider, async (req, res) => {
  try {
    const provider = String(process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
    if (provider !== 'twitterapi') {
      return res.status(409).json({
        ok: false,
        error: `Follow polling is unsupported for provider ${provider}`,
        code: 'FOLLOW_POLL_UNSUPPORTED'
      });
    }
    const pollFollows = require('../../jobs/x-poll-follows');
    const result = await pollFollows.run({});
    logger.info('x-monitor', 'Manual follow polling completed');
    res.status(result.status === 'skipped' ? 202 : 200).json({ ok: true, data: result });
  } catch (err) {
    logger.error('x-monitor', `Manual follow polling failed: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message, code: 'FOLLOW_POLL_FAILED' });
  }
});

router.get('/follow-polls', requireLegacyXProvider, async (req, res) => {
  try {
    const result = await db.query(
      `SELECT p.*, k.x_handle AS kol_handle
       FROM x_follow_poll_runs p
       JOIN x_kol_accounts k ON k.id = p.kol_id
       ORDER BY p.started_at DESC
       LIMIT 100`
    );
    res.json({ ok: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'FOLLOW_POLL_LIST_FAILED' });
  }
});

router.get('/provider-usage', async (req, res) => {
  try {
    const requested = String(req.query.provider || process.env.X_DATA_PROVIDER || 'mock').toLowerCase();
    if (requested !== '6551' && !legacyXProvidersEnabled()) {
      return res.status(410).json({
        ok: false,
        error: 'Legacy X provider usage is unavailable in the production runtime',
        code: 'LEGACY_X_PROVIDER_DISABLED'
      });
    }
    const provider = ['twitterapi', '6551'].includes(requested) ? requested : 'twitterapi';
    const usage = await providerUsage.getDailyUsage(provider);
    res.json({ ok: true, data: usage });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'PROVIDER_USAGE_FAILED' });
  }
});

router.post('/stream/sync', requireLegacyXProvider, async (req, res) => {
  try {
    if (String(process.env.X_DATA_PROVIDER || '').toLowerCase() !== 'twitterapi') {
      return res.status(409).json({ ok: false, error: 'Current provider does not support TwitterAPI.io Stream', code: 'STREAM_UNSUPPORTED' });
    }
    if (String(process.env.TWITTER_STREAM_ENABLED || 'false').toLowerCase() !== 'true') {
      return res.status(409).json({ ok: false, error: 'Twitter Stream is disabled', code: 'STREAM_DISABLED' });
    }
    const client = createXClient();
    if (typeof client.addUserToTweetMonitor !== 'function') {
      return res.status(409).json({ ok: false, error: 'Current provider does not support Stream', code: 'STREAM_UNSUPPORTED' });
    }
    const kols = await db.query('SELECT * FROM x_kol_accounts WHERE enabled = true ORDER BY id');
    const results = [];
    for (const kol of kols.rows) {
      try {
        await client.addUserToTweetMonitor(kol.x_handle);
        await db.query(
          "UPDATE x_kol_accounts SET stream_status = 'pending', stream_active_at = NULL, updated_at = NOW() WHERE id = $1",
          [kol.id]
        );
        results.push({ kol_id: kol.id, x_handle: kol.x_handle, status: 'pending' });
      } catch (error) {
        await db.query(
          "UPDATE x_kol_accounts SET stream_status = 'error', updated_at = NOW() WHERE id = $1",
          [kol.id]
        );
        results.push({ kol_id: kol.id, x_handle: kol.x_handle, status: 'error', error: error.message });
      }
    }
    res.json({ ok: true, data: results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'STREAM_SYNC_FAILED' });
  }
});

router.get('/6551/status', async (req, res) => {
  try {
    res.json({
      ok: true,
      data: await get6551Status(undefined, undefined, {
        refreshRemote: String(req.query.refresh || '').toLowerCase() === 'true'
      })
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'X6551_STATUS_FAILED' });
  }
});

router.get('/6551/watch-plan', async (req, res) => {
  try {
    if (String(process.env.X_DATA_PROVIDER || '').toLowerCase() !== '6551') {
      return res.status(409).json({ ok: false, error: '6551 is not the active provider', code: 'X6551_PROVIDER_INACTIVE' });
    }
    const plan = await getWatchPlan(new X6551Client(process.env.OPENNEWS_TOKEN));
    res.json({ ok: true, data: plan });
  } catch (err) {
    logger.error('6551-watch', `Watch dry-run failed: ${err.message}`);
    const status = ['X6551_AUTH_ERROR', 'X6551_RATE_LIMITED'].includes(err.code) ? 502 : 500;
    res.status(status).json({ ok: false, error: err.message, code: err.code || 'X6551_WATCH_PLAN_FAILED' });
  }
});

router.post('/6551/watch-apply', async (req, res) => {
  try {
    if (String(process.env.X_DATA_PROVIDER || '').toLowerCase() !== '6551') {
      return res.status(409).json({ ok: false, error: '6551 is not the active provider', code: 'X6551_PROVIDER_INACTIVE' });
    }
    if (getTradingMode() !== 'signal' || engineState.getArmed()) {
      return res.status(409).json({ ok: false, error: 'Watch apply requires signal-only mode and a locked engine', code: 'X6551_SAFETY_STATE_REQUIRED' });
    }
    const status = await get6551Status();
    if (status.usage.messages.level === 'critical') {
      return res.status(409).json({ ok: false, error: 'Monthly message threshold blocks Watch changes', code: 'X6551_USAGE_GATE_BLOCKED' });
    }
    const result = await applyWatchPlan(new X6551Client(process.env.OPENNEWS_TOKEN), {
      confirmation: req.body?.confirmation,
      adopt: Array.isArray(req.body?.adopt) ? req.body.adopt : []
    });
    res.json({ ok: true, data: result });
  } catch (err) {
    logger.error('6551-watch', `Watch apply failed: ${err.message}`);
    const status = err.code === 'X6551_WATCH_CONFIRMATION_REQUIRED' ? 400 : 409;
    res.status(status).json({ ok: false, error: err.message, code: err.code || 'X6551_WATCH_APPLY_FAILED' });
  }
});

module.exports = router;
