const MODE_LABELS: Record<string, string> = {
  signal: '信号监控',
  paper: '模拟交易',
  live: '真实交易',
  unknown: '未知模式',
};

const STATUS_LABELS: Record<string, string> = {
  active: '已启用',
  paused: '已暂停',
  locked: '已锁定',
  armed: '已解锁',
  signal_only: '仅记录信号',
  recorded: '已记录',
  pending: '待处理',
  pending_risk: '风控检查中',
  approved: '已批准',
  execution_reserved: '已预留执行额度',
  reserved: '已预留',
  preparing: '准备中',
  submitting: '提交中',
  submitted: '已提交',
  confirming: '确认中',
  chain_verifying: '链上确认中',
  failure_verifying: '失败证据核验中',
  definitive_failed_no_fill: '明确失败且未成交',
  retry_scheduled: '重试已排队',
  retry_verifying: '重试前复核中',
  retry_blocked: '重试已阻断',
  awaiting_result: '等待交易结果',
  uncertain: '成交结果不确定',
  exhausted: '重试次数已耗尽',
  superseded: '未提交尝试已失效',
  confirmed: '已确认',
  submission_uncertain: '提交结果待核对',
  reconciliation_required: '需要人工对账',
  rejected: '已拒绝',
  executed: '已执行',
  expired: '已过期',
  failed: '失败',
  open: '持仓中',
  open_unprotected: '持仓未保护',
  open_protected: '持仓已保护',
  partially_closed: '部分平仓',
  closing: '平仓确认中',
  close_uncertain: '平仓结果待核对',
  closed: '已平仓',
  protection_failed: '保护策略失败',
  tp_hit: '已触发止盈',
  sl_hit: '已触发止损',
  manual_close: '手动平仓',
  running: '运行中',
  healthy: '正常',
  queued: '排队中',
  cooling: '限流冷却中',
  ready: '已就绪',
  blocked: '被阻断',
  enabled: '已开启',
  disabled: '已关闭',
  stopped: '已停止',
  subscribed: '已订阅',
  connected: '已连接',
  disconnected: '已断开',
  connecting: '连接中',
  error: '异常',
  unavailable: '不可用',
  replaced: '交易已替换',
  dropped: '交易已丢弃',
  cancelled: '已取消',
  cancelling: '取消中',
  success: '成功',
  unknown: '未知',
};

