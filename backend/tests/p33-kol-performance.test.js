const assert = require('node:assert/strict');
const test = require('node:test');
const { requestBody } = require('../domains/kol-performance/post-ca-research');
const {
  DEFAULT_CA_INTERVAL_MS,
  DEFAULT_GLOBAL_INTERVAL_MS,
  createKlinePacer,
  replayAsset
} = require('../domains/kol-performance/price-replay');
const { loadFollowEvents, loadPostEvents } = require('../domains/kol-performance/source-loaders');
const { KolPerformanceWorker, KolProfileWorker, summarize } = require('../domains/kol-performance/worker');

const ADDRESS = '0x1111111111111111111111111111111111111111';
const EVENT_AT = '2026-08-01T00:00:30.000Z';

test('P33 post CA prompt is evidence-only natural language research with required public search', () => {
  const body = requestBody({
    handle: 'Example', text: `Launch ${ADDRESS}`, source_url: 'https://x.com/example/status/1', created_at: EVENT_AT
  });
  const prompt = JSON.stringify(body.input);
  assert.match(prompt, /@example/);
  assert.match(prompt, new RegExp(ADDRESS));
  assert.match(prompt, /x_search|web_search/);
  assert.doesNotMatch(prompt, /GMGN|Swap|Quote|Order|本地程序|交易执行/i);
  assert.deepEqual(body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
  assert.equal(body.tool_choice, 'required');
});

test('P33 post source keeps a direct author CA local and never invokes Grok', async () => {
  let grokCalls = 0;
  const loaded = await loadPostEvents('Example', {
    xClient: { getUserTweets: async () => [{ id: 'tweet-1', text: ADDRESS, created_at: EVENT_AT }] },
    resolveContractChain: async () => ({ status: 'resolved', chainId: 'base', contractAddress: ADDRESS }),
    researchPostCa: async () => { grokCalls += 1; return { status: 'no_match', candidates: [] }; }
  });
  assert.equal(loaded.source_event_count, 1);
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].extraction_status, 'resolved');
  assert.equal(loaded.events[0].chain_id, 'base');
  assert.equal(grokCalls, 0);
});

test('P33 follow source reads actual observed activities and reuses a resolved strategy event', async () => {
  let query;
  let params;
  let researchCalls = 0;
  const loaded = await loadFollowEvents('@Example', {
    sampleStartedAt: '2026-08-01T00:00:00.000Z',
    sampleEndedAt: '2026-08-02T00:00:00.000Z',
    resolveFollowEvent: async () => { researchCalls += 1; throw new Error('must not research cached result'); },
    executor: {
      async query(sql, values) {
        query = sql;
        params = values;
        return { rows: [{
          activity_id: 9,
          target_handle: '@Target',
          strategy_event_id: 19,
          strategy_status: 'resolved',
          chain_id: 'base',
          contract_address: ADDRESS,
          provider_created_at: EVENT_AT,
          evidence: { source: 'grok' },
          profile_snapshot: {},
          token_name: 'Example Token',
          token_symbol: 'EXAMPLE'
        }] };
      }
    }
  });
  assert.match(query, /FROM x_activities AS activity/);
  assert.match(query, /LEFT JOIN LATERAL[\s\S]*?follow_discovery_events/);
  assert.deepEqual(params, [
    'example', '2026-08-01T00:00:00.000Z', '2026-08-02T00:00:00.000Z', 100
  ]);
  assert.equal(loaded.grok_lookup_count, 0);
  assert.equal(researchCalls, 0);
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].extraction_status, 'resolved');
  assert.equal(loaded.events[0].target_handle, 'target');
  assert.equal(loaded.events[0].contract_address, ADDRESS);
  assert.equal(loaded.events[0].token_symbol, 'EXAMPLE');
});

