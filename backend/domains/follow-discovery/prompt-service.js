const crypto = require('crypto');
const db = require('../../lib/db');

const CONFIG_KEY = 'follow_discovery_prompts';
const PROMPT_SERIES = 'follow-research-v1';
const MAX_PROMPT_LENGTH = 4000;
const CACHE_TTL_MS = 1000;

const DEFAULT_PROMPTS = Object.freeze({
  version: 1,
  fast_prompt: [
    '请快速检索 X 账号 @{{target_handle}} 的项目关联信息，找出最可信的完整 CA、所属区块链、代币名称和官方来源。',
    '',
    '优先查看该账号的 Bio、置顶、原创内容和官网。如果它是创始人、CEO 或核心成员，请追溯关联的官方项目账号，再从官方来源确认 CA。如果发现多个 CA，请列出来源并区分主次；证据不足时不要猜测。'
  ].join('\n'),
  relationship_prompt: [
    '请进一步检索 X 账号 @{{target_handle}} 与项目官方账号、创始人、CEO 或核心团队的关系，并找出对应项目的完整 CA、所属区块链和官方来源。',
    '',
    '重点查看 Bio、置顶、原创、转发、回复、关联账号和官网。只保留公开内容能够支持的关系和 CA；多个候选分别列出来源，证据不足时不要猜测。'
  ].join('\n')
});

function promptError(message, code = 'FOLLOW_PROMPT_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizePrompt(value, field) {
  if (typeof value !== 'string') throw promptError(`${field} must be a string`);
  const normalized = value.replace(/\r\n/g, '\n').trim();
  if (normalized.length < 12) throw promptError(`${field} is too short`);
  if (normalized.length > MAX_PROMPT_LENGTH) {
    throw promptError(`${field} cannot exceed ${MAX_PROMPT_LENGTH} characters`);
  }
  return normalized;
}

function normalizeVersion(value, fallback = 1) {
  const version = Number(value);
  return Number.isInteger(version) && version > 0 ? version : fallback;
}

function normalizeStoredConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PROMPTS };
  try {
    return {
      version: normalizeVersion(value.version),
      fast_prompt: normalizePrompt(value.fast_prompt, 'fast_prompt'),
      relationship_prompt: normalizePrompt(value.relationship_prompt, 'relationship_prompt')
    };
  } catch {
    return { ...DEFAULT_PROMPTS };
  }
}

function validateDraft(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw promptError('Prompt configuration must be an object');
  }
  return {
    fast_prompt: normalizePrompt(value.fast_prompt, 'fast_prompt'),
    relationship_prompt: normalizePrompt(value.relationship_prompt, 'relationship_prompt')
  };
}

function renderPrompt(template, targetHandle) {
  const handle = String(targetHandle || '').trim().replace(/^@+/, '');
  if (!handle) throw promptError('target_handle is required');
  const marker = '{{target_handle}}';
  const rendered = String(template || '').split(marker).join(handle);
  return rendered.includes(`@${handle}`)
    ? rendered
    : `${rendered}\n\n目标账号：@${handle}`;
}

function contentHash(config) {
  return crypto.createHash('sha256')
    .update(`${config.fast_prompt}\n---\n${config.relationship_prompt}`)
    .digest('hex');
}

function publicConfig(config, metadata = {}) {
  return {
    version: normalizeVersion(config.version),
    fast_prompt: config.fast_prompt,
    relationship_prompt: config.relationship_prompt,
    source: metadata.source || 'stored',
    updated_at: metadata.updated_at || null,
    prompt_version: `${PROMPT_SERIES}.${normalizeVersion(config.version)}`
  };
}

function createPromptService(database = db, options = {}) {
  const cacheTtlMs = Math.max(0, Number(options.cacheTtlMs ?? CACHE_TTL_MS));
  let cache = null;
  let cacheExpiresAt = 0;

  async function getCurrent(getOptions = {}) {
    if (!getOptions.forceRefresh && cache && cacheExpiresAt > Date.now()) return cache;
    try {
      const result = await database.query(
        'SELECT value_json, updated_at FROM config WHERE key = $1',
        [CONFIG_KEY]
      );
      const row = result.rows[0];
      const config = row
        ? publicConfig(normalizeStoredConfig(row.value_json), { source: 'stored', updated_at: row.updated_at })
        : publicConfig({ ...DEFAULT_PROMPTS }, { source: 'default' });
      cache = config;
      cacheExpiresAt = Date.now() + cacheTtlMs;
      return config;
    } catch (error) {
      if (cache) return cache;
      return publicConfig({ ...DEFAULT_PROMPTS }, { source: 'default' });
    }
  }

  async function write(nextDraft, writeOptions = {}) {
    const draft = validateDraft(nextDraft);
    const expectedVersion = normalizeVersion(writeOptions.expectedVersion, 0);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      const currentResult = await client.query(
        'SELECT value_json FROM config WHERE key = $1 FOR UPDATE',
        [CONFIG_KEY]
      );
      const current = currentResult.rows[0]
        ? normalizeStoredConfig(currentResult.rows[0].value_json)
        : { ...DEFAULT_PROMPTS };
      if (expectedVersion > 0 && expectedVersion !== current.version) {
        throw promptError(
          'Prompt configuration changed since it was loaded',
          'FOLLOW_PROMPT_VERSION_CONFLICT'
        );
      }
      const next = { version: current.version + 1, ...draft };
      const saved = await client.query(
        `INSERT INTO config (key, value_json) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()
         RETURNING value_json, updated_at`,
        [CONFIG_KEY, JSON.stringify(next)]
      );
      await client.query(
        `INSERT INTO system_logs(level, module, message, meta)
         VALUES ('audit', 'follow-discovery-prompts', $1, $2)`,
        [writeOptions.action || 'PROMPTS_UPDATED', {
          operator: String(writeOptions.operator || 'admin').slice(0, 128),
          previous_version: current.version,
          next_version: next.version,
          content_hash: contentHash(next)
        }]
      );
      await client.query('COMMIT');
      cache = publicConfig(normalizeStoredConfig(saved.rows[0].value_json), {
        source: 'stored', updated_at: saved.rows[0].updated_at
      });
      cacheExpiresAt = Date.now() + cacheTtlMs;
      return cache;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function update(value, options = {}) {
    return write(value, {
      expectedVersion: value?.version,
      operator: options.operator,
      action: 'PROMPTS_UPDATED'
    });
  }

  async function reset(value = {}, options = {}) {
    return write(DEFAULT_PROMPTS, {
      expectedVersion: value?.version,
      operator: options.operator,
      action: 'PROMPTS_RESET_TO_DEFAULT'
    });
  }

  return { getCurrent, reset, update };
}

const promptService = createPromptService();

module.exports = {
  CONFIG_KEY,
  DEFAULT_PROMPTS,
  MAX_PROMPT_LENGTH,
  PROMPT_SERIES,
  createPromptService,
  normalizeStoredConfig,
  promptService,
  renderPrompt,
  validateDraft
};