const BLOCKER_LABELS: Record<string, string> = {
  MIGRATION_NOT_CURRENT: '数据库尚未应用当前 P14 迁移',
  LIVE_MODE_REQUIRED: '需要切换到真实交易模式',
  LIVE_TRADING_DISABLED: '实盘交易开关尚未开启',
  GMGN_CREDENTIALS_MISSING: 'GMGN 交易鉴权信息未配置完整',
  GMGN_KEY_EXCLUSIVE_NOT_CONFIRMED: '尚未确认 GMGN API 密钥由本系统独占',
  GMGN_RECENT_429: 'GMGN 最近发生过限流',
  GMGN_SCHEDULER_NOT_HEALTHY: 'GMGN 请求调度器状态异常',
  GMGN_TRADE_WEIGHT_UNAVAILABLE: 'GMGN 可用请求额度不足以发起新交易',
  TRANSIENT_READINESS_FAILURE: '外部服务短暂异常，正在等待恢复',
  TRANSIENT_READINESS_WAITING: '外部服务仍未恢复，系统继续等待',
  TRANSIENT_READINESS_TIMEOUT: '外部服务异常等待超时（旧版本故障保护）',
  OPERATOR_STOPPED: '操作员已停止新买入',
  X_6551_INGESTION_UNHEALTHY: '6551 实时采集进程未订阅或心跳已失效',
  TRADE_ALERTS_NOT_VERIFIED: '资金告警尚未验证',
  LIVE_POLICY_EMPTY: '实盘执行策略尚未配置',
  P20_LIVE_DISABLED: '动态策略实盘能力尚未开启',
  DYNAMIC_POLICY_CONFIG_INVALID: '存在无法执行的动态实盘策略配置',
  LIVE_POLICY_CONTAINS_UNVERIFIED_EVENT: '实盘策略包含未经验证的事件类型',
  LIVE_POLICY_WHITELIST_MISSING: '实盘策略中的白名单不存在或未启用',
  LIVE_POLICY_RELATION_MISSING: '实盘策略缺少启用的监控账号到项目账号关系',
  NO_LIVE_CHAIN_READY: '当前没有满足实盘条件的链',
  GLOBAL_USD_LIMIT_INVALID: '全局美元预算上限未配置或无效',
  EMERGENCY_STOP_ACTIVE: '紧急停止开关已开启',
  RECONCILER_NOT_RUNNING: '交易对账服务未运行',
  RECONCILER_ERROR: '交易对账服务发生异常',
  UNPROTECTED_LIVE_POSITIONS: '存在未受保护的真实持仓',
  UNRESOLVED_TRADE_ATTEMPTS: '存在尚未解决的交易记录',
  WALLET_QUARANTINE_ACTIVE: '存在成交状态不确定的钱包，已冻结该链该钱包的资金写入',
  CHAIN_CONSECUTIVE_FAILURE_LOCK: '该链连续明确失败次数达到阈值，新买入已暂停',
  FAST_PATH_CACHE_NOT_READY: '快速交易缓存尚未就绪',
  FAST_PATH_WARMER_NOT_RUNNING: '快速交易缓存预热服务未运行',
  FOLLOW_POLICY_NOT_LIVE: '关注发现策略未处于实盘模式',
  FOLLOW_WATCH_NOT_SYNCED: '关注发现目标尚未同步到 6551 Watch',
  FOLLOW_SCOPE_CHAIN_MISSING: '关注发现作用域没有配置交易链',
  P21_FOLLOW_DISCOVERY_DISABLED: 'P21 关注发现运行开关尚未开启',
  ARM_SCOPE_CHANGED: '启动确认后，交易作用域已发生变化',
  ARM_SNAPSHOT_STALE: '启动确认快照已失效，需要重新检查',
  LIVE_SCOPE_SIGNAL_NOT_ALLOWED: '信号不属于当前已确认的交易作用域',
  RUNTIME_SCOPE_NOT_FOUND: '指定的交易作用域不存在或已停用',
  FAST_PATH_WARMER_ERROR: '快速交易缓存预热服务异常',
  FAST_PATH_SLO_NOT_VERIFIED: '快速交易时延指标尚未验证',
  LIVE_CONFIGURATION_CHANGED: '真实交易配置已变化，需要重新检查',
  CONTRACT_PROBE_FAILED: 'GMGN 接口契约探测失败',
  STRATEGY_PROBE_FAILED: 'GMGN 策略只读接口探测失败',
  LIVE_ACCEPTANCE_SCOPE_EXPIRED: '限时实盘验收已过期，系统保持空策略',
  WHITELIST_HARD_LIMIT_INVALID: '白名单交易硬限额无效',
  CHAIN_NOT_IMPLEMENTED: '该链交易能力尚未实现',
  CHAIN_CONTRACT_NOT_TESTED: '该链尚未完成 GMGN 接口实测',
  CHAIN_PRODUCTION_NOT_APPROVED: '该链尚未完成真实买入和平仓验收，生产权限未批准',
  CHAIN_SHADOW_NOT_VERIFIED: '该链尚未完成影子运行验证',
  CHAIN_LIVE_FLAG_NOT_SET: '该链旧版实盘验收标记未设置',
  CHAIN_LIVE_DISABLED: '该链实盘开关尚未开启',
  CHAIN_RPC_MISSING: '该链只读验真 RPC 未配置',
  CHAIN_FEE_RESERVE_MISSING: '该链最大费用预留未配置',
  CHAIN_GAS_RESERVE_MISSING: '该链最低 Gas 保留额未配置',
  CHAIN_RPC_UNAVAILABLE: '该链只读验真 RPC 当前不可用',
  RPC_CHAIN_MISMATCH: 'RPC 返回的链身份与目标链不一致',
  CHAIN_BUDGET_DISABLED: '该链交易预算尚未启用',
  CHAIN_HARD_LIMIT_INVALID: '该链交易硬限额无效',
  CHAIN_NATIVE_BALANCE_UNKNOWN: '无法读取该链原生资产余额',
  CHAIN_NATIVE_BALANCE_INSUFFICIENT: '该链原生资产余额不足',
  LIVE_PROVIDER_NOT_ALLOWED: '该信号来源未获实盘授权',
  LIVE_EVENT_NOT_ALLOWED: '该互动类型未获实盘授权',
  LIVE_EVENT_NOT_VERIFIED: '该互动类型尚未完成真实验证',
  LIVE_CHAIN_NOT_ALLOWED: '该链未被实盘策略允许',
  LIVE_WHITELIST_NOT_ALLOWED: '该白名单未被实盘策略允许',
  LIVE_EXPLICIT_RELATION_REQUIRED: '缺少明确的账号关系绑定',
  SIGNAL_EXPIRED: '信号已超过允许时效',
  CHAIN_DAILY_BUDGET_EXCEEDED: '已超过该链每日资金上限',
  CHAIN_WEEKLY_BUDGET_EXCEEDED: '已超过该链每周资金上限',
  CHAIN_PER_TRADE_LIMIT_EXCEEDED: '已超过该链单笔本金上限',
  MAX_OPEN_POSITIONS_REACHED: '已达到该链最大同时持仓数',
  WHITELIST_BUDGET_EXCEEDED: '已超过该白名单累计预算',
  GLOBAL_DAILY_USD_BUDGET_EXCEEDED: '已超过全局每日美元资金上限',
  GLOBAL_WEEKLY_USD_BUDGET_EXCEEDED: '已超过全局每周美元资金上限',
  MINIMUM_GAS_RESERVE_BREACH: '交易后余额将低于最低 Gas 保留额',
};