test('P33 follow source researches observed activities that have no strategy-specific event', async () => {
  const progress = [];
  const loaded = await loadFollowEvents('@Example', {
    sampleStartedAt: '2026-08-01T00:00:00.000Z',
    sampleEndedAt: '2026-08-02T00:00:00.000Z',
    followResearchIntervalMs: 0,
    onProgress: async (value) => progress.push(value),
    executor: {
      async query() {
        return { rows: [{
          activity_id: 10,
          target_handle: '@NewProject',
          provider_created_at: EVENT_AT,
          provider: '6551',
          strategy_event_id: null,
          strategy_status: null
        }] };
      }
    },
    resolveFollowEvent: async (event) => {
      assert.equal(event.target_handle, 'newproject');
      assert.deepEqual(event.allowed_chain_ids, ['sol', 'bsc', 'base', 'eth', 'robinhood']);
      return {
        profile: { project_name: 'New Project' },
        selected: { chainId: 'base', contractAddress: ADDRESS, source: 'grok_x_search' },
        evidence: [{ type: 'grok_x_post', ref: 'https://x.com/newproject/status/1' }],
        research: { prompt_version: 'test' }
      };
    }
  });

  assert.equal(loaded.source_event_count, 1);
  assert.equal(loaded.grok_lookup_count, 1);
  assert.equal(loaded.events[0].extraction_status, 'resolved');
  assert.equal(loaded.events[0].contract_address, ADDRESS);
  assert.equal(loaded.events[0].evidence_json.resolution_source, 'grok_follow_research');
  assert.equal(progress.some((value) => value.current_target_handle === 'newproject'), true);
  assert.equal(progress.at(-1).processed_follow_events, 1);
  assert.equal(progress.at(-1).resolved_follow_events, 1);
});

test('P33 follow source keeps observed events visible when Grok is unavailable and stops the batch', async () => {
  let calls = 0;
  const rows = ['first', 'second'].map((target, index) => ({
    activity_id: index + 1,
    target_handle: target,
    provider_created_at: new Date(Date.parse(EVENT_AT) + index * 1_000).toISOString(),
    provider: '6551',
    strategy_event_id: null,
    strategy_status: null
  })).reverse();
  const loaded = await loadFollowEvents('example', {
    followResearchIntervalMs: 0,
    executor: { query: async () => ({ rows }) },
    resolveFollowEvent: async () => {
      calls += 1;
      const error = new Error('xAI timed out');
      error.code = 'XAI_SEARCH_TIMEOUT';
      error.retryable = true;
      throw error;
    }
  });

  assert.equal(calls, 1);
  assert.equal(loaded.events.length, 2);
  assert.equal(loaded.events.every((event) => event.extraction_status === 'provider_failed'), true);
  assert.equal(loaded.provider_failed_count, 1);
  assert.equal(loaded.source_coverage_complete, false);
  assert.equal(loaded.source_unprocessed_segment_count, 1);
});

test('P33 replay never counts a pre-event high from the same entry candle', async () => {
  const cache = new Map();
  const calls = [];
  const repository = {
    getReplayCache: async (request) => cache.get(JSON.stringify(request)) || null,
    putReplayCache: async (request) => cache.set(JSON.stringify({ ...request, rows: undefined }), request.rows),
  };
  const eventUnix = Math.floor(Date.parse(EVENT_AT) / 1000);
  const result = await replayAsset({ chain_id: 'base', contract_address: ADDRESS, source_occurred_at: EVENT_AT }, '2026-08-03T00:00:00.000Z', repository, {
    fetchKline: async (request) => {
      calls.push(request);
      if (request.resolution === '1m') {
        return { rows: [
          { timestamp: eventUnix - 60, close: 100, high: 999 },
          { timestamp: eventUnix, close: 10, high: 999 },
          { timestamp: eventUnix + 60, close: 11, high: 15 },
        ] };
      }
      return { rows: [{ timestamp: request.from, close: 12, high: 14 }] };
    }
  });
  assert.equal(calls.length, 2);
  assert.equal(result.price_status, 'completed');
  assert.equal(result.entry_price, 10);
  assert.equal(result.peak_price, 15);
  assert.equal(result.peak_multiple, 1.5);
  assert.notEqual(result.peak_price, 999);
});

