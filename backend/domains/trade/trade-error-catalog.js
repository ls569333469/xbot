const STARTUP_CODES = new Set([
  'EXECUTION_GATE_STALE',
  'LIVE_ENGINE_NOT_ARMED',
  'LIVE_READINESS_FAILED',
  'LIVE_CONFIGURATION_CHANGED',
  'LIVE_SCOPE_SNAPSHOT_MISMATCH',
  'LIVE_CHAIN_READINESS_FAILED',
  'LIVE_SCOPE_SIGNAL_NOT_ALLOWED',
  'LIVE_POLICY_REJECTED',
  'EMERGENCY_STOP_ACTIVE',
  'CHAIN_PRODUCTION_NOT_APPROVED',
  'ACCEPTANCE_SCOPE_MISMATCH',
  'WHITELIST_NOT_ACTIVE',
  'PREPARE_TOKEN_INVALID',
  'PREPARE_TOKEN_MISMATCH',
  'PREPARE_SNAPSHOT_CHANGED'
]);

const TRADE_GATE_MESSAGES = {
  CA_BUY_LIMIT_REACHED: '该 CA 已达到允许的买入次数上限，本次不会重复买入',
  WHITELIST_BUDGET_EXCEEDED: '该白名单累计预算不足，无法完成本次买入',
  CHAIN_DAILY_BUDGET_EXCEEDED: '该链今日交易预算已用完，本次买入未执行',
  CHAIN_WEEKLY_BUDGET_EXCEEDED: '该链本周交易预算已用完，本次买入未执行',
  CHAIN_PER_TRADE_LIMIT_EXCEEDED: '本次买入金额超过该链单笔限额',
  MAX_OPEN_POSITIONS_REACHED: '该链同时持仓数量已达到上限',
  GLOBAL_DAILY_USD_BUDGET_EXCEEDED: '全局今日美元预算已用完，本次买入未执行',
  GLOBAL_WEEKLY_USD_BUDGET_EXCEEDED: '全局本周美元预算已用完，本次买入未执行',
  GAS_RESERVE_CONFIG_INVALID: '该链 Gas 保留配置无效，无法安全准备交易',
  WHITELIST_HARD_LIMIT_INVALID: '白名单交易限额配置无效，无法准备交易',
  CHAIN_HARD_LIMIT_INVALID: '该链交易限额配置无效，无法准备交易'
};

