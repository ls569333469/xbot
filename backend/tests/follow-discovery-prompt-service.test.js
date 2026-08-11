const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DEFAULT_PROMPTS,
  MAX_PROMPT_LENGTH,
  PROMPT_SERIES,
  createPromptService,
  normalizeStoredConfig,
  renderPrompt,
  validateDraft
} = require('../domains/follow-discovery/prompt-service');

function fakeDatabase() {
  let row = null;
  const audits = [];
  const client = {
    async query(sql, params = []) {
      if (/^BEGIN|^COMMIT|^ROLLBACK/.test(sql.trim())) return { rows: [] };
      if (sql.includes('SELECT value_json FROM config')) return { rows: row ? [row] : [] };
      if (sql.includes('INSERT INTO config')) {
        row = { value_json: JSON.parse(params[1]), updated_at: '2026-08-10T00:00:00.000Z' };
        return { rows: [row] };
      }
      if (sql.includes('INSERT INTO system_logs')) {
        audits.push({ message: params[0], meta: params[1] });
        return { rows: [] };
      }
      throw new Error(`Unexpected fake query: ${sql}`);
    },
    release() {}
  };
  return {
    audits,
    pool: { async connect() { return client; } },
    async query(sql) {
      if (sql.includes('SELECT value_json, updated_at FROM config')) return { rows: row ? [row] : [] };
      throw new Error(`Unexpected fake query: ${sql}`);
    }
  };
}

test('follow discovery prompt defaults stay natural-language and provider-agnostic', () => {
  assert.match(DEFAULT_PROMPTS.fast_prompt, /@\{\{target_handle\}\}/);
  assert.match(DEFAULT_PROMPTS.relationship_prompt, /创始人/);
  assert.doesNotMatch(`${DEFAULT_PROMPTS.fast_prompt}\n${DEFAULT_PROMPTS.relationship_prompt}`, /GMGN|交易执行|本地程序/i);
  assert.equal(PROMPT_SERIES, 'follow-research-v1');
});

test('follow discovery prompt rendering binds the exact target account', () => {
  const rendered = renderPrompt('请检索 @{{target_handle}} 的官方 CA。', '@ExampleAccount');
  assert.equal(rendered, '请检索 @ExampleAccount 的官方 CA。');
  assert.throws(() => renderPrompt('请检索项目。', ''), { code: 'FOLLOW_PROMPT_INVALID' });
});

test('follow discovery prompt drafts are bounded and normalized', () => {
  const draft = validateDraft({
    fast_prompt: '  请检索 @{{target_handle}} 的 CA。\r\n',
    relationship_prompt: '请核对项目与创始人的关系。'
  });
  assert.equal(draft.fast_prompt, '请检索 @{{target_handle}} 的 CA。');
  assert.throws(() => validateDraft({ fast_prompt: 'too short', relationship_prompt: DEFAULT_PROMPTS.relationship_prompt }), {
    code: 'FOLLOW_PROMPT_INVALID'
  });
  assert.throws(() => validateDraft({
    fast_prompt: 'x'.repeat(MAX_PROMPT_LENGTH + 1),
    relationship_prompt: DEFAULT_PROMPTS.relationship_prompt
  }), { code: 'FOLLOW_PROMPT_INVALID' });
});

test('invalid stored prompt records fall back to safe defaults', () => {
  assert.deepEqual(normalizeStoredConfig({ fast_prompt: '' }), DEFAULT_PROMPTS);
});

test('prompt updates are versioned, audited, and protected from stale writes', async () => {
  const database = fakeDatabase();
  const service = createPromptService(database, { cacheTtlMs: 0 });
  const initial = await service.getCurrent({ forceRefresh: true });
  const saved = await service.update({
    version: initial.version,
    fast_prompt: '请快速检索 @{{target_handle}} 的完整 CA 和链。',
    relationship_prompt: DEFAULT_PROMPTS.relationship_prompt
  }, { operator: 'test-user' });
  assert.equal(saved.version, initial.version + 1);
  assert.equal(database.audits[0].message, 'PROMPTS_UPDATED');
  assert.equal(database.audits[0].meta.operator, 'test-user');
  await assert.rejects(
    service.update({
      version: initial.version,
      fast_prompt: saved.fast_prompt,
      relationship_prompt: saved.relationship_prompt
    }),
    { code: 'FOLLOW_PROMPT_VERSION_CONFLICT' }
  );
  const reset = await service.reset({ version: saved.version });
  assert.equal(reset.version, saved.version + 1);
  assert.equal(reset.fast_prompt, DEFAULT_PROMPTS.fast_prompt);
  assert.equal(database.audits.at(-1).message, 'PROMPTS_RESET_TO_DEFAULT');
});