test('P33 paces real K-line requests globally and more strictly per CA', async () => {
  let clock = 10_000;
  const waits = [];
  const pacer = createKlinePacer({
    globalIntervalMs: 1_000,
    caIntervalMs: 2_500,
    now: () => clock,
    sleep: async (delayMs) => { waits.push(delayMs); clock += delayMs; }
  });
  const first = await pacer.wait({ chain_id: 'base', contract_address: ADDRESS });
  const second = await pacer.wait({
    chain_id: 'base', contract_address: '0x2222222222222222222222222222222222222222'
  });
  const third = await pacer.wait({ chain_id: 'base', contract_address: ADDRESS.toUpperCase() });
  assert.equal(first.delay_ms, 0);
  assert.equal(second.delay_ms, 1_000);
  assert.equal(third.delay_ms, 1_500);
  assert.deepEqual(waits, [1_000, 1_500]);
  assert.equal(DEFAULT_GLOBAL_INTERVAL_MS, 1_000);
  assert.equal(DEFAULT_CA_INTERVAL_MS, 2_000);
  const protectedDefaults = createKlinePacer({ globalIntervalMs: 0, caIntervalMs: 1 });
  assert.equal(protectedDefaults.globalIntervalMs, DEFAULT_GLOBAL_INTERVAL_MS);
  assert.equal(protectedDefaults.caIntervalMs, DEFAULT_CA_INTERVAL_MS);
});

test('P33 replay cache hits bypass pacing and the GMGN provider', async () => {
  const eventUnix = Math.floor(Date.parse(EVENT_AT) / 1000);
  let pacingCalls = 0;
  let providerCalls = 0;
  const result = await replayAsset(
    { chain_id: 'base', contract_address: ADDRESS, source_occurred_at: EVENT_AT },
    '2026-08-01T00:10:00.000Z',
    {
      getReplayCache: async () => [{ timestamp: eventUnix, close: 2, high: 3 }],
      putReplayCache: async () => { throw new Error('cache hit must not be persisted again'); }
    },
    {
      pacer: { wait: async () => { pacingCalls += 1; } },
      fetchKline: async () => { providerCalls += 1; return { rows: [] }; }
    }
  );
  assert.equal(result.price_status, 'completed');
  assert.equal(pacingCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(result.provider_snapshot.requests[0].cache_hit, true);
});

test('P33 records a real K-line attempt in the error snapshot when the provider times out', async () => {
  const repository = {
    getReplayCache: async () => null,
    putReplayCache: async () => { throw new Error('cache must not persist a failed provider response'); }
  };
  await assert.rejects(
    () => replayAsset({ chain_id: 'robinhood', contract_address: ADDRESS, source_occurred_at: EVENT_AT }, '2026-08-03T00:00:00.000Z', repository, {
      pacer: { wait: async () => ({ delay_ms: 750, released_at: '2026-08-01T00:00:00.000Z' }) },
      fetchKline: async () => { throw Object.assign(new Error('network timeout'), { code: 'GMGN_REQUEST_TIMEOUT' }); }
    }),
    (error) => {
      assert.equal(error.providerSnapshot.requests.length, 1);
      assert.equal(error.providerSnapshot.requests[0].resolution, '1m');
      assert.equal(error.providerSnapshot.requests[0].outcome, 'failed');
      assert.equal(error.providerSnapshot.requests[0].pacing.delay_ms, 750);
      return true;
    }
  );
});

test('P33 turns one unexpected chain-resolution failure into a no-match event', async () => {
  const loaded = await loadPostEvents('Example', {
    xClient: { getUserTweets: async () => [{ id: 'tweet-2', text: ADDRESS, created_at: EVENT_AT }] },
    resolveContractChain: async () => { throw Object.assign(new Error('RPC unavailable'), { code: 'CHAIN_RPC_UNAVAILABLE' }); },
    researchPostCa: async () => ({ status: 'no_match', candidates: [] })
  });
  assert.equal(loaded.events.length, 1);
  assert.equal(loaded.events[0].extraction_status, 'no_match');
  assert.equal(loaded.events[0].evidence_json.code, 'POST_CA_CHAIN_RESOLUTION_FAILED');
});

test('P33 summary counts wins only from actual price-ready unique CAs above 1.00x', () => {
  const summary = summarize([
    { source_type: 'tweet', source_id: 'one', extraction_status: 'resolved' },
    { source_type: 'tweet', source_id: 'two', extraction_status: 'resolved' },
    { source_type: 'tweet', source_id: 'three', extraction_status: 'no_match' },
  ], [
    { price_status: 'completed', peak_multiple: 1.01 },
    { price_status: 'completed', peak_multiple: 1.0 },
    { price_status: 'completed', peak_multiple: 2.4 },
    { price_status: 'retry', peak_multiple: null },
  ]);
  assert.equal(summary.raw_event_count, 3);
  assert.equal(summary.parsed_ca_count, 2);
  assert.equal(summary.unique_ca_count, 4);
  assert.equal(summary.price_ready_ca_count, 3);
  assert.equal(summary.win_rate, 2 / 3);
  assert.equal(summary.median_peak_multiple, 1.01);
  assert.equal(summary.best_peak_multiple, 2.4);
  assert.equal(summary.deduplicated_ca_count, 0);
});

test('P33 stops subsequent price replay after the first retryable GMGN error', async () => {
  const updates = [];
  let calls = 0;
  const worker = new KolPerformanceWorker({
    repository: { updateAssetPrice: async (id, value) => { updates.push({ id, value }); } },
    replayAsset: async () => {
      calls += 1;
      throw Object.assign(new Error('network timeout'), {
        code: 'GMGN_NETWORK_ERROR',
        providerSnapshot: { requests: [{ cache_hit: false, resolution: '1m' }] }
      });
    },
    logger: { error() {} }
  });
  const result = await worker.priceAssets({ as_of_at: '2026-08-03T00:00:00.000Z' }, [
    { id: '1', price_status: 'pending' }, { id: '2', price_status: 'pending' }
  ]);
  assert.equal(calls, 1);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].value.price_status, 'retry');
  assert.equal(updates[0].value.provider_snapshot.requests.length, 1);
  assert.equal(result.providerStopped, true);
  assert.equal(result.providerKlineCalls, 1);
});

