const crypto = require('crypto');
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const repository = require('./repository');
const { resolveFollowEvent, providerWait } = require('./resolver');
const materializer = require('./materializer');
const { enabled } = require('./authorization');

class FollowDiscoveryWorker {
  constructor(options = {}) {
    this.interval = null;
    this.running = false;
    this.workerId = options.workerId || crypto.randomUUID();
    this.researchFollowTarget = options.researchFollowTarget;
    this.xaiOptions = options.xaiOptions || {};
    this.lastRunAt = null;
    this.lastError = null;
    this.processed = 0;
  }

  async runOnce() {
    if (this.running || !enabled()) return { processed: false, reason: this.running ? 'busy' : 'disabled' };
    this.running = true;
    let job = null;
    let leaseHeartbeat = null;
    try {
      job = await repository.claimNext(this.workerId, db, 240);
      if (!job) return { processed: false, reason: 'empty' };
      leaseHeartbeat = setInterval(() => {
        void repository.renewLease(job.id, this.workerId).catch((error) => {
          logger.warn('follow-discovery', `Event ${job.id} lease renewal failed: ${error.message}`);
        });
      }, 30_000);
      leaseHeartbeat.unref?.();
      const context = await repository.getEvent(job.id);
      if (!context || !context.policy_enabled || !context.kol_enabled
          || Number(context.policy_revision) !== Number(context.current_policy_revision)
          || context.mode !== context.current_mode) {
        const error = new Error('Follow discovery policy changed before processing');
        error.code = 'FOLLOW_POLICY_REVISION_CHANGED';
        error.rejected = true;
        await repository.markFailed(job.id, error);
        return { processed: true, status: 'cancelled' };
      }
      const ageMs = Date.now() - new Date(context.provider_created_at).getTime();
      if (!Number.isFinite(ageMs) || ageMs < 0
          || ageMs > Number(context.resolver_options?.event_ttl_seconds || 900) * 1000) {
        const error = new Error('Follow event expired before unique CA resolution completed');
        error.code = 'FOLLOW_EVENT_EXPIRED';
        error.rejected = true;
        await repository.markFailed(job.id, error);
        return { processed: true, status: 'rejected' };
      }
      await repository.markStage(job.id, 'grok_search', this.workerId);
      const resolution = await resolveFollowEvent(context, {
        onStage: (stage) => repository.markStage(job.id, stage, this.workerId),
        researchFollowTarget: this.researchFollowTarget,
        xaiOptions: this.xaiOptions,
        requestContext: {
          source: 'p21_follow_discovery_verify',
          processRole: process.env.XBOT_PROCESS_ROLE || 'all',
          policyId: context.policy_id,
          context: { follow_event_id: Number(job.id), target_handle: context.target_handle }
        }
      });
      const client = await db.pool.connect();
      let output;
      try {
        await client.query('BEGIN');
        const locked = await repository.getEvent(job.id, client);
        if (!locked || Number(locked.policy_revision) !== Number(locked.current_policy_revision)
            || locked.context_hash !== context.context_hash) {
          const error = new Error('Follow discovery policy changed after resolution');
          error.code = 'FOLLOW_POLICY_REVISION_CHANGED';
          throw error;
        }
        output = await materializer.materialize(locked, resolution, client);
        await client.query(
          `UPDATE follow_discovery_events SET status = 'resolved', stage = 'completed',
             project_classification = $2, classification_confidence = $3,
             profile_snapshot = $4, evidence = $5, candidates = $6,
             chain_id = $7, contract_address = $8, variant_id = $9,
             whitelist_id = $10, signal_id = $11, failure_code = NULL, last_error = NULL,
             locked_at = NULL, lease_expires_at = NULL, worker_id = NULL,
             completed_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [job.id, resolution.classification.deterministic,
            resolution.classification.confidence, JSON.stringify(resolution.profile),
            JSON.stringify({ sources: resolution.evidence, grok: resolution.classification,
              grok_research: resolution.research || null,
              websites: resolution.websiteEvidence,
              related_accounts: resolution.relatedAccounts || [],
              relationships: (resolution.relatedAccounts || []).map((account) => account.relationship).filter(Boolean)
            }), JSON.stringify(resolution.candidates),
            resolution.selected.chainId, resolution.selected.contractAddress,
            output?.variant?.id || null, output?.whitelist?.id || null,
            output?.signal?.id || null]
        );
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      if (output?.signal?.id && context.mode === 'live') {
        await db.query("SELECT pg_notify('xbot_live_signal', $1)", [JSON.stringify([{
          id: Number(output.signal.id), execution_mode: 'live'
        }])]);
      }
      this.processed += 1;
      this.lastRunAt = new Date();
      return { processed: true, status: 'resolved', eventId: job.id, signalId: output?.signal?.id || null };
    } catch (error) {
      this.lastError = { code: error.code || 'FOLLOW_DISCOVERY_FAILED', message: error.message, at: new Date() };
      if (job) {
        if (providerWait(error)) await repository.markWaiting(job.id, error);
        else await repository.markFailed(job.id, error);
      }
      logger.error('follow-discovery', `Event ${job?.id || 'unknown'} failed: ${error.message}`);
      return { processed: Boolean(job), status: providerWait(error) ? 'waiting' : 'failed', error: error.code };
    } finally {
      if (leaseHeartbeat) clearInterval(leaseHeartbeat);
      this.running = false;
    }
  }

  start(options = {}) {
    if (this.interval) return;
    const intervalMs = Math.max(250, Number(options.intervalMs || 1000));
    this.interval = setInterval(() => void this.runOnce(), intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  getStatus() {
    return { enabled: enabled(), running: this.running, processed: this.processed,
      lastRunAt: this.lastRunAt, lastError: this.lastError };
  }
}

const followDiscoveryWorker = new FollowDiscoveryWorker();
module.exports = { FollowDiscoveryWorker, followDiscoveryWorker };
