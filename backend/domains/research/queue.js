const db = require('../../lib/db');
const logger = require('../../lib/logger');
const engineState = require('../../lib/engine-state');
const researchAccess = require('../../lib/gmgn-access-service').accessFor('research');
const {
  REPORT_ANALYZER_VERSION,
  createReport,
  expandReport,
  findReusableReport,
  getReport,
  normalizeRequest
} = require('./service');
const { XAI_PROMPT_VERSION } = require('./xai-client');
const { TRADE_MAX_RESERVATION_WEIGHT } = require('../../lib/gmgn-rate-scheduler');

const DEFAULT_CONCURRENCY = 3;
const LIVE_CONCURRENCY = 1;
const LIVE_RESEARCH_ADMISSION_WEIGHT = TRADE_MAX_RESERVATION_WEIGHT + 3;
const MAX_BATCH_SIZE = 30;

function normalizeAddresses(chainId, values) {
  const raw = Array.isArray(values) ? values : [values];
  const unique = new Map();
  raw.filter(Boolean).forEach((value) => {
    const normalized = normalizeRequest(chainId, value);
    unique.set(normalized.address, normalized.address);
  });
  const addresses = [...unique.values()];
  if (addresses.length === 0) {
    const error = new Error('At least one contract address is required');
    error.code = 'RESEARCH_ADDRESSES_REQUIRED';
    throw error;
  }
  if (addresses.length > MAX_BATCH_SIZE) {
    const error = new Error(`At most ${MAX_BATCH_SIZE} contract addresses are allowed`);
    error.code = 'RESEARCH_BATCH_TOO_LARGE';
    throw error;
  }
  return addresses;
}

async function withTransaction(action) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function createResearchJob(input) {
  const chainId = String(input.chain_id || '').trim().toLowerCase();
  const addresses = normalizeAddresses(
    chainId,
    input.contract_addresses ?? input.addresses ?? input.contract_address
  );
  const jobId = await withTransaction(async (client) => {
    const jobResult = await client.query(
      `INSERT INTO research_jobs
        (chain_id, mode, status, total_count, prompt_version)
       VALUES ($1, $2, 'pending', $3, $4)
       RETURNING id`,
      [chainId, addresses.length === 1 ? 'single' : 'batch', addresses.length, XAI_PROMPT_VERSION]
    );
    const id = jobResult.rows[0].id;
    for (const address of addresses) {
      await client.query(
        `INSERT INTO research_job_items(job_id, chain_id, contract_address)
         VALUES ($1, $2, $3)`,
        [id, chainId, address]
      );
    }
    return id;
  });
  researchQueue.wake();
  return getResearchJob(jobId);
}

async function getResearchJob(id) {
  const [jobResult, itemResult] = await Promise.all([
    db.query('SELECT * FROM research_jobs WHERE id = $1', [id]),
    db.query(
      `SELECT item.*, CASE WHEN report.id IS NULL THEN NULL ELSE to_jsonb(report) END AS report
       FROM research_job_items AS item
       LEFT JOIN token_research_reports AS report ON report.id = item.report_id
       WHERE item.job_id = $1
       ORDER BY item.id`,
      [id]
    )
  ]);
  const job = jobResult.rows[0];
  return job ? { ...job, items: itemResult.rows, queue_status: researchQueue.getStatus() } : null;
}

function jobStatusFromCounts(counts) {
  if (Number(counts.active_count) > 0) return 'running';
  if (Number(counts.cancelled_count) === Number(counts.total_count)) return 'cancelled';
  if (Number(counts.failed_count) === Number(counts.total_count)) return 'failed';
  if (Number(counts.failed_count) > 0 || Number(counts.cancelled_count) > 0) return 'partial';
  return 'completed';
}

