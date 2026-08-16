const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  batchRequestBody,
  normalizeBatchResult,
  researchPostBatch
} = require('../domains/kol-performance/post-ca-research');
const { replayAsset } = require('../domains/kol-performance/price-replay');
const { createKolPerformanceRepository } = require('../domains/kol-performance/repository');
const { loadPostEvents, loadWindowedTweets } = require('../domains/kol-performance/source-loaders');
const { KolPerformanceWorker } = require('../domains/kol-performance/worker');

const ADDRESS = '0x1111111111111111111111111111111111111111';

function post(id, createdAt, text = '新币项目即将上线') {
  return { id, created_at: createdAt, text, is_reply: false, is_quote: false, is_retweet: false };
}

test('P34 batch Grok prompt remains natural-language public research without GMGN or trading instructions', () => {
  const body = batchRequestBody({
    handle: 'Example',
    posts: [{ source_id: 'tweet-1', source_url: 'https://x.com/example/status/1', created_at: '2026-08-01T00:00:00Z', text: '这个新项目值得研究' }]
  });
  const prompt = JSON.stringify(body.input);
  assert.match(prompt, /@example/);
  assert.match(prompt, /tweet-1/);
  assert.match(prompt, /x_search|web_search/);
  assert.doesNotMatch(prompt, /GMGN|Swap|Quote|Order|本地程序|交易执行/i);
  assert.equal(body.tool_choice, 'required');
});

test('P34 batch normalization binds only requested tweet IDs and valid evidence-backed addresses', () => {
  const payload = {
    output_text: JSON.stringify({ items: [
      { source_id: 'tweet-1', status: 'resolved', candidates: [{
        chain_id: 'base', contract_address: ADDRESS, token_name: 'Example', token_symbol: 'EX',
        evidence_url: 'https://x.com/example/status/1', evidence_excerpt: 'Official CA'
      }] },
      { source_id: 'other', status: 'resolved', candidates: [{
        chain_id: 'base', contract_address: ADDRESS, token_name: 'Other', token_symbol: 'OTHER',
        evidence_url: 'https://x.com/other/status/2', evidence_excerpt: 'Other CA'
      }] }
    ] }),
    citations: ['https://x.com/example/status/1'],
    usage: { server_side_tool_usage_details: { x_search_calls: 1 } }
  };
  const result = normalizeBatchResult(payload, ['tweet-1']);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].source_id, 'tweet-1');
  assert.equal(result.items[0].candidates[0].contract_address, ADDRESS);
});

test('P34 production batch research searches first and structures only verified evidence second', async () => {
  const requests = [];
  const payloads = [
    {
      output_text: `source_id tweet-1: Base CA ${ADDRESS}; evidence https://x.com/example/status/1`,
      usage: { server_side_tool_usage_details: { x_search_calls: 2 } }
    },
    {
      output_text: JSON.stringify({ items: [{
        source_id: 'tweet-1', status: 'resolved', candidates: [{
          chain_id: 'base', contract_address: ADDRESS, token_name: 'Example',
          token_symbol: 'EX', evidence_url: 'https://x.com/example/status/1',
          evidence_excerpt: `Official CA ${ADDRESS}`
        }]
      }] })
    }
  ];
  const result = await researchPostBatch({
    handle: 'example',
    posts: [{ source_id: 'tweet-1', text: '新项目发布', source_url: 'https://x.com/example/status/1' }]
  }, {
    apiKey: 'test-key',
    responsesUrl: 'https://api.x.ai/v1/responses',
    fetchImpl: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      const payload = payloads.shift();
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => payload };
    }
  });

  assert.equal(requests.length, 2);
  assert.ok(requests[0].tools?.some((tool) => tool.type === 'x_search'));
  assert.equal(requests[0].text, undefined);
  assert.equal(requests[1].tools, undefined);
  assert.equal(requests[1].text.format.type, 'json_schema');
  assert.equal(result.search_tool_calls, 2);
  assert.equal(result.items[0].candidates[0].contract_address, ADDRESS);
  assert.match(result.prompt_version, /two-stage/);
});

