import {
  WhitelistEntry, KolAccount, TradeSignal, ApiResponse,
  PaginatedResponse, XActivity, Position, X6551Status, X6551WatchPlan,
  ChainId, ChainConfig, TradeAttempt, TradeAttemptDetails, TradeRuntimePolicy,
  TradeReadiness, TradeRetryRuntime, WalletWriteLane, ChainTradeCircuit, ArmPreparation,
  RuntimePolicyDetailPage, RuntimeSummary, DynamicPolicy, DynamicResolution,
  DynamicSignalStatus, DynamicPaperSession, ActorScreeningRun, DynamicPolicyTemplate, EntityId
} from './types';

const configuredApiBase = import.meta.env.VITE_API_URL;
const mountedBase = import.meta.env.BASE_URL === '/'
  ? ''
  : import.meta.env.BASE_URL.replace(/\/$/, '');
const BASE_URL = configuredApiBase ?? mountedBase;
const GET_CACHE_TTL_MS = 2000;
const getCache = new Map<string, { expiresAt: number; value: unknown }>();
const getInFlight = new Map<string, Promise<unknown>>();
let cacheGeneration = 0;

function invalidateGetCache() {
  cacheGeneration += 1;
  getCache.clear();
  getInFlight.clear();
}

// 从 localStorage 或环境变量读取 token
export function getAuthToken(): string {
  return localStorage.getItem('xbot_admin_token') || '';
}

function validatePayloadSchema(endpoint: string, payload: any) {
  if (!payload || typeof payload !== 'object' || !payload.ok) return;
  const data = payload.data;
  if (!data) return;
  if (!Array.isArray(data)
      && typeof data === 'object'
      && typeof data.success === 'boolean') return;

  const checkKeys = (item: any, expectedKeys: string[], typeName: string) => {
    if (!item || typeof item !== 'object') return;
    const missing = expectedKeys.filter(k => !(k in item));
    if (missing.length > 0) {
      console.warn(
        `%c[Schema Drift Warning] Endpoint "${endpoint}" returned data for "${typeName}" missing expected contract keys: ${missing.join(', ')}`,
        'color: #ff4757; font-weight: bold;'
      );
    }
  };

  const items = Array.isArray(data) ? data : [data];

  const isWhitelistUtilityEndpoint = endpoint.startsWith('/api/whitelist/templates')
    || endpoint.startsWith('/api/whitelist/watch-impact');

  if (endpoint.startsWith('/api/whitelist') && !isWhitelistUtilityEndpoint) {
    items.forEach(item => {
      checkKeys(item, ['contract_address', 'chain_id', 'budget_per_trade', 'current_buy_count'], 'WhitelistEntry');
      if ('tokenAddress' in item || 'projectName' in item) {
        console.warn(`%c[Schema Drift Warning] Obsolete camelCase fields (tokenAddress/projectName) detected in Whitelist response!`, 'color: #ffa502;');
      }
    });
  } else if (endpoint.startsWith('/api/kol')) {
    items.forEach(item => {
      checkKeys(item, ['x_handle', 'display_name', 'chain_ids', 'enabled'], 'KolAccount');
    });
  } else if (
    endpoint === '/api/trade/positions' || endpoint.startsWith('/api/trade/positions?') ||
    endpoint === '/api/trade/history' || endpoint.startsWith('/api/trade/history?')
  ) {
    items.forEach(item => {
      checkKeys(item, ['contract_address', 'chain_id', 'amount_in', 'entry_price', 'status'], 'Position');
    });
  }
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const method = String(options?.method || 'GET').toUpperCase();
  const explicitAuthorization = new Headers(options?.headers).has('Authorization');
  const cacheableGet = method === 'GET' && !explicitAuthorization;
  const requestGeneration = cacheGeneration;
  const cacheKey = `${requestGeneration}:${url}`;
  if (cacheableGet) {
    const cached = getCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value as T;
    const existing = getInFlight.get(cacheKey);
    if (existing) return existing as Promise<T>;
  } else if (method !== 'GET') {
    invalidateGetCache();
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getAuthToken()}`,
    ...(options?.headers as Record<string, string> || {}),
  };

  const request = (async () => {
  try {
    const res = await fetch(url, { ...options, headers });
    if (!res.ok && res.status === 401) {
      window.dispatchEvent(new Event('xbot:unauthorized'));
      console.error('API 401: Token 无效或缺失');
      return { ok: false, error: 'Unauthorized' } as unknown as T;
    }
    const raw = await res.text();
    if (!raw) {
      return {
        ok: false,
        error: `API ${res.status} returned an empty response`,
      } as unknown as T;
    }
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      const error = `API ${res.status} returned a non-JSON response`;
      console.error(`API Error on ${endpoint}: ${error}`);
      return { ok: false, error } as unknown as T;
    }
    if (import.meta.env.DEV) {
      validatePayloadSchema(endpoint, data);
    }
    const typed = data as T;
    if (cacheableGet
        && requestGeneration === cacheGeneration
        && (data as { ok?: boolean })?.ok) {
      getCache.set(cacheKey, { expiresAt: Date.now() + GET_CACHE_TTL_MS, value: typed });
    }
    return typed;
  } catch (err) {
    console.error(`API Error on ${endpoint}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' } as unknown as T;
  }
  })();
  if (cacheableGet) getInFlight.set(cacheKey, request as Promise<unknown>);
  try {
    return await request;
  } finally {
    if (cacheableGet) getInFlight.delete(cacheKey);
  }
}

