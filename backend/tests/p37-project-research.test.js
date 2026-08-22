const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const dbPath = require.resolve('../lib/db');
const originalDbModule = require.cache[dbPath];
const reports = new Map();
const checkpoints = new Map();

function clone(value) {
  return value == null ? value : structuredClone(value);
}

const fakeDb = {
  async query(sql, params = []) {
    const statement = String(sql).replace(/\s+/g, ' ').trim();
    if (statement === 'SELECT * FROM token_research_reports WHERE id = $1') {
      return { rows: reports.has(String(params[0])) ? [clone(reports.get(String(params[0])))] : [] };
    }
    if (statement.startsWith('INSERT INTO token_research_xai_checkpoints')) {
      const id = String(params[0]);
      const existing = checkpoints.get(id);
      const checkpoint = existing && existing.prompt_version === params[1]
        ? { ...existing, expires_at: params[2] }
        : {
          report_id: id,
          prompt_version: params[1],
          search_status: 'pending',
          evidence_text: null,
          citations: [],
          search_usage: null,
          search_tool_calls: 0,
          grok_request_attempts: 0,
          second_request_reason: null,
          last_error_code: null,
          expires_at: params[2]
        };
      checkpoints.set(id, checkpoint);
      return { rows: [clone(checkpoint)] };
    }
    if (statement === 'SELECT * FROM token_research_xai_checkpoints WHERE report_id = $1') {
      const checkpoint = checkpoints.get(String(params[0]));
      return { rows: checkpoint ? [clone(checkpoint)] : [] };
    }
    if (statement.startsWith('UPDATE token_research_xai_checkpoints SET grok_request_attempts')) {
      const id = String(params[0]);
      const checkpoint = checkpoints.get(id);
      if (!checkpoint || checkpoint.grok_request_attempts >= 2
          || (checkpoint.grok_request_attempts === 1 && !params[2])) return { rows: [] };
      const updated = {
        ...checkpoint,
        grok_request_attempts: checkpoint.grok_request_attempts + 1,
        search_status: params[1],
        second_request_reason: checkpoint.grok_request_attempts === 1
          ? params[2]
          : checkpoint.second_request_reason,
        last_error_code: null
      };
      checkpoints.set(id, updated);
      return { rows: [clone(updated)] };
    }
    if (statement.startsWith('UPDATE token_research_xai_checkpoints SET search_status')) {
      const id = String(params[0]);
      const checkpoint = checkpoints.get(id);
      const updated = {
        ...checkpoint,
        search_status: params[1],
        evidence_text: params[2] ?? checkpoint.evidence_text,
        citations: JSON.parse(params[3]),
        search_usage: params[4] ? JSON.parse(params[4]) : null,
        search_tool_calls: Math.min(params[5], checkpoint.search_tool_calls + params[6]),
        last_error_code: params[7]
      };
      checkpoints.set(id, updated);
      return { rows: [clone(updated)] };
    }
    if (statement.startsWith('UPDATE token_research_reports SET analysis_started_at')) {
      const id = String(params[0]);
      reports.set(id, { ...reports.get(id), prompt_version: params[1], xai_error_code: null });
      return { rows: [] };
    }
    if (statement.startsWith('UPDATE token_research_reports SET candidates')) {
      const id = String(params[6]);
      const report = reports.get(id);
      const updated = {
        ...report,
        candidates: JSON.parse(params[0]),
        provider_snapshot: { ...report.provider_snapshot, ...params[1] },
        analyzer_version: params[2],
        prompt_version: params[3],
        model_name: params[4],
        xai_duration_ms: params[5],
        xai_error_code: null,
        analysis_finished_at: new Date().toISOString()
      };
      reports.set(id, updated);
      return { rows: [clone(updated)] };
    }
    if (statement.startsWith('UPDATE token_research_reports SET provider_snapshot')) {
      return { rows: [] };
    }
    if (statement.startsWith('INSERT INTO x_actor_directory')) return { rows: [] };
    throw new Error(`Unexpected P37 test query: ${statement}`);
  },
  pool: { connect: async () => { throw new Error('Unexpected transaction'); } }
};

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: fakeDb,
  children: [],
  paths: []
};