const LOCAL_EXECUTION_MESSAGES = {
  GMGN_KEY_MISSING: 'GMGN API 密钥未配置，无法发起交易请求',
  GMGN_PRIVATE_KEY_MISSING: 'GMGN 签名私钥未配置，无法发起交易请求',
  GMGN_PRIVATE_KEY_INVALID: 'GMGN 签名私钥格式不正确，无法发起交易请求',
  GMGN_WALLET_MISSING: 'GMGN 未返回目标链钱包，无法确定交易钱包',
  GMGN_WALLET_AMBIGUOUS: 'GMGN 返回了多个目标链钱包，无法安全选择交易钱包',
  GMGN_SCHEMA_INVALID: 'GMGN 返回的数据格式不完整，无法安全继续交易',
  GMGN_GAS_PRICE_UNAVAILABLE: 'GMGN 未返回可用的 Gas 价格，无法准备交易',
  GMGN_GAS_PRICE_TOO_LOW: 'GMGN 返回的 Gas 价格低于系统允许值，无法准备交易',
  GMGN_LEGACY_FLOW_REMOVED: '旧版本地钱包交易入口已停用，请使用 GMGN 交易链路',
  GMGN_RATE_DEADLINE_EXPIRED: '等待 GMGN 请求额度时超过本次交易时限，未提交交易',
  GMGN_RATE_LIMIT_COOLDOWN: 'GMGN 当前处于限流冷却，本次请求未提交交易',
  GMGN_RATE_RESERVATION_INVALID: 'GMGN 请求额度凭证无效或已用尽，未提交交易',
  GMGN_RATE_WEIGHT_INVALID: 'GMGN 请求权重配置无效，未提交交易',
  GMGN_SCHEDULER_RESET: 'GMGN 请求调度器被重置，本次交易未提交',
  GMGN_REQUEST_TIMEOUT: 'GMGN 请求超时，未获得可用数据，无法继续',
  GMGN_NETWORK_ERROR: 'GMGN 网络请求失败，未获得可用数据，无法继续',
  GMGN_NON_JSON_RESPONSE: 'GMGN 数据格式异常，无法继续',
  GMGN_RESPONSE_INVALID: 'GMGN 数据格式异常，无法继续',
  GMGN_INVALID_JSON: 'GMGN 数据格式异常，无法继续',
  GMGN_ORDER_ID_MISSING: 'GMGN 未返回有效订单号，无法继续交易',
  GMGN_SUBMISSION_UNCERTAIN: 'GMGN 提交状态不明确，无法继续交易',
  RETRY_RUNTIME_DISABLED: '当前链路未开启交易重试，本次不再重试',
  RETRY_PRINCIPAL_MISMATCH: '重试金额与原交易不一致，系统拒绝重试',
  TRADE_ATTEMPT_CAS_FAILED: '交易状态已被其他流程更新，请刷新后核对',
  WHITELIST_ACTIVATION_CHANGED: '白名单状态在提交前发生变化，本次交易未执行',
  LIVE_TRIGGER_EVENT_NOT_ALLOWED: '该信号的触发方式当前不允许实盘执行',
  STRATEGY_GROUP_CAS_FAILED: '保护策略状态已发生变化，请刷新后核对',
  CLOSE_RECOVERY_NOT_ELIGIBLE: '该平仓记录当前不满足重新核验条件',
  CLOSE_RECOVERY_ORDER_EXISTS: '该平仓已经存在已提交订单，不能重复恢复',
  STRATEGY_CANCEL_EVIDENCE_REQUIRED: '缺少保护策略取消证据，无法安全恢复平仓',
  POSITION_RECOVERY_CAS_FAILED: '持仓在恢复过程中发生变化，请刷新后核对'
};

const GMGN_SCHEDULER_CODES = new Set([
  'GMGN_RATE_DEADLINE_EXPIRED',
  'GMGN_RATE_LIMIT_COOLDOWN',
  'GMGN_RATE_RESERVATION_INVALID',
  'GMGN_RATE_WEIGHT_INVALID',
  'GMGN_SCHEDULER_RESET'
]);

const GMGN_PROVIDER_CODES = new Set([
  'GMGN_GAS_PRICE_UNAVAILABLE',
  'GMGN_GAS_PRICE_TOO_LOW',
  'GMGN_NETWORK_ERROR',
  'GMGN_NON_JSON_RESPONSE',
  'GMGN_REQUEST_TIMEOUT',
  'GMGN_RESPONSE_INVALID',
  'GMGN_SCHEMA_INVALID'
]);

const STARTUP_MESSAGES = {
  EXECUTION_GATE_STALE: '实时交易检查已过期，需要重新检查后再执行',
  LIVE_ENGINE_NOT_ARMED: '真实交易 Engine 当前未启动，本次交易未执行',
  LIVE_READINESS_FAILED: '真实交易启动检查未通过，本次交易未执行',
  LIVE_CONFIGURATION_CHANGED: '真实交易配置在检查后发生变化，需要重新检查',
  LIVE_SCOPE_SNAPSHOT_MISMATCH: '当前信号不属于已确认的交易作用域',
  LIVE_CHAIN_READINESS_FAILED: '目标交易链当前未通过实盘检查',
  LIVE_SCOPE_SIGNAL_NOT_ALLOWED: '该信号不在当前 Engine 已确认的交易范围内',
  LIVE_POLICY_REJECTED: '当前实盘策略不允许执行该信号',
  EMERGENCY_STOP_ACTIVE: '紧急停止开关已开启，本次交易未执行',
  CHAIN_PRODUCTION_NOT_APPROVED: '目标链尚未获得真实交易许可',
  ACCEPTANCE_SCOPE_MISMATCH: '当前交易不属于已确认的验收范围',
  WHITELIST_NOT_ACTIVE: '目标 CA 白名单已停用，本次交易未执行',
  PREPARE_TOKEN_INVALID: '交易准备凭证无效或已过期，请重新准备',
  PREPARE_TOKEN_MISMATCH: '交易准备凭证与当前目标不一致，请重新准备',
  PREPARE_SNAPSHOT_CHANGED: '交易参数、余额或策略状态发生变化，请重新准备'
};