test('P34 splits saturated 6551 windows, filters exact timestamps, and deduplicates tweet IDs', async () => {
  let calls = 0;
  const loaded = await loadWindowedTweets('example', {
    sampleStartedAt: '2026-08-01T00:00:00Z',
    sampleEndedAt: '2026-08-03T00:00:00Z',
    sourceSegmentDays: 2,
    sourceRequestIntervalMs: 0,
    limit: 4,
    xClient: {
      searchTweets: async () => {
        calls += 1;
        if (calls === 1) return [
          post('saturated-1', '2026-08-01T01:00:00Z'),
          post('saturated-2', '2026-08-01T02:00:00Z'),
          post('saturated-3', '2026-08-01T03:00:00Z'),
          post('saturated-4', '2026-08-01T04:00:00Z')
        ];
        if (calls === 2) return [
          post('left', '2026-08-01T12:00:00Z'),
          post('outside-left', '2026-08-02T02:00:00Z')
        ];
        return [
          post('left', '2026-08-01T12:00:00Z'),
          post('right', '2026-08-02T12:00:00Z'),
          post('outside-all', '2026-08-04T00:00:00Z')
        ];
      }
    }
  });
  assert.equal(calls, 3);
  assert.deepEqual(loaded.tweets.map((tweet) => tweet.id), [
    'saturated-1', 'saturated-2', 'saturated-3', 'saturated-4', 'left', 'right'
  ]);
  assert.equal(loaded.meta.source_coverage_complete, true);
  assert.equal(loaded.meta.source_request_count, 3);
});

test('P34 keeps successful 6551 segments when a later window is rate limited', async () => {
  let calls = 0;
  const loaded = await loadWindowedTweets('example', {
    sampleStartedAt: '2026-08-01T00:00:00Z',
    sampleEndedAt: '2026-08-03T00:00:00Z',
    sourceSegmentDays: 2,
    sourceRequestIntervalMs: 0,
    limit: 2,
    xClient: {
      searchTweets: async (_filters, requestOptions) => {
        calls += 1;
        assert.deepEqual(requestOptions, { maxAttempts: 1 });
        if (calls === 1) return [
          post('kept-1', '2026-08-01T02:00:00Z'),
          post('kept-2', '2026-08-02T02:00:00Z')
        ];
        throw Object.assign(new Error('too frequent'), {
          code: 'X6551_RATE_LIMITED', retryAfterMs: 30_000
        });
      },
      getUserTweets: async () => assert.fail('reply sampling must stop after source rate limiting')
    }
  });

  assert.deepEqual(loaded.tweets.map((tweet) => tweet.id), ['kept-1', 'kept-2']);
  assert.equal(loaded.meta.source_request_count, 2);
  assert.equal(loaded.meta.source_successful_request_count, 1);
  assert.equal(loaded.meta.source_coverage_complete, false);
  assert.equal(loaded.meta.source_error_code, 'X6551_RATE_LIMITED');
  assert.equal(loaded.meta.source_retry_after_ms, 30_000);
});

test('P34 separates complete original-post windows from one bounded reply sample', async () => {
  const searchCalls = [];
  let replyCalls = 0;
  const loaded = await loadWindowedTweets('example', {
    sampleStartedAt: '2026-08-01T00:00:00Z',
    sampleEndedAt: '2026-08-08T00:00:00Z',
    sourceSegmentDays: 7,
    sourceRequestIntervalMs: 0,
    xClient: {
      searchTweets: async (filters) => {
        searchCalls.push(filters);
        return [post('original', '2026-08-02T00:00:00Z')];
      },
      getUserTweets: async (_handle, _options, requestOptions) => {
        replyCalls += 1;
        assert.deepEqual(requestOptions, { maxAttempts: 1 });
        return [
          { ...post('reply', '2026-08-03T00:00:00Z'), is_reply: true },
          post('recent-original', '2026-08-04T00:00:00Z')
        ];
      }
    }
  });

  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0].excludeReplies, true);
  assert.equal(replyCalls, 1);
  assert.deepEqual(loaded.tweets.map((tweet) => tweet.id), ['original', 'reply']);
  assert.equal(loaded.meta.source_coverage_complete, true);
  assert.equal(loaded.meta.reply_sample_request_count, 1);
  assert.equal(loaded.meta.reply_sample_count, 1);
  assert.equal(loaded.meta.reply_sample_complete, true);
});

test('P34 sends broad natural-language crypto posts to Grok even when no explicit CA exists', async () => {
  const researched = [];
  const loaded = await loadPostEvents('example', {
    xClient: { getUserTweets: async () => [post('tweet-1', '2026-08-01T00:00:00Z', '这个新币项目市值还很小')] },
    researchPostBatch: async ({ posts }) => {
      researched.push(...posts);
      return { items: posts.map((item) => ({ source_id: item.source_id, status: 'no_match', candidates: [] })), prompt_version: 'test', citations: [] };
    }
  });
  assert.equal(researched.length, 1);
  assert.equal(loaded.grok_batch_count, 1);
  assert.equal(loaded.grok_post_count, 1);
  assert.equal(loaded.events[0].evidence_json.code, 'POST_CA_NO_MATCH');
});