const {
  parseStructuredOutput,
  runFirstResearch,
  runFormatRepair,
  runTargetedFollowup,
  structuredResultFromOutput
} = require('../domains/research/xai-client');
const { withSocialResolution } = require('../domains/research/checkpoint-repository');
const { expandReport } = require('../domains/research/service');

function report(id, officialHandle = null) {
  return {
    id: String(id),
    chain_id: 'base',
    contract_address: `0x${String(id).padStart(40, '0')}`,
    status: 'completed',
    provider_snapshot: {
      metadata: {
        chain: 'base',
        address: `0x${String(id).padStart(40, '0')}`,
        name: `P37 ${id}`,
        symbol: `P${id}`,
        official_x_handle: officialHandle,
        website_url: null,
        source: 'gmgn'
      }
    },
    candidates: officialHandle ? [{
      handle: officialHandle,
      display_name: '',
      role: 'official_project',
      organization: '',
      association: '',
      confidence: 'high',
      verified: false,
      source: 'gmgn',
      evidence: [{ label: 'GMGN token metadata official X', source: 'gmgn' }]
    }] : [],
    analyzer_version: 'p37-v1',
    prompt_version: 'p37-project-identity-v1',
    xai_error_code: null,
    analysis_finished_at: null,
    expires_at: new Date(Date.now() + 3600000).toISOString()
  };
}

function response(output, searchCalls = 1) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        output_text: output,
        usage: {
          total_tokens: 100,
          server_side_tool_usage_details: { x_search_calls: searchCalls, web_search_calls: 0 }
        }
      };
    }
  };
}

function structuredOutput(values = {}) {
  return JSON.stringify({
    status: values.status || 'insufficient',
    summary: values.summary || 'ok',
    candidates: values.candidates || [],
    evidence: values.evidence || []
  });
}

test('P37 deterministic parser accepts one JSON fence and rejects prose or multiple objects', () => {
  assert.deepEqual(parseStructuredOutput(`\`\`\`json\n${structuredOutput()}\n\`\`\``), {
    status: 'insufficient', summary: 'ok', candidates: [], evidence: []
  });
  assert.throws(() => parseStructuredOutput(`Result: ${structuredOutput()}`), {
    code: 'XAI_STRUCTURE_JSON_INVALID'
  });
  assert.throws(() => parseStructuredOutput(`${structuredOutput({ summary: 'a' })}\n${structuredOutput({ summary: 'b' })}`), {
    code: 'XAI_STRUCTURE_JSON_INVALID'
  });
  assert.throws(() => parseStructuredOutput('{"summary":"cut"'), {
    code: 'XAI_STRUCTURE_JSON_INVALID'
  });
  assert.throws(() => structuredResultFromOutput(structuredOutput({
    status: 'resolved',
    candidates: [{
      handle: 'missing_evidence', role: 'official_project', organization: '', association: 'exact CA',
      confidence: 'high', evidence_ids: ['missing']
    }]
  })), { code: 'XAI_STRUCTURE_SCHEMA_INVALID' });
});