const LOCAL_MESSAGES = {
  SIGNAL_NOT_FOUND: '找不到对应信号，无法执行交易',
  POSITION_NOT_FOUND: '找不到对应持仓，无法执行平仓',
  POSITION_NOT_CLOSABLE: '该持仓当前不可平仓',
  POSITION_LOT_MISSING: '该持仓没有可核验的交易份额，无法平仓',
  POSITION_BALANCE_EMPTY: '钱包中没有可平仓的代币余额',
  POSITION_LOT_DECIMALS_MISMATCH: '持仓份额的小数位配置不一致，无法安全平仓',
  POSITION_LOT_WALLET_MISMATCH: '持仓份额对应的钱包不一致，无法安全平仓',
  STRATEGY_STATE_UNSAFE: '保护策略状态未核验完成，暂不能平仓',
  CLOSE_SLIPPAGE_INVALID: '平仓滑点配置无效，必须重新设置',
  STRATEGY_CANCELLED_BEFORE_SWAP: '保护策略已取消，但平仓交易尚未提交',
  STRATEGY_CANCEL_UNCERTAIN: '保护策略取消结果无法确认，平仓结果需要核验',
  STRATEGY_CANCEL_UNVERIFIED: '保护策略取消尚未得到 GMGN 确认，平仓结果需要核验',
  STRATEGY_TRIGGERED_DURING_CANCEL: '取消保护策略期间它已触发，平仓结果需要核验',
  MULTIPLE_FILL_INCIDENT: '检测到可能的重复成交，需要人工核对订单和链上记录'
};

const UNCERTAIN_CODES = new Set([
  'GMGN_REQUEST_TIMEOUT',
  'GMGN_NETWORK_ERROR',
  'GMGN_NON_JSON_RESPONSE',
  'GMGN_ORDER_ID_MISSING',
  'GMGN_RESPONSE_INVALID',
  'GMGN_SCHEMA_INVALID',
  'GMGN_INVALID_JSON',
  'GMGN_SUBMISSION_UNCERTAIN',
  'PRE_SUBMIT_RECOVERY_SWAP_EXISTS',
  'STALE_WRITE_LEASE',
  'NO_HASH_FAILURE_EVIDENCE_PENDING',
  'FAILED_ORDER_CHAIN_EVIDENCE_CONFLICT',
  'GMGN_ORDER_EXPIRED'
]);

const HEALTH_CODES = new Set([
  'MINIMUM_GAS_RESERVE_BREACH',
  'WALLET_BALANCE_CACHE_STALE',
  'CHAIN_RPC_UNAVAILABLE',
  'CHAIN_RPC_TIMEOUT',
  'CHAIN_RPC_MISSING',
  'CHAIN_RPC_BALANCE_UNAVAILABLE',
  'CHAIN_RPC_HTTP_ERROR',
  'CHAIN_RPC_RESPONSE_INVALID',
  'CHAIN_NATIVE_BALANCE_UNKNOWN',
  'CHAIN_NATIVE_BALANCE_INSUFFICIENT',
  'INSUFFICIENT_NATIVE_BALANCE',
  'GMGN_SCHEDULER_NOT_HEALTHY',
  'GMGN_RECENT_429',
  'GMGN_TRADE_WEIGHT_REFILLING',
  'GMGN_SCHEDULER_BUSY',
  'X_6551_INGESTION_UNHEALTHY',
  'UNRESOLVED_TRADE_ATTEMPTS'
]);