const BLOCKER_ACTION_LABELS: Record<string, string> = {
  MIGRATION_NOT_CURRENT: '停止交易进程，备份数据库后执行 P14 additive migration',
  LIVE_MODE_REQUIRED: '后台尚未加载真实交易运行基线',
  LIVE_TRADING_DISABLED: '后台尚未加载真实交易许可基线',
  FOLLOW_WATCH_NOT_SYNCED: '等待 6551 Watch 同步成功后重新检查',
  P21_FOLLOW_DISCOVERY_DISABLED: '开启 P21 关注发现运行开关后重新检查',
  ARM_SCOPE_CHANGED: '返回作用域配置，确认 Revision 后重新准备',
  ARM_SNAPSHOT_STALE: '重新执行一次实盘检查，不复用旧快照',
  X_6551_INGESTION_UNHEALTHY: '系统正在自动重连，状态恢复后弹窗会自动更新',
  LIVE_POLICY_EMPTY: '选择 6551、回复、SOL 和首个 CA，然后保存实盘执行策略',
  P20_LIVE_DISABLED: '开启 P20 实盘能力，或将动态策略切换为记录、模拟或暂停',
  DYNAMIC_POLICY_CONFIG_INVALID: '检查动态策略逐链金额、每日额度、滑点和每日新币上限',
  LIVE_POLICY_CONTAINS_UNVERIFIED_EVENT: '只保留已经真实验证的互动类型',
  LIVE_POLICY_WHITELIST_MISSING: '检查实盘策略选择的白名单是否仍为启用状态',
  LIVE_POLICY_RELATION_MISSING: '在白名单中添加并启用“监控账号 → 项目账号”关系',
  NO_LIVE_CHAIN_READY: '检查所选链的 GMGN、RPC、钱包和预算状态',
  GLOBAL_USD_LIMIT_INVALID: '填写全局每日和每周 USD 上限',
  CHAIN_CONTRACT_NOT_TESTED: '等待该链接口实测完成',
  CHAIN_PRODUCTION_NOT_APPROVED: '先完成限时单白名单真实买入和平仓验收，再由管理员批准生产',
  LIVE_ACCEPTANCE_SCOPE_EXPIRED: '保持交易引擎停止，由管理员通过后台维护工具结束或取消过期验收',
  CHAIN_SHADOW_NOT_VERIFIED: '等待该链影子运行验证完成',
  CHAIN_LIVE_DISABLED: '等待该链完成验收后开放',
  CHAIN_BUDGET_DISABLED: '在链配置中启用该链预算',
  CHAIN_HARD_LIMIT_INVALID: '修正该链交易限额',
  CHAIN_NATIVE_BALANCE_INSUFFICIENT: '降低交易限额或补充原生资产',
  CHAIN_FEE_RESERVE_MISSING: '在环境配置中填写该链最大费用预留',
  CHAIN_GAS_RESERVE_MISSING: '在环境配置中填写该链最低 Gas 保留额',
  CHAIN_RPC_UNAVAILABLE: '检查该链 RPC 网络连接后重新检查',
  RPC_CHAIN_MISMATCH: '更换为目标主网的 RPC 地址',
  LIVE_CONFIGURATION_CHANGED: '点击“启动真实交易”重新完成实时检查',
  GMGN_RECENT_429: '等待限流冷却结束',
  WALLET_QUARANTINE_ACTIVE: '先核对 GMGN Order、链上回执和余额证据，再带审计原因解除隔离',
  CHAIN_CONSECUTIVE_FAILURE_LOCK: '排查该链失败原因，确认修复后在交易日志页人工重置熔断',
  FAST_PATH_CACHE_NOT_READY: '等待快速交易缓存预热完成',
  FAST_PATH_SLO_NOT_VERIFIED: '继续采集真实事件并完成时延验证',
};

const EVENT_LABELS: Record<string, string> = {
  tweet: '发帖',
  retweet: '转发',
  quote: '引用',
  reply: '回复',
  follow: '关注',
  unfollow: '取消关注',
  ca: '提及合约地址',
};