test('P34 reserves Grok capacity for original posts when replies dominate the source sample', async () => {
  const rows = [post('original', '2026-08-02T00:00:00Z', '新币项目发布')];
  for (let index = 0; index < 20; index += 1) {
    rows.push({ ...post(`reply-${index}`, `2026-08-01T${String(index).padStart(2, '0')}:00:00Z`, '回复这个新币项目'), is_reply: true });
  }
  const researched = [];
  await loadPostEvents('example', {
    maxGrokPosts: 10,
    xClient: { getUserTweets: async () => rows },
    researchPostBatch: async ({ posts }) => {
      researched.push(...posts);
      return { items: posts.map((item) => ({ source_id: item.source_id, status: 'no_match', candidates: [] })), prompt_version: 'test', citations: [] };
    }
  });
  assert.equal(researched.length, 5);
  assert.ok(researched.some((item) => item.source_id === 'original'));
  assert.ok(researched.filter((item) => item.source_type === 'reply').length <= 4);
});

test('P34 ignores an old empty K-line cache and persists only a later usable provider response', async () => {
  const eventAt = '2026-08-01T00:00:30Z';
  const eventUnix = Math.floor(Date.parse(eventAt) / 1000);
  let providerCalls = 0;
  let writes = 0;
  const result = await replayAsset(
    { chain_id: 'base', contract_address: ADDRESS, source_occurred_at: eventAt },
    '2026-08-01T00:10:00Z',
    {
      getReplayCache: async () => [],
      putReplayCache: async ({ rows }) => { writes += 1; assert.equal(rows.length, 1); }
    },
    {
      fetchKline: async () => {
        providerCalls += 1;
        return { rows: [{ timestamp: eventUnix, close: 2, high: 3 }] };
      }
    }
  );
  assert.equal(result.price_status, 'completed');
  assert.equal(providerCalls, 1);
  assert.equal(writes, 1);
});

test('P34 reports price_unavailable instead of completed when every confirmed CA has empty GMGN history', async () => {
  let asset = {
    id: 1, price_status: 'pending', chain_id: 'base', contract_address: ADDRESS,
    source_occurred_at: '2026-08-01T00:00:00Z'
  };
  const statuses = [];
  const repository = {
    claimNextRun: async () => ({ id: 1, mode: 'post_calls', actor_handle: 'example', as_of_at: '2026-08-02T00:00:00Z', metrics: {} }),
    getRun: async () => ({ id: 1, events: [{ source_type: 'tweet', source_id: '1', extraction_status: 'resolved' }], assets: [asset] }),
    setRunStatus: async (_id, status, details) => { statuses.push({ status, details }); },
    findMetadata: async () => null,
    updateAssetPrice: async (_id, value) => { asset = { ...asset, ...value }; }
  };
  const worker = new KolPerformanceWorker({
    repository,
    replayAsset: async () => ({
      price_status: 'no_data', price_error_code: 'GMGN_KLINE_EMPTY',
      price_error_detail: 'GMGN did not return a usable entry candle', provider_snapshot: { requests: [] }
    }),
    logger: { error() {} }
  });
  const result = await worker.runOnce();
  assert.equal(result.status, 'price_unavailable');
  assert.equal(statuses.at(-1).status, 'price_unavailable');
  assert.equal(statuses.at(-1).details.error_code, 'GMGN_KLINE_EMPTY');
});

test('P34 fails visibly when Grok fails for every selected post and no CA can be recovered', async () => {
  const statuses = [];
  const worker = new KolPerformanceWorker({
    repository: {
      claimNextRun: async () => ({ id: 2, mode: 'post_calls', actor_handle: 'example', as_of_at: '2026-08-02T00:00:00Z', metrics: {} }),
      getRun: async () => ({ id: 2, events: [], assets: [] }),
      insertEvent: async () => {},
      createAssetsFromResolvedEvents: async () => {},
      setRunStatus: async (_id, status, details) => { statuses.push({ status, details }); }
    },
    loadPostEvents: async () => ({
      events: [{ source_type: 'tweet', source_id: '1', extraction_status: 'provider_failed' }],
      provider_failed_count: 1, source_event_count: 1, source_coverage_complete: true
    }),
    logger: { error() {} }
  });
  worker.repository.getRun = async () => statuses.length === 0
    ? { id: 2, events: [], assets: [] }
    : { id: 2, events: [{ source_type: 'tweet', source_id: '1', extraction_status: 'provider_failed' }], assets: [] };
  const result = await worker.runOnce();
  assert.equal(result.status, 'failed');
  assert.equal(statuses.at(-1).details.error_code, 'KOL_PERFORMANCE_GROK_FAILED');
});