export function setAdminToken(token: string) {
  invalidateGetCache();
  localStorage.setItem('xbot_admin_token', token.trim());
}

export function clearAdminToken() {
  invalidateGetCache();
  localStorage.removeItem('xbot_admin_token');
}

export function validateAdminToken(token: string) {
  return fetchApi<ApiResponse<unknown>>('/api/system/engine-status', {
    headers: { Authorization: `Bearer ${token.trim()}` },
  });
}

export const api = {
  launchMonitors: {
    list: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<PaginatedResponse<import('./types').LaunchMonitor>>(`/api/launch-monitors${q}`);
    },
    create: (data: Partial<import('./types').LaunchMonitor>) => fetchApi<ApiResponse<import('./types').LaunchMonitor>>('/api/launch-monitors', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<import('./types').LaunchMonitor>) => fetchApi<ApiResponse<import('./types').LaunchMonitor>>(`/api/launch-monitors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: 'active' | 'paused') => fetchApi<ApiResponse<import('./types').LaunchMonitor>>(`/api/launch-monitors/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    remove: (id: string) => fetchApi<ApiResponse<{ success: boolean }>>(`/api/launch-monitors/${id}`, { method: 'DELETE' }),
    watchImpact: (data: Pick<import('./types').LaunchMonitor, 'sources' | 'relations'>) => fetchApi<ApiResponse<{ unique_handles: number; reused_watches: number; new_watches: number }>>('/api/launch-monitors/watch-impact', { method: 'POST', body: JSON.stringify(data) }),
  },
  whitelist: {
    list: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<PaginatedResponse<WhitelistEntry>>(`/api/whitelist${q}`);
    },
    get: (id: string) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}`),
    create: (data: Partial<WhitelistEntry>) => fetchApi<ApiResponse<WhitelistEntry>>('/api/whitelist', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<WhitelistEntry>) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    retryActivation: (id: string) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}/activation/retry`, { method: 'POST', body: '{}' }),
    remove: (id: string) => fetchApi<ApiResponse<{ success: boolean }>>(`/api/whitelist/${id}`, { method: 'DELETE' }),
    watchImpact: (data: Pick<WhitelistEntry, 'relations' | 'direct_sources'>) => fetchApi<ApiResponse<{
      unique_handles: number;
      reused_watches: number;
      new_watches: number;
      handles: Array<{ handle: string; watch_status: string }>;
    }>>('/api/whitelist/watch-impact', { method: 'POST', body: JSON.stringify(data) }),
    templates: {
      list: (chainId?: string) => fetchApi<ApiResponse<import('./types').WhitelistTemplate[]>>(
        `/api/whitelist/templates${chainId ? `?chain_id=${encodeURIComponent(chainId)}` : ''}`
      ),
      create: (data: Partial<import('./types').WhitelistTemplate>) => fetchApi<ApiResponse<import('./types').WhitelistTemplate>>('/api/whitelist/templates', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: string, data: Partial<import('./types').WhitelistTemplate>) => fetchApi<ApiResponse<import('./types').WhitelistTemplate>>(`/api/whitelist/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      remove: (id: string) => fetchApi<ApiResponse<{ success: boolean }>>(`/api/whitelist/templates/${id}`, { method: 'DELETE' }),
    },
  },

  research: {
    tokenMetadata: (chain: string, address: string) => fetchApi<ApiResponse<import('./types').TokenMetadata>>(
      `/api/research/token-metadata?${new URLSearchParams({ chain, address }).toString()}`
    ),
    createReport: (chain_id: string, contract_address: string) => fetchApi<ApiResponse<import('./types').TokenResearchReport>>('/api/research/token-reports', { method: 'POST', body: JSON.stringify({ chain_id, contract_address }) }),
    getReport: (id: string) => fetchApi<ApiResponse<import('./types').TokenResearchReport>>(`/api/research/token-reports/${id}`),
    expandReport: (id: string) => fetchApi<ApiResponse<import('./types').TokenResearchReport>>(`/api/research/token-reports/${id}/expand`, { method: 'POST' }),
    whitelistDraft: (id: string) => fetchApi<ApiResponse<import('./types').WhitelistDraftPayload>>(`/api/research/token-reports/${id}/whitelist-draft`, { method: 'POST' }),
    actors: (params?: Record<string, string>) => fetchApi<ApiResponse<unknown[]>>(
      `/api/research/actors${params ? `?${new URLSearchParams(params).toString()}` : ''}`
    ),
    createJob: (chain_id: string, contract_addresses: string[]) => fetchApi<ApiResponse<import('./types').ResearchJob>>('/api/research/jobs', { method: 'POST', body: JSON.stringify({ chain_id, contract_addresses }) }),
    getJob: (id: string) => fetchApi<ApiResponse<import('./types').ResearchJob>>(`/api/research/jobs/${id}`),
    retryFailed: (id: string) => fetchApi<ApiResponse<import('./types').ResearchJob>>(`/api/research/jobs/${id}/retry-failed`, { method: 'POST' }),
    cancelJob: (id: string) => fetchApi<ApiResponse<import('./types').ResearchJob>>(`/api/research/jobs/${id}/cancel`, { method: 'POST' }),
  },

  kol: {
    list: (params?: Record<string, string>) => fetchApi<ApiResponse<KolAccount[]>>(`/api/kol${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
    create: (data: Partial<KolAccount>) => fetchApi<ApiResponse<KolAccount>>('/api/kol', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<KolAccount>) => fetchApi<ApiResponse<KolAccount>>(`/api/kol/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    toggle: (id: string) => fetchApi<ApiResponse<KolAccount>>(`/api/kol/${id}/toggle`, { method: 'PATCH' }),
    retryProfile: (id: string) => fetchApi<ApiResponse<KolAccount>>(`/api/kol/${id}/profile/retry`, { method: 'POST' }),
    remove: (id: string) => fetchApi<ApiResponse<boolean>>(`/api/kol/${id}`, { method: 'DELETE' }),
    getActivities: (id: string) => fetchApi<PaginatedResponse<XActivity>>(`/api/kol/${id}/activities`),
  },

  dynamicSignal: {
    status: () => fetchApi<ApiResponse<DynamicSignalStatus>>('/api/dynamic-signal/status'),
    policies: (params?: Record<string, string>) => fetchApi<ApiResponse<DynamicPolicy[]>>(`/api/dynamic-signal/policies${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
    templates: {
      list: () => fetchApi<ApiResponse<DynamicPolicyTemplate[]>>('/api/dynamic-signal/templates'),
      create: (data: { name: string; config: Partial<DynamicPolicyTemplate['config']> }) => fetchApi<ApiResponse<DynamicPolicyTemplate>>('/api/dynamic-signal/templates', { method: 'POST', body: JSON.stringify(data) }),
      update: (id: string, data: { name?: string; config?: Partial<DynamicPolicyTemplate['config']> }) => fetchApi<ApiResponse<DynamicPolicyTemplate>>(`/api/dynamic-signal/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
      remove: (id: string) => fetchApi<ApiResponse<{ deleted: boolean }>>(`/api/dynamic-signal/templates/${id}`, { method: 'DELETE' }),
    },
    savePolicy: (kolId: string, data: Partial<DynamicPolicy>) => fetchApi<ApiResponse<DynamicPolicy>>(`/api/dynamic-signal/policies/${kolId}`, { method: 'PUT', body: JSON.stringify(data) }),
    removePolicy: (id: string) => fetchApi<ApiResponse<{ deleted: boolean }>>(`/api/dynamic-signal/policies/${id}`, { method: 'DELETE' }),
    resolutions: (params?: Record<string, string>) => fetchApi<ApiResponse<DynamicResolution[]>>(`/api/dynamic-signal/resolutions${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
    resolution: (id: string) => fetchApi<ApiResponse<DynamicResolution>>(`/api/dynamic-signal/resolutions/${id}`),
    paperSessions: (params?: Record<string, string>) => fetchApi<ApiResponse<DynamicPaperSession[]>>(`/api/dynamic-signal/paper-sessions${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
  },

  actorScreening: {
    list: (limit = 50) => fetchApi<ApiResponse<ActorScreeningRun[]>>(`/api/actor-screening?limit=${Math.min(100, Math.max(1, limit))}`),
    get: (id: string) => fetchApi<ApiResponse<ActorScreeningRun>>(`/api/actor-screening/${id}`),
    create: (data: { handles: string[]; sample_started_at?: string; sample_ended_at?: string }) => fetchApi<ApiResponse<ActorScreeningRun>>('/api/actor-screening', { method: 'POST', body: JSON.stringify(data) }),
    retry: (id: string) => fetchApi<ApiResponse<{ queued: boolean }>>(`/api/actor-screening/${id}/retry`, { method: 'POST', body: '{}' }),
  },

  followDiscovery: {
    prompts: () => fetchApi<ApiResponse<import('./types').FollowDiscoveryPrompts>>('/api/follow-discovery/prompts'),
    updatePrompts: (data: Pick<import('./types').FollowDiscoveryPrompts, 'version' | 'fast_prompt' | 'relationship_prompt'>) =>
      fetchApi<ApiResponse<import('./types').FollowDiscoveryPrompts>>('/api/follow-discovery/prompts', { method: 'PUT', body: JSON.stringify(data) }),
    resetPrompts: (version: number) =>
      fetchApi<ApiResponse<import('./types').FollowDiscoveryPrompts>>('/api/follow-discovery/prompts/reset', { method: 'POST', body: JSON.stringify({ version }) }),
    policies: (params?: Record<string, string>) => fetchApi<ApiResponse<import('./types').FollowDiscoveryPolicy[]>>(`/api/follow-discovery/policies${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
    policy: (id: string) => fetchApi<ApiResponse<import('./types').FollowDiscoveryPolicy>>(`/api/follow-discovery/policies/${id}`),
    createPolicy: (data: Partial<import('./types').FollowDiscoveryPolicy> & { kol_id: string }) => fetchApi<ApiResponse<import('./types').FollowDiscoveryPolicy>>('/api/follow-discovery/policies', { method: 'POST', body: JSON.stringify(data) }),
    updatePolicy: (id: string, data: Partial<import('./types').FollowDiscoveryPolicy>) => fetchApi<ApiResponse<import('./types').FollowDiscoveryPolicy>>(`/api/follow-discovery/policies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    removePolicy: (id: string) => fetchApi<ApiResponse<{ archived: boolean }>>(`/api/follow-discovery/policies/${id}`, { method: 'DELETE' }),
    watchImpact: (kolId: string) => fetchApi<ApiResponse<{ handle: string; new_watches: number; required_event: 'follow' }>>('/api/follow-discovery/watch-impact', { method: 'POST', body: JSON.stringify({ kol_id: kolId }) }),
    events: (params?: Record<string, string>) => fetchApi<ApiResponse<import('./types').FollowDiscoveryEvent[]>>(`/api/follow-discovery/events${params ? `?${new URLSearchParams(params).toString()}` : ''}`),
    event: (id: string) => fetchApi<ApiResponse<import('./types').FollowDiscoveryEvent>>(`/api/follow-discovery/events/${id}`),
  },

  signals: {
    list: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<PaginatedResponse<TradeSignal>>(`/api/system/signals${q}`);
    },
    stats: () => fetchApi<ApiResponse<any>>('/api/system/signals/stats'),
  },

  xMonitor: {
    activities: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<PaginatedResponse<XActivity>>(`/api/x-monitor/activities${q}`);
    },
    status: () => fetchApi<ApiResponse<any>>('/api/x-monitor/status'),
    pollNow: () => fetchApi<ApiResponse<boolean>>('/api/x-monitor/poll-now', { method: 'POST' }),
    pollFollowsNow: () => fetchApi<ApiResponse<any>>('/api/x-monitor/poll-follows-now', { method: 'POST' }),
    followPolls: () => fetchApi<ApiResponse<any[]>>('/api/x-monitor/follow-polls'),
    providerUsage: () => fetchApi<ApiResponse<any>>('/api/x-monitor/provider-usage'),
    syncStream: () => fetchApi<ApiResponse<any[]>>('/api/x-monitor/stream/sync', { method: 'POST' }),
    status6551: (refresh = false) => fetchApi<ApiResponse<X6551Status>>(`/api/x-monitor/6551/status${refresh ? '?refresh=true' : ''}`),
    watchPlan6551: () => fetchApi<ApiResponse<X6551WatchPlan>>('/api/x-monitor/6551/watch-plan'),
  },

  config: {
    get: (key: string) => fetchApi<ApiResponse<any>>(`/api/config/${key}`),
    set: (key: string, data: any) => fetchApi<ApiResponse<any>>(`/api/config/${key}`, { method: 'PUT', body: JSON.stringify(data) }),
    getChains: () => fetchApi<ApiResponse<Partial<Record<ChainId, ChainConfig>>>>('/api/config/chains'),
    setManagedRetry: (enabled: boolean) => fetchApi<ApiResponse<Partial<Record<ChainId, ChainConfig>>>>('/api/config/chains/retry', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  },

  system: {
    health: () => fetchApi<ApiResponse<any>>('/api/health'),
    dashboard: () => fetchApi<ApiResponse<any>>('/api/system/dashboard'),
    runtimeSummary: () => fetchApi<ApiResponse<RuntimeSummary>>('/api/system/runtime-summary'),
    runtimeScopes: () => fetchApi<ApiResponse<import('./types').RuntimeScope[]>>('/api/system/runtime-scopes'),
    prepareArm: (scope?: { scope_type?: string; scope_id?: number | null; chain_ids?: string[] }, options: { probe?: boolean } = {}) => fetchApi<ApiResponse<ArmPreparation>>('/api/system/arm/prepare', {
      method: 'POST', body: JSON.stringify({ scope: scope || { scope_type: 'combined' }, probe: options.probe === true }), signal: AbortSignal.timeout(45_000)
    }),
    confirmArm: (preparation: ArmPreparation) => fetchApi<ApiResponse<any>>('/api/system/arm/confirm', {
      method: 'POST',
      body: JSON.stringify({
        preparation_id: preparation.preparation_id,
        arm_token: preparation.arm_token,
        confirmation: 'ARM LIVE TRADING'
      })
    }),
    disarm: () => fetchApi<ApiResponse<any>>('/api/system/disarm', { method: 'POST' }),
    engineStatus: () => fetchApi<ApiResponse<any>>('/api/system/engine-status'),
    readiness: (probe = false, scope?: { scope_type?: string; scope_id?: number | null; chain_ids?: string[] }) => {
      const params = new URLSearchParams({ probe: String(probe) });
      if (scope?.scope_type) params.set('scope_type', scope.scope_type);
      if (scope?.scope_id !== null && scope?.scope_id !== undefined) params.set('scope_id', String(scope.scope_id));
      if (scope?.chain_ids?.length) params.set('chain_ids', scope.chain_ids.join(','));
      return fetchApi<ApiResponse<TradeReadiness>>(`/api/system/readiness?${params.toString()}`);
    },
    budgets: () => fetchApi<ApiResponse<any>>('/api/system/budgets'),
    testTradeAlert: () => fetchApi<ApiResponse<any>>('/api/system/alerts/test', { method: 'POST', body: '{}' }),
    getEnv: () => fetchApi<ApiResponse<any>>('/api/system/env'),
    saveEnv: (data: any) => fetchApi<ApiResponse<any>>('/api/system/env', { method: 'POST', body: JSON.stringify(data) }),
    setRuntimeMode: (mode: string) => fetchApi<ApiResponse<any>>('/api/system/env/runtime-mode', { method: 'POST', body: JSON.stringify({ mode, confirmation: 'CHANGE TRADING MODE' }) }),
    setLiveEnabled: (enabled: boolean) => fetchApi<ApiResponse<any>>('/api/system/env/live-enabled', { method: 'POST', body: JSON.stringify({ enabled, confirmation: enabled ? 'ENABLE LIVE TRADING' : '' }) }),
    replaceGmgnPrivateKey: (privateKey: string) => fetchApi<ApiResponse<any>>('/api/system/env/gmgn-private-key', { method: 'POST', body: JSON.stringify({ private_key: privateKey, confirmation: 'REPLACE GMGN PRIVATE KEY' }) }),
  },

  trade: {
    positions: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<ApiResponse<Position[]>>(`/api/trade/positions${q}`);
    },
    history: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<ApiResponse<Position[]>>(`/api/trade/history${q}`);
    },
    close: (id: EntityId) => fetchApi<ApiResponse<Position>>(`/api/trade/positions/${id}/close`, { method: 'POST' }),
    runtimePolicy: () => fetchApi<ApiResponse<TradeRuntimePolicy>>('/api/trade/runtime-policy'),
    runtimePolicyDetail: (params?: Record<string, string>) => fetchApi<ApiResponse<RuntimePolicyDetailPage>>(
      `/api/trade/runtime-policy/detail${params ? `?${new URLSearchParams(params).toString()}` : ''}`
    ),
    retryRuntime: () => fetchApi<ApiResponse<TradeRetryRuntime>>('/api/trade/retry-runtime'),
    walletLanes: () => fetchApi<ApiResponse<WalletWriteLane[]>>('/api/trade/wallet-lanes'),
    releaseWalletLane: (lane: Pick<WalletWriteLane, 'chain' | 'wallet_address'>, reason: string, evidence: string) =>
      fetchApi<ApiResponse<WalletWriteLane>>('/api/trade/wallet-lanes/release', {
        method: 'POST',
        body: JSON.stringify({
          chain: lane.chain,
          wallet_address: lane.wallet_address,
          reason,
          evidence: { operator_note: evidence },
          confirmation: 'RELEASE WALLET QUARANTINE'
        })
      }),
    resetChainCircuit: (chain: ChainId, reason: string) =>
      fetchApi<ApiResponse<ChainTradeCircuit>>(`/api/trade/chain-circuits/${chain}/reset`, {
        method: 'POST',
        body: JSON.stringify({ reason, confirmation: 'RESET CHAIN FAILURE CIRCUIT' })
      }),
    attempts: (limit = 100) => fetchApi<ApiResponse<TradeAttempt[]>>(`/api/trade/attempts?limit=${limit}`),
    attempt: (id: EntityId) => fetchApi<ApiResponse<TradeAttemptDetails>>(`/api/trade/attempts/${id}`),
    prepareSignal: (id: EntityId) => fetchApi<ApiResponse<Record<string, unknown>>>(`/api/trade/signals/${id}/prepare`, { method: 'POST', body: '{}' }),
    executeSignal: (id: EntityId, prepareToken: string) => fetchApi<ApiResponse<Record<string, unknown>>>(`/api/trade/signals/${id}/execute`, { method: 'POST', body: JSON.stringify({ prepare_token: prepareToken, confirmation: 'EXECUTE LIVE BUY' }) }),
    prepareClose: (id: EntityId, percent = 100) => fetchApi<ApiResponse<import('./types').ClosePreparation>>(`/api/trade/positions/${id}/close/prepare`, { method: 'POST', body: JSON.stringify({ percent }) }),
    executeClose: (id: EntityId, prepareToken: string) => fetchApi<ApiResponse<Record<string, unknown>>>(`/api/trade/positions/${id}/close/execute`, { method: 'POST', body: JSON.stringify({ prepare_token: prepareToken, confirmation: 'EXECUTE LIVE CLOSE' }) })
  }
};