const RESEARCH_ROLE_LABELS: Record<string, string> = {
  official_project: '项目官方',
  project: '项目账号',
  founder: '创始人',
  co_founder: '联合创始人',
  ceo: 'CEO',
  core_team: '核心团队',
  team_account: '团队账号',
  ecosystem: '生态账号',
  advisor: '顾问',
  contributor: '贡献者',
};

const SIGNAL_TYPE_LABELS: Record<string, string> = {
  handle_match: '项目账号关系匹配',
  ca_mention: '合约地址提及',
  ticker_mention: '代币符号提及',
};

const SIDE_LABELS: Record<string, string> = {
  buy: '买入',
  sell: '卖出',
  strategy_create: '创建策略',
  strategy_cancel: '取消策略',
};

const QUERY_STAGE_LABELS: Record<string, string> = {
  stopped: '已停止查询',
  hot_1s: '高频确认（每 1 秒）',
  warm_2s: '快速确认（每 2 秒）',
  cool_5s: '常规确认（每 5 秒）',
  stable_15_30s: '稳定查询（每 15-30 秒）',
  terminal_audit_15_30m: '终态审计（每 15-30 分钟）',
};

const WATCH_ACTION_LABELS: Record<string, string> = {
  none: '无需变更',
  add: '新增监控',
  update: '更新监控',
  delete: '删除监控',
  adopt: '接管监控',
  protected: '受保护，不变更',
};

export function modeLabel(value?: string | null): string {
  return MODE_LABELS[String(value || 'unknown').toLowerCase()] || `未知模式（${value}）`;
}

export function statusLabel(value?: string | null): string {
  return STATUS_LABELS[String(value || 'unknown').toLowerCase()] || `未知状态（${value}）`;
}

export function researchRoleLabel(value?: string | null): string {
  const normalized = String(value || '').trim().toLowerCase();
  return RESEARCH_ROLE_LABELS[normalized] || String(value || '项目相关账号');
}

export function blockerLabel(value: string): string {
  return BLOCKER_LABELS[value] || `未识别的阻断项（${value}）`;
}

export function blockerActionLabel(value: string): string {
  return BLOCKER_ACTION_LABELS[value] || '请先处理该项后重新检查';
}

const ADVISORY_LABELS: Record<string, string> = {
  GMGN_TRADE_WEIGHT_REFILLING: 'GMGN 额度正在恢复中',
  GMGN_SCHEDULER_BUSY: 'GMGN 当前有请求排队',
  FAST_PATH_WARMER_DISABLED_LAZY_LOAD: '快速交易缓存按需加载',
  FAST_PATH_CACHE_NOT_READY: '快速交易缓存尚未全部命中',
  FAST_PATH_SLO_NOT_VERIFIED: '快速交易时延样本尚未达标',
  TRADE_ALERTS_NOT_VERIFIED: '资金告警尚未完成验证',
  WALLET_QUARANTINE_ACTIVE: '存在待核对的钱包写入隔离',
};

const ADVISORY_ACTION_LABELS: Record<string, string> = {
  GMGN_TRADE_WEIGHT_REFILLING: '等待额度恢复；不重复触发探测',
  GMGN_SCHEDULER_BUSY: '等待当前请求完成',
  FAST_PATH_WARMER_DISABLED_LAZY_LOAD: '首次交易按需补齐缓存',
  FAST_PATH_CACHE_NOT_READY: '交易前只补齐当前 CA 所需数据',
  FAST_PATH_SLO_NOT_VERIFIED: '继续积累样本，不阻止本次作用域确认',
  TRADE_ALERTS_NOT_VERIFIED: '完成告警测试后再作为运维验收项处理',
  WALLET_QUARANTINE_ACTIVE: '先核对该钱包的未确定结果',
};

export function advisoryLabel(value: string): string {
  return ADVISORY_LABELS[value] || `观察项（${value}）`;
}

export function advisoryActionLabel(value: string): string {
  return ADVISORY_ACTION_LABELS[value] || '记录并观察，不作为启动阻断项';
}

export function eventTypeLabel(value?: string | null): string {
  return EVENT_LABELS[String(value || 'unknown').toLowerCase()] || `未知互动（${value}）`;
}

export function signalTypeLabel(value?: string | null): string {
  return SIGNAL_TYPE_LABELS[String(value || '').toLowerCase()] || `未知匹配（${value}）`;
}

export function sideLabel(value?: string | null): string {
  return SIDE_LABELS[String(value || '').toLowerCase()] || `未知方向（${value}）`;
}

export function queryStageLabel(value?: string | null): string {
  if (!value) return '尚未开始';
  return QUERY_STAGE_LABELS[value] || `未知阶段（${value}）`;
}

export function watchActionLabel(value?: string | null): string {
  return WATCH_ACTION_LABELS[String(value || 'none').toLowerCase()] || `未知操作（${value}）`;
}