function text(value, max = 500) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized.slice(0, max) : null;
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function providerDetails(input) {
  const summary = object(input.attempt_event_summary || input.latest_attempt_event_summary);
  const response = object(input.last_response_json);
  const responseProvider = object(response.provider);
  const responseError = object(response.error);
  const provider = { ...response, ...responseProvider, ...responseError };
  const responseErrorText = typeof response.error === 'string' ? response.error : null;
  const providerCode = text(
    input.provider_code
      ?? input.providerCode
      ?? summary.provider_code
      ?? summary.providerCode
      ?? input.api_error
      ?? input.apiError
      ?? responseErrorText
      ?? response.error_code
      ?? response.error_status
      ?? provider.error
      ?? provider.error_code
      ?? provider.error_status
      ?? provider.code,
    160
  );
  const providerMessage = text(
    input.provider_message
      ?? input.providerMessage
      ?? summary.provider_message
      ?? summary.providerMessage
      ?? input.api_message
      ?? input.apiMessage
      ?? response.message
      ?? response.error_message
      ?? provider.message,
    500
  );
  const httpStatus = numberOrNull(
    input.http_status ?? input.httpStatus ?? summary.http_status ?? input.status
  );
  return { providerCode, providerMessage, httpStatus };
}

function stageFor(input, providerCode, category) {
  if (text(input.stage)) return text(input.stage, 80);
  if (category === 'startup_blocker') return '启动检查';
  if (category === 'trade_gate') return '交易门禁';
  if (category === 'health_advisory') return '健康观察';
  if (category === 'provider_rate_limited') return 'GMGN 请求';
  if (category === 'provider_uncertain') return 'GMGN 交易提交';
  if (category === 'local_execution'
      && (providerCode || String(input.code || '').toUpperCase().startsWith('GMGN_'))) {
    return 'GMGN 请求';
  }
  if (providerCode) return 'GMGN 交易提交';
  return '交易执行';
}

function resultFor(category, input) {
  if (input.order_created === true || text(input.tx_hash)) return '已产生交易证据';
  if (category === 'provider_uncertain') return '提交结果待核验';
  if (category === 'health_advisory') return '仅记录观察';
  return '未提交交易';
}