function researchAdmission(status = researchAccess.scheduler.getStatus(), options = {}) {
  if (status.state === 'cooling') {
    return {
      allowed: false,
      wait_reason: 'GMGN_COOLDOWN',
      retry_at: status.cooldownUntil || status.resetAt || null
    };
  }
  if (Number(status.reservedWeight || 0) > 0) {
    return { allowed: false, wait_reason: 'TRADE_PROVIDER_LEASE_ACTIVE', retry_at: null };
  }
  const higherPriorityQueued = Object.entries(status.queueByPriority || {})
    .some(([priority, count]) => Number(priority) < 5 && Number(count) > 0);
  if (higherPriorityQueued) {
    return { allowed: false, wait_reason: 'TRADE_PROVIDER_QUEUE_ACTIVE', retry_at: null };
  }
  if (options.liveMode === true
      && Number.isFinite(Number(status.availableWeight))
      && Number(status.availableWeight) < LIVE_RESEARCH_ADMISSION_WEIGHT) {
    return { allowed: false, wait_reason: 'TRADE_CAPACITY_RESERVED', retry_at: null };
  }
  return { allowed: true, wait_reason: null, retry_at: null };
}

function schedulerAllowsResearch(status = researchAccess.scheduler.getStatus(), options = {}) {
  return researchAdmission(status, options).allowed;
}

function runtimeRequestsLiveMode(runtime = {}) {
  return runtime.armed === true
    || runtime.desired_running === true
    || ['recovering', 'running', 'paused_transient', 'fault_protected']
      .includes(String(runtime.status || '').toLowerCase());
}

function localEngineRuntime(engine = engineState) {
  const status = engine.getStatus?.() || {};
  return {
    desired_running: status.desiredRunning === true,
    status: status.status || null,
    armed: engine.getArmed?.() === true
  };
}

async function readPersistedEngineRuntime(executor = db) {
  const result = await executor.query(
    "SELECT value_json FROM trade_runtime_state WHERE key = 'live_engine_control'"
  );
  return result.rows[0]?.value_json || {};
}

async function refreshJob(jobId, executor = db) {
  const result = await executor.query(
    `WITH counts AS (
       SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_count,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
              COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
              COUNT(*) FILTER (WHERE status NOT IN ('completed','failed','cancelled'))::int AS active_count,
              COUNT(*)::int AS total_count
       FROM research_job_items WHERE job_id = $1
     )
     UPDATE research_jobs AS job
     SET completed_count = counts.completed_count,
         failed_count = counts.failed_count,
         cancelled_count = counts.cancelled_count,
         status = CASE
           WHEN job.cancelled_at IS NOT NULL THEN 'cancelled'
           WHEN counts.active_count > 0 THEN 'running'
           WHEN counts.cancelled_count = counts.total_count THEN 'cancelled'
           WHEN counts.failed_count = counts.total_count THEN 'failed'
           WHEN counts.failed_count > 0 OR counts.cancelled_count > 0 THEN 'partial'
           ELSE 'completed'
         END,
         started_at = COALESCE(job.started_at, NOW()),
         finished_at = CASE WHEN counts.active_count = 0 THEN NOW() ELSE NULL END,
         updated_at = NOW()
     FROM counts
     WHERE job.id = $1
     RETURNING job.*`,
    [jobId]
  );
  return result.rows[0] || null;
}

async function claimItems(limit = DEFAULT_CONCURRENCY) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `WITH due AS (
         SELECT item.id
         FROM research_job_items AS item
         JOIN research_jobs AS job ON job.id = item.job_id
         WHERE job.status <> 'cancelled'
           AND (item.status = 'queued'
             OR (item.status IN ('gmgn','grok','verification')
                 AND item.locked_at < NOW() - INTERVAL '5 minutes'))
         ORDER BY item.created_at, item.id
         FOR UPDATE OF item SKIP LOCKED
         LIMIT $1
       )
       UPDATE research_job_items AS item
       SET status = 'gmgn', attempt_count = attempt_count + 1,
           started_at = COALESCE(started_at, NOW()), locked_at = NOW(),
           error_code = NULL, error_message = NULL, updated_at = NOW()
       FROM due
       WHERE item.id = due.id
       RETURNING item.*`,
      [Math.max(1, Number(limit) || DEFAULT_CONCURRENCY)]
    );
    const jobIds = [...new Set(result.rows.map((row) => row.job_id))];
    for (const jobId of jobIds) await refreshJob(jobId, client);
    return result.rows;
  });
}

