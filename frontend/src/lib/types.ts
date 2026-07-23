export type ChainId = 'sol' | 'bsc' | 'base' | 'eth' | 'robinhood';
export type ActivityType = 'tweet' | 'retweet' | 'quote' | 'reply' | 'follow' | 'unfollow';
export type SignalStatus = 'signal_only' | 'pending' | 'pending_risk' | 'approved' | 'execution_reserved' | 'rejected' | 'executed' | 'expired' | 'recorded';
export type ExecutionMode = 'signal' | 'paper' | 'live' | 'unknown';
export type PositionStatus = 'pending' | 'open' | 'open_unprotected' | 'open_protected' | 'partially_closed' | 'closing' | 'closed' | 'protection_failed' | 'close_uncertain' | 'tp_hit' | 'sl_hit' | 'manual_close' | 'failed';
export type SignalType = 'handle_match' | 'ca_mention' | 'ticker_mention';

export interface XSignalRelation {
  id?: string;
  whitelist_id?: string;
  kol_id?: string;
  actor_handle: string;
  actor_display_name?: string;
  target_x_handle: string;
  enabled?: boolean;
}

export interface WhitelistEntry {
  id: string;
  contract_address: string;
  chain_id: ChainId;
  symbol: string;
  project_name: string;
  project_x_handles: string[];
  relations: XSignalRelation[];
  budget_per_trade: number;
  total_budget: number;
  spent_budget: number;
  auto_tp_pct: number;
  auto_sl_pct: number;
  slippage: number;
  allow_repeat_buy: boolean;
  max_repeat_buys: number;
  current_buy_count: number;
  paper_spent_budget: number;
  paper_buy_count: number;
  status: 'active' | 'paused' | 'exhausted' | 'expired';
  created_at: string;
  updated_at: string;
}