function describeTradeError(input = {}) {
  const rawCode = text(input.code ?? input.error_code ?? input.trade_error_code
    ?? input.reject_reason ?? input.failure_class, 160);
  if (!rawCode) return null;
  const code = rawCode;
  const normalized = code.toUpperCase();
  const provider = providerDetails(input);
  const status = provider.httpStatus;
  const statusIs429 = status === 429 || normalized.includes('RATE_LIMIT')
    || ['GMGN_RECENT_429', 'GMGN_SCHEDULER_NOT_HEALTHY'].includes(normalized);

  let category = 'unknown';
  let userMessage = null;
  let source = 'system';
  let retryAllowed = false;
  let nextAction = '保留记录并核对详细信息';

  if (Object.hasOwn(TRADE_GATE_MESSAGES, normalized)) {
    category = 'trade_gate';
    userMessage = TRADE_GATE_MESSAGES[normalized];
    source = 'local_trade_gate';
    nextAction = normalized === 'CA_BUY_LIMIT_REACHED'
      ? '确认是否已有买入记录；不要重复提交'
      : '检查对应链、白名单或预算配置';
  } else if (Object.hasOwn(STARTUP_MESSAGES, normalized) || STARTUP_CODES.has(normalized)) {
    category = 'startup_blocker';
    userMessage = STARTUP_MESSAGES[normalized] || '真实交易启动检查未通过，本次交易未执行';
    source = 'local_engine';
    nextAction = '处理启动检查中的明确问题后重新检查';
  } else if (Object.hasOwn(LOCAL_MESSAGES, normalized)) {
    category = 'local_execution';
    userMessage = LOCAL_MESSAGES[normalized];
    source = 'local_execution';
    nextAction = normalized.startsWith('POSITION_') ? '刷新持仓和钱包余额后重试' : '打开交易详情核对状态';
  } else if (Object.hasOwn(LOCAL_EXECUTION_MESSAGES, normalized)
      && !(input.write_started === true && UNCERTAIN_CODES.has(normalized))) {
    category = ['GMGN_RATE_RESERVATION_INVALID', 'GMGN_RATE_DEADLINE_EXPIRED',
      'GMGN_RATE_LIMIT_COOLDOWN'].includes(normalized)
      ? 'provider_rate_limited' : 'local_execution';
    source = GMGN_SCHEDULER_CODES.has(normalized) ? 'local_gmgn_scheduler'
      : GMGN_PROVIDER_CODES.has(normalized) ? 'gmgn' : 'local_execution';
    userMessage = LOCAL_EXECUTION_MESSAGES[normalized];
    nextAction = normalized.startsWith('GMGN_RATE_')
      ? '等待请求调度恢复后，再处理新的交易信号'
      : '检查交易配置和当前状态后，再决定是否重新执行';
  } else if (HEALTH_CODES.has(normalized)) {
    category = 'health_advisory';
    source = normalized.startsWith('CHAIN_RPC') || normalized === 'WALLET_BALANCE_CACHE_STALE'
      ? 'rpc_observer' : 'runtime_health';
    userMessage = normalized === 'MINIMUM_GAS_RESERVE_BREACH'
      ? '按当前余额估算，交易后可能低于最低 Gas 保留额；本项仅作观察，不阻止 GMGN'
      : '运行健康或只读观察出现异常；本项仅作记录，不改变 Engine 状态';
    nextAction = '查看健康详情；不要因为该观察项重复提交交易';
  } else if (statusIs429) {
    category = 'provider_rate_limited';
    source = 'gmgn';
    userMessage = 'GMGN 暂时限流，本次请求未获得可用的交易结果';
    nextAction = '等待 GMGN 冷却结束；不要重复点击或重新提交 Swap';
  } else if (normalized === '40002301' || normalized === 'GEVMINSUFFICIENTFUNDS'
      || provider.providerCode?.toUpperCase() === 'GEVMINSUFFICIENTFUNDS'
      || ['INSUFFICIENT_FUNDS', 'GMGN_INSUFFICIENT_FUNDS'].includes(normalized)) {
    category = 'provider_rejection';
    source = 'gmgn';
    userMessage = '钱包余额不足，无法支付本次买入金额和交易手续费';
    nextAction = '补充目标链原生币余额后，再处理新的交易信号';
  } else if (UNCERTAIN_CODES.has(normalized)
      || normalized === 'UNCERTAIN'
      || status >= 500
      || (status >= 400 && status < 500 && input.write_started === true
        && !['40002301'].includes(normalized))) {
    category = 'provider_uncertain';
    source = 'gmgn';
    userMessage = '交易提交结果暂时无法确认，不能判断为失败或重复提交';
    nextAction = '等待订单、钱包活动和链上回执核验；不要重复提交';
  } else if (status >= 400 && status < 500 || normalized.startsWith('GMGN_') || provider.providerCode) {
    category = 'provider_rejection';
    source = 'gmgn';
    userMessage = provider.providerMessage
      ? `GMGN 拒绝本次交易：${provider.providerMessage}`
      : 'GMGN 拒绝本次交易请求';
    nextAction = '根据 GMGN 原始原因处理后，再决定是否发起新的交易';
  }

  if (!userMessage) {
    category = 'unknown';
    userMessage = category === 'unknown' && (source === 'gmgn' || provider.providerCode)
      ? 'GMGN 返回了暂未登记的交易问题，暂不能判断为成功'
      : '系统返回了暂未登记的交易问题';
  }

  const txHash = text(input.tx_hash || input.execution_tx_hash, 180);
  const orderCreated = input.order_created === true
    || Boolean(input.order_id || input.provider_order_id || txHash);
  return {
    code,
    user_message: userMessage,
    category,
    source,
    stage: stageFor(input, provider.providerCode, category),
    provider_code: provider.providerCode,
    provider_message: provider.providerMessage,
    http_status: provider.httpStatus,
    result: resultFor(category, { ...input, order_created: orderCreated, tx_hash: txHash }),
    order_created: orderCreated,
    tx_hash: txHash,
    retry_allowed: retryAllowed,
    next_action: nextAction
  };
}

function isExecutionBlocker(code) {
  const descriptor = describeTradeError({ code });
  return descriptor?.category !== 'health_advisory';
}

module.exports = {
  describeTradeError,
  HEALTH_CODES,
  isExecutionBlocker,
  LOCAL_EXECUTION_MESSAGES,
  STARTUP_CODES,
  TRADE_GATE_MESSAGES,
  UNCERTAIN_CODES
};