async function setItemStage(id, stage, values = {}) {
  const result = await db.query(
    `UPDATE research_job_items
     SET status = $2, report_id = COALESCE($3, report_id),
         locked_at = NOW(), updated_at = NOW()
     WHERE id = $1 AND status <> 'cancelled' RETURNING *`,
    [id, stage, values.report_id || null]
  );
  return result.rows[0];
}

async function completeItem(item, report) {
  await db.query(
    `UPDATE research_job_items
     SET status = 'completed', report_id = $2, locked_at = NULL,
         finished_at = NOW(), duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         error_code = NULL, error_message = NULL, updated_at = NOW()
      WHERE id = $1 AND status <> 'cancelled'`,
    [item.id, report.id]
  );
  await refreshJob(item.job_id);
}

async function failItem(item, error) {
  await db.query(
    `UPDATE research_job_items
     SET status = 'failed', locked_at = NULL, finished_at = NOW(),
         duration_ms = EXTRACT(EPOCH FROM (NOW() - started_at)) * 1000,
         error_code = $2, error_message = $3, updated_at = NOW()
      WHERE id = $1 AND status <> 'cancelled'`,
    [
      item.id,
      String(error.code || 'RESEARCH_ITEM_FAILED').slice(0, 80),
      String(error.message || error).slice(0, 1000)
    ]
  );
  await refreshJob(item.job_id);
}

async function processItem(item) {
  try {
    let report = item.report_id ? await getReport(item.report_id) : null;
    if (!report) report = await findReusableReport(item.chain_id, item.contract_address);
    if (!report) {
      report = await createReport({
        chain_id: item.chain_id,
        contract_address: item.contract_address
      });
    }
    const reusableExpandedReport = report.analysis_finished_at
      && !report.xai_error_code
      && report.analyzer_version === `${REPORT_ANALYZER_VERSION}+xai`;
    if (!reusableExpandedReport) {
      const active = await setItemStage(item.id, 'grok', { report_id: report.id });
      if (!active) {
        await refreshJob(item.job_id);
        return;
      }
      report = await expandReport(report.id, {
        onStage: async (stage) => setItemStage(item.id, stage, { report_id: report.id })
      });
    }
    await completeItem(item, report);
  } catch (error) {
    await failItem(item, error);
  }
}