test('P37 client uses one bounded HTTP request per phase and format repair has no tools', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'p37-test-key';
  const bodies = [];
  const fetchImpl = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return response(structuredOutput(), bodies.length === 2 ? 0 : 1);
  };
  try {
    await runFirstResearch({ chain: 'base', address: '0x1' }, { fetchImpl });
    await runFormatRepair({ chain: 'base', address: '0x1' }, {
      fetchImpl,
      evidenceText: '{broken}',
      citations: []
    });
    await runTargetedFollowup({ chain: 'base', address: '0x1' }, { fetchImpl });
    assert.equal(bodies.length, 3);
    assert.equal(bodies[0].max_tool_calls, 4);
    assert.equal(bodies[0].max_turns, 4);
    assert.equal(bodies[0].max_output_tokens, 6000);
    assert.equal('tools' in bodies[1], false);
    assert.equal('tool_choice' in bodies[1], false);
    assert.equal(bodies[1].max_output_tokens, 4000);
    assert.equal(bodies[2].max_tool_calls, 4);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('P37 client does not hide an extra HTTP retry behind a 429 response', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'p37-test-key';
  let requests = 0;
  let reservations = 0;
  try {
    await assert.rejects(() => runFirstResearch({ chain: 'base', address: '0x1' }, {
      beforeRequest: async () => { reservations += 1; },
      fetchImpl: async () => {
        requests += 1;
        return {
          ok: false,
          status: 429,
          headers: { get: () => '2' },
          json: async () => ({ error: { message: 'rate limited' } })
        };
      }
    }), { code: 'XAI_RATE_LIMITED', retryAfterMs: 2000 });
    assert.equal(requests, 1);
    assert.equal(reservations, 1);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('P37 first success short-circuits and conditional second request chooses one branch', async () => {
  const previousKey = process.env.XAI_API_KEY;
  const previous6551 = process.env.OPENNEWS_TOKEN;
  process.env.XAI_API_KEY = 'p37-test-key';
  delete process.env.OPENNEWS_TOKEN;
  try {
    reports.set('1', report('1', 'known_official'));
    let calls = 0;
    const first = await expandReport('1', {
      xaiOptions: { fetchImpl: async () => { calls += 1; return response(structuredOutput({ summary: 'known' })); } }
    });
    assert.equal(calls, 1);
    assert.equal(first.social_resolution.grok_request_attempts, 1);
    assert.equal(first.social_resolution.status, 'gmgn_confirmed');
    assert.equal('requests' in (first.provider_snapshot.xai.usage || {}), false);

    reports.set('2', report('2', 'known_second'));
    const formatBodies = [];
    const repaired = await expandReport('2', {
      xaiOptions: {
        fetchImpl: async (_url, options) => {
          formatBodies.push(JSON.parse(options.body));
          return formatBodies.length === 1
            ? response('not-json')
            : response(structuredOutput({ summary: 'repaired' }), 0);
        }
      }
    });
    assert.equal(formatBodies.length, 2);
    assert.equal('tools' in formatBodies[1], false);
    assert.equal(repaired.social_resolution.second_request_reason, 'format_repair');

    reports.set('3', report('3'));
    const followupBodies = [];
    const official = {
      handle: 'p37_official', role: 'official_project', organization: 'P37',
      association: 'Official account linked to the exact contract', confidence: 'high',
      evidence_ids: ['official-post']
    };
    const officialEvidence = [{
      evidence_id: 'official-post',
      source_type: 'x_post',
      url: 'https://x.com/p37_official/status/1',
      tweet_id: '1',
      excerpt: 'Official contract post'
    }];
    const followed = await expandReport('3', {
      xaiOptions: {
        fetchImpl: async (_url, options) => {
          followupBodies.push(JSON.parse(options.body));
          return followupBodies.length === 1
            ? response(structuredOutput({ summary: 'missing' }))
            : response(structuredOutput({
              status: 'resolved', summary: 'found', candidates: [official], evidence: officialEvidence
            }));
        }
      }
    });
    assert.equal(followupBodies.length, 2);
    assert.deepEqual(followupBodies[1].tools, [{ type: 'x_search' }, { type: 'web_search' }]);
    assert.equal(followed.social_resolution.second_request_reason, 'targeted_followup');
    assert.equal(followed.social_resolution.grok_request_attempts, 2);
    assert.equal(followed.candidates[0].handle, 'p37_official');

    reports.set('4', report('4'));
    let failedCalls = 0;
    await assert.rejects(() => expandReport('4', {
      xaiOptions: {
        fetchImpl: async () => {
          failedCalls += 1;
          return response('not-json');
        }
      }
    }), { code: 'XAI_STRUCTURE_REPAIR_FAILED' });
    assert.equal(failedCalls, 2);
    await assert.rejects(() => expandReport('4', {
      xaiOptions: {
        fetchImpl: async () => {
          failedCalls += 1;
          return response(structuredOutput());
        }
      }
    }), { code: 'XAI_GROK_REQUEST_BUDGET_EXHAUSTED' });
    assert.equal(failedCalls, 2);

    reports.set('5', report('5'));
    checkpoints.set('5', {
      report_id: '5',
      prompt_version: 'p37-project-identity-v1',
      search_status: 'searching',
      evidence_text: null,
      citations: [],
      search_usage: null,
      search_tool_calls: 0,
      grok_request_attempts: 1,
      second_request_reason: null,
      last_error_code: null,
      expires_at: reports.get('5').expires_at,
      updated_at: new Date().toISOString()
    });
    let concurrentCalls = 0;
    await assert.rejects(() => expandReport('5', {
      xaiOptions: { fetchImpl: async () => { concurrentCalls += 1; return response(structuredOutput()); } }
    }), { code: 'XAI_GROK_REQUEST_IN_PROGRESS' });
    assert.equal(concurrentCalls, 0);
    assert.equal(checkpoints.get('5').grok_request_attempts, 1);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
    if (previous6551 === undefined) delete process.env.OPENNEWS_TOKEN;
    else process.env.OPENNEWS_TOKEN = previous6551;
  }
});

test('P37 public social-resolution DTO excludes private evidence and usage', () => {
  const publicReport = withSocialResolution(report('8'), {
    report_id: '8',
    search_status: 'failed',
    evidence_text: 'private raw provider output',
    citations: ['https://example.com/private-checkpoint'],
    search_usage: { requests: [{ usage: { total_tokens: 99 } }] },
    search_tool_calls: 4,
    grok_request_attempts: 2,
    second_request_reason: 'targeted_followup',
    last_error_code: 'XAI_SEARCH_TIMEOUT'
  });
  assert.equal(publicReport.social_resolution.grok_request_attempts, 2);
  assert.equal(publicReport.social_resolution.gmgn_status, 'missing');
  assert.equal(publicReport.social_resolution.status, 'provider_failed');
  assert.equal('gmgn_source_status' in publicReport.social_resolution, false);
  assert.equal('official_x_handle' in publicReport.social_resolution, false);
  assert.equal('evidence_text' in publicReport.social_resolution, false);
  assert.equal('search_usage' in publicReport.social_resolution, false);
  assert.doesNotMatch(JSON.stringify(publicReport.social_resolution), /private raw provider output/);
});

test('P37 migration and UI contracts stay isolated from trading domains', () => {
  const migration = fs.readFileSync(
    path.join(root, 'backend/db/migrations/054_p37_project_research_xai_checkpoints.sql'),
    'utf8'
  );
  const repository = fs.readFileSync(
    path.join(root, 'backend/domains/research/checkpoint-repository.js'),
    'utf8'
  );
  const workspace = fs.readFileSync(
    path.join(root, 'frontend/src/pages/whitelist/ResearchWorkspace.tsx'),
    'utf8'
  );
  const routes = fs.readFileSync(path.join(root, 'backend/domains/research/routes.js'), 'utf8');
  assert.match(migration, /grok_request_attempts BETWEEN 0 AND 2/i);
  assert.match(migration, /search_tool_calls BETWEEN 0 AND 8/i);
  assert.match(migration, /format_repair','targeted_followup/i);
  assert.doesNotMatch(migration, /trade_signals|trade_orders|positions|trade_attempts/i);
  assert.match(repository, /grok_request_attempts < \$4/);
  assert.match(routes, /retry-social-resolution/);
  assert.match(workspace, /每个 CA 首次成功即停止/);
  assert.match(workspace, /Grok 请求/);
  assert.doesNotMatch(workspace, /evidence_text|search_usage/);
});

test.after(() => {
  if (originalDbModule) require.cache[dbPath] = originalDbModule;
  else delete require.cache[dbPath];
});
