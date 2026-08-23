export type ChainId = 'sol' | 'bsc' | 'base' | 'eth' | 'robinhood';
export type EcosystemTag = ChainId | 'cross_chain';
export type ActivityType = 'tweet' | 'retweet' | 'quote' | 'reply' | 'follow' | 'unfollow';
export type SignalStatus = 'signal_only' | 'pending' | 'pending_risk' | 'approved' | 'execution_reserved' | 'rejected' | 'executed' | 'expired' | 'recorded';
export type ExecutionMode = 'signal' | 'paper' | 'live' | 'unknown';
export type PositionStatus = 'pending' | 'open' | 'open_unprotected' | 'open_protected' | 'partially_closed' | 'closing' | 'closed' | 'protection_failed' | 'close_uncertain' | 'tp_hit' | 'sl_hit' | 'manual_close' | 'failed';
export type SignalType = 'handle_match' | 'ca_mention' | 'ticker_mention' | 'dynamic_keyword' | 'follow_discovery';
export type StrategyType = 'fixed_ca' | 'dynamic_policy' | 'follow_discovery' | 'unknown';
export type EntityId = string | number;
export type TradeIntentStatus = 'created' | 'submitting' | 'awaiting_result' |
  'retry_verifying' | 'retry_scheduled' | 'confirmed' | 'exhausted' |
  'rejected' | 'uncertain' | 'cancelled';

export interface XSignalRelation {
  id?: string;
  whitelist_id?: string;
  kol_id?: string;
  actor_handle: string;
  actor_display_name?: string;
  target_x_handle: string;
  event_types: Array<Exclude<ActivityType, 'tweet' | 'unfollow'>>;
  enabled?: boolean;
  watch_sync_status?: 'pending' | 'processing' | 'succeeded' | 'failed' | 'in_sync' | 'observed' | string;
  watch_sync_error?: string | null;
  watch_synced_at?: string | null;
}

export type ExitStrategyLeg =
  | { type: 'take_profit'; trigger_pct: number; sell_pct: number }
  | { type: 'stop_loss'; drop_pct: number; sell_pct: number }
  | { type: 'trailing_take_profit'; activation_pct: number; drawdown_pct: number; sell_pct: number }
  | { type: 'trailing_stop_loss'; drop_pct: number; drawdown_pct: number; sell_pct: number };

export interface ExitStrategy {
  version: 1;
  sell_ratio_type: 'buy_amount';
  legs: ExitStrategyLeg[];
}

export interface XDirectSource {
  id?: string;
  actor_handle: string;
  actor_display_name?: string;
  event_types: Array<Exclude<ActivityType, 'follow' | 'unfollow'>>;
  match_mode: 'ca_only';
  source_kind: 'project' | 'ecosystem' | 'launch';
  role?: string;
  watch_sync_status?: string;
  watch_sync_error?: string | null;
}

export interface WhitelistProjectAccount {
  id?: string;
  handle: string;
  role: string;
  usage: 'identity' | 'direct_source' | 'interaction_target';
  evidence_snapshot?: Record<string, unknown>;
}

export interface WhitelistEntry {
  id: string;
  launch_rule_id?: string | null;
  contract_address: string;
  chain_id: ChainId;
  symbol: string;
  project_name: string;
  project_x_handles: string[];
  relations: XSignalRelation[];
  direct_sources: XDirectSource[];
  project_accounts: WhitelistProjectAccount[];
  relation_count?: number;
  ecosystem_source_count?: number;
  launch_source_count?: number;
  selected_actor_handles?: string[];
  budget_per_trade: number;
  total_budget: number;
  spent_budget: number;
  auto_tp_pct: number;
  auto_sl_pct: number;
  exit_strategy: ExitStrategy;
  exit_strategy_version: number;
  slippage: number;
  allow_repeat_buy: boolean;
  max_repeat_buys: number;
  current_buy_count: number;
  paper_spent_budget: number;
  paper_buy_count: number;
  status: 'active' | 'paused' | 'exhausted' | 'expired' | 'archived';
  live_activation_state: 'syncing' | 'live_ready' | 'sync_failed';
  activation_version: number;
  activation_error_code?: string | null;
  activation_error_detail?: string | null;
  activation_checked_at?: string | null;
  activated_at?: string | null;
  created_at: string;
  updated_at: string;
  token_logo_url?: string | null;
  token_official_x_handle?: string | null;
  token_website_url?: string | null;
  token_metadata_source?: string | null;
  token_metadata_fetched_at?: string | null;
}

export interface WhitelistTemplateSnapshot {
  schema_version: 2;
  budget_per_trade: number;
  total_budget: number;
  slippage: number;
  allow_repeat_buy: boolean;
  max_repeat_buys: number;
  exit_strategy: ExitStrategy;
  relation_event_types: Array<Exclude<ActivityType, 'tweet' | 'unfollow'>>;
  direct_source_event_types: Array<Exclude<ActivityType, 'follow' | 'unfollow'>>;
  direct_source_rule_enabled: boolean;
  direct_source_actor_handles: string[];
  relation_rule_enabled: boolean;
  relation_actor_handles: string[];
  relation_target_policy: 'all_selected_project_identities';
}