export interface KolAccount {
  id: string;
  x_user_id: string;
  x_handle: string;
  display_name: string;
  chain_ids: ChainId[];
  weight: number;
  enabled: boolean;
  follow_baseline_completed_at?: string;
  follow_poll_status?: string;
  stream_status?: string;
  stream_active_at?: string;
  last_active_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface XActivity {
  id: string;
  kol_id: number;
  kol_handle: string;
  activity_type: ActivityType;
  tweet_id: string;
  tweet_text: string;
  target_x_handle?: string;
  target_x_handles?: string[];
  extracted_cas: string[];
  extracted_tickers: string[];
  processed: boolean;
  provider?: string;
  observation_started_at?: string;
  observation_ended_at?: string;
  created_at: string;
}

export interface X6551Status {
  provider: string;
  configured: boolean;
  wss: {
    enabled: boolean;
    status: string;
    lockHeld: boolean;
    connectedAt: string | null;
    subscribedAt: string | null;
    connectionAgeMs: number | null;
    lastMessageAt: string | null;
    lastPongAt: string | null;
    reconnectCount: number;
    consecutiveFailures: number;
    reconnectAlerted: boolean;
    eventsReceived: number;
    lastError: string | null;
    source?: 'service_heartbeat' | 'local_process';
    serviceRole?: string;
    heartbeatAt?: string | null;
    heartbeatAgeMs?: number | null;
    heartbeatFresh?: boolean;
    heartbeatStaleAfterMs?: number;
  };
  watches: {
    byStatus: Record<string, number>;
    total: number;
    managed: number;
  };
  inbox: {
    byStatus: Record<string, number>;
    total: number;
    today: number;
    month: number;
    unknown: number;
    lastReceivedAt: string | null;
  };
  usage: {
    rest: Record<string, unknown>;
    messages: {
      observedMonth: number;
      monthlyLimit: number;
      usagePct: number;
      projectedMonth: number;
      level: string;
      source: string;
    };
  };
  safety: {
    tradingMode: string;
    engineArmed: boolean;
    watchApplyEnabled: boolean;
  };
}

export interface X6551WatchPlanEntry {
  username: string;
  roles: string[];
  desiredFlags: Record<string, boolean>;
  remoteFlags: Record<string, boolean> | null;
  remotePresent: boolean;
  managed: boolean;
  action: string;
  blocker: string | null;
  estimatedPoints: number;
}

export interface X6551WatchPlan {
  provider: '6551';
  entries: X6551WatchPlanEntry[];
  actions: X6551WatchPlanEntry[];
  adoptionRequired: X6551WatchPlanEntry[];
  blockers: X6551WatchPlanEntry[];
  estimatedPoints: number;
  desiredCount: number;
  remoteCount: number;
  managedCount: number;
}

export interface TradeSignal {
  id: string;
  type: SignalType;
  kol_id: string;
  kol_handle: string;
  kol_weight: number;
  activity_id: string;
  activity_type: ActivityType;
  ca: string;
  project_name: string;
  chain: ChainId;
  status: SignalStatus;
  execution_mode: ExecutionMode;
  reject_reason?: string;
  created_at: string;
  match_detail: string;
  signal_type?: SignalType;
  symbol?: string;
  chain_id?: ChainId;
  contract_address?: string;
  provider?: string;
  source_created_at?: string;
  observation_started_at?: string;
  observation_ended_at?: string;
  live_authorization?: 'record_only' | 'manual_allowed' | 'auto_allowed';
}

export interface Position {
  id: string;
  signal_id: string;
  whitelist_id: string;
  contract_address: string;
  chain_id: ChainId;
  symbol: string | null;
  amount_in: number;
  amount_out: number;
  entry_price: number;
  exit_price?: number;
  tp_pct: number;
  sl_pct: number;
  tpsl_status: string;
  pnl: number | null;
  pnl_pct: number | null;
  status: PositionStatus;
  execution_mode: ExecutionMode;
  opened_at: string;
  closed_at?: string;
  kol_handle?: string;
  signal_type?: string;
  kol_weight?: number;
  risk_check?: Record<string, boolean>;
  sim_peaks?: {
    max_gain_pct: number;
    max_loss_pct: number;
    peaks_5m: { high: number; low: number };
    peaks_15m: { high: number; low: number };
    peaks_1h: { high: number; low: number };
    peaks_4h: { high: number; low: number };
  };
  sell_tx_hash?: string;
  buy_tx_hash?: string;
}

export interface TradeAttempt {
  id: string;
  signal_id?: string;
  position_id?: string;
  side: 'buy' | 'sell' | 'strategy_create' | 'strategy_cancel';
  chain: Exclude<ChainId, 'robinhood'>;
  wallet_address: string;
  input_token: string;
  output_token: string;
  input_amount_raw: string;
  output_amount_raw?: string;
  status: string;
  error_code?: string;
  requires_manual_review: boolean;
  created_at: string;
  submitted_at?: string;
  confirmed_at?: string;
  order_id?: string;
  provider_order_id?: string;
  tx_hash?: string;
  provider_status?: string;
  order_status?: string;
  last_queried_at?: string;
  next_query_at?: string;
  query_count?: number;
  query_stage?: string;
}

export interface TradeReadiness {
  generatedAt: string;
  snapshotHash: string | null;
  mode: string;
  armed: boolean;
  liveEnabled: boolean;
  readyToArm: boolean;
  blockers: string[];
  advisories: string[];
  checks: Record<string, boolean | number>;
  chains: Array<{
    chain: 'sol' | 'bsc' | 'base' | 'eth';
    implemented: boolean;
    contract_tested: boolean;
    contract_evidence?: {
      id: string | number | null;
      type: 'contract_probe';
      status: 'passed' | 'failed';
      createdAt: string | null;
      whitelistIds: number[];
    } | null;
    policy_enabled: boolean;
    ready: boolean;
    blockers: string[];
    wallet_address?: string | null;
    native_balance?: number | null;
    native_balances?: Array<{ symbol?: string; balance?: string | number; amount?: string | number }>;
    rpc_probe?: {
      ok: boolean;
      chain: string;
      identity?: string;
      blockRef?: string;
      error?: string;
    } | null;
    trade_evidence: {
      confirmedBuys: number;
      confirmedSells: number;
      confirmedOrders: number;
      confirmedReceipts: number;
      lastConfirmedAt: string | null;
    };
    limits?: {
      enabled?: boolean;
      maxPerTrade?: number;
      dailyBudget?: number;
      weeklyBudget?: number;
      maxOpenPositions?: number;
    };
  }>;
  scheduler: {
    state: string;
    officialRate: number;
    officialCapacity: number;
    configuredRate: number;
    configuredCapacity: number;
    currentRate: number;
    availableWeight: number;
    reservedWeight: number;
    reservedLastSecond: number;
    consumedLastSecond: number;
    reservedOrConsumedLastSecond: number;
    queueDepth: number;
    queueByPriority: Record<string, number>;
    cooldownUntil: number | null;
    last429At: number | null;
    resetAt: number | null;
    endpointWeights: Record<string, number>;
  };
  cache: { total: number; fresh: number; stale: number };
  cacheRequired: { total: number; missing: string[]; ready: boolean };
  cacheWarmer: {
    running: boolean;
    active: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    processed: number;
    batchSize: number;
  };
  latencySlo: {
    windowHours: number;
    requiredSamples: number;
    passed: boolean;
    inbox: { count: number; p50: number | null; p95: number | null; p99: number | null };
    signal: { count: number; p50: number | null; p95: number | null; p99: number | null };
    execution: { count: number; p50: number | null; p95: number | null; p99: number | null };
    receiveToSwap: { count: number; p50: number | null; p95: number | null; p99: number | null };
  };
  contractProbes: Record<string, { ok: boolean; chain: string; error?: string }>;
  relations: Array<{
    id: number;
    whitelistId: number;
    actorHandle: string;
    targetHandle: string;
  }>;
  latestEvidence: {
    providerEventId: string | null;
    activityId: number | null;
    signalId: number | null;
    signalStatus: string | null;
    attemptId: number | null;
    attemptStatus: string | null;
    providerOrderId: string | null;
    txHash: string | null;
    receiptStatus: string | null;
    signalCreatedAt: string | null;
  } | null;
  reconciler: {
    running: boolean;
    active: boolean;
    lastRunAt: string | null;
    lastSuccessAt: string | null;
    lastError: string | null;
    processed: number;
    backlog: Array<{ status: string; count: number; oldest: string | null }>;
    strategyBacklog: Array<{ status: string; count: number; oldest: string | null }>;
  };
  pollingPolicy: Array<{ fromSeconds: number; toSeconds: number | null; intervalMs: number | number[] }>;
  policy?: {
    providers: string[];
    eventTypes: string[];
    verifiedEventTypes: string[];
    chains: string[];
    whitelistIds: number[];
    maxSignalAgeSeconds: number;
  };
}

export interface TradeRuntimePolicy {
  scheduler: TradeReadiness['scheduler'];
  polling_policy: TradeReadiness['pollingPolicy'];
  readiness: TradeReadiness;
  endpoint_weights: Record<string, number>;
  new_trade_reservation_weight: number;
  live_queue: {
    running: boolean;
    scannerRunning: boolean;
    listenerConnected: boolean;
    lastNotificationAt: string | null;
    queueDepth: number;
    processed: number;
    lastError: string | null;
    lastExecutionAt: string | null;
  };
}

export interface ChainConfig {
  chainId: ChainId;
  enabled: boolean;
  dailyBudget: number;
  weeklyBudget: number;
  maxPerTrade: number;
  maxOpenPositions: number;
  dailyLossLimit: number;
  defaultTpPercent: number;
  defaultSlPercent: number;
  defaultSlippagePercent: number;
}

export interface RiskConfig {
  securityCheckEnabled: boolean;
  maxTaxThreshold: number;
  minLiquidityUsd: number;
  maxSlippageAllowed: number;
  consecutiveLossLimit: number;
  caCooldownSeconds: number;
}

export interface XMonitorConfig {
  pollIntervalMs: number;
  maxKolPerRound: number;
}

export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  code?: string;
  details?: unknown;
  meta?: {
    merged_into_existing?: boolean;
    added_relations?: number;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total?: number;
  page?: number;
  pageSize?: number;
}
