const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULT_PROMPTS } = require('../domains/follow-discovery/prompt-service');
const {
  ACCOUNT_GROK_PROMPT_SERIES,
  OFFICIAL_XAI_ORIGIN,
  requestBody,
  researchAccount
} = require('../domains/account-research/grok-research');

const LEGACY_SAMPLE = {
  id: '123',
  text: 'legacy sample CA 3arUrpH3nzaRJbbpVgY42dcqSq9A5BFgUxKozZ4npump'
};

function structuredFixture() {
  return {
    status: 'analyzed',
    account_type: 'researcher',
    summary: 'Evidence-backed account summary',
    project_name: 'Example Project',
    project_handle: 'exampleproject',
    relationship: 'The account publishes research for the project.',
    candidate_contracts: [
      {
        address: '3arUrpH3nzaRJbbpVgY42dcqSq9A5BFgUxKozZ4npump',
        chain_id: 'sol',
        confidence: 'high',
        primary_evidence_id: 'ev-1'
      },
      {
        address: '0x1111111111111111111111111111111111111111',
        chain_id: 'base',
        confidence: 'medium',
        primary_evidence_id: 'ev-2'
      }
    ],
    evidence: [
      {
        evidence_id: 'ev-1',
        source_type: 'tweet',
        url: 'https://x.com/example/status/1',
        tweet_id: '1',
        handle: 'example',
        published_at: '2026-08-01T00:00:00.000Z',
        excerpt: 'Solana contract evidence'
      },
      {
        evidence_id: 'ev-2',
        source_type: 'website',
        url: 'https://example.com/token',
        tweet_id: '',
        handle: 'exampleproject',
        published_at: '2026-08-02T00:00:00.000Z',
        excerpt: 'Base contract evidence'
      }
    ],
    style_tags: ['long-form', 'on-chain'],
    strengths: ['Cites original sources'],
    risks: ['May discuss several projects'],
    qualitative_rating: 'watch'
  };
}

test('KOL Grok prompt directly searches the account without 6551 samples or execution providers', () => {
  const body = requestBody({ handle: 'example', samples: [LEGACY_SAMPLE] });
  const prompt = JSON.stringify(body.input);
  assert.match(prompt, /研究 X 账号 @example/);
  assert.doesNotMatch(prompt, /legacy sample|3arUrpH3nzaRJbbpVgY42dcqSq9A5BFgUxKozZ4npump/);
  assert.doesNotMatch(prompt, /GMGN|Swap|Quote|Order|本地程序|交易执行/i);
  assert.match(prompt, /至少调用一次 x_search 或 web_search/);
  assert.deepEqual(body.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
  assert.equal(body.tool_choice, 'required');
  assert.equal(body.text.format.type, 'json_schema');
});

test('KOL Grok research uses the official endpoint and returns multiple evidence-backed CAs', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  let requestedUrl = '';
  let requestedBody = null;
  try {
    const result = await researchAccount({ handle: 'example', samples: [LEGACY_SAMPLE] }, {
      promptConfig: { ...DEFAULT_PROMPTS, version: 9, kol_research_version: 4 },
      fetchImpl: async (url, options) => {
        requestedUrl = url;
        requestedBody = JSON.parse(options.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output_text: JSON.stringify(structuredFixture()),
            citations: [
              'https://x.com/example/status/1',
              'http://127.0.0.1/private'
            ],
            usage: {
              total_tokens: 120,
              server_side_tool_usage_details: { x_search_calls: 1, web_search_calls: 1 }
            }
          })
        };
      }
    });

    assert.equal(new URL(requestedUrl).origin, OFFICIAL_XAI_ORIGIN);
    assert.deepEqual(requestedBody.tools, [{ type: 'x_search' }, { type: 'web_search' }]);
    assert.doesNotMatch(JSON.stringify(requestedBody), /legacy sample/);
    assert.equal(result.candidates.length, 2);
    assert.equal(result.evidence.length, 2);
    assert.deepEqual(result.citations, ['https://x.com/example/status/1']);
    assert.equal(result.search_tool_calls, 2);
    assert.equal(result.prompt_version, `${ACCOUNT_GROK_PROMPT_SERIES}.4`);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('KOL Grok rejects a successful response that did not use a search tool', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  let attempts = 0;
  try {
    await assert.rejects(
      researchAccount({ handle: 'example' }, {
        sleep: async () => {},
        fetchImpl: async () => {
          attempts += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({ output_text: JSON.stringify(structuredFixture()), usage: {} })
          };
        }
      }),
      (error) => error.code === 'XAI_SEARCH_NO_TOOL_USE'
    );
    assert.equal(attempts, 2);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('KOL Grok falls back to search first and then structures the evidence', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  let attempts = 0;
  const bodies = [];
  try {
    const result = await researchAccount({ handle: 'example' }, {
      sleep: async () => {},
      fetchImpl: async (_url, options) => {
        attempts += 1;
        bodies.push(JSON.parse(options.body));
        const text = attempts === 2
          ? 'Evidence report with source URLs'
          : JSON.stringify(structuredFixture());
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output: [{
              type: 'message',
              content: [{ type: 'output_text', text }]
            }],
            usage: attempts === 2 ? {
              server_side_tool_usage_details: { x_search_calls: 1 }
            } : {}
          })
        };
      }
    });
    assert.equal(attempts, 3);
    assert.equal(bodies[1].text, undefined);
    assert.deepEqual(bodies[1].tools, [{ type: 'x_search' }, { type: 'web_search' }]);
    assert.equal(bodies[2].tools, undefined);
    assert.equal(bodies[2].text.format.type, 'json_schema');
    assert.equal(result.search_tool_calls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('KOL Grok accepts official search call records from Responses output items', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  let attempts = 0;
  try {
    const result = await researchAccount({ handle: 'example' }, {
      fetchImpl: async () => {
        attempts += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output_text: JSON.stringify(structuredFixture()),
            output: [
              { type: 'custom_tool_call', name: 'x_search' },
              { type: 'web_search_call' }
            ],
            usage: {}
          })
        };
      }
    });
    assert.equal(attempts, 1);
    assert.equal(result.search_tool_calls, 2);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('KOL Grok refuses a non-official production endpoint before issuing the request', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  try {
    await assert.rejects(
      researchAccount({ handle: 'example' }, {
        responsesUrl: 'https://proxy.example.com/v1/responses',
        fetchImpl: async () => assert.fail('request must not be issued')
      }),
      (error) => error.code === 'XAI_SEARCH_OFFICIAL_ENDPOINT_REQUIRED'
    );
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('KOL Grok retries one 429 and preserves bounded provider behavior', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  let calls = 0;
  try {
    const result = await researchAccount({ handle: 'example' }, {
      sleep: async () => {},
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            ok: false,
            status: 429,
            headers: { get: () => '1' },
            json: async () => ({ error: { message: 'rate limited' } })
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            output_text: JSON.stringify(structuredFixture()),
            usage: { server_side_tool_usage_details: { x_search_calls: 1 } }
          })
        };
      }
    });
    assert.equal(calls, 2);
    assert.equal(result.status, 'analyzed');
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});
