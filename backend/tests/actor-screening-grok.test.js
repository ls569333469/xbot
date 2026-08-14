const assert = require('node:assert/strict');
const test = require('node:test');
const {
  ACTOR_GROK_PROMPT_VERSION,
  analyzeActor,
  requestBody
} = require('../domains/actor-screening/grok-analysis');

const SAMPLES = [{
  id: '123',
  created_at: '2026-08-01T00:00:00.000Z',
  intent: 'full_ca_solo',
  text: 'CA 3arUrpH3nzaRJbbpVgY42dcqSq9A5BFgUxKozZ4npump'
}];

test('actor Grok prompt is natural account research and excludes execution providers', () => {
  const body = requestBody({ handle: 'example', samples: SAMPLES });
  const prompt = JSON.stringify(body.input);
  assert.match(prompt, /研究 X 账号 @example/);
  assert.match(prompt, /X 搜索/);
  assert.doesNotMatch(prompt, /GMGN|Swap|Quote/i);
  assert.deepEqual(body.tools, [{ type: 'x_search' }]);
  assert.equal(body.tool_choice, 'auto');
});

test('actor Grok analysis audits optional search use and retains only supplied tweet evidence', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  try {
    const output = {
      status: 'analyzed',
      account_type: 'researcher',
      summary: 'Evidence-backed account summary',
      style_tags: ['long-form'],
      strengths: ['Explains a thesis'],
      risks: ['Sometimes reviews past moves'],
      qualitative_rating: 'watch',
      evidence: [
        { tweet_id: '123', assessment: 'Contains a complete CA' },
        { tweet_id: 'not-supplied', assessment: 'Must be discarded' }
      ]
    };
    const result = await analyzeActor({ handle: 'example', samples: SAMPLES }, {
      responsesUrl: 'https://api.x.ai/v1/responses',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify(output),
          citations: ['https://x.com/example/status/123'],
          usage: {
            total_tokens: 120,
            server_side_tool_usage_details: { x_search_calls: 1 }
          }
        })
      })
    });

    assert.equal(result.summary, output.summary);
    assert.equal(result.prompt_version, ACTOR_GROK_PROMPT_VERSION);
    assert.deepEqual(result.evidence, [{
      tweet_id: '123', assessment: 'Contains a complete CA'
    }]);
    assert.equal(result.usage.server_side_tool_usage_details.x_search_calls, 1);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});

test('actor Grok keeps a valid analysis when the model does not call x_search', async () => {
  const previousKey = process.env.XAI_API_KEY;
  process.env.XAI_API_KEY = 'xai-test';
  try {
    const result = await analyzeActor({ handle: 'example', samples: SAMPLES }, {
      responsesUrl: 'https://api.x.ai/v1/responses',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          output_text: JSON.stringify({
            status: 'analyzed',
            account_type: 'researcher',
            summary: 'The supplied 6551 samples are sufficient for a qualitative summary.',
            style_tags: ['calls'],
            strengths: ['Uses complete contract addresses'],
            risks: [],
            qualitative_rating: 'watch',
            evidence: [{ tweet_id: '123', assessment: 'Contains a complete CA' }]
          }),
          usage: { total_tokens: 80 }
        })
      })
    });

    assert.equal(result.status, 'analyzed');
    assert.equal(result.x_search_calls, 0);
    assert.match(result.summary, /6551/);
  } finally {
    if (previousKey === undefined) delete process.env.XAI_API_KEY;
    else process.env.XAI_API_KEY = previousKey;
  }
});
