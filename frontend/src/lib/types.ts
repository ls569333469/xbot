export type ChainId = 'sol' | 'bsc' | 'base' | 'eth' | 'robinhood';
export type ActivityType = 'tweet' | 'retweet' | 'quote' | 'reply' | 'follow';
export type SignalStatus = 'pending' | 'approved' | 'rejected' | 'executed' | 'expired' | 'recorded';
export type PositionStatus = 'pending' | 'open' | 'tp_hit' | 'sl_hit' | 'manual_close' | 'failed';
export type SignalType = 'handle_match' | 'ca_mention' | 'ticker_mention';

export interface WhitelistEntry {
  id: string;
  contract_address: string;
  chain_id: ChainId;
  symbol: string;
  project_name: string;
  project_x_handles: string[];
  budget_per_trade: number;
  total_budget: number;
  spent_budget: number;
  auto_tp_pct: number;
  auto_sl_pct: number;
  slippage: number;
  allow_repeat_buy: boolean;
  max_repeat_buys: number;
  current_buy_count: number;
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
  extracted_cas: string[];
  extracted_tickers: string[];
  processed: boolean;
  created_at: string;
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
  reject_reason?: string;
  created_at: string;
  match_detail: string;
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
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total?: number;
  page?: number;
  pageSize?: number;
}
