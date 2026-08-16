const logger = require('../../lib/logger');
const { researchAccount } = require('../account-research/grok-research');
const { createKolPerformanceRepository } = require('./repository');
const { createKlinePacer, replayAsset, retryablePriceError } = require('./price-replay');
const { loadFollowEvents, loadPostEvents } = require('./source-loaders');

function median(values) {
  const ordered = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
}

function summarize(events, assets, extra = {}) {
  const sourceEventCount = new Set(events.map((event) => `${event.source_type}:${event.source_id}`)).size;
  const parsedCaCount = events.filter((event) => event.extraction_status === 'resolved').length;
  const ready = assets.filter((asset) => asset.price_status === 'completed'
    && Number.isFinite(Number(asset.peak_multiple)));
  const multiples = ready.map((asset) => Number(asset.peak_multiple));
  const wins = multiples.filter((value) => value > 1).length;
  const unavailable = assets.filter((asset) => ['pending', 'retry', 'no_data', 'failed'].includes(asset.price_status));
  const sourceTypeCounts = extra.source_type_counts || events.reduce((counts, event) => {
    counts[event.source_type] = (counts[event.source_type] || 0) + 1;
    return counts;
  }, {});
  return {
    raw_event_count: sourceEventCount,
    parsed_ca_count: parsedCaCount,
    unique_ca_count: assets.length,
    price_ready_ca_count: ready.length,
    missing_price_ca_count: assets.length - ready.length,
    win_rate: ready.length > 0 ? wins / ready.length : null,
    average_peak_multiple: multiples.length > 0
      ? multiples.reduce((total, value) => total + value, 0) / multiples.length : null,
    median_peak_multiple: median(multiples),
    best_peak_multiple: multiples.length > 0 ? Math.max(...multiples) : null,
    pending_price_ca_count: unavailable.length,
    grok_lookup_count: Number(extra.grok_lookup_count || 0),
    grok_batch_count: Number(extra.grok_batch_count || extra.grok_lookup_count || 0),
    grok_post_count: Number(extra.grok_post_count || 0),
    grok_request_count: Number(extra.grok_request_count || 0),
    grok_search_tool_calls: Number(extra.grok_search_tool_calls || 0),
    direct_ca_count: Number(extra.direct_ca_count || 0),
    candidate_post_count: Number(extra.candidate_post_count || 0),
    provider_failed_count: Number(extra.provider_failed_count
      ?? events.filter((event) => event.extraction_status === 'provider_failed').length),
    source_request_count: Number(extra.source_request_count || 0),
    source_primary_request_count: Number(extra.source_primary_request_count || 0),
    source_successful_request_count: Number(extra.source_successful_request_count || 0),
    source_coverage_complete: extra.source_coverage_complete !== false,
    source_saturated_segment_count: Number(extra.source_saturated_segment_count || 0),
    source_unprocessed_segment_count: Number(extra.source_unprocessed_segment_count || 0),
    source_window_started_at: extra.source_window_started_at || null,
    source_window_ended_at: extra.source_window_ended_at || null,
    source_earliest_at: extra.source_earliest_at || null,
    source_latest_at: extra.source_latest_at || null,
    source_type_counts: sourceTypeCounts,
    source_coverage_reason: extra.source_coverage_reason || null,
    source_error_code: extra.source_error_code || null,
    source_error_detail: extra.source_error_detail || null,
    source_retry_after_ms: Number(extra.source_retry_after_ms || 0),
    reply_sample_request_count: Number(extra.reply_sample_request_count || 0),
    reply_sample_count: Number(extra.reply_sample_count || 0),
    reply_sample_complete: extra.reply_sample_complete === true,
    reply_sample_error_code: extra.reply_sample_error_code || null,
    reply_sample_error_detail: extra.reply_sample_error_detail || null,
    provider_kline_calls: Number(extra.provider_kline_calls || 0),
    cache_hit_count: Number(extra.cache_hit_count || 0),
    deduplicated_ca_count: Math.max(0, parsedCaCount - assets.length),
    provider_pacing_wait_ms: Number(extra.provider_pacing_wait_ms || 0)
  };
}

class KolPerformanceWorker {
  constructor(options = {}) {
    this.repository = options.repository || createKolPerformanceRepository(options.db);
    this.logger = options.logger || logger;
    this.loadPostEvents = options.loadPostEvents || loadPostEvents;
    this.loadFollowEvents = options.loadFollowEvents || loadFollowEvents;
    this.replayAsset = options.replayAsset || replayAsset;
    this.klinePacer = options.klinePacer || createKlinePacer(options.pacingOptions);
    this.sourceOptions = options.sourceOptions || {};
    this.timer = null;
    this.active = false;
    this.running = false;
  }