async function cancelResearchJob(jobId) {
  return withTransaction(async (client) => {
    const jobResult = await client.query(
      'SELECT * FROM research_jobs WHERE id = $1 FOR UPDATE',
      [jobId]
    );
    const job = jobResult.rows[0];
    if (!job) return null;
    if (['completed', 'partial', 'failed', 'cancelled'].includes(job.status)) {
      const items = await client.query(
        `SELECT item.*, CASE WHEN report.id IS NULL THEN NULL ELSE to_jsonb(report) END AS report
         FROM research_job_items AS item
         LEFT JOIN token_research_reports AS report ON report.id = item.report_id
         WHERE item.job_id = $1 ORDER BY item.id`,
        [jobId]
      );
      return { ...job, items: items.rows, queue_status: researchQueue.getStatus() };
    }
    await client.query(
      `UPDATE research_job_items
       SET status = 'cancelled', locked_at = NULL, finished_at = NOW(), updated_at = NOW()
       WHERE job_id = $1 AND status NOT IN ('completed','failed','cancelled')`,
      [jobId]
    );
    await client.query(
      `UPDATE research_jobs
       SET status = 'cancelled', cancelled_count = total_count - completed_count - failed_count,
           cancelled_at = NOW(), finished_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [jobId]
    );
    const [updated, items] = await Promise.all([
      client.query('SELECT * FROM research_jobs WHERE id = $1', [jobId]),
      client.query(
        `SELECT item.*, CASE WHEN report.id IS NULL THEN NULL ELSE to_jsonb(report) END AS report
         FROM research_job_items AS item
         LEFT JOIN token_research_reports AS report ON report.id = item.report_id
         WHERE item.job_id = $1 ORDER BY item.id`,
        [jobId]
      )
    ]);
    return { ...updated.rows[0], items: items.rows, queue_status: researchQueue.getStatus() };
  });
}

async function retryFailedItems(jobId) {
  const result = await db.query(
    `UPDATE research_job_items
     SET status = 'queued', error_code = NULL, error_message = NULL,
         started_at = NULL, finished_at = NULL, duration_ms = NULL,
         locked_at = NULL, updated_at = NOW()
     WHERE job_id = $1 AND status = 'failed'
       AND EXISTS(SELECT 1 FROM research_jobs WHERE id = $1 AND status <> 'cancelled')
     RETURNING id`,
    [jobId]
  );
  if (result.rows.length === 0) {
    const error = new Error('Research job has no failed items to retry');
    error.code = 'RESEARCH_RETRY_EMPTY';
    throw error;
  }
  await db.query(
     `UPDATE research_jobs
      SET status = 'pending', failed_count = 0, finished_at = NULL,
          cancelled_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [jobId]
  );
  researchQueue.wake();
  return getResearchJob(jobId);
}

class ResearchQueue {
  constructor(options = {}) {
    this.engine = options.engine || engineState;
    this.db = options.db || db;
    this.scheduler = options.scheduler || researchAccess.scheduler;
    this.claim = options.claimItems || claimItems;
    this.process = options.processItem || processItem;
    this.timer = null;
    this.running = false;
    this.runtimeSnapshot = {};
    this.lastRunAt = null;
  }

  async runOnce() {
    if (this.running) return 0;
    this.runtimeSnapshot = await readPersistedEngineRuntime(this.db);
    const liveMode = runtimeRequestsLiveMode(this.runtimeSnapshot)
      || runtimeRequestsLiveMode(localEngineRuntime(this.engine));
    if (!schedulerAllowsResearch(this.scheduler.getStatus(), { liveMode })) return 0;
    this.running = true;
    try {
      const items = await this.claim(liveMode ? LIVE_CONCURRENCY : DEFAULT_CONCURRENCY);
      await Promise.all(items.map(this.process));
      this.lastRunAt = new Date().toISOString();
      return items.length;
    } finally {
      this.running = false;
    }
  }

  wake() {
    setTimeout(() => {
      this.runOnce().catch((error) => {
        logger.error('research-queue', 'Research queue wake failed', { error: error.message });
      });
    }, 0);
  }

  start(options = {}) {
    if (this.timer) return;
    const intervalMs = Math.max(250, Number(options.intervalMs || 1000));
    this.timer = setInterval(() => this.wake(), intervalMs);
    this.timer.unref?.();
    this.wake();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  getStatus() {
    const schedulerStatus = this.scheduler.getStatus();
    const liveMode = runtimeRequestsLiveMode(this.runtimeSnapshot)
      || runtimeRequestsLiveMode(localEngineRuntime(this.engine));
    const admission = researchAdmission(schedulerStatus, { liveMode });
    return {
      worker_running: this.running,
      admission_allowed: admission.allowed,
      wait_reason: this.running ? 'RESEARCH_WORKER_BUSY' : admission.wait_reason,
      retry_at: admission.retry_at,
      live_mode: liveMode,
      effective_concurrency: liveMode ? LIVE_CONCURRENCY : DEFAULT_CONCURRENCY,
      last_run_at: this.lastRunAt
    };
  }
}

const researchQueue = new ResearchQueue();

module.exports = {
  DEFAULT_CONCURRENCY,
  LIVE_CONCURRENCY,
  LIVE_RESEARCH_ADMISSION_WEIGHT,
  MAX_BATCH_SIZE,
  ResearchQueue,
  cancelResearchJob,
  claimItems,
  createResearchJob,
  getResearchJob,
  jobStatusFromCounts,
  localEngineRuntime,
  normalizeAddresses,
  processItem,
  readPersistedEngineRuntime,
  refreshJob,
  researchAdmission,
  researchQueue,
  retryFailedItems,
  runtimeRequestsLiveMode,
  schedulerAllowsResearch
};
