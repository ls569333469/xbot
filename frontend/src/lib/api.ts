import {
  WhitelistEntry, KolAccount, TradeSignal, ApiResponse,
  PaginatedResponse, XActivity, Position, X6551Status, X6551WatchPlan,
  TradeAttempt, TradeRuntimePolicy, TradeReadiness
} from './types';

const BASE_URL = import.meta.env.VITE_API_URL || '';

// 从 localStorage 或环境变量读取 token
export function getAuthToken(): string {
  return localStorage.getItem('xbot_admin_token') || '';
}

function validatePayloadSchema(endpoint: string, payload: any) {
  if (!payload || typeof payload !== 'object' || !payload.ok) return;
  const data = payload.data;
  if (!data) return;

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

  if (endpoint.startsWith('/api/whitelist')) {
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
  } else if (endpoint.startsWith('/api/trade/positions') || endpoint.startsWith('/api/trade/history')) {
    items.forEach(item => {
      checkKeys(item, ['contract_address', 'chain_id', 'amount_in', 'entry_price', 'status'], 'Position');
    });
  }
}

async function fetchApi<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${getAuthToken()}`,
    ...(options?.headers as Record<string, string> || {}),
  };

  try {
    const res = await fetch(url, { ...options, headers });
    if (!res.ok && res.status === 401) {
      console.error('API 401: Token 无效或缺失');
      return { ok: false, error: 'Unauthorized' } as unknown as T;
    }
    const data = await res.json();
    if (import.meta.env.DEV) {
      validatePayloadSchema(endpoint, data);
    }
    return data;
  } catch (err) {
    console.error(`API Error on ${endpoint}:`, err);
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' } as unknown as T;
  }
}

export function setAdminToken(token: string) {
  localStorage.setItem('xbot_admin_token', token);
}

export const api = {
  whitelist: {
    list: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return fetchApi<PaginatedResponse<WhitelistEntry>>(`/api/whitelist${q}`);
    },
    get: (id: string) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}`),
    create: (data: Partial<WhitelistEntry>) => fetchApi<ApiResponse<WhitelistEntry>>('/api/whitelist', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<WhitelistEntry>) => fetchApi<ApiResponse<WhitelistEntry>>(`/api/whitelist/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    updateStatus: (id: string, status: string) => fetchApi<ApiResponse<boolean>>(`/api/whitelist/${id}/status`, { method: 'PATCH', body: JSON.stringify({ status }) }),
    remove: (id: string) => fetchApi<ApiResponse<boolean>>(`/api/whitelist/${id}`, { method: 'DELETE' }),
  },

  kol: {
    list: () => fetchApi<ApiResponse<KolAccount[]>>('/api/kol'),
    create: (data: Partial<KolAccount>) => fetchApi<ApiResponse<KolAccount>>('/api/kol', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: Partial<KolAccount>) => fetchApi<ApiResponse<KolAccount>>(`/api/kol/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    toggle: (id: string) => fetchApi<ApiResponse<KolAccount>>(`/api/kol/${id}/toggle`, { method: 'PATCH' }),
    remove: (id: string) => fetchApi<ApiResponse<boolean>>(`/api/kol/${id}`, { method: 'DELETE' }),
    getActivities: (id: string) => fetchApi<PaginatedResponse<XActivity>>(`/api/kol/${id}/activities`),
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
    status6551: () => fetchApi<ApiResponse<X6551Status>>('/api/x-monitor/6551/status'),
    watchPlan6551: () => fetchApi<ApiResponse<X6551WatchPlan>>('/api/x-monitor/6551/watch-plan'),
  },

  config: {
    get: (key: string) => fetchApi<ApiResponse<any>>(`/api/config/${key}`),
    set: (key: string, data: any) => fetchApi<ApiResponse<any>>(`/api/config/${key}`, { method: 'PUT', body: JSON.stringify(data) }),
    getChains: () => fetchApi<ApiResponse<any>>('/api/config/chains'),
    setChain: (chainId: string, data: any) => fetchApi<ApiResponse<any>>(`/api/config/chains/${chainId}`, { method: 'PUT', body: JSON.stringify(data) }),
  },

  system: {
    health: () => fetchApi<ApiResponse<any>>('/api/health'),
    dashboard: () => fetchApi<ApiResponse<any>>('/api/system/dashboard'),
    arm: (confirmation: string) => fetchApi<ApiResponse<any>>('/api/system/arm', { method: 'POST', body: JSON.stringify({ confirmation }) }),
    disarm: () => fetchApi<ApiResponse<any>>('/api/system/disarm', { method: 'POST' }),
    engineStatus: () => fetchApi<ApiResponse<any>>('/api/system/engine-status'),
    readiness: (probe = false) => fetchApi<ApiResponse<TradeReadiness>>(`/api/system/readiness?probe=${probe}`),
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
    close: (id: string) => fetchApi<ApiResponse<Position>>(`/api/trade/positions/${id}/close`, { method: 'POST' }),
    runtimePolicy: () => fetchApi<ApiResponse<TradeRuntimePolicy>>('/api/trade/runtime-policy'),
    attempts: (limit = 100) => fetchApi<ApiResponse<TradeAttempt[]>>(`/api/trade/attempts?limit=${limit}`),
    attempt: (id: string) => fetchApi<ApiResponse<any>>(`/api/trade/attempts/${id}`),
    prepareSignal: (id: string) => fetchApi<ApiResponse<any>>(`/api/trade/signals/${id}/prepare`, { method: 'POST', body: '{}' }),
    executeSignal: (id: string, prepareToken: string) => fetchApi<ApiResponse<any>>(`/api/trade/signals/${id}/execute`, { method: 'POST', body: JSON.stringify({ prepare_token: prepareToken, confirmation: 'EXECUTE LIVE BUY' }) }),
    prepareClose: (id: string, percent = 100) => fetchApi<ApiResponse<any>>(`/api/trade/positions/${id}/close/prepare`, { method: 'POST', body: JSON.stringify({ percent }) }),
    executeClose: (id: string, prepareToken: string) => fetchApi<ApiResponse<any>>(`/api/trade/positions/${id}/close/execute`, { method: 'POST', body: JSON.stringify({ prepare_token: prepareToken, confirmation: 'EXECUTE LIVE CLOSE' }) })
  }
};