test('P34 persists the exact current CA before each replay and settled counts afterwards', async () => {
  const progress = [];
  const updated = [];
  const assets = [1, 2, 3].map((id) => ({
    id: String(id), price_status: 'pending', chain_id: 'base',
    contract_address: `0x${String(id).padStart(40, '0')}`, token_symbol: `T${id}`
  }));
  const worker = new KolPerformanceWorker({
    repository: {
      updateRunProgress: async (_runId, value) => { progress.push(value); },
      updateAssetPrice: async (id, value) => { updated.push({ id, value }); }
    },
    replayAsset: async () => ({
      price_status: 'completed', entry_price: 1, peak_price: 2, peak_multiple: 2,
      provider_snapshot: { requests: [] }
    }),
    logger: { error() {} }
  });

  const result = await worker.priceAssets({ id: '44', as_of_at: EVENT_AT }, assets);
  const active = progress.filter((item) => item.current_asset_id);
  assert.deepEqual(active.map((item) => item.current_asset_index), [1, 2, 3]);
  assert.deepEqual(active.map((item) => item.current_contract_address), assets.map((asset) => asset.contract_address));
  assert.equal(progress.at(-1).processed_assets, 3);
  assert.equal(progress.at(-1).successful_assets, 3);
  assert.equal(progress.at(-1).current_asset_id, null);
  assert.equal(updated.length, 3);
  assert.equal(result.processedAssets, 3);
});

test('P33 account profile worker only persists Grok research and has no price dependency', async () => {
  const completed = [];
  const worker = new KolProfileWorker({
    repository: {
      claimNextProfileRun: async () => ({ id: 12, actor_handle: 'example' }),
      completeProfileRun: async (id, result) => { completed.push({ id, result }); }
    },
    researchAccount: async ({ handle }) => ({ status: 'analyzed', account_type: 'kol', candidates: [], handle }),
    logger: { error() {} }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'completed');
  assert.equal(completed.length, 1);
  assert.equal(completed[0].result.handle, 'example');
});