export interface WhitelistTemplate {
  id: string;
  name: string;
  chain_id: ChainId;
  template_snapshot: WhitelistTemplateSnapshot;
  version: number;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface LaunchMonitorSource {
  id?: string;
  actor_handle: string;
  actor_display_name?: string;
  role: string;
  event_types: Array<Exclude<ActivityType, 'follow' | 'unfollow'>>;
  enabled?: boolean;
}

export interface LaunchMonitorRelation {
  id?: string;
  actor_handle: string;
  actor_display_name?: string;
  target_x_handle: string;
  event_types: Array<Extract<ActivityType, 'retweet' | 'quote' | 'reply'>>;
  enabled?: boolean;
}

export interface LaunchMonitorDiscovery {
  id: string;
  chain_id: ChainId;
  contract_address: string;
  whitelist_id: string;
  signal_id?: string | null;
  trigger_kind: 'project_source' | 'ecosystem_relation';
  actor_handle: string;
  target_x_handle?: string | null;
  created_at: string;
}

export interface LaunchMonitor {
  id: string;
  chain_id: ChainId;
  project_name?: string | null;
  sources: LaunchMonitorSource[];
  relations: LaunchMonitorRelation[];
  discoveries: LaunchMonitorDiscovery[];
  budget_per_trade: number;
  total_budget: number;
  slippage: number;
  allow_repeat_buy: boolean;
  max_repeat_buys: number;
  exit_strategy: ExitStrategy;
  exit_strategy_version: number;
  status: 'active' | 'paused' | 'triggered' | 'expired';
  discovery_count: number;
  triggered_at?: string | null;
  expires_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface TokenMetadata {
  chain: ChainId;
  address: string;
  name: string;
  symbol: string;
  decimals: number | null;
  logo_url: string | null;
  official_x_handle: string | null;
  social_source_status?: 'found' | 'missing' | 'invalid';
  website_url: string | null;
  source: 'gmgn';
  fetched_at: string;
}

export interface ResearchCandidate {
  handle: string;
  display_name: string;
  role: string;
  organization: string;
  association?: string;
  confidence: 'verified' | 'high' | 'medium' | 'low' | 'unverified';
  verified: boolean;
  source: string;
  evidence: Array<{ label: string; url?: string | null; tweet_id?: string | null; source?: string | null }>;
  selected?: boolean;
}

export interface TokenResearchReport {
  id: string;
  chain_id: ChainId;
  contract_address: string;
  status: 'pending' | 'completed' | 'partial' | 'failed';
  provider_snapshot: {
    metadata: TokenMetadata;
    security?: Record<string, unknown>;
    pool?: Record<string, unknown>;
    sources?: string[];
    xai?: {
      status?: 'completed' | 'insufficient' | 'failed';
      summary?: string;
      citations?: string[];
      duration_ms?: number;
      error_code?: string;
      usage?: Record<string, unknown> | null;
      grok_request_attempts?: number;
      search_tool_calls?: number;
    };
  };
  social_resolution?: {
    status: 'pending' | 'searching' | 'format_repair' | 'targeted_followup' | 'result_ready' | 'gmgn_confirmed' | 'grok_verified' | 'grok_candidate' | 'insufficient' | 'provider_failed';
    gmgn_status: 'found' | 'missing' | 'invalid';
    official_handle?: string | null;
    source?: 'gmgn' | 'grok' | 'gmgn+grok' | null;
    confidence?: 'verified' | 'high' | 'medium' | 'low' | 'unverified' | null;
    grok_request_attempts: number;
    grok_request_limit: 2;
    search_tool_calls: number;
    search_tool_call_limit: 8;
    second_request_reason?: 'format_repair' | 'targeted_followup' | null;
    last_error_code?: string | null;
    retry_allowed: boolean;
  };
  candidates: ResearchCandidate[];
  analyzer_version: string;
  prompt_version?: string;
  model_name?: string | null;
  xai_duration_ms?: number | null;
  xai_error_code?: string | null;
  analysis_started_at?: string | null;
  analysis_finished_at?: string | null;
  fetched_at: string;
  expires_at: string;
}

export interface ResearchJobItem {
  id: string;
  job_id: string;
  chain_id: ChainId;
  contract_address: string;
  status: 'queued' | 'gmgn' | 'grok' | 'verification' | 'completed' | 'failed' | 'cancelled';
  report_id?: string | null;
  report?: TokenResearchReport | null;
  attempt_count: number;
  error_code?: string | null;
  error_message?: string | null;
  duration_ms?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface ResearchJob {
  id: string;
  chain_id: ChainId;
  mode: 'single' | 'batch';
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  total_count: number;
  completed_count: number;
  failed_count: number;
  cancelled_count: number;
  concurrency_limit: number;
  prompt_version: string;
  started_at?: string | null;
  finished_at?: string | null;
  queue_status?: {
    worker_running: boolean;
    admission_allowed: boolean;
    wait_reason?: 'GMGN_COOLDOWN' | 'TRADE_PROVIDER_LEASE_ACTIVE' | 'TRADE_PROVIDER_QUEUE_ACTIVE' | 'TRADE_CAPACITY_RESERVED' | 'RESEARCH_WORKER_BUSY' | null;
    retry_at?: number | string | null;
    live_mode: boolean;
    effective_concurrency: number;
    last_run_at?: string | null;
  };
  items: ResearchJobItem[];
}

export type WhitelistDraftPayload = Partial<WhitelistEntry> & {
  candidates?: ResearchCandidate[];
  template_id?: string | null;
  relation_event_types?: WhitelistTemplateSnapshot['relation_event_types'];
  direct_source_event_types?: WhitelistTemplateSnapshot['direct_source_event_types'];
  direct_source_rule_enabled?: boolean;
  direct_source_actor_handles?: string[];
  relation_rule_enabled?: boolean;
  relation_actor_handles?: string[];
  relation_target_handles?: string[];
  relation_target_policy?: 'all_selected_project_identities' | 'manual';
};

export interface KolLabel {
  id: string;
  name: string;
  account_count: number;
  created_at?: string;
  updated_at?: string;
}

export interface KolAccount {
  id: string;
  x_user_id: string;
  x_handle: string;
  display_name: string;
  chain_ids: EcosystemTag[];
  custom_labels: Array<Pick<KolLabel, 'id' | 'name'>>;
  custom_label_ids?: string[];
  weight: number;
  enabled: boolean;
  profile_status?: 'verified' | 'pending';
  profile_warning?: string;
  profile_attempt_count?: number;
  profile_last_checked_at?: string | null;
  profile_next_retry_at?: string | null;
  profile_verified_at?: string | null;
  profile_last_error_code?: string | null;
  follow_baseline_completed_at?: string;
  follow_poll_status?: string;
  stream_status?: string;
  stream_active_at?: string;
  last_active_at?: string;
  created_at?: string;
  updated_at?: string;
}

export interface DynamicPolicy {
  id: string;
  kol_id: string;
  x_handle: string;
  display_name?: string;
  mode: 'record' | 'paper' | 'live' | 'paused';
  enabled: boolean;
  allowed_chain_ids: ChainId[];
  allowed_event_types: Array<'tweet' | 'quote' | 'reply'>;
  allowed_term_types: Array<'ca' | 'cashtag' | 'hashtag' | 'approved_name'>;
  approved_aliases: Array<string | { name: string; normalized?: string }>;
  preset_asset_routes: DynamicPresetAssetRoute[];
  chain_budgets: Record<ChainId, DynamicChainBudget>;
  budget_per_trade: number;
  daily_budget: number;
  daily_new_token_limit: number;
  per_token_buy_limit: number;
  slippage: number;
  exit_strategy: ExitStrategy;
  resolver_options: Record<string, unknown>;
  revision: number;
  context_hash: string;
  watch_sync_status?: 'pending' | 'processing' | 'succeeded' | 'failed' | string | null;
  watch_sync_error?: string | null;
  watch_synced_at?: string | null;
  watch_desired_version?: number | null;
  updated_at?: string;
}

export interface DynamicPresetAssetRouteInput {
  route_id?: EntityId | null;
  label: string;
  aliases: string[];
  chain_id: ChainId;
  contract_address: string;
  enabled: boolean;
}

export interface DynamicPresetAssetRoute extends DynamicPresetAssetRouteInput {
  route_id: EntityId;
  variant_id: EntityId;
  asset_family_id?: EntityId | null;
  verification: {
    status: 'verified';
    source: 'local_rpc';
    verified_at: string;
    error_code: null;
    snapshot?: Record<string, unknown>;
  };
}

export type DynamicPolicyInput = Omit<Partial<DynamicPolicy>, 'preset_asset_routes'> & {
  preset_asset_routes?: DynamicPresetAssetRouteInput[];
};

export interface DynamicPresetRouteMatchPreview {
  status: 'none' | 'matched' | 'ambiguous' | 'conflict' | 'binding_required' | 'invalid';
  failure_code?: string | null;
  matched_route_ids: EntityId[];
  candidate?: {
    presetRouteId?: EntityId;
    routeLabel?: string;
    chainId?: ChainId;
    contractAddress?: string;
    matchedAliases?: string[];
  } | null;
  intent?: { intentClass?: string; reasonCodes?: string[] };
  normalized_terms: Array<Record<string, unknown>>;
}

export interface DynamicChainBudget {
  budget_per_trade: number;
  daily_budget: number;
}

export type DynamicPolicyTemplateConfig = Pick<DynamicPolicy,
  'allowed_chain_ids' | 'allowed_event_types' | 'allowed_term_types' |
  'approved_aliases' | 'chain_budgets' | 'daily_new_token_limit' |
  'per_token_buy_limit' | 'slippage' | 'exit_strategy' | 'resolver_options'> & {
  preset_asset_routes: DynamicPresetAssetRouteInput[];
};

export interface DynamicPolicyTemplate {
  id: string;
  name: string;
  config: DynamicPolicyTemplateConfig;
  version: number;
  created_at?: string;
  updated_at?: string;
}

export interface FollowDiscoveryPolicy {
  id: string;
  kol_id: string;
  x_user_id: string;
  x_handle: string;
  display_name?: string;
  mode: 'record' | 'paper' | 'live' | 'paused';
  enabled: boolean;
  allowed_chain_ids: ChainId[];
  trade_template_id?: string | null;
  trade_template_name?: string | null;
  trade_config_snapshot: Pick<DynamicPolicyTemplateConfig,
    'chain_budgets' | 'daily_new_token_limit' | 'per_token_buy_limit' | 'slippage' | 'exit_strategy'>;
  resolver_options: {
    event_ttl_seconds: number;
    max_tweets: number;
    minimum_account_age_days: number;
    include_profile_website: boolean;
    require_original_content: boolean;
  };
  revision: number;
  context_hash: string;
  baseline_at: string;
  watch_sync_status?: string | null;
  watch_sync_error?: string | null;
  watch_synced_at?: string | null;
  watch_desired_present?: boolean | null;
  updated_at?: string;
}

export interface FollowDiscoveryPrompts {
  version: number;
  kol_research_version: number;
  fast_prompt: string;
  relationship_prompt: string;
  kol_research_prompt: string;
  source: 'default' | 'stored';
  updated_at?: string | null;
  prompt_version: string;
}

export interface FollowDiscoveryEvent {
  id: string;
  policy_id: string;
  actor_handle: string;
  target_user_id: string;
  target_handle: string;
  mode: 'record' | 'paper' | 'live';
  status: 'baseline' | 'pending' | 'processing' | 'resolved' | 'rejected' | 'failed' | 'cancelled';
  stage: string;
  project_classification?: string | null;
  classification_confidence?: string | null;
  chain_id?: ChainId | null;
  contract_address?: string | null;
  failure_code?: string | null;
  last_error?: string | null;
  provider_created_at: string;
  policy_revision: number;
  current_policy_revision: number;
}

export interface AccountResearchGrokResult {
  status: 'analyzed' | 'insufficient';
  account_type: 'kol' | 'trader' | 'researcher' | 'project' | 'person' | 'organization' | 'unknown';
  summary?: string | null;
  project_name?: string | null;
  project_handle?: string | null;
  relationship?: string | null;
  candidates: Array<{
    address: string;
    chain_id: ChainId;
    confidence: 'high' | 'medium' | 'low';
    primary_evidence_id: string;
  }>;
  evidence: Array<{
    evidence_id: string;
    source_type: 'bio' | 'tweet' | 'website' | 'other';
    url?: string | null;
    tweet_id?: string | null;
    handle?: string | null;
    published_at?: string | null;
    excerpt?: string | null;
  }>;
  citations: string[];
  style_tags: string[];
  strengths: string[];
  risks: string[];
  qualitative_rating: 'promising' | 'watch' | 'high_risk' | 'insufficient';
  model?: string;
  prompt_version?: string;
  duration_ms?: number;
  search_tool_calls?: number;
}

export interface AccountReturnSample {
  sample_key?: string;
  tweet_id?: string;
  event_id?: string;
  target_handle?: string;
  chain: ChainId;
  contract_address: string;
  token_name?: string | null;
  token_symbol?: string | null;
  event_time?: string;
  event_time_unix?: number;
  entry_price?: number;
  close_price_24h?: number;
  high_price_24h?: number;
  close_multiple_24h?: number;
  max_multiple_24h?: number;
  return_24h_pct: number;
  max_gain_24h_pct?: number | null;
  entry_candle_at?: number | null;
  close_candle_at?: number | null;
  entry_method?: string;
  kline_resolution?: string;
}

export interface AccountPerformanceResearch {
  metric_version: string;
  status: 'completed' | 'partial' | 'deferred';
  sample_size: number;
  sample_snapshot?: Array<{
    id: string;
    text: string;
    created_at: string;
    is_reply?: boolean;
    is_retweet?: boolean;
    is_quote?: boolean;
  }>;
  sample_window?: { started_at?: string | null; ended_at?: string | null; requested_limit?: number };
  direct_intent_rate?: number | null;
  ca_resolution_rate?: number | null;
  ambiguity_rate?: number | null;
  provider_coverage_rate?: number | null;
  historical_candidate_coverage_rate?: number | null;
  false_positive_rate?: number | null;
  win_rate_24h?: number | null;
  return_snapshot?: {
    kline_source?: string;
    benchmark?: string;
    samples?: AccountReturnSample[];
    median_return_24h_pct?: number | null;
    median_max_gain_24h_pct?: number | null;
    median_close_multiple_24h?: number | null;
    median_max_multiple_24h?: number | null;
  };
  metrics?: {
    direct?: number;
    resolved?: number;
    ambiguous?: number;
    coverage?: number;
    tweets?: number;
    asset_posts?: number;
    eligible_posts?: number;
    explicit_ca_posts?: number;
    return_samples?: number;
    return_sample_limit?: number;
    kline_attempts?: number;
    kline_reused?: number;
    provider_kline_calls?: number;
    kline_skipped?: number;
    kline_errors?: Record<string, number>;
    chain_resolution?: Record<string, number>;
    attempt_count?: number;
    max_attempts?: number;
    retry_at?: string | null;
  };
  recommendation: 'approve_for_record' | 'watch' | 'insufficient_data';
  reason_codes?: string[];
  error_code?: string | null;
  last_error?: string | null;
}

export interface AccountFollowPerformanceResearch {
  metric_version: string;
  status: 'completed' | 'partial' | 'deferred';
  x_handle: string;
  follow_event_count: number;
  resolved_ca_event_count: number;
  unique_ca_trigger_count: number;
  mature_24h_count: number;
  ca_trigger_rate?: number | null;
  win_rate_24h?: number | null;
  event_snapshot?: Array<{
    id: string;
    target_handle?: string;
    status: string;
    chain_id?: ChainId | null;
    contract_address?: string | null;
    provider_created_at: string;
    failure_code?: string | null;
    token_name?: string | null;
    token_symbol?: string | null;
    prompt_version?: string | null;
  }>;
  return_snapshot?: {
    kline_source?: string;
    benchmark?: string;
    samples?: AccountReturnSample[];
    median_return_24h_pct?: number | null;
    median_max_gain_24h_pct?: number | null;
    median_close_multiple_24h?: number | null;
    median_max_multiple_24h?: number | null;
  };
  metrics?: {
    return_samples?: number;
    return_sample_limit?: number;
    kline_attempts?: number;
    kline_reused?: number;
    kline_skipped?: number;
    kline_errors?: Record<string, number>;
    provider_kline_calls?: number;
    attempt_count?: number;
    max_attempts?: number;
    retry_at?: string | null;
  };
  recommendation: 'watch' | 'insufficient_data';
  reason_codes?: string[];
  error_code?: string | null;
  last_error?: string | null;
}

export interface AccountResearchResult {
  id: string;
  x_handle: string;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  sample_size: number;
  direct_intent_rate?: number | null;
  ca_resolution_rate?: number | null;
  ambiguity_rate?: number | null;
  provider_coverage_rate?: number | null;
  historical_candidate_coverage_rate?: number | null;
  executable_win_rate?: number | null;
  false_positive_rate?: number | null;
  recommendation: 'approve_for_record' | 'watch' | 'reject' | 'insufficient_data';
  reason_codes?: string[];
  metrics?: {
    grok?: {
      status: 'completed' | 'failed';
      result?: AccountResearchGrokResult | null;
      error?: { code: string; message: string } | null;
      reused?: boolean;
    };
    follow_performance?: {
      status: 'completed' | 'partial' | 'deferred' | 'failed';
      result?: AccountFollowPerformanceResearch | null;
      error?: { code: string; message: string } | null;
      reused?: boolean;
    };
    performance?: {
      status: 'completed' | 'partial' | 'deferred' | 'failed';
      result?: AccountPerformanceResearch | null;
      error?: { code: string; message: string } | null;
      reused?: boolean;
    };
  };
  error_code?: string | null;
  last_error?: string | null;
}

export interface AccountResearchRun {
  id: string;
  input_handles: string[];
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  created_at: string;
  results?: AccountResearchResult[];
  result_count?: number;
  completed_count?: number;
  finished_count?: number;
  failed_count?: number;
  recommended_count?: number;
  discovered_count?: number;
  deduplicated?: boolean;
}

export type KolPerformanceMode = 'post_calls' | 'follow_discovery';
export type KolPerformanceRunStatus = 'pending' | 'extracting' | 'pricing' | 'completed' | 'no_samples' | 'partial' | 'price_retry' | 'price_unavailable' | 'failed';

export interface KolPerformanceEvent {
  id: string;
  source_type: 'tweet' | 'reply' | 'quote' | 'follow';
  source_id: string;
  source_url?: string | null;
  target_handle?: string | null;
  source_occurred_at: string;
  extraction_status: 'resolved' | 'no_match' | 'ambiguous' | 'provider_failed';
  chain_id?: ChainId | null;
  contract_address?: string | null;
  token_name?: string | null;
  token_symbol?: string | null;
  content_snapshot?: Record<string, unknown>;
  evidence_json?: Record<string, unknown>;
}

export interface KolPerformanceAsset {
  id: string;
  first_event_id: string;
  chain_id: ChainId;
  contract_address: string;
  token_name?: string | null;
  token_symbol?: string | null;
  entry_price?: number | string | null;
  entry_candle_at?: string | null;
  peak_price?: number | string | null;
  peak_candle_at?: string | null;
  peak_multiple?: number | string | null;
  price_status: 'pending' | 'completed' | 'retry' | 'no_data' | 'failed';
  price_error_code?: string | null;
  price_error_detail?: string | null;
  source_type: 'tweet' | 'reply' | 'quote' | 'follow';
  source_id: string;
  source_url?: string | null;
  target_handle?: string | null;
  source_occurred_at: string;
  evidence_json?: Record<string, unknown>;
}

export interface KolPerformanceMetrics {
  raw_event_count?: number;
  parsed_ca_count?: number;
  unique_ca_count?: number;
  price_ready_ca_count?: number;
  missing_price_ca_count?: number;
  win_rate?: number | null;
  average_peak_multiple?: number | null;
  median_peak_multiple?: number | null;
  best_peak_multiple?: number | null;
  pending_price_ca_count?: number;
  grok_lookup_count?: number;
  grok_batch_count?: number;
  grok_post_count?: number;
  grok_request_count?: number;
  grok_search_tool_calls?: number;
  direct_ca_count?: number;
  candidate_post_count?: number;
  provider_failed_count?: number;
  source_request_count?: number;
  source_primary_request_count?: number;
  source_successful_request_count?: number;
  source_coverage_complete?: boolean;
  source_saturated_segment_count?: number;
  source_unprocessed_segment_count?: number;
  source_window_started_at?: string | null;
  source_window_ended_at?: string | null;
  source_earliest_at?: string | null;
  source_latest_at?: string | null;
  source_type_counts?: Partial<Record<'tweet' | 'quote' | 'reply' | 'follow', number>>;
  source_coverage_reason?: string | null;
  source_error_code?: string | null;
  source_error_detail?: string | null;
  source_retry_after_ms?: number;
  reply_sample_request_count?: number;
  reply_sample_count?: number;
  reply_sample_complete?: boolean;
  reply_sample_error_code?: string | null;
  reply_sample_error_detail?: string | null;
  provider_kline_calls?: number;
  cache_hit_count?: number;
  progress?: {
    stage?: 'source_loading' | 'event_loading' | 'follow_research' | 'ca_extraction' | 'pricing' | 'paused' | 'finished';
    total_assets?: number;
    processed_assets?: number;
    successful_assets?: number;
    unavailable_assets?: number;
    source_event_count?: number;
    total_follow_events?: number;
    processed_follow_events?: number;
    resolved_follow_events?: number;
    failed_follow_events?: number;
    current_follow_index?: number | null;
    current_target_handle?: string | null;
    current_asset_id?: string | null;
    current_asset_index?: number | null;
    current_chain_id?: ChainId | null;
    current_contract_address?: string | null;
    current_token_symbol?: string | null;
    current_started_at?: string | null;
    last_asset_id?: string | null;
    last_contract_address?: string | null;
    last_outcome?: string | null;
    started_at?: string | null;
    updated_at?: string | null;
    finished_at?: string | null;
    outcome?: string | null;
  };
}

export interface KolPerformanceRun {
  id: string;
  mode: KolPerformanceMode;
  actor_handle: string;
  sample_started_at?: string | null;
  sample_ended_at?: string | null;
  as_of_at: string;
  status: KolPerformanceRunStatus;
  metrics?: KolPerformanceMetrics;
  reason_codes?: string[];
  error_code?: string | null;
  last_error?: string | null;
  created_at: string;
  started_at?: string | null;
  updated_at?: string | null;
  completed_at?: string | null;
  unique_ca_count?: number;
  price_ready_count?: number;
  events?: KolPerformanceEvent[];
  assets?: KolPerformanceAsset[];
  deduplicated?: boolean;
}

export interface KolProfileRun {
  id: string;
  actor_handle: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result_json?: AccountResearchGrokResult;
  error_code?: string | null;
  last_error?: string | null;
  created_at: string;
  completed_at?: string | null;
  deduplicated?: boolean;
}

export type DynamicResolutionStatus = 'pending' | 'resolved' | 'rejected' | 'ambiguous' | 'not_found' | 'provider_failed';
export type DynamicCandidateStatus = 'unknown' | 'tradable' | 'untradable';

export interface DynamicResolutionCandidate {
  id: string;
  variant_id?: string | null;
  chain_id: ChainId;
  contract_address: string;
  score?: number | null;
  strong_anchor_codes: string[];
  support_reason_codes: string[];
  rejection_reason_codes: string[];
  provider_status: 'unknown' | 'verified' | 'error';
  tradable_status: DynamicCandidateStatus;
  field_availability: Record<string, boolean>;
  provider_snapshot: Record<string, unknown>;
  selected: boolean;
}

export interface DynamicResolution {
  id: string;
  actor_policy_id?: string | null;
  actor_policy_revision?: number | null;
  actor_handle?: string | null;
  x_handle?: string | null;
  processing_mode?: 'record' | 'paper' | 'live';
  status: DynamicResolutionStatus;
  intent_class: string;
  intent_reason_codes: string[];
  observed_terms: unknown[];
  author_owned_terms: unknown[];
  quoted_terms: unknown[];
  allowed_chain_ids: ChainId[];
  chain_id?: ChainId | null;
  contract_address?: string | null;
  name?: string | null;
  symbol?: string | null;
  launchpad?: string | null;
  exchange?: string | null;
  resolution_confidence: 'verified' | 'high' | 'medium' | 'low' | 'unknown';
  resolution_reason_codes: string[];
  failure_code?: string | null;
  candidate_coverage: Record<string, unknown>;
  provider_snapshot: Record<string, unknown>;
  timing_json: Record<string, unknown>;
  candidates: DynamicResolutionCandidate[];
  created_at: string;
  completed_at?: string | null;
}

export interface DynamicSignalStatus {
  features: Record<string, boolean>;
  worker: { running: boolean; active: boolean; workerId?: string };
  paperWorker: { running: boolean; active: boolean };
  jobs: Array<{ status: string; count: number; oldest?: string | null }>;
}

export interface DynamicPaperSession {
  id: string;
  actor_policy_id: string;
  policy_revision: number;
  x_handle?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  started_at: string;
  ends_at: string;
  completed_at?: string | null;
  summary: Record<string, unknown>;
  evaluations: Array<Record<string, unknown>>;
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
    remoteTotal: number | null;
    remoteAvailable: boolean;
    remoteError: string | null;
    registryTotal: number;
    managed: number;
  };
  watchSync: {
    byStatus: Record<string, number>;
    pending: number;
    failed: number;
    oldestRequestedAt: string | null;
    runtime: {
      enabled: boolean;
      running: boolean;
      active: boolean;
      lastRunAt: string | null;
      lastSuccessAt: string | null;
      lastError: string | null;
      processed: number;
    } | null;
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

export interface AssetIdentity {
  symbol: string | null;
  name: string | null;
  logo_url: string | null;
  display_label: string;
  metadata_source: string;
}

export interface EntityExecution {
  mode: ExecutionMode | null;
  status: string | null;
  intent_id: EntityId | null;
  attempt_id: EntityId | null;
  order_id: EntityId | null;
  tx_hash: string | null;
  side?: 'buy' | 'sell' | 'strategy_create' | 'strategy_cancel' | null;
  blockers: string[];
}

export interface EntityRisk {
  warnings: string[];
  hard_failures: string[];
}

export interface ClosePreparation {
  chain: ChainId;
  position_id: EntityId;
  sell_percent: number;
  wallet_available_raw: string;
  sell_amount_raw: string;
  sell_amount: string | number;
  strategy_action: 'sell' | 'cancel_then_sell';
  prepare_token: string;
  expires_in_seconds: number;
}

export interface ExternalCloseReconciliation {
  positionId: EntityId;
  status: 'matched' | 'external_balance_present' | 'no_open_lot'
    | 'manual_reconciliation_required' | 'chain_verifying' | 'protection_close_detected';
  attemptId?: EntityId | null;
  orderId?: EntityId | null;
  existing?: boolean;
  strategyAction?: 'cancelled' | 'none';
  cancelledStrategyCount?: number;
  strategyGroupId?: EntityId | null;
}

export interface KnownCloseReconciliation {
  positionId: EntityId;
  source: 'known_close_order';
  status: 'confirmed' | 'native_proceeds_unverified' | 'transfer_mismatch'
    | 'chain_verifying' | 'chain_failed' | 'chain_pending'
    | 'reconciliation_claimed_elsewhere';
  orderId?: EntityId | null;
}

export interface TradeSignal {
  id: EntityId;
  contract_version: 'p27.v1';
  strategy_type: Exclude<StrategyType, 'unknown'>;
  type?: SignalType;
  kol_id: EntityId;
  kol_handle: string;
  kol_weight: number;
  activity_id: EntityId;
  activity_type: ActivityType;
  ca?: string;
  project_name: string | null;
  chain?: ChainId;
  chain_id: ChainId;
  contract_address: string;
  asset: AssetIdentity;
  settlement: {
    token_decimals: number | null;
    source: 'order_report' | 'position_lot' | 'unavailable';
  };
  project: { name: string | null; handles: string[] };
  authorization: {
    signal_policy_snapshot: {
      mode: 'live' | 'paper' | 'record' | 'unknown';
      policy_id: EntityId | null;
      revision: number | null;
      context_hash: string | null;
    };
    execution_decision: {
      status: 'not_attempted' | 'allowed' | 'denied' | 'unknown';
      blockers: string[];
    };
    current_projection: {
      status: 'record_only' | 'manual_allowed' | 'auto_allowed' | 'unknown';
      blockers: string[];
    };
  };
  execution: EntityExecution;
  risk: EntityRisk;
  source: {
    provider: string;
    activity_id: EntityId | null;
    trace_id: string | null;
  };
  status: SignalStatus;
  execution_mode: ExecutionMode;
  reject_reason?: string;
  created_at: string;
  match_detail: string;
  signal_type: SignalType;
  symbol?: string | null;
  provider?: string;
  source_created_at?: string;
  observation_started_at?: string;
  observation_ended_at?: string;
  live_authorization?: 'record_only' | 'manual_allowed' | 'auto_allowed' | 'unknown';
  trade_intent_id?: EntityId | null;
  trade_intent_status?: TradeIntentStatus | null;
  retry_count?: number;
  max_retries?: number;
  trade_attempt_id?: EntityId | null;
  attempt_no?: number | null;
  trade_attempt_status?: string | null;
  failure_class?: string | null;
  trade_error_code?: string | null;
}

export interface Position {
  id: EntityId;
  contract_version: 'p27.v1';
  strategy_type: StrategyType;
  signal_id: EntityId | null;
  whitelist_id: EntityId | null;
  contract_address: string;
  chain_id: ChainId;
  symbol: string | null;
  project_name?: string | null;
  asset: AssetIdentity;
  execution: EntityExecution;
  risk: EntityRisk;
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
  trade_intent_id?: EntityId | null;
  trade_intent_status?: TradeIntentStatus | null;
  trade_attempt_id?: EntityId | null;
  attempt_no?: number | null;
  trade_attempt_status?: string | null;
  failure_class?: string | null;
  trade_error_code?: string | null;
}

export interface TradeAttempt {
  id: EntityId;
  contract_version: 'p27.v1';
  strategy_type: StrategyType;
  chain_id: ChainId;
  contract_address: string;
  asset: AssetIdentity;
  execution: EntityExecution;
  risk: EntityRisk;
  order: {
    id: EntityId | null;
    provider_order_id: string | null;
    tx_hash: string | null;
    status: string | null;
  };
  intent_id: EntityId;
  attempt_no: number;
  retry_of_attempt_id?: EntityId | null;
  signal_id?: EntityId | null;
  position_id?: EntityId | null;
  side: 'buy' | 'sell' | 'strategy_create' | 'strategy_cancel';
  chain: ChainId;
  wallet_address: string;
  input_token: string;
  output_token: string;
  input_amount_raw: string;
  output_amount_raw?: string;
  status: string;
  error_code?: string;
  error_class?: string;
  failure_class?: string;
  failure_evidence_json?: Record<string, unknown>;
  retry_eligible?: boolean;
  retry_decided_at?: string;
  estimated_fee_native?: string | number | null;
  actual_fee_native?: string | number | null;
  fee_escalation_level?: number;
  requires_manual_review: boolean;
  created_at: string;
  submitted_at?: string;
  confirmed_at?: string;
  order_id?: EntityId;
  provider_order_id?: string;
  tx_hash?: string;
  provider_status?: string;
  order_status?: string;
  last_queried_at?: string;
  next_query_at?: string;
  query_count?: number;
  query_stage?: string;
  intent_status: TradeIntentStatus;
  retry_count: number;
  max_retries: number;
  retry_expires_at?: string | null;
  next_retry_at?: string | null;
  intent_error_code?: string | null;
  wallet_lane_state?: WalletWriteLane['state'] | null;
  wallet_lane_reason?: string | null;
  principal_reserved_native?: string | number | null;
  retry_fee_envelope_native?: string | number | null;
  fee_used_native?: string | number | null;
}

export interface TradeIntent {
  id: EntityId;
  source_key: string;
  scope_key: string;
  side: 'buy' | 'sell';
  chain: ChainId;
  wallet_address: string;
  contract_address: string;
  status: TradeIntentStatus;
  max_retries: number;
  retry_count: number;
  expires_at?: string | null;
  next_retry_at?: string | null;
  principal_amount_raw?: string | null;
  principal_amount_display?: string | number | null;
  config_snapshot_json?: Record<string, unknown>;
  last_error_code?: string | null;
  confirmation_source?: string | null;
  incident_status?: string | null;
  created_at: string;
  completed_at?: string | null;
}

export interface TradeFailureEvidence {
  id: EntityId;
  attempt_id: EntityId;
  snapshot_version: number;
  evidence_type: string;
  status: 'observed' | 'passed' | 'failed' | 'conflict' | 'unavailable';
  evidence_json: Record<string, unknown>;
  observed_at: string;
}

export interface TradeRetryDecision {
  id: EntityId;
  intent_id: EntityId;
  attempt_id: EntityId;
  decision: 'retry_scheduled' | 'retry_blocked' | 'uncertain' | 'exhausted';
  reason_code: string;
  evidence_json: Record<string, unknown>;
  code_version: string;
  decided_at: string;
}

export interface TradeReconciliationIncident {
  id: EntityId;
  intent_id?: EntityId | null;
  attempt_id?: EntityId | null;
  incident_type: 'late_confirmation' | 'multiple_fill' |
    'budget_reconciliation_deficit' | 'manual_lane_release';
  severity: 'medium' | 'high' | 'critical';
  status: 'open' | 'acknowledged' | 'resolved';
  details_json: Record<string, unknown>;
  created_at: string;
}

export interface BudgetReservation {
  id: EntityId;
  intent_id: EntityId;
  amount_native: string | number;
  fee_native: string | number;
  fee_used_native: string | number;
  amount_usd_snapshot: string | number;
  status: string;
}

export interface WalletWriteLane {
  chain: ChainId;
  wallet_address: string;
  wallet_masked?: string;
  state: 'idle' | 'submitting' | 'quarantined';
  owner_attempt_id?: EntityId | null;
  reason_code?: string | null;
  evidence_json?: Record<string, unknown>;
  lease_expires_at?: string | null;
  quarantined_at?: string | null;
  released_at?: string | null;
  released_by?: string | null;
  release_reason?: string | null;
  updated_at: string;
}

export interface ChainTradeCircuit {
  chain: ChainId;
  state: 'open' | 'tripped';
  consecutive_failures: number;
  threshold: number;
  reason_code?: string | null;
  last_failure_attempt_id?: string | null;
  last_success_attempt_id?: string | null;
  tripped_at?: string | null;
  updated_at: string;
}

export interface TradeRetryRuntime {
  running: boolean;
  active: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  processed: number;
  succeeded: number;
  scanIntervalMs: number;
  maintenanceIntervalMs: number;
  lastMaintenanceAt: string | null;
  backlog: Array<{ status: TradeIntentStatus; count: number; oldest: string | null }>;
  quarantines: Array<Pick<WalletWriteLane, 'chain' | 'wallet_address' | 'reason_code' | 'quarantined_at'>>;
  circuits: ChainTradeCircuit[];
}

export interface TradeAttemptDetails extends TradeAttempt {
  intent: TradeIntent;
  budget_reservation?: BudgetReservation | null;
  wallet_lane?: WalletWriteLane | null;
  intent_sources: Array<Record<string, unknown>>;
  failure_evidence: TradeFailureEvidence[];
  retry_decisions: TradeRetryDecision[];
  reconciliation_incidents: TradeReconciliationIncident[];
  orders: TradeOrderRecord[];
  events: TradeAttemptEvent[];
  strategy_groups: Array<Record<string, unknown>>;
  strategy_legs: Array<Record<string, unknown>>;
  position_lots: Array<Record<string, unknown>>;
  chain_receipts: Array<Record<string, unknown>>;
}

export interface TradeOrderRecord extends Record<string, unknown> {
  id: EntityId;
  provider_order_id?: string | null;
  tx_hash?: string | null;
  normalized_status?: string | null;
  submitted_at?: string | null;
  last_queried_at?: string | null;
  next_query_at?: string | null;
  query_count?: number | null;
}

export interface TradeAttemptEvent extends Record<string, unknown> {
  id: EntityId;
  from_status?: string | null;
  to_status: string;
  created_at: string;
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
    chain: ChainId;
    implemented: boolean;
    code_capable?: boolean;
    contract_tested: boolean;
    production_approved?: boolean;
    acceptance_status?: 'none' | 'active' | 'expired' | 'completed' | 'cancelled';
    contract_evidence?: {
      id: string | number | null;
      type: 'contract_probe';
      status: 'passed' | 'failed';
      createdAt: string | null;
      validUntil?: string | null;
      valid_now?: boolean;
      status_view?: 'current' | 'historical';
      contextHash?: string;
      codeVersion?: string;
      stale?: boolean;
      whitelistIds: number[];
    } | null;
    policy_enabled: boolean;
    strategy_ready?: boolean;
    ready: boolean;
    blockers: string[];
    wallet_address?: string | null;
    native_balance?: number | null;
    native_balances?: Array<{ symbol?: string; balance?: string | number; amount?: string | number }>;
    native_balance_source?: string | null;
    native_balance_checked_at?: string | null;
    native_balance_age_ms?: number | null;
    native_balance_ttl_ms?: number | null;
    native_balance_fresh?: boolean;
    native_balance_usable_for_gate?: boolean;
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
      retryEnabled?: boolean;
      maxRetries?: number;
      retryWindowMs?: number;
      failureEvidenceWindowMs?: number;
      feeEscalationEnabled?: boolean;
      maxRetryFeeNative?: number;
      exitGasReserve?: number;
    };
    failure_circuit?: ChainTradeCircuit | null;
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
  latencySlo: {
    windowHours: number;
    requiredSamples: number;
    passed: boolean;
    inbox: { count: number; p50: number | null; p95: number | null; p99: number | null };
    signal: { count: number; p50: number | null; p95: number | null; p99: number | null };
    execution: { count: number; p50: number | null; p95: number | null; p99: number | null };
    receiveToSwap: { count: number; p50: number | null; p95: number | null; p99: number | null };
    receiveToSubmitted: { count: number; p50: number | null; p95: number | null; p99: number | null };
  };
  contractProbes: Record<string, { ok: boolean; chain: string; error?: string }>;
  strategyProbes?: Record<string, { ok: boolean; returned?: number; error?: string }>;
  acceptanceScope?: LiveAcceptanceScope | null;
  relations: Array<{
    id: number;
    whitelistId: number;
    actorHandle: string;
    targetHandle: string;
    eventTypes: string[];
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
  retry?: TradeRetryRuntime;
  pollingPolicy: Array<{ fromSeconds: number; toSeconds: number | null; intervalMs: number | number[] }>;
  scope?: {
    scope_type: 'combined' | 'fixed_ca' | 'dynamic_policy' | 'follow_discovery';
    scope_id: number | null;
    policy_revision?: number | null;
    chains: string[];
    whitelist_ids?: number[];
    dynamic_policy_ids?: number[];
    follow_policy_ids?: number[];
    counts?: {
      chains: number;
      whitelists: number;
      dynamic_policies: number;
      follow_policies: number;
      watches: number;
      relations: number;
    };
    manifest_hash?: string | null;
  };
  provider?: {
    cooldown_until?: number | string | null;
    affected?: string[];
    advisories?: string[];
  };
  policy?: {
    providers: string[];
    eventTypes: string[];
    verifiedEventTypes: string[];
    chains: string[];
    whitelistIds: number[];
    maxSignalAgeSeconds: number;
  };
}

export interface ArmPreparation {
  preparation_id: number | null;
  arm_token: string | null;
  expires_at: string | null;
  summary: {
    readyToArm: boolean;
    blockers: string[];
    advisories: string[];
    scope?: {
      type: 'combined' | 'fixed_ca' | 'dynamic_policy' | 'follow_discovery';
      id: number | null;
      revision?: number | null;
      label: string;
    };
    counts: {
      chains: number;
      whitelists: number;
      watches: number;
      relations: number;
    };
    chains: Array<{
      chain: ChainId;
      ready: boolean;
      blockers: string[];
      nativeBalance: number | null;
    }>;
  };
  scope?: {
    scope_type: 'combined' | 'fixed_ca' | 'dynamic_policy' | 'follow_discovery';
    scope_id: number | null;
    chains?: string[];
    policy_revision?: number | null;
    manifest_hash?: string | null;
  };
}

export interface RuntimeScope {
  scope_type: 'combined' | 'fixed_ca' | 'dynamic_policy' | 'follow_discovery';
  scope_id: number | null;
  label: string;
  chains: string[];
  revision?: number | null;
  context_hash?: string | null;
}

export interface RuntimeSummary {
  generated_at: string;
  engine: {
    armed: boolean;
    status: 'stopped' | 'recovering' | 'running' | 'paused_transient' | 'fault_protected';
    desiredRunning: boolean;
    mode: string;
    lastError: string | null;
    lastErrorDetails: unknown;
    operator: string | null;
    armedAt: string | null;
    lastRecoveredAt: string | null;
  };
  counts: {
    chains: number;
    whitelists: number;
    watches: number;
    relations: number;
    syncing: number;
    sync_failed: number;
  };
  chains: Array<{
    chain: ChainId;
    name: string;
    ready: boolean;
  }>;
}

export interface RuntimePolicyDetailItem {
  id: string | number;
  chain_id: ChainId;
  contract_address: string;
  symbol?: string | null;
  project_name?: string | null;
  token_logo_url?: string | null;
  budget_per_trade: number;
  total_budget: number;
  activation_version: number;
  activated_at?: string | null;
  relation_count: number;
  source_count: number;
  unique_actor_count: number;
  actor_handles: string[];
}

export interface RuntimePolicyDetailPage {
  items: RuntimePolicyDetailItem[];
  total: number;
  page: number;
  page_size: number;
  scope?: RuntimeScope | null;
}

export interface LiveAcceptanceScope {
  id: string | number;
  chain: ChainId;
  whitelist_id: string | number;
  status: 'active' | 'completed' | 'cancelled';
  expires_at: string;
  created_at?: string;
  completed_at?: string | null;
  completion_reason?: string | null;
  expired?: boolean;
  symbol?: string | null;
  contract_address?: string | null;
}

export interface TradeRuntimePolicy {
  scheduler: TradeReadiness['scheduler'];
  polling_policy: TradeReadiness['pollingPolicy'];
  readiness: TradeReadiness;
  endpoint_weights: Record<string, number>;
  new_trade_reservation_weight: number;
  acceptance_scope?: LiveAcceptanceScope | null;
  live_queue: {
    running: boolean;
    scannerRunning: boolean;
    listenerConnected: boolean;
    lastNotificationAt: string | null;
    queueDepth: number;
    processed: number;
    lastError: string | null;
    lastErrorAt?: string | null;
    lastHistoricalError?: { code: string; at: string } | null;
    lastExecutionAt: string | null;
  };
}

export interface ChainConfig {
  nativeSymbol: string;
  retryEnabled: boolean;
  maxRetries: number;
  retryWindowMs: number;
  failureEvidenceWindowMs: number;
  feeEscalationEnabled: boolean;
  maxRetryFeeNative: number;
  exitGasReserve: number;
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
    added_sources?: number;
  };
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  total?: number;
  page?: number;
  pageSize?: number;
}
