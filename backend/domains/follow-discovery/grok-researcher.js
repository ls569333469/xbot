const {
  classifyXaiError,
  extractOutputText,
  resolveResponsesUrl,
  retryAfterMs,
  sanitizeUsage
} = require('../research/xai-client');
const { safeHandle, safeText, safeUrl } = require('../research/sanitizers');
const { DEFAULT_PROMPTS, PROMPT_SERIES, promptService, renderPrompt } = require('./prompt-service');

const FOLLOW_XAI_PROMPT_VERSION = PROMPT_SERIES;
const FOLLOW_XAI_MODEL = 'grok-4.5';
const OFFICIAL_XAI_ORIGIN = 'https://api.x.ai';
const ROLE_TYPES = [
  'official_project', 'founder', 'co_founder', 'ceo', 'executive',
  'core_contributor', 'team_member', 'ecosystem', 'kol', 'unknown'
];
const CHAINS = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const CHAIN_HINTS = [...CHAINS, 'unknown'];
const SOURCE_TYPES = ['profile', 'x_post', 'website', 'token_page', 'other'];
const CHAIN_EVIDENCE_PATTERNS = {
  sol: [/\bsolana\b/i, /\bon\s+solana\b/i, /\bsolscan\b/i],
  bsc: [/\bbsc\b/i, /\bbnb\s+chain\b/i, /\bon\s+bnb\b/i,
    /\bchain\s*(?:id)?\s*[:#]?\s*56\b/i, /\bbscscan\b/i],
  base: [/\bbase\s+(?:chain|mainnet|network)\b/i, /\bon\s+base\b/i,
    /\bchain\s*(?:id)?\s*[:#]?\s*8453\b/i, /\bbasescan\b/i],
  eth: [/\bethereum\b/i, /\beth\s+(?:chain|mainnet|network)\b/i,
    /\bon\s+eth(?:ereum)?\b/i, /\bchain\s*(?:id)?\s*[:#]?\s*1\b/i, /\betherscan\b/i],
  robinhood: [/\brobinhood\s+chain\b/i, /\bhood\s+chain\b/i,
    /\bon\s+robinhood\b/i, /\bchain\s*(?:id)?\s*[:#]?\s*4663\b/i,
    /\brobinhoodchain\.blockscout\.com\b/i]
};

function evidenceContainsAddress(evidence, address) {
  const expected = String(address || '').trim();
  if (!expected) return false;
  const text = `${evidence?.url || ''}\n${evidence?.excerpt || ''}`;
  return expected.startsWith('0x')
    ? text.toLowerCase().includes(expected.toLowerCase())
    : text.includes(expected);
}

function candidateHasExplicitChainEvidence(candidate, evidence = []) {
  const chain = String(candidate?.chain_id || '').trim().toLowerCase();
  const evidenceId = safeText(candidate?.chain_evidence_id, 80);
  const source = (Array.isArray(evidence) ? evidence : [])
    .find((item) => safeText(item?.evidence_id, 80) === evidenceId);
  if (!source || !evidenceContainsAddress(source, candidate?.address)) return false;
  const text = `${source.url || ''}\n${source.excerpt || ''}`;
  return (CHAIN_EVIDENCE_PATTERNS[chain] || []).some((pattern) => pattern.test(text));
}

function evidenceSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: ['evidence_id', 'source_type', 'url', 'tweet_id', 'handle', 'published_at', 'excerpt'],
    properties: {
      evidence_id: { type: 'string' },
      source_type: { type: 'string', enum: SOURCE_TYPES },
      url: { type: 'string' },
      tweet_id: { type: 'string' },
      handle: { type: 'string' },
      published_at: { type: 'string' },
      excerpt: { type: 'string' }
    }
  };
}

function researchSchema() {
  return {
    type: 'object', additionalProperties: false,
    required: [
      'status', 'target_type', 'project_name', 'project_handle', 'relationship',
      'project_evidence_ids', 'candidate_contracts', 'evidence'
    ],
    properties: {
      status: { type: 'string', enum: ['found', 'not_found', 'ambiguous'] },
      target_type: { type: 'string', enum: ['project', 'person', 'organization', 'other', 'uncertain'] },
      project_name: { type: 'string' },
      project_handle: { type: 'string' },
      relationship: { type: 'string' },
      project_evidence_ids: { type: 'array', maxItems: 6, items: { type: 'string' } },
      candidate_contracts: {
        type: 'array', maxItems: 4,
        items: {
          type: 'object', additionalProperties: false,
          required: ['address', 'chain_id', 'confidence', 'primary_evidence_id', 'chain_evidence_id'],
          properties: {
            address: { type: 'string' },
            chain_id: { type: 'string', enum: CHAIN_HINTS },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            primary_evidence_id: { type: 'string' },
            chain_evidence_id: { type: 'string' }
          }
        }
      },
      evidence: { type: 'array', maxItems: 12, items: evidenceSchema() }
    }
  };
}

function parseJsonDocuments(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  try { return [JSON.parse(source)]; } catch {}
  const documents = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') { inString = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { documents.push(JSON.parse(source.slice(start, index + 1))); } catch {}
        start = -1;
      }
    }
  }
  return documents;
}

function searchToolCalls(payload) {
  const details = payload?.usage?.server_side_tool_usage_details;
  if (!details || typeof details !== 'object') return null;
  return ['x_search_calls', 'web_search_calls']
    .map((key) => Number(details[key] || 0))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
}

function roleTypesFor(targetType, relationship) {
  if (targetType !== 'person') return targetType === 'project' || targetType === 'organization'
    ? ['official_project'] : ['unknown'];
  const text = String(relationship || '').toLowerCase();
  if (text.includes('ceo')) return ['ceo'];
  if (text.includes('co-founder') || text.includes('cofounder') || text.includes('联合创始')) return ['co_founder'];
  if (text.includes('founder') || text.includes('创始')) return ['founder'];
  if (text.includes('executive') || text.includes('高管')) return ['executive'];
  if (text.includes('core') || text.includes('核心')) return ['core_contributor'];
  return ['team_member'];
}

function normalizeResearchResult(structured, payload, input = {}, promptConfig = null) {
  const evidence = (Array.isArray(structured.evidence) ? structured.evidence : [])
    .map((item) => ({
      evidence_id: safeText(item.evidence_id, 80),
      source_type: SOURCE_TYPES.includes(item.source_type) ? item.source_type : 'other',
      url: safeUrl(item.url),
      tweet_id: safeText(item.tweet_id, 40),
      handle: safeHandle(item.handle),
      published_at: safeText(item.published_at, 80),
      excerpt: safeText(item.excerpt, 1600)
    }))
    .filter((item) => item.evidence_id && (item.url || item.tweet_id || item.excerpt));
  const evidenceIds = new Set(evidence.map((item) => item.evidence_id));
  const targetHandle = safeHandle(input.target_handle);
  const projectHandle = safeHandle(structured.project_handle) || targetHandle;
  const targetType = ['project', 'person', 'organization'].includes(structured.target_type)
    ? structured.target_type : 'uncertain';
  const classification = targetType === 'person' ? 'person'
    : ['project', 'organization'].includes(targetType) ? 'project' : 'uncertain';
  const relationship = safeText(structured.relationship, 240);
  const projectEvidenceIds = (Array.isArray(structured.project_evidence_ids)
    ? structured.project_evidence_ids : [])
    .map((value) => safeText(value, 80)).filter((value) => evidenceIds.has(value)).slice(0, 6);
  const identityEvidenceIds = evidence
    .filter((item) => item.handle && item.handle === targetHandle)
    .map((item) => item.evidence_id).slice(0, 6);
  const related = projectHandle && projectHandle !== targetHandle
    ? [{
      handle: projectHandle,
      display_name: safeText(structured.project_name, 100),
      relationship,
      confidence: structured.candidate_contracts?.[0]?.confidence || 'medium',
      evidence_ids: projectEvidenceIds
    }].filter((item) => item.evidence_ids.length > 0)
    : [];
  const candidates = (Array.isArray(structured.candidate_contracts)
    ? structured.candidate_contracts : [])
    .map((item) => {
      const evidenceItem = evidence.find((value) => value.evidence_id === safeText(item.primary_evidence_id, 80));
      const chainEvidenceId = safeText(item.chain_evidence_id, 80);
      const chainEvidence = evidence.find((value) => value.evidence_id === chainEvidenceId);
      if (!evidenceItem) return null;
      return {
        address: safeText(item.address, 80),
        chain_id: CHAINS.includes(item.chain_id) ? item.chain_id : null,
        chain_evidence_id: chainEvidence ? chainEvidenceId : null,
        owner_handle: projectHandle,
        source_url: evidenceItem.url,
        source_tweet_id: evidenceItem.tweet_id,
        published_at: evidenceItem.published_at,
        source_excerpt: evidenceItem.excerpt,
        confidence: item.confidence,
        evidence_ids: [...new Set([evidenceItem.evidence_id,
          chainEvidence?.evidence_id].filter(Boolean))]
      };
    })
    .filter((item) => item && item.address && item.owner_handle && item.evidence_ids.length > 0)
    .slice(0, 4);
  return {
    prompt_version: promptConfig?.prompt_version || FOLLOW_XAI_PROMPT_VERSION,
    model: String(process.env.XAI_MODEL || FOLLOW_XAI_MODEL).trim(),
    summary: [safeText(structured.project_name, 160), relationship].filter(Boolean).join(': '),
    target_identity: {
      classification,
      role_types: roleTypesFor(targetType, relationship),
      confidence: candidates[0]?.confidence || 'low',
      reasons: relationship ? [relationship] : [],
      evidence_ids: identityEvidenceIds
    },
    related_project_accounts: related,
    candidates,
    evidence,
    citations: (Array.isArray(payload?.citations) ? payload.citations : [])
      .map(safeUrl).filter(Boolean).slice(0, 40),
    usage: sanitizeUsage(payload?.usage)
  };
}

function researchInput(input = {}, mode = 'fast', promptConfig = DEFAULT_PROMPTS) {
  const targetHandle = safeHandle(input.target_handle);
  const template = mode === 'fast' ? promptConfig.fast_prompt : promptConfig.relationship_prompt;
  const temporalNote = input.followed_at
    ? `本次关注发生于 ${safeText(input.followed_at, 80)}。判断这次关注时已经公开的信息时，不要使用该时间之后发布的内容。`
    : '';
  return [
    renderPrompt(template, targetHandle),
    temporalNote,
    '请使用可用的搜索工具核对公开资料，只保留有来源支持的结果。'
  ].filter(Boolean).join('\n\n');
}

function requestBody(input, mode, reasoningEffort, promptConfig = DEFAULT_PROMPTS) {
  const taskPrompt = researchInput(input, mode, promptConfig);
  return {
    model: String(process.env.XAI_MODEL || FOLLOW_XAI_MODEL).trim(),
    reasoning_effort: reasoningEffort,
    input: [
      { role: 'system', content: [
        '你是一名加密项目研究员。请检索公开资料并核对来源，不要凭记忆回答。',
        '完整 CA、所属区块链、项目身份和人物关系都必须有可核对的公开来源；不确定时明确说明。',
        '请将研究结果整理为系统要求的结构。'
      ].join('\n') },
      { role: 'user', content: taskPrompt }
    ],
    tools: [{ type: 'x_search' }, { type: 'web_search' }],
    tool_choice: 'required',
    text: { format: { type: 'json_schema', name: 'xbot_follow_discovery_fast', strict: true, schema: researchSchema() } }
  };
}

async function requestResearch(input, options, mode, promptConfig = DEFAULT_PROMPTS) {
  const fetchImpl = options.fetchImpl || fetch;
  const requestedTimeout = Number(options.timeoutMs ?? process.env.XAI_FOLLOW_TIMEOUT_MS ?? (mode === 'fast' ? 60000 : 120000));
  const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
    ? Math.min(180000, Math.max(15000, requestedTimeout)) : (mode === 'fast' ? 60000 : 120000);
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const reasoningEffort = String(options.reasoningEffort || process.env.XAI_REASONING_EFFORT || 'low').trim();
  const responsesUrl = options.responsesUrl || resolveResponsesUrl(options.baseUrl);
  const body = requestBody(input, mode, reasoningEffort, promptConfig);
  let response;
  let payload = {};
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      response = await fetchImpl(responsesUrl, {
        method: 'POST',
        headers: { Authorization: `Bearer ${String(process.env.XAI_API_KEY).trim()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
      payload = await response.json().catch(() => ({}));
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        error.code = 'XAI_SEARCH_TIMEOUT'; error.retryable = true;
      } else if (!error?.code && error instanceof TypeError) {
        error.code = 'XAI_SEARCH_NETWORK_ERROR'; error.retryable = true;
      }
      if (attempt >= 2) throw error;
      await sleep(Math.min(30000, 1000 * (2 ** (attempt - 1))));
      continue;
    }
    if (response.status !== 429 || attempt === 2) break;
    await sleep(retryAfterMs(response.headers?.get?.('retry-after')));
  }
  if (!response.ok) {
    const classified = classifyXaiError(response.status, payload);
    const error = new Error(classified.message);
    error.code = classified.code; error.httpStatus = response.status;
    error.retryable = response.status === 429 || response.status >= 500;
    error.usage = sanitizeUsage(payload?.usage);
    throw error;
  }
  const toolCalls = searchToolCalls(payload);
  if (toolCalls === null || toolCalls <= 0) {
    const error = new Error('Grok returned without using x_search or web_search');
    error.code = 'XAI_SEARCH_NO_TOOL_USE'; error.retryable = true;
    throw error;
  }
  const outputText = extractOutputText(payload).trim();
  if (!outputText) {
    const error = new Error(payload?.status === 'incomplete' ? 'P21 Grok search response was incomplete' : 'P21 Grok search response was empty');
    error.code = payload?.status === 'incomplete' ? 'XAI_RESPONSE_INCOMPLETE' : 'XAI_OUTPUT_EMPTY';
    throw error;
  }
  const structured = parseJsonDocuments(outputText).at(-1);
  if (!structured || !['found', 'not_found', 'ambiguous'].includes(structured.status)
      || !Array.isArray(structured.candidate_contracts) || !Array.isArray(structured.evidence)) {
    const error = new Error('P21 Grok search output does not match the compact research schema');
    error.code = 'XAI_SCHEMA_INVALID'; throw error;
  }
  return { structured, payload };
}

async function researchFollowTarget(input, options = {}) {
  const apiKey = String(process.env.XAI_API_KEY || '').trim();
  if (!apiKey) {
    const error = new Error('XAI_API_KEY is not configured'); error.code = 'XAI_KEY_MISSING'; throw error;
  }
  const responsesUrl = options.responsesUrl || resolveResponsesUrl(options.baseUrl);
  if (options.requireOfficial !== false && new URL(responsesUrl).origin !== OFFICIAL_XAI_ORIGIN) {
    const error = new Error('P21 follow research requires the official xAI API for x_search');
    error.code = 'XAI_SEARCH_OFFICIAL_ENDPOINT_REQUIRED'; throw error;
  }
  // Injected fetchers are used by unit tests; production calls load the current
  // persisted prompt once per event so the fast and fallback stages share it.
  const promptConfig = options.promptConfig
    || (options.fetchImpl ? DEFAULT_PROMPTS : await promptService.getCurrent());
  let result;
  try {
    result = await requestResearch(input, { ...options, responsesUrl }, 'fast', promptConfig);
  } catch (error) {
    if (!['XAI_SEARCH_NO_TOOL_USE', 'XAI_SCHEMA_INVALID', 'XAI_OUTPUT_EMPTY', 'XAI_RESPONSE_INCOMPLETE'].includes(error.code)) throw error;
  }
  let normalized = result
    ? normalizeResearchResult(result.structured, result.payload, input, promptConfig)
    : null;
  if (!result || result.structured.status !== 'found' || result.structured.candidate_contracts.length !== 1
      || normalized.candidates.length !== 1) {
    result = await requestResearch(input, { ...options, responsesUrl }, 'fallback', promptConfig);
    normalized = normalizeResearchResult(result.structured, result.payload, input, promptConfig);
  }
  return normalized;
}

module.exports = {
  CHAINS,
  CHAIN_EVIDENCE_PATTERNS,
  FOLLOW_XAI_MODEL,
  FOLLOW_XAI_PROMPT_VERSION,
  OFFICIAL_XAI_ORIGIN,
  candidateHasExplicitChainEvidence,
  parseJsonDocuments,
  researchFollowTarget,
  researchInput,
  researchSchema,
  searchToolCalls
};