  async updateProgress(runId, progress) {
    if (typeof this.repository.updateRunProgress !== 'function') return null;
    return this.repository.updateRunProgress(runId, progress);
  }

  async loadSources(run) {
    const loader = run.mode === 'post_calls' ? this.loadPostEvents : this.loadFollowEvents;
    const externalProgress = this.sourceOptions.onProgress;
    return loader(run.actor_handle, {
      ...this.sourceOptions,
      sampleStartedAt: run.sample_started_at,
      sampleEndedAt: run.sample_ended_at,
      asOfAt: run.as_of_at,
      onProgress: run.mode === 'follow_discovery' ? async (progress) => {
        if (typeof externalProgress === 'function') await externalProgress(progress);
        await this.updateProgress(run.id, {
          started_at: run.started_at || new Date().toISOString(),
          total_assets: 0,
          processed_assets: 0,
          successful_assets: 0,
          unavailable_assets: 0,
          ...progress
        });
      } : externalProgress
    });
  }

  async hydrateAssetMetadata(assets) {
    for (const asset of assets) {
      if (asset.token_name && asset.token_symbol) continue;
      const metadata = await this.repository.findMetadata(asset.chain_id, asset.contract_address);
      if (metadata) await this.repository.updateAssetMetadata(asset.id, metadata);
    }
  }

  async priceAssets(run, assets) {
    let providerStopped = false;
    let providerError = null;
    let providerKlineCalls = 0;
    let cacheHitCount = 0;
    let providerPacingWaitMs = 0;
    let processedAssets = assets.filter((asset) => asset.price_status === 'completed').length;
    let successfulAssets = processedAssets;
    let unavailableAssets = 0;
    for (const [assetIndex, asset] of assets.entries()) {
      if (asset.price_status === 'completed') continue;
      if (providerStopped) break;
      const current = {
        stage: 'pricing',
        total_assets: assets.length,
        processed_assets: processedAssets,
        successful_assets: successfulAssets,
        unavailable_assets: unavailableAssets,
        current_asset_id: String(asset.id),
        current_asset_index: assetIndex + 1,
        current_chain_id: asset.chain_id || null,
        current_contract_address: asset.contract_address || null,
        current_token_symbol: asset.token_symbol || null,
        current_started_at: new Date().toISOString()
      };
      await this.updateProgress(run.id, current);
      let outcome = 'failed';
      try {
        const price = await this.replayAsset(asset, run.as_of_at, this.repository, {
          pacer: this.klinePacer
        });
        const requests = Array.isArray(price.provider_snapshot?.requests)
          ? price.provider_snapshot.requests : [];
        providerKlineCalls += requests.filter((request) => !request.cache_hit).length;
        cacheHitCount += requests.filter((request) => request.cache_hit).length;
        providerPacingWaitMs += requests.reduce(
          (total, request) => total + Number(request.pacing?.delay_ms || 0), 0
        );
        await this.repository.updateAssetPrice(asset.id, price);
        outcome = price.price_status;
      } catch (error) {
        providerError = error;
        const failedRequests = Array.isArray(error.providerSnapshot?.requests)
          ? error.providerSnapshot.requests : [];
        providerKlineCalls += failedRequests.filter((request) => !request.cache_hit).length;
        cacheHitCount += failedRequests.filter((request) => request.cache_hit).length;
        providerPacingWaitMs += failedRequests.reduce(
          (total, request) => total + Number(request.pacing?.delay_ms || 0), 0
        );
        const providerSnapshot = {
          ...(error.providerSnapshot || {}),
          error: error.code || error.message
        };
        if (retryablePriceError(error)) {
          providerStopped = true;
          outcome = 'retry';
          await this.repository.updateAssetPrice(asset.id, {
            price_status: 'retry', price_error_code: error.code || 'GMGN_KLINE_RETRY',
            price_error_detail: error.message, provider_snapshot: providerSnapshot
          });
        } else {
          outcome = 'no_data';
          await this.repository.updateAssetPrice(asset.id, {
            price_status: 'no_data', price_error_code: error.code || 'GMGN_KLINE_FAILED',
            price_error_detail: error.message, provider_snapshot: providerSnapshot
          });
        }
      }
      processedAssets += 1;
      if (outcome === 'completed') successfulAssets += 1;
      else unavailableAssets += 1;
      await this.updateProgress(run.id, {
        ...current,
        processed_assets: processedAssets,
        successful_assets: successfulAssets,
        unavailable_assets: unavailableAssets,
        current_asset_id: null,
        current_asset_index: null,
        current_chain_id: null,
        current_contract_address: null,
        current_token_symbol: null,
        current_started_at: null,
        last_asset_id: String(asset.id),
        last_contract_address: asset.contract_address || null,
        last_outcome: outcome
      });
    }
    return {
      providerStopped, providerError, providerKlineCalls, cacheHitCount, providerPacingWaitMs,
      processedAssets, successfulAssets, unavailableAssets
    };
  }

