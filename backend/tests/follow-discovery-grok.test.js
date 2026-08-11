const assert = require('node:assert/strict');
const test = require('node:test');
const {
  candidateHasExplicitChainEvidence, parseJsonDocuments, researchFollowTarget, researchSchema
} = require('../domains/follow-discovery/grok-researcher');
const { DEFAULT_PROMPTS } = require('../domains/follow-discovery/prompt-service');

const ADDRESS = '0x0000000000000000000000000000000000000001';
process.env.XAI_API_KEY = process.env.XAI_API_KEY || 'xai-test-key';

function payload(overrides = {}) {
  return {
    output_text: JSON.stringify({
      status: 'found', target_type: 'project', project_name: 'New Project', project_handle: 'new_project',
      relationship: 'official project account', project_evidence_ids: ['profile_1'],
      candidate_contracts: [{
        address: ADDRESS, chain_id: 'bsc', confidence: 'high', primary_evidence_id: 'post_1',
        chain_evidence_id: 'post_1'
      }],
      evidence: [
        { evidence_id: 'profile_1', source_type: 'profile', url: 'https://x.com/new_project',
          tweet_id: '', handle: 'new_project', published_at: '', excerpt: 'New Project official account' },
        { evidence_id: 'post_1', source_type: 'x_post',
          url: 'https://x.com/new_project/status/1234567890123456789',
          tweet_id: '1234567890123456789', handle: 'new_project',
          published_at: '2026-08-05T11:00:00Z', excerpt: `Official CA ${ADDRESS} on BNB Chain` }
      ]
    }), citations: ['https://x.com/new_project/status/1234567890123456789'], usage: {
      total_tokens: 10, server_side_tool_usage_details: { x_search_calls: 1, web_search_calls: 0 }
    },
    ...overrides
  };
}

test('P21 Grok researcher uses official xAI search tools with a focused discovery prompt', async () => {
  let request;
  const result = await researchFollowTarget({
    target_handle: 'new_project', target_user_id: '20002',
    followed_at: '2026-08-05T12:00:00Z', allowed_chain_ids: ['bsc']
  }, {
    timeoutMs: 15000,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async json() { return payload(); } };
    }
  });
  assert.equal(new URL(request.url).origin, 'https://api.x.ai');
  assert.deepEqual(request.body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
  assert.equal(request.body.tool_choice, 'required');
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.text.format.strict, true);
  assert.deepEqual(request.body.text.format.schema, researchSchema());
  assert.equal(request.body.reasoning_effort, 'low');
  assert.match(request.body.input[0].content, /加密项目研究员/);
  assert.match(request.body.input[1].content, /请快速检索 X 账号/);
  assert.match(request.body.input[1].content, /完整 CA/);
  assert.doesNotMatch(request.body.input[0].content, /GMGN|third-party/i);
  assert.doesNotMatch(request.body.input[1].content, /GMGN|third-party/i);
  assert.equal(result.candidates[0].address, ADDRESS);
  assert.equal(result.candidates[0].owner_handle, 'new_project');
  assert.deepEqual(result.citations, ['https://x.com/new_project/status/1234567890123456789']);
});

test('Grok researcher uses the persisted prompt snapshot for both stages', async () => {
  let request;
  const promptConfig = {
    ...DEFAULT_PROMPTS,
    version: 7,
    prompt_version: 'follow-research-v1.7',
    fast_prompt: '请快速查找 @{{target_handle}} 的官方 CA 和所属区块链。',
    relationship_prompt: '请核对 @{{target_handle}} 与项目核心人员的关系及官方 CA。'
  };
  const result = await researchFollowTarget({ target_handle: 'new_project' }, {
    promptConfig,
    fetchImpl: async (url, options) => {
      request = { url, options, body: JSON.parse(options.body) };
      return { ok: true, status: 200, async json() { return payload(); } };
    }
  });
  assert.match(request.body.input[1].content, /请快速查找 @new_project/);
  assert.equal(result.prompt_version, 'follow-research-v1.7');
});

test('P21 Grok researcher does not run a second search merely to decide an EVM chain', async () => {
  let calls = 0;
  const result = await researchFollowTarget({
    target_handle: 'new_project', allowed_chain_ids: ['base', 'robinhood']
  }, {
    fetchImpl: async () => {
      calls += 1;
      const response = payload();
      const output = JSON.parse(response.output_text);
      output.candidate_contracts[0].chain_id = 'base';
      output.evidence[1].excerpt = `Official CA ${ADDRESS}`;
      response.output_text = JSON.stringify(output);
      return { ok: true, status: 200, async json() { return response; } };
    }
  });
  assert.equal(calls, 1);
  assert.equal(result.candidates[0].chain_id, 'base');
});

test('P21 chain evidence accepts the Robinhood Blockscout explorer for the same CA', () => {
  const candidate = {
    address: ADDRESS, chain_id: 'robinhood', chain_evidence_id: 'chain_1'
  };
  const evidence = [{
    evidence_id: 'chain_1',
    url: `https://robinhoodchain.blockscout.com/address/${ADDRESS}`,
    excerpt: `Contract ${ADDRESS}`
  }];
  assert.equal(candidateHasExplicitChainEvidence(candidate, evidence), true);
});

test('P21 Grok researcher refuses a non-official xAI endpoint', async () => {
  await assert.rejects(
    researchFollowTarget({ target_handle: 'new_project', allowed_chain_ids: ['bsc'] }, {
      responsesUrl: 'https://api.apikey.fun/v1/responses', fetchImpl: async () => ({ ok: true })
    }),
    (error) => error.code === 'XAI_SEARCH_OFFICIAL_ENDPOINT_REQUIRED'
  );
});

test('P21 Grok researcher retries a rate limit and keeps provider errors retryable', async () => {
  let calls = 0;
  const result = await researchFollowTarget({ target_handle: 'new_project', allowed_chain_ids: ['bsc'] }, {
    sleep: async () => {},
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' }, async json() { return {}; } };
      return { ok: true, status: 200, async json() { return payload(); } };
    }
  });
  assert.equal(calls, 2);
  assert.equal(result.candidates.length, 1);
});

test('P21 Grok researcher rejects a response that did not use a search tool', async () => {
  await assert.rejects(
    researchFollowTarget({ target_handle: 'new_project', allowed_chain_ids: ['bsc'] }, {
      sleep: async () => {},
      fetchImpl: async () => ({ ok: true, status: 200, async json() {
        return payload({ usage: { total_tokens: 10, server_side_tool_usage_details: {
          x_search_calls: 0, web_search_calls: 0
        } } });
      } })
    }),
    (error) => error.code === 'XAI_SEARCH_NO_TOOL_USE'
  );
});

test('P21 Grok researcher classifies search timeout as retryable', async () => {
  let calls = 0;
  await assert.rejects(
    researchFollowTarget({ target_handle: 'new_project', allowed_chain_ids: ['bsc'] }, {
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        const error = new Error('search timed out');
        error.name = 'TimeoutError';
        throw error;
      }
    }),
    (error) => error.code === 'XAI_SEARCH_TIMEOUT' && error.retryable === true
  );
  assert.equal(calls, 2);
});

test('P21 Grok researcher keeps the last valid JSON document from tool-call output', () => {
  const documents = parseJsonDocuments('{"status":"not_found"}\n{"status":"found","candidate_contracts":[]}');
  assert.equal(documents.length, 2);
  assert.equal(documents.at(-1).status, 'found');
});
