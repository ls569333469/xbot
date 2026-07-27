const assert = require('node:assert/strict');
const path = require('path');
const test = require('node:test');

require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
require('./integration-guard');
const db = require('../lib/db');
const {
  cancelResearchJob,
  createResearchJob,
  getResearchJob,
  refreshJob,
  researchQueue,
  retryFailedItems
} = require('../domains/research/queue');

test('research jobs persist independent CA items and retry only failures', async () => {
  const originalWake = researchQueue.wake;
  researchQueue.wake = () => {};
  let jobId;
  try {
    const job = await createResearchJob({
      chain_id: 'base',
      contract_addresses: [
        '0x1111111111111111111111111111111111111111',
        '0x2222222222222222222222222222222222222222'
      ]
    });
    jobId = job.id;
    assert.equal(job.status, 'pending');
    assert.equal(job.items.length, 2);

    await db.query(
      `UPDATE research_job_items
       SET status = CASE WHEN contract_address LIKE '0x1111%' THEN 'completed' ELSE 'failed' END,
           error_code = CASE WHEN contract_address LIKE '0x2222%' THEN 'XAI_RATE_LIMITED' END,
           finished_at = NOW()
       WHERE job_id = $1`,
      [jobId]
    );
    await refreshJob(jobId);
    const partial = await getResearchJob(jobId);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.completed_count, 1);
    assert.equal(partial.failed_count, 1);

    const retried = await retryFailedItems(jobId);
    assert.equal(retried.status, 'pending');
    assert.equal(retried.items.filter((item) => item.status === 'queued').length, 1);
    assert.equal(retried.items.filter((item) => item.status === 'completed').length, 1);
  } finally {
    researchQueue.wake = originalWake;
    if (jobId) await db.query('DELETE FROM research_jobs WHERE id = $1', [jobId]);
  }
});

test('research jobs can be cancelled without deleting completed reports', async () => {
  const originalWake = researchQueue.wake;
  researchQueue.wake = () => {};
  let jobId;
  try {
    const job = await createResearchJob({
      chain_id: 'eth',
      contract_addresses: [
        '0x3333333333333333333333333333333333333333',
        '0x4444444444444444444444444444444444444444'
      ]
    });
    jobId = job.id;
    const cancelled = await cancelResearchJob(jobId);
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(cancelled.cancelled_count, 2);
    assert.equal(cancelled.concurrency_limit, 3);
    assert.equal(cancelled.items.every((item) => item.status === 'cancelled'), true);
    await assert.rejects(() => retryFailedItems(jobId), { code: 'RESEARCH_RETRY_EMPTY' });
  } finally {
    researchQueue.wake = originalWake;
    if (jobId) await db.query('DELETE FROM research_jobs WHERE id = $1', [jobId]);
  }
});

test.after(async () => {
  await db.pool.end();
});