  async runOnce() {
    if (this.active) return { status: 'skipped' };
    this.active = true;
    let run = null;
    try {
      run = await this.repository.claimNextRun();
      if (!run) return { status: 'idle' };
      await this.updateProgress(run.id, {
        stage: run.mode === 'post_calls' ? 'source_loading' : 'event_loading',
        started_at: run.started_at || new Date().toISOString(),
        total_assets: 0,
        processed_assets: 0,
        successful_assets: 0,
        unavailable_assets: 0
      });
      let detail = await this.repository.getRun(run.id);
      let sourceMeta = { ...(run.metrics || {}) };
      if (detail.events.length === 0) {
        const loaded = await this.loadSources(run);
        sourceMeta = loaded;
        await this.updateProgress(run.id, {
          stage: 'ca_extraction',
          started_at: run.started_at || new Date().toISOString(),
          source_event_count: loaded.events.length,
          total_assets: 0,
          processed_assets: 0,
          successful_assets: 0,
          unavailable_assets: 0
        });
        for (const event of loaded.events) await this.repository.insertEvent({ ...event, run_id: run.id });
        await this.repository.createAssetsFromResolvedEvents(run.id);
        detail = await this.repository.getRun(run.id);
      }
      if (detail.assets.length === 0) {
        const metrics = {
          ...summarize(detail.events, detail.assets, sourceMeta),
          progress: {
            stage: 'finished', total_assets: 0, processed_assets: 0,
            successful_assets: 0, unavailable_assets: 0, finished_at: new Date().toISOString()
          }
        };
        const reason = metrics.raw_event_count === 0
          ? 'KOL_PERFORMANCE_SOURCE_EMPTY' : 'KOL_PERFORMANCE_CA_EMPTY';
        if (metrics.provider_failed_count > 0) {
          await this.repository.setRunStatus(run.id, 'failed', {
            metrics,
            reason_codes: [reason, 'KOL_PERFORMANCE_GROK_FAILED'],
            error_code: 'KOL_PERFORMANCE_GROK_FAILED',
            last_error: run.mode === 'follow_discovery'
              ? 'Grok did not return a usable result for the observed followed accounts'
              : 'Grok did not return a usable result for the selected post candidates'
          });
          return { status: 'failed', runId: run.id };
        }
        const status = metrics.source_coverage_complete === false ? 'partial' : 'no_samples';
        const reasons = [reason];
        if (status === 'partial') reasons.push('KOL_PERFORMANCE_SOURCE_PARTIAL');
        await this.repository.setRunStatus(run.id, status, {
          metrics,
          reason_codes: reasons,
          error_code: status === 'partial' ? metrics.source_error_code : null,
          last_error: status === 'partial' ? metrics.source_error_detail : null
        });
        return { status, runId: run.id };
      }
      const extractionMetrics = summarize(detail.events, detail.assets, sourceMeta);
      await this.repository.setRunStatus(run.id, 'pricing', {
        metrics: {
          ...extractionMetrics,
          progress: {
            stage: 'pricing', total_assets: detail.assets.length, processed_assets: 0,
            successful_assets: 0, unavailable_assets: 0, current_asset_id: null,
            updated_at: new Date().toISOString()
          }
        }
      });
      await this.hydrateAssetMetadata(detail.assets);
      detail = await this.repository.getRun(run.id);
      const priced = await this.priceAssets(run, detail.assets);
      detail = await this.repository.getRun(run.id);
      const metrics = {
        ...summarize(detail.events, detail.assets, {
          ...sourceMeta, provider_kline_calls: priced.providerKlineCalls,
          cache_hit_count: priced.cacheHitCount,
          provider_pacing_wait_ms: priced.providerPacingWaitMs
        }),
        progress: {
          stage: priced.providerStopped ? 'paused' : 'finished',
          total_assets: detail.assets.length,
          processed_assets: priced.processedAssets,
          successful_assets: priced.successfulAssets,
          unavailable_assets: priced.unavailableAssets,
          current_asset_id: null,
          finished_at: new Date().toISOString()
        }
      };
      if (priced.providerStopped) {
        await this.repository.setRunStatus(run.id, 'price_retry', {
          metrics,
          reason_codes: ['KOL_PERFORMANCE_GMGN_PRICE_RETRY', 'KOL_PERFORMANCE_GMGN_BATCH_SHORT_CIRCUITED'],
          error_code: priced.providerError?.code || 'GMGN_KLINE_RETRY',
          last_error: priced.providerError?.message || 'GMGN historical price replay is unavailable'
        });
        return { status: 'price_retry', runId: run.id };
      }
      const sourcePartial = metrics.source_coverage_complete === false || metrics.provider_failed_count > 0;
      if (metrics.price_ready_ca_count === detail.assets.length && !sourcePartial) {
        await this.repository.setRunStatus(run.id, 'completed', { metrics, reason_codes: [] });
        return { status: 'completed', runId: run.id };
      }
      if (metrics.price_ready_ca_count === 0) {
        const firstError = detail.assets.find((asset) => asset.price_error_code);
        await this.repository.setRunStatus(run.id, 'price_unavailable', {
          metrics,
          reason_codes: ['KOL_PERFORMANCE_GMGN_PRICE_UNAVAILABLE'],
          error_code: firstError?.price_error_code || 'GMGN_KLINE_EMPTY',
          last_error: firstError?.price_error_detail || 'GMGN did not return a usable historical price window'
        });
        return { status: 'price_unavailable', runId: run.id };
      }
      const reasons = ['KOL_PERFORMANCE_PARTIAL_RESULT'];
      if (sourcePartial) reasons.push('KOL_PERFORMANCE_SOURCE_PARTIAL');
      if (metrics.missing_price_ca_count > 0) reasons.push('KOL_PERFORMANCE_GMGN_PRICE_PARTIAL');
      await this.repository.setRunStatus(run.id, 'partial', {
        metrics,
        reason_codes: reasons,
        error_code: metrics.source_error_code || null,
        last_error: metrics.source_error_detail || null
      });
      return { status: 'partial', runId: run.id };
    } catch (error) {
      if (run) {
        await this.updateProgress(run.id, {
          stage: 'finished', outcome: 'failed', finished_at: new Date().toISOString()
        }).catch(() => {});
        await this.repository.setRunStatus(run.id, 'failed', {
          error_code: error.code || 'KOL_PERFORMANCE_WORKER_FAILED', last_error: error.message
        }).catch(() => {});
      }
      this.logger.error('kol-performance', 'KOL performance worker failed', {
        run_id: run?.id || null, code: error.code || 'KOL_PERFORMANCE_WORKER_FAILED', error: error.message
      });
      throw error;
    } finally {
      this.active = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.running = true;
    const interval = Math.max(1_000, Number(options.intervalMs || 2_000));
    void this.runOnce().catch(() => {});
    this.timer = setInterval(() => void this.runOnce().catch(() => {}), interval);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; }
  getStatus() { return { running: this.running, active: this.active }; }
}

class KolProfileWorker {
  constructor(options = {}) {
    this.repository = options.repository || createKolPerformanceRepository(options.db);
    this.researchAccount = options.researchAccount || researchAccount;
    this.logger = options.logger || logger;
    this.timer = null;
    this.active = false;
    this.running = false;
  }