test('P34 reports a partial run with the exact 6551 source error after retaining samples', async () => {
  const statuses = [];
  const retained = [{ source_type: 'tweet', source_id: '1', extraction_status: 'no_match' }];
  let inserted = false;
  const worker = new KolPerformanceWorker({
    repository: {
      claimNextRun: async () => ({ id: 3, mode: 'post_calls', actor_handle: 'example', as_of_at: '2026-08-02T00:00:00Z', metrics: {} }),
      getRun: async () => inserted
        ? { id: 3, events: retained, assets: [] }
        : { id: 3, events: [], assets: [] },
      insertEvent: async () => { inserted = true; },
      createAssetsFromResolvedEvents: async () => {},
      setRunStatus: async (_id, status, details) => { statuses.push({ status, details }); }
    },
    loadPostEvents: async () => ({
      events: retained,
      source_event_count: 1,
      source_coverage_complete: false,
      source_error_code: 'X6551_RATE_LIMITED',
      source_error_detail: 'too frequent',
      source_request_count: 2,
      source_successful_request_count: 1
    }),
    logger: { error() {} }
  });

  const result = await worker.runOnce();
  assert.equal(result.status, 'partial');
  assert.equal(statuses.at(-1).details.error_code, 'X6551_RATE_LIMITED');
  assert.equal(statuses.at(-1).details.last_error, 'too frequent');
  assert.equal(statuses.at(-1).details.metrics.raw_event_count, 1);
});

test('P34 migration only extends KOL research states and never touches live trade tables', () => {
  const migration = fs.readFileSync(path.resolve(
    __dirname, '../db/migrations/051_p34_kol_research_result_convergence.sql'
  ), 'utf8');
  assert.match(migration, /partial.*price_retry.*price_unavailable/s);
  assert.doesNotMatch(migration, /(?:trade_signals|trade_intents|trade_attempts|trade_orders|positions)/i);
});

test('P34 profile history is newest-first and applies a bounded result limit', async () => {
  const calls = [];
  const rows = [{ id: '2', actor_handle: 'latest' }, { id: '1', actor_handle: 'older' }];
  const repository = createKolPerformanceRepository({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows };
    }
  });

  assert.deepEqual(await repository.listProfileRuns(500), rows);
  assert.match(calls[0].sql, /ORDER BY created_at DESC LIMIT \$1/);
  assert.deepEqual(calls[0].params, [100]);
});

test('P34 profile history API and frontend restore completed results after a page refresh', () => {
  const routes = fs.readFileSync(path.resolve(
    __dirname, '../domains/kol-performance/routes.js'
  ), 'utf8');
  const api = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/lib/api.ts'), 'utf8');
  const panel = fs.readFileSync(path.resolve(
    __dirname, '../../frontend/src/pages/kol/AccountResearchPanel.tsx'
  ), 'utf8');

  assert.match(routes, /get\('\/profile-runs'[\s\S]*?service\.listProfileRuns\(req\.query\.limit\)/);
  assert.match(api, /listProfileRuns:[\s\S]*?\/api\/kol-research\/profile-runs\?limit=/);
  assert.match(panel, /api\.kolResearch\.listProfileRuns\(\)/);
  assert.match(panel, /setSelectedProfileRunId[\s\S]*?next\[0\]\?\.id/);
  assert.match(panel, /api\.kolResearch\.getProfileRun\(selectedProfileRunId\)/);
  assert.match(panel, /profileRuns\.map/);
});

test('P34 progress is persisted locally and the frontend separates active work from terminal partial results', async () => {
  const calls = [];
  const repository = createKolPerformanceRepository({
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [{ metrics: { progress: JSON.parse(params[1]) } }] };
    }
  });
  await repository.updateRunProgress(12, {
    stage: 'pricing', current_asset_id: '3', current_asset_index: 2,
    current_contract_address: ADDRESS, total_assets: 3, processed_assets: 1
  });
  assert.match(calls[0].sql, /jsonb_set[\s\S]*?\{progress\}/);
  assert.match(calls[0].sql, /status IN \('pending', 'extracting', 'pricing'\)/);

  const panel = fs.readFileSync(path.resolve(
    __dirname, '../../frontend/src/pages/kol/AccountResearchPanel.tsx'
  ), 'utf8');
  const apiSource = fs.readFileSync(path.resolve(__dirname, '../../frontend/src/lib/api.ts'), 'utf8');
  assert.match(panel, /正在处理 CA/);
  assert.match(panel, /处理中 \$\{currentAssetIndex/);
  assert.match(panel, /阶段 1\/2/);
  assert.doesNotMatch(panel, /Math\.round\(progressPercent\)/);
  assert.match(panel, /progress\.current_asset_id/);
  assert.match(panel, /任务已结束，不会继续运行/);
  assert.match(panel, /已结束（部分结果）/);
  assert.match(panel, /完成于[\s\S]*?总耗时/);
  assert.ok(apiSource.includes("else if (/^\\/api\\/kol(?:[/?]|$)/.test(endpoint))"));
  assert.doesNotMatch(apiSource, /endpoint\.startsWith\('\/api\/kol'\)/);
});
