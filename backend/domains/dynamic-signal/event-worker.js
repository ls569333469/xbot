const crypto = require('crypto');
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const { resolveDynamicSignal } = require('./ca-resolver');
const candidateRepository = require('./candidate-repository');
const eventQueue = require('./event-queue');
const resolutionStore = require('./resolution-store');
const targetService = require('./dynamic-target-service');
const paperWorker = require('./paper-worker');
const { p20FeatureState } = require('../../lib/p20-features');

class DynamicSignalWorker {
  constructor(options = {}) {
    this.db = options.db || db;
    this.logger = options.logger || logger;
    this.getFeatureState = options.getFeatureState || p20FeatureState;
    this.workerId = options.workerId || `dynamic:${process.pid}:${crypto.randomUUID()}`;
    this.timer = null;
    this.running = false;
    this.active = false;
    this.wsBroadcast = null;
    this.lastRunAt = null;
    this.lastSuccessAt = null;
    this.lastError = null;
    this.processed = 0;
  }

  async runOnce() {
    if (this.active) return { status: 'skipped', reason: 'already_running' };
    const initialFlags = this.getFeatureState();
    if (!initialFlags.P20_DYNAMIC_RESOLUTION_ENABLED || !initialFlags.P20_RECORD_ENABLED) {
      return { status: 'skipped', reason: 'p20_disabled' };
    }
    this.active = true;
    this.lastRunAt = new Date();
    let job = null;
    let leaseTimer = null;
    let leaseLost = false;
    let leaseRenewing = false;
    try {
      job = await eventQueue.claimNext(this.workerId, this.db);
      if (!job) return { status: 'idle' };
      const renewLease = async () => {
        if (!job || leaseLost || leaseRenewing) return;
        leaseRenewing = true;
        try {
          const owned = await eventQueue.renew(job.id, this.workerId, this.db);
          if (!owned) leaseLost = true;
        } catch (error) {
          this.logger.warn?.('dynamic-signal-worker', `P20 lease renewal failed: ${error.message}`, {
            jobId: job.id
          });
        } finally {
          leaseRenewing = false;
        }
      };
      leaseTimer = setInterval(() => void renewLease(), 20_000);
      leaseTimer.unref?.();
      const context = await eventQueue.loadContext(job.id, this.db);
      if (!context || !context.policy_enabled
          || Number(context.policy_revision) !== Number(context.current_policy_revision)) {
        await eventQueue.cancel(job.id, 'DYNAMIC_POLICY_CHANGED', this.db, this.workerId);
        return { status: 'cancelled', jobId: job.id, reason: 'dynamic_policy_changed' };
      }
      const currentMode = eventQueue.effectiveMode(context.configured_mode, this.getFeatureState());
      if (currentMode !== context.mode) {
        await eventQueue.cancel(job.id, 'DYNAMIC_RUNTIME_MODE_CHANGED', this.db, this.workerId);
        return { status: 'cancelled', jobId: job.id, reason: 'runtime_mode_changed' };
      }
      if (!context.allowed_event_types.includes(context.activity_type)) {
        const error = new Error('Activity type is no longer allowed by dynamic policy');
        error.code = 'DYNAMIC_EVENT_NOT_ALLOWED';
        throw error;
      }
      const candidateIndex = await candidateRepository.loadIndex({
        allowedChains: context.allowed_chain_ids
      }, this.db);
      let result = await resolveDynamicSignal({
        eventType: context.activity_type,
        actorText: context.tweet_text || '',
        quotedText: context.raw_json?.quotedText || context.raw_json?.quoted_text || '',
        replyText: context.raw_json?.replyText || context.raw_json?.reply_text || '',
        approvedAliases: context.allowed_term_types.includes('approved_name')
          ? context.approved_aliases : [],
        allowedChains: context.allowed_chain_ids,
        allowedTermTypes: context.allowed_term_types,
        executionMode: context.mode,
        ...(context.resolver_options || {})
      }, {
        candidateIndex,
        verificationOptions: {
          requestOptions: {
            requestContext: {
              source: 'p20_dynamic_verify',
              processRole: process.env.XBOT_PROCESS_ROLE || 'all',
              policyId: context.actor_policy_id,
              context: { dynamic_job_id: Number(job.id) }
            }
          }
        }
      });
      if (result.status === 'resolved' && result.selectedCandidate) {
          const selectedRow = await candidateRepository.upsertCandidate(
            result.selectedCandidate, context.mode === 'live' ? 'tweet_ca' : 'gmgn_info', this.db,
          { sourceRef: context.tweet_id || context.provider_event_id }
        );
        const selected = {
          ...result.selectedCandidate,
          id: selectedRow.id,
          variantId: selectedRow.id,
          assetFamilyId: selectedRow.asset_family_id
        };
        result = {
          ...result,
          selectedCandidate: selected,
          candidates: (result.candidates || []).map((candidate) => (
            candidate.chainId === selected.chainId
              && candidate.contractAddress === selected.contractAddress ? selected : candidate
          ))
        };
      }

      const commitMode = eventQueue.effectiveMode(context.configured_mode, this.getFeatureState());
      if (commitMode !== context.mode) {
        await eventQueue.cancel(job.id, 'DYNAMIC_RUNTIME_MODE_CHANGED', this.db, this.workerId);
        return { status: 'cancelled', jobId: job.id, reason: 'runtime_mode_changed' };
      }
      await renewLease();
      if (leaseLost) {
        const error = new Error('Dynamic job lease was lost before persistence');
        error.code = 'DYNAMIC_JOB_LEASE_LOST';
        throw error;
      }

      const client = await this.db.pool.connect();
      let signal = null;
      let evaluation = null;
      try {
        await client.query('BEGIN');
        const attempt = await resolutionStore.persist(context, result, client);
        if (result.status === 'resolved' && ['paper', 'live'].includes(context.mode)) {
          const target = await targetService.materialize(context, attempt, result.selectedCandidate, client);
          signal = await targetService.createSignal(context, attempt, target, result, client);
          if (context.mode === 'paper' && signal) {
            const session = await paperWorker.ensureSession(
              context.actor_policy_id, context.policy_revision, client
            );
            evaluation = await paperWorker.createEvaluation(session.id, target.id, signal.id, client);
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
      if (signal?.execution_mode === 'live') {
        await this.db.query(
          "SELECT pg_notify('xbot_live_signal', $1)",
          [JSON.stringify([{ id: Number(signal.id), execution_mode: 'live' }])]
        );
      } else if (signal?.execution_mode === 'paper' && evaluation) {
        await paperWorker.execute(evaluation, signal, this.wsBroadcast, this.db);
      }
      this.processed += 1;
      this.lastSuccessAt = new Date();
      this.lastError = null;
      this.wsBroadcast?.({ type: 'p20:resolution', payload: {
        jobId: job.id, status: result.status, signalId: signal?.id || null
      } });
      return { status: 'completed', jobId: job.id, resolutionStatus: result.status, signal };
    } catch (error) {
      this.lastError = `${error.code || 'DYNAMIC_JOB_FAILED'}: ${eventQueue.errorMessage(error)}`;
      if (job) {
        const failure = error instanceof Error ? error : new Error(String(error));
        failure.code = failure.code || error?.code || 'DYNAMIC_JOB_FAILED';
        failure.attemptCount = job.attempt_count;
        await eventQueue.fail(job.id, failure, this.db, this.workerId)
          .catch(() => {});
      }
      this.logger.error('dynamic-signal-worker', `P20 job failed: ${eventQueue.errorMessage(error)}`, {
        jobId: job?.id, code: error.code
      });
      return { status: 'failed', jobId: job?.id || null, error: this.lastError };
    } finally {
      if (leaseTimer) clearInterval(leaseTimer);
      this.active = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.running = true;
    this.wsBroadcast = options.wsBroadcast || null;
    const intervalMs = Math.max(250, Number(options.intervalMs || 500));
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.running = false;
  }

  getStatus() {
    return {
      running: this.running, active: this.active, workerId: this.workerId,
      lastRunAt: this.lastRunAt, lastSuccessAt: this.lastSuccessAt,
      lastError: this.lastError, processed: this.processed
    };
  }
}

const dynamicSignalWorker = new DynamicSignalWorker();
module.exports = { DynamicSignalWorker, dynamicSignalWorker };