  async runOnce() {
    if (this.active) return { status: 'skipped' };
    this.active = true;
    let run = null;
    try {
      run = await this.repository.claimNextProfileRun();
      if (!run) return { status: 'idle' };
      const result = await this.researchAccount({ handle: run.actor_handle });
      await this.repository.completeProfileRun(run.id, result);
      return { status: 'completed', runId: run.id };
    } catch (error) {
      if (run) await this.repository.failProfileRun(run.id, error).catch(() => {});
      this.logger.error('kol-profile', 'KOL profile worker failed', {
        run_id: run?.id || null, code: error.code || 'KOL_PROFILE_RESEARCH_FAILED', error: error.message
      });
      throw error;
    } finally {
      this.active = false;
    }
  }

  start(options = {}) {
    if (this.timer) return;
    this.running = true;
    const interval = Math.max(1_000, Number(options.intervalMs || 2_000));
    void this.runOnce().catch(() => {});
    this.timer = setInterval(() => void this.runOnce().catch(() => {}), interval);
    this.timer.unref?.();
  }

  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; this.running = false; }
  getStatus() { return { running: this.running, active: this.active }; }
}

const kolPerformanceWorker = new KolPerformanceWorker();
const kolProfileWorker = new KolProfileWorker();

module.exports = { KolPerformanceWorker, KolProfileWorker, kolPerformanceWorker, kolProfileWorker, median, summarize };
