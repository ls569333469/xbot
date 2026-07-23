import React, { useState, useEffect } from 'react';
import { api, getAuthToken, setAdminToken } from '../lib/api';
import { Shield, Settings, Server, Key, Eye, EyeOff, RefreshCw, RotateCcw, ListChecks, Radio, Gauge, LockKeyhole, Save, ShieldCheck, X } from 'lucide-react';
import type { TradeReadiness, TradeRuntimePolicy, X6551Status, X6551WatchPlan } from '../lib/types';
import { useToast } from '../components/ui/ToastContext';
import { FormSkeleton } from '../components/ui/Skeleton';
import { blockerActionLabel, blockerLabel, eventTypeLabel, statusLabel, watchActionLabel } from '../lib/display-labels';

const EDITABLE_CHAINS = ['sol', 'bsc', 'base', 'eth'] as const;
type EditableChain = typeof EDITABLE_CHAINS[number];

interface EditableChainConfig {
  enabled: boolean;
  dailyBudget: number;
  weeklyBudget: number;
  maxPerTrade: number;
  maxOpenPositions: number;
  dailyLossLimit: number;
  nativeSymbol: string;
  defaultTpPct?: number;
  defaultSlPct?: number;
  defaultSlippage?: number;
}

interface LiveEngineRuntime {
  armed: boolean;
  status: 'stopped' | 'recovering' | 'running' | 'fault_protected';
  desiredRunning: boolean;
  lastError: string | null;
  lastErrorDetails: unknown;
  operator: string | null;
  armedAt: string | null;
  lastRecoveredAt: string | null;
}

const SCHEDULER_PRIORITIES = [
  ['0', 'P0 订单确认'],
  ['1', 'P1 新交易'],
  ['2', 'P2 策略动作'],
  ['3', 'P3 稳定对账'],
  ['4', 'P4 缓存预热'],
] as const;

function formatEvidenceTime(value: string | null) {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? '-'
    : parsed.toLocaleString('zh-CN', { hour12: false });
}

export default function SettingsPage() {
  const [isArmed, setIsArmed] = useState(false);
  const [engineMode, setEngineMode] = useState('signal');
  const [engineRuntime, setEngineRuntime] = useState<LiveEngineRuntime>({
    armed: false,
    status: 'stopped',
    desiredRunning: false,
    lastError: null,
    lastErrorDetails: null,
    operator: null,
    armedAt: null,
    lastRecoveredAt: null
  });
  const [riskConfig, setRiskConfig] = useState<any>({
    security_check_enabled: true, max_buy_tax: 5, max_sell_tax: 10,
    max_rug_ratio: 0.3, min_liquidity_usd: 10000, max_slippage_pct: 15,
    consecutive_loss_limit: 5, ca_cooldown_min: 30,
  });
  const [xConfig, setXConfig] = useState<any>({
    timeline_poll_interval_sec: 60, follows_poll_interval_sec: 60, max_kol_per_round: 3,
  });
  const [envConfig, setEnvConfig] = useState<any>({
    BACKEND_PORT: '3011',
    BACKEND_HOST: '127.0.0.1',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'xbot',
    DB_USER: 'pm_user',
    DB_PASSWORD: '',
    TRADING_MODE: 'signal',
    GMGN_API_KEY: '',
    GMGN_PRIVATE_KEY_CONFIGURED: false,
    X_DATA_PROVIDER: 'mock',
    SOCIALDATA_API_KEY: '',
    OPENNEWS_TOKEN: '',
    TWITTERAPI_IO_API_KEY: '',
    TWITTERAPI_IO_FOLLOW_INTERVAL_MS: '60000',
    TWITTERAPI_IO_MIN_INTERVAL_MS: '6000',
    TWITTERAPI_IO_DAILY_CREDIT_LIMIT: '50000',
    TWITTERAPI_IO_CREDIT_WARNING_PCT: '80',
    TWITTER_STREAM_ENABLED: 'false',
    TWITTERAPI_IO_WEBHOOK_SECRET: '',
    X_6551_TIMEOUT_MS: '15000',
    X_6551_WSS_ENABLED: 'false',
    X_6551_WATCH_APPLY_ENABLED: 'false',
    X_6551_WATCH_UNFOLLOW_ENABLED: 'false',
    X_6551_HEARTBEAT_MS: '20000',
    X_6551_RECONNECT_MAX_MS: '30000',
    X_6551_MONTHLY_MESSAGE_LIMIT: '2000000',
    LIVE_TRADING_ENABLED: 'false',
    SHADOW_LIVE_ENABLED: 'false',
    ADMIN_TOKEN: ''
  });

  const [loading, setLoading] = useState(true);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState('');
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [x6551Status, setX6551Status] = useState<X6551Status | null>(null);
  const [watchPlan, setWatchPlan] = useState<X6551WatchPlan | null>(null);
  const [watchPlanLoading, setWatchPlanLoading] = useState(false);
  const [runtimePolicy, setRuntimePolicy] = useState<TradeRuntimePolicy | null>(null);
  const [livePolicy, setLivePolicy] = useState<any>({
    providers: [], event_types: [], chains: [], whitelist_ids: [], max_signal_age_seconds: 30
  });
  const [chainConfigs, setChainConfigs] = useState<Partial<Record<EditableChain, EditableChainConfig>>>({});
  const [savedChainConfigs, setSavedChainConfigs] = useState<Partial<Record<EditableChain, EditableChainConfig>>>({});
  const [selectedChain, setSelectedChain] = useState<EditableChain>('sol');
  const [savingChain, setSavingChain] = useState<EditableChain | null>(null);
  const [policyWhitelists, setPolicyWhitelists] = useState<Array<{
    id: string; symbol?: string; chain_id: string; contract_address: string;
    budget_per_trade?: number; total_budget?: number; project_name?: string;
  }>>([]);
  const [privateKeyDraft, setPrivateKeyDraft] = useState('');
  const [armReadiness, setArmReadiness] = useState<TradeReadiness | null>(null);
  const [showArmDialog, setShowArmDialog] = useState(false);
  const [schedulerNow, setSchedulerNow] = useState(Date.now());
  const { toast } = useToast();

  const applyEngineStatus = (data: any) => {
    setIsArmed(Boolean(data?.armed));
    setEngineMode(data?.mode || 'signal');
    setEngineRuntime(previous => ({
      ...previous,
      ...data,
      armed: Boolean(data?.armed),
      status: data?.status || (data?.armed ? 'running' : 'stopped'),
      desiredRunning: Boolean(data?.desiredRunning)
    }));
  };

  useEffect(() => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }

    Promise.all([
      api.system.engineStatus(),
      api.config.get('risk_config'),
      api.config.get('x_monitor_config'),
      api.system.getEnv(),
      api.xMonitor.status6551(),
      api.trade.runtimePolicy(),
      api.config.get('live_policy'),
      api.whitelist.list({ pageSize: '100' }),
      api.config.getChains(),
    ]).then(([engineRes, riskRes, xRes, envRes, x6551Res, runtimeRes, livePolicyRes, whitelistRes, chainConfigRes]) => {
      if (engineRes.ok && engineRes.data) {
        applyEngineStatus(engineRes.data);
      }
      if (riskRes.ok && riskRes.data) setRiskConfig((previous: any) => ({ ...previous, ...riskRes.data }));
      if (xRes.ok && xRes.data) setXConfig(xRes.data);
      if (envRes.ok && envRes.data) setEnvConfig((previous: any) => ({ ...previous, ...envRes.data }));
      if (x6551Res.ok && x6551Res.data) setX6551Status(x6551Res.data);
      if (runtimeRes.ok && runtimeRes.data) setRuntimePolicy(runtimeRes.data);
      if (livePolicyRes.ok && livePolicyRes.data) {
        setLivePolicy((previous: any) => ({ ...previous, ...livePolicyRes.data }));
      }
      if (whitelistRes.ok && whitelistRes.data) setPolicyWhitelists(whitelistRes.data);
      if (chainConfigRes.ok && chainConfigRes.data) {
        setChainConfigs(chainConfigRes.data);
        setSavedChainConfigs(chainConfigRes.data);
      }
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (!showArmDialog || !getAuthToken()) return;
    let active = true;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const response = await api.system.readiness(false);
        if (active && response.ok && response.data) setArmReadiness(response.data);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refresh(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [showArmDialog]);

  useEffect(() => {
    if (!getAuthToken()) return;

    let active = true;
    let inFlight = false;
    const refreshRuntime = async () => {
      setSchedulerNow(Date.now());
      if (inFlight) return;
      inFlight = true;
      try {
        const [runtimeResponse, engineResponse] = await Promise.all([
          api.trade.runtimePolicy(),
          api.system.engineStatus()
        ]);
        if (!active) return;
        if (runtimeResponse.ok && runtimeResponse.data) setRuntimePolicy(runtimeResponse.data);
        if (engineResponse.ok && engineResponse.data) applyEngineStatus(engineResponse.data);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refreshRuntime(), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const handleToggle = async () => {
    if (!isArmed) {
      const readiness = await api.system.readiness(true);
      if (!readiness.ok || !readiness.data) {
        toast(readiness.error || '实盘准备状态检查失败', 'error');
        return;
      }
      setArmReadiness(readiness.data);
      setShowArmDialog(true);
      return;
    }
    const res = await api.system.disarm();
    if (res.ok && res.data) {
      applyEngineStatus({ ...res.data, mode: engineMode });
      toast('已停止接收新的真实买入', 'warning');
    } else {
      toast(res.error || '操作失败', 'error');
    }
  };

  const confirmArm = async () => {
    if (!armReadiness?.readyToArm) return;
    const res = await api.system.arm('ARM LIVE TRADING');
    if (res.ok && res.data) {
      applyEngineStatus(res.data);
      setShowArmDialog(false);
      toast('真实交易已启动', 'success');
    } else {
      toast(res.error || '启动真实交易失败', 'error');
    }
  };

  const saveRisk = async () => {
    const res = await api.config.set('risk_config', riskConfig);
    if (res.ok && res.data) setRiskConfig((previous: any) => ({ ...previous, ...res.data }));
    toast(res.ok ? '已保存风控设置' : '保存失败', res.ok ? 'success' : 'error');
  };

  const saveXConfig = async () => {
    const res = await api.config.set('x_monitor_config', xConfig);
    toast(res.ok ? '已保存监控设置' : '保存失败', res.ok ? 'success' : 'error');
  };

  const togglePolicyValue = (field: 'providers' | 'event_types' | 'chains' | 'whitelist_ids', value: string | number) => {
    setLivePolicy((previous: any) => {
      const current = Array.isArray(previous[field]) ? previous[field] : [];
      const exists = current.includes(value);
      return { ...previous, [field]: exists ? current.filter((item: any) => item !== value) : [...current, value] };
    });
  };

  const saveLivePolicy = async () => {
    if (!window.confirm('确认保存实盘执行策略并停止新的真实买入？已有订单、持仓保护和退出会继续运行。')) return;
    const res = await api.config.set('live_policy', livePolicy);
    if (res.ok && res.data) {
      setLivePolicy(res.data);
      setIsArmed(false);
      setEngineRuntime(previous => ({ ...previous, armed: false, status: 'fault_protected', desiredRunning: false, lastError: 'LIVE_CONFIGURATION_CHANGED' }));
      const runtime = await api.trade.runtimePolicy();
      if (runtime.ok && runtime.data) setRuntimePolicy(runtime.data);
      toast('实盘执行策略已保存，新的真实买入已停止', 'success');
    } else {
      toast(res.error || '实盘执行策略保存失败', 'error');
    }
  };

  const updateChainConfig = <K extends keyof EditableChainConfig>(
    chain: EditableChain,
    field: K,
    value: EditableChainConfig[K]
  ) => {
    setChainConfigs(previous => ({
      ...previous,
      [chain]: { ...previous[chain], [field]: value } as EditableChainConfig,
    }));
  };

  const saveChainConfig = async (chain: EditableChain) => {
    const config = chainConfigs[chain];
    if (!config) return;
    const positiveFields: Array<keyof EditableChainConfig> = [
      'maxPerTrade', 'dailyBudget', 'weeklyBudget', 'maxOpenPositions', 'dailyLossLimit'
    ];
    if (positiveFields.some(field => !Number.isFinite(Number(config[field])) || Number(config[field]) <= 0)) {
      toast('链级交易额度必须全部大于 0', 'error');
      return;
    }
    if (config.maxPerTrade > config.dailyBudget || config.dailyBudget > config.weeklyBudget) {
      toast('额度必须满足：单笔上限 <= 每日上限 <= 每周上限', 'error');
      return;
    }
    if (!Number.isInteger(config.maxOpenPositions)) {
      toast('最大同时持仓数必须是整数', 'error');
      return;
    }
    if (!window.confirm(`确认保存 ${chain.toUpperCase()} 资金上限并停止新的真实买入？`)) return;

    setSavingChain(chain);
    const response = await api.config.setChain(chain, config);
    setSavingChain(null);
    if (!response.ok || !response.data) {
      toast(response.error || '保存链级资金配置失败', 'error');
      return;
    }
    setChainConfigs(response.data);
    setSavedChainConfigs(response.data);
    setIsArmed(false);
    setEngineRuntime(previous => ({
      ...previous,
      armed: false,
      status: 'fault_protected',
      desiredRunning: false,
      lastError: 'CHAIN_CONFIGURATION_CHANGED'
    }));
    const runtime = await api.trade.runtimePolicy();
    if (runtime.ok && runtime.data) setRuntimePolicy(runtime.data);
    toast(`${chain.toUpperCase()} 资金上限已保存，请重新检查并启动真实交易`, 'success');
  };

  const resetChainConfig = (chain: EditableChain) => {
    const saved = savedChainConfigs[chain];
    if (!saved) return;
    setChainConfigs(previous => ({ ...previous, [chain]: saved }));
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const runDedicatedRestart = async (action: () => Promise<any>, message: string) => {
    setIsRestarting(true);
    setRestartMessage(message);
    const res = await action();
    if (!res.ok) {
      setIsRestarting(false);
      toast(res.error || '配置更新失败', 'error');
      return;
    }
    setRestartMessage('后台正在以停止新买入状态重启...');
    setTimeout(() => window.location.reload(), 2200);
  };

  const replacePrivateKey = async () => {
    if (!privateKeyDraft.trim()) return;
    if (!window.confirm('确认替换 GMGN 签名私钥并立即停止新的真实买入？')) return;
    await runDedicatedRestart(
      () => api.system.replaceGmgnPrivateKey(privateKeyDraft),
      '正在替换 GMGN 签名私钥...'
    );
  };

  const refresh6551Status = async () => {
    const res = await api.xMonitor.status6551();
    if (res.ok && res.data) setX6551Status(res.data);
    else toast(`6551 状态刷新失败: ${res.error || 'Unknown error'}`, 'error');
  };

  const run6551WatchDryRun = async () => {
    setWatchPlanLoading(true);
    const res = await api.xMonitor.watchPlan6551();
    setWatchPlanLoading(false);
    if (res.ok && res.data) {
      setWatchPlan(res.data);
      toast('6551 监控变更预览已完成', 'success');
    } else {
      toast(`6551 监控变更预览失败：${res.error || '未知错误'}`, 'error');
    }
  };

  const saveEnv = async () => {
    setIsRestarting(true);
    setRestartMessage('正在写入 .env 配置文件并请求系统自热重启...');
    const {
      TRADING_MODE: _mode,
      LIVE_TRADING_ENABLED: _liveEnabled,
      GMGN_PRIVATE_KEY_CONFIGURED: _privateKeyConfigured,
      ...generalConfig
    } = envConfig;
    const res = await api.system.saveEnv(generalConfig);
    if (!res.ok) {
      setIsRestarting(false);
      toast('保存 API 环境变量失败: ' + res.error, 'error');
      return;
    }

    setRestartMessage('正在等待后台进程自重载并检验数据库健康连通性...');
    if (envConfig.ADMIN_TOKEN && envConfig.ADMIN_TOKEN !== '********') {
      setAdminToken(envConfig.ADMIN_TOKEN);
    }

    let pollCount = 0;
    const interval = setInterval(async () => {
      pollCount++;
      if (pollCount > 15) {
        clearInterval(interval);
        setIsRestarting(false);
        toast('服务重启超时，请在服务器后台终端检查 Express 进程状态', 'error');
        return;
      }

      try {
        const health = await api.system.engineStatus();
        if (health.ok) {
          clearInterval(interval);
          setIsRestarting(false);
          toast('API 与环境变量已成功载入并重启就绪！', 'success');
          // Refresh configuration data
          Promise.all([
            api.system.engineStatus(),
            api.config.get('risk_config'),
            api.config.get('x_monitor_config'),
            api.system.getEnv(),
            api.xMonitor.status6551(),
          ]).then(([eR, rR, xR, evR, sR]) => {
            if (eR.ok && eR.data) {
              applyEngineStatus(eR.data);
            }
            if (rR.ok && rR.data) setRiskConfig((previous: any) => ({ ...previous, ...rR.data }));
            if (xR.ok && xR.data) setXConfig(xR.data);
            if (evR.ok && evR.data) setEnvConfig(evR.data);
            if (sR.ok && sR.data) setX6551Status(sR.data);
          });
        }
      } catch {
        // Continue polling if connection is refused during restart
      }
    }, 1500);
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-lg max-w-4xl">
        <div className="card flex justify-between items-center" style={{ minHeight: '110px' }}>
          <div className="flex-1">
            <div className="skeleton mb-xs" style={{ width: '40%', height: '20px' }}></div>
            <div className="skeleton" style={{ width: '70%', height: '14px' }}></div>
          </div>
          <div className="skeleton rounded-md" style={{ width: '150px', height: '52px' }}></div>
        </div>
        <div className="grid grid-cols-2 gap-lg">
          <FormSkeleton />
          <FormSkeleton />
        </div>
      </div>
    );
  }

  const selectedChainConfig = chainConfigs[selectedChain];
  const editableChainFields: Array<keyof EditableChainConfig> = [
    'enabled', 'maxPerTrade', 'dailyBudget', 'weeklyBudget', 'maxOpenPositions', 'dailyLossLimit'
  ];
  const chainHasChanges = (chain: EditableChain) => {
    const current = chainConfigs[chain];
    const saved = savedChainConfigs[chain];
    return Boolean(current && saved && editableChainFields.some(field => current[field] !== saved[field]));
  };
  const selectedChainHasChanges = chainHasChanges(selectedChain);

  return (
    <div className="flex flex-col gap-lg max-w-4xl position-relative">
      
      {/* Restart Overlay overlay */}
      {isRestarting && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(10, 10, 15, 0.85)', backdropFilter: 'blur(20px)',
          zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', color: '#ffffff'
        }}>
          <div className="flex flex-col items-center gap-md text-center max-w-md px-lg">
            <div className="relative mb-md">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: 'var(--color-accent)' }}></div>
              <Server className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-secondary" size={16} />
            </div>
            <h3 className="text-lg font-bold">后台进程重载中</h3>
            <p className="text-secondary text-sm">{restartMessage}</p>
          </div>
        </div>
      )}

      {showArmDialog && armReadiness && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(10, 10, 15, 0.78)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
        }}>
          <div className="card flex flex-col gap-md" role="dialog" aria-modal="true" aria-label="启动真实交易"
            style={{ width: 'min(760px, 100%)', maxHeight: '88vh', overflowY: 'auto' }}>
            <div className="flex justify-between items-center border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}>
              <div>
                <h3 className="text-lg font-bold">启动真实交易</h3>
                <span className={`text-xs font-mono ${armReadiness.readyToArm ? 'text-success' : 'text-danger'}`}>
                  {armReadiness.readyToArm ? '实时检查通过，可以启动' : '实时检查未通过'}
                </span>
              </div>
              <div className="flex items-center gap-xs">
                <button type="button" className="btn btn-secondary" onClick={async () => {
                  const response = await api.system.readiness(true);
                  if (response.ok && response.data) setArmReadiness(response.data);
                  else toast(response.error || '重新检查失败', 'error');
                }} title="重新检查">
                  <RefreshCw size={16} />
                </button>
                <button type="button" className="btn btn-secondary" onClick={() => setShowArmDialog(false)} title="关闭">
                  <X size={16} />
                </button>
              </div>
            </div>

            {armReadiness.blockers.length > 0 && (
              <div className="flex flex-col gap-xs">
                <strong className="text-sm text-danger">还需完成 {armReadiness.blockers.length} 项</strong>
                {armReadiness.blockers.map(blocker => (
                  <div key={blocker} className="border-t pt-xs" style={{ borderColor: 'var(--color-border)' }}>
                    <div className="text-sm font-medium">{blockerLabel(blocker)}</div>
                    <div className="text-xs text-secondary">{blockerActionLabel(blocker)}</div>
                  </div>
                ))}
              </div>
            )}

            {armReadiness.advisories.length > 0 && (
              <div className="flex flex-col gap-xs border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                <strong className="text-sm">观察项（不阻断真实交易）</strong>
                <div className="text-xs text-secondary">
                  {armReadiness.advisories.map(blockerLabel).join(' · ')}
                </div>
              </div>
            )}

            <div className="flex flex-col gap-sm">
              {armReadiness.chains.map(chain => {
                const nativeEntry = chain.native_balances?.find(item => item.symbol);
                const nativeBalance = chain.native_balance ?? nativeEntry?.balance ?? nativeEntry?.amount ?? null;
                return (
                  <div key={chain.chain} className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <div className="flex justify-between items-center gap-sm" style={{ flexWrap: 'wrap' }}>
                      <strong className="font-mono">{chain.chain.toUpperCase()}</strong>
                      <span className={`text-xs font-mono ${chain.ready ? 'text-success' : 'text-secondary'}`}>
                        {chain.ready ? '可以实盘' : '尚未开放'}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '8px' }}>
                      <div><span className="text-xs text-secondary">托管钱包</span><div className="text-xs font-mono" style={{ overflowWrap: 'anywhere' }}>{chain.wallet_address || '-'}</div></div>
                      <div><span className="text-xs text-secondary">原生资产余额</span><div className="text-xs font-mono">{nativeBalance ?? '-'}</div></div>
                      <div><span className="text-xs text-secondary">GMGN 接口 / RPC 实时探测</span><div className="text-xs font-mono">{chain.contract_tested ? '已通过' : '未通过'} / {chain.rpc_probe?.ok ? `已通过（区块 ${chain.rpc_probe.blockRef}）` : '未通过'}</div></div>
                      <div><span className="text-xs text-secondary">单笔 / 每日 / 每周</span><div className="text-xs font-mono">{chain.limits?.maxPerTrade ?? '-'} / {chain.limits?.dailyBudget ?? '-'} / {chain.limits?.weeklyBudget ?? '-'}</div></div>
                      <div><span className="text-xs text-secondary">真实成交（买入 / 卖出）</span><div className="text-xs font-mono">{chain.trade_evidence.confirmedBuys} / {chain.trade_evidence.confirmedSells}</div></div>
                      <div><span className="text-xs text-secondary">GMGN 订单 / RPC 回执</span><div className="text-xs font-mono">{chain.trade_evidence.confirmedOrders} / {chain.trade_evidence.confirmedReceipts}</div></div>
                      <div><span className="text-xs text-secondary">最近链上确认</span><div className="text-xs font-mono">{formatEvidenceTime(chain.trade_evidence.lastConfirmedAt)}</div></div>
                    </div>
                    {chain.blockers.length > 0 && <div className="text-xs text-secondary font-mono mt-1" style={{ overflowWrap: 'anywhere' }}>{chain.blockers.map(blockerLabel).join(' · ')}</div>}
                  </div>
                );
              })}
            </div>

            <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
              <span className="text-xs text-secondary">本次自动交易范围</span>
              <div className="text-xs font-mono mt-1" style={{ overflowWrap: 'anywhere' }}>
                {armReadiness.policy?.providers.join(', ') || '-'} · {armReadiness.policy?.eventTypes.map(eventTypeLabel).join(', ') || '-'} · {armReadiness.policy?.whitelistIds.length || 0}
              </div>
              <div className="text-xs font-mono mt-1">
                全局 USD 每日 / 每周：{envConfig.GMGN_GLOBAL_DAILY_USD_LIMIT || '-'} / {envConfig.GMGN_GLOBAL_WEEKLY_USD_LIMIT || '-'} · SOL 最低保留：{envConfig.GMGN_MIN_GAS_RESERVE_SOL || '-'} SOL
              </div>
              <div className="flex flex-col gap-xs mt-1">
                {(armReadiness.policy?.whitelistIds || []).map(id => {
                  const whitelist = policyWhitelists.find(item => Number(item.id) === Number(id));
                  if (!whitelist) return null;
                  const relations = armReadiness.relations.filter(item => item.whitelistId === Number(id));
                  return (
                    <div key={id} className="text-xs font-mono flex flex-col gap-xs" style={{ overflowWrap: 'anywhere' }}>
                      <span>{whitelist.chain_id.toUpperCase()} · {whitelist.symbol || whitelist.project_name || '未命名'} · {whitelist.contract_address} · 单笔 {whitelist.budget_per_trade ?? '-'} · 累计 {whitelist.total_budget ?? '-'}</span>
                      {relations.map(relation => (
                        <span key={relation.id}>@{relation.actorHandle} → @{relation.targetHandle}</span>
                      ))}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex justify-end gap-sm border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
              <button type="button" className="btn btn-secondary" onClick={() => setShowArmDialog(false)}>返回设置</button>
              <button type="button" className="btn btn-primary" disabled={!armReadiness.readyToArm} onClick={confirmArm}>
                <Shield size={15} /> 确认启动真实交易
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Live trading control */}
      <div className="card flex justify-between items-center settings-live-control" style={{ background: isArmed ? 'rgba(0, 214, 143, 0.04)' : 'rgba(255, 71, 87, 0.04)', borderColor: isArmed ? 'rgba(0, 214, 143, 0.15)' : 'rgba(255, 71, 87, 0.15)', flexWrap: 'wrap', gap: '16px' }}>
        <div className="flex flex-col gap-xs settings-live-control__copy">
          <h2 className="text-xl font-bold flex items-center gap-sm">
            <Shield className={isArmed ? 'text-success' : 'text-danger'} />
            {isArmed ? '真实交易运行中' : engineRuntime.status === 'fault_protected' ? '故障保护' : '已停止'}
          </h2>
          <div className="flex gap-md text-sm" style={{ flexWrap: 'wrap' }}>
            <span><span className="text-secondary">新买入：</span><strong>{isArmed ? '自动执行' : '已停止'}</strong></span>
            <span><span className="text-secondary">已有订单与持仓：</span><strong>持续对账和保护</strong></span>
            {engineRuntime.operator && <span><span className="text-secondary">最近操作人：</span><strong>{engineRuntime.operator}</strong></span>}
          </div>
          <p className="text-secondary text-sm">
            {isArmed
              ? '新的合格 6551 信号会自动提交 GMGN 真实订单。'
              : engineRuntime.status === 'fault_protected'
                ? `系统已停止新买入：${engineRuntime.lastError ? blockerLabel(engineRuntime.lastError) : '实时检查未通过'}`
                : '不接收新的真实买入；订单查询、持仓保护和退出继续运行。'}
          </p>
        </div>
        <button className={`btn settings-live-control__action ${isArmed ? 'btn-danger' : 'btn-primary'}`}
          style={{ padding: '12px 24px', fontSize: '1.05rem', fontWeight: 700 }} onClick={handleToggle}>
          {isArmed ? '停止新买入' : '启动真实交易'}
        </button>
      </div>

      {runtimePolicy && (
        <div className="card flex flex-col gap-md">
          <div className="flex justify-between items-center border-b pb-sm" style={{ borderColor: 'var(--color-border)', flexWrap: 'wrap', gap: '12px' }}>
            <h3 className="text-lg font-bold flex items-center gap-sm"><Gauge size={18} /> GMGN 性能与限流</h3>
            <button className="btn btn-secondary" onClick={async () => {
              const res = await api.trade.runtimePolicy();
              if (res.ok && res.data) setRuntimePolicy(res.data);
            }}><RefreshCw size={15} /> 刷新</button>
          </div>
          <div className="settings-metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '12px' }}>
            <div><span className="text-xs text-secondary">请求调度器</span><strong className="block font-mono text-sm">{statusLabel(runtimePolicy.scheduler.state)}</strong></div>
            <div><span className="text-xs text-secondary">官方桶</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.officialRate}/{runtimePolicy.scheduler.officialCapacity}</strong></div>
            <div><span className="text-xs text-secondary">内部桶</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.currentRate}/{runtimePolicy.scheduler.configuredCapacity}</strong></div>
            <div><span className="text-xs text-secondary">可用权重</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.availableWeight.toFixed(2)}</strong></div>
            <div><span className="text-xs text-secondary">当前预留</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.reservedWeight.toFixed(2)}</strong></div>
            <div><span className="text-xs text-secondary">近 1 秒预留 / 消耗</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.reservedLastSecond} / {runtimePolicy.scheduler.consumedLastSecond}</strong></div>
            <div><span className="text-xs text-secondary">新交易预留</span><strong className="block font-mono text-sm">{runtimePolicy.new_trade_reservation_weight} 权重</strong></div>
            <div><span className="text-xs text-secondary">报价 / 下单权重</span><strong className="block font-mono text-sm">2 / 5</strong></div>
            <div><span className="text-xs text-secondary">队列</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.queueDepth}</strong></div>
            <div><span className="text-xs text-secondary">实时信号通道</span><strong className={`block font-mono text-sm ${runtimePolicy.live_queue.listenerConnected ? 'text-success' : 'text-danger'}`}>{runtimePolicy.live_queue.listenerConnected ? '已连接' : '扫描后备'}</strong></div>
            <div><span className="text-xs text-secondary">当前降级上限</span><strong className="block font-mono text-sm">每秒 {runtimePolicy.scheduler.currentRate} 权重</strong></div>
            <div><span className="text-xs text-secondary">最近 429</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.last429At ? new Date(runtimePolicy.scheduler.last429At).toLocaleString() : '无'}</strong></div>
            <div><span className="text-xs text-secondary">429 冷却倒计时</span><strong className="block font-mono text-sm">{runtimePolicy.scheduler.cooldownUntil ? `${Math.max(0, Math.ceil((runtimePolicy.scheduler.cooldownUntil - schedulerNow) / 1000))} 秒` : '无'}</strong></div>
          </div>
          <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-xs text-secondary">优先级队列</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginTop: '8px' }}>
              {SCHEDULER_PRIORITIES.map(([priority, label]) => (
                <div key={priority} className="font-mono text-xs">{label}: {runtimePolicy.scheduler.queueByPriority[priority] || 0}</div>
              ))}
            </div>
          </div>
          <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <span className="text-xs text-secondary">订单查询阶段</span>
            <div className="font-mono text-sm mt-1">1 秒 → 2 秒 → 5 秒 → 15-30 秒</div>
            <div className="font-mono text-xs text-secondary mt-1">运行中策略：10-30 秒 · 持仓余额：120 秒</div>
          </div>
          <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <div className="flex justify-between text-xs"><span className="text-secondary">快速交易时延指标 · 24 小时</span><strong className={runtimePolicy.readiness.latencySlo.passed ? 'text-success' : 'text-secondary'}>{runtimePolicy.readiness.latencySlo.passed ? '已达标' : '等待验证'}</strong></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px', marginTop: '8px' }}>
              {([
                ['事件入库', runtimePolicy.readiness.latencySlo.inbox],
                ['信号生成', runtimePolicy.readiness.latencySlo.signal],
                ['执行准备', runtimePolicy.readiness.latencySlo.execution],
                ['接收事件 → 发起下单', runtimePolicy.readiness.latencySlo.receiveToSwap]
              ] as const).map(([label, metric]) => (
                <div key={label} className="font-mono text-xs">
                  <span className="text-secondary">{label}</span>
                  <div>{metric.count} · {metric.p50 ?? '-'} / {metric.p95 ?? '-'} / {metric.p99 ?? '-'} ms</div>
                </div>
              ))}
            </div>
          </div>
          <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <div className="flex justify-between text-sm"><span>真实交易实时检查</span><strong className={runtimePolicy.readiness.readyToArm ? 'text-success' : 'text-danger'}>{runtimePolicy.readiness.readyToArm ? '可以启动' : '未通过'}</strong></div>
            {runtimePolicy.readiness.blockers.length > 0 && <div className="text-xs text-secondary font-mono mt-1" style={{ overflowWrap: 'anywhere' }}>{runtimePolicy.readiness.blockers.map(blockerLabel).join(' · ')}</div>}
            {runtimePolicy.readiness.advisories.length > 0 && <div className="text-xs text-secondary font-mono mt-1" style={{ overflowWrap: 'anywhere' }}>观察项：{runtimePolicy.readiness.advisories.map(blockerLabel).join(' · ')}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '12px' }}>
              <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                <strong className="font-mono text-sm">快速交易缓存</strong>
                <div className={`text-xs ${runtimePolicy.readiness.cacheRequired.ready ? 'text-success' : 'text-secondary'}`}>
                  {runtimePolicy.readiness.cacheRequired.ready ? '已就绪' : `缺少 ${runtimePolicy.readiness.cacheRequired.missing.length} 项`} · {runtimePolicy.readiness.cache.fresh}/{runtimePolicy.readiness.cacheRequired.total}
                </div>
              </div>
              <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                <strong className="font-mono text-sm">缓存预热服务</strong>
                <div className={`text-xs ${runtimePolicy.readiness.cacheWarmer.running && !runtimePolicy.readiness.cacheWarmer.lastError ? 'text-success' : 'text-secondary'}`}>
                  {runtimePolicy.readiness.cacheWarmer.running ? '运行中' : '已停止'} · 每批 {runtimePolicy.readiness.cacheWarmer.batchSize} 项
                </div>
              </div>
              <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                <strong className="font-mono text-sm">策略对账积压</strong>
                <div className="text-xs text-secondary">
                  {runtimePolicy.readiness.reconciler.strategyBacklog.reduce((total, item) => total + item.count, 0)}
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '12px' }}>
              {runtimePolicy.readiness.chains.map(chain => (
                <div key={chain.chain} className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                  <strong className="font-mono text-sm">{chain.chain.toUpperCase()}</strong>
                  <div className={`text-xs ${chain.ready ? 'text-success' : 'text-secondary'}`}>{chain.ready ? '可以实盘' : chain.blockers.map(blockerLabel).join('，')}</div>
                  <div className="text-xs font-mono mt-1">
                    真实买入 {chain.trade_evidence.confirmedBuys} · 真实卖出 {chain.trade_evidence.confirmedSells}
                  </div>
                  <div className="text-xs text-secondary font-mono">
                    GMGN 订单 {chain.trade_evidence.confirmedOrders} · RPC 回执 {chain.trade_evidence.confirmedReceipts}
                  </div>
                </div>
              ))}
            </div>
            {runtimePolicy.readiness.latestEvidence && (
              <div className="border-t pt-sm mt-1" style={{ borderColor: 'var(--color-border)' }}>
                <span className="text-xs text-secondary">最近一条实盘链路证据</span>
                <div className="text-xs font-mono mt-1" style={{ overflowWrap: 'anywhere' }}>
                  Provider Event {runtimePolicy.readiness.latestEvidence.providerEventId || '-'} · Activity #{runtimePolicy.readiness.latestEvidence.activityId || '-'} · Signal #{runtimePolicy.readiness.latestEvidence.signalId || '-'} ({statusLabel(runtimePolicy.readiness.latestEvidence.signalStatus || 'unknown')})
                </div>
                <div className="text-xs font-mono" style={{ overflowWrap: 'anywhere' }}>
                  Attempt #{runtimePolicy.readiness.latestEvidence.attemptId || '-'} · GMGN Order {runtimePolicy.readiness.latestEvidence.providerOrderId || '-'} · Tx {runtimePolicy.readiness.latestEvidence.txHash || '-'} · RPC {statusLabel(runtimePolicy.readiness.latestEvidence.receiptStatus || 'unknown')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="card flex flex-col gap-md">
        <div className="border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}>
          <h3 className="text-lg font-bold flex items-center gap-sm"><Gauge size={18} /> 链级资金上限</h3>
        </div>
        <div className="chain-config-tabs" role="tablist" aria-label="链级资金配置">
          {EDITABLE_CHAINS.map(chain => (
            <button
              key={chain}
              type="button"
              role="tab"
              aria-selected={selectedChain === chain}
              className="chain-config-tab"
              onClick={() => setSelectedChain(chain)}
            >
              <span>{chain.toUpperCase()}</span>
              {chainHasChanges(chain) && <span className="chain-config-tab__dirty" title="有未保存修改" />}
            </button>
          ))}
        </div>
        {selectedChainConfig && (
          <section className="chain-config-panel" role="tabpanel">
            <div className="chain-config-panel__heading">
              <label className="flex items-center gap-sm">
                <input type="checkbox" checked={selectedChainConfig.enabled}
                  onChange={event => updateChainConfig(selectedChain, 'enabled', event.target.checked)} />
                <strong className="font-mono">{selectedChain.toUpperCase()}</strong>
                <span className="text-xs text-secondary">允许真实交易</span>
              </label>
              <span className={`text-xs ${selectedChainHasChanges ? 'text-warning' : 'text-success'}`}>
                {selectedChainHasChanges ? '有未保存修改' : '已与后端同步'}
              </span>
            </div>
            <div className="chain-config-grid">
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">单笔本金上限 ({selectedChainConfig.nativeSymbol})</span>
                <input type="number" min="0.000001" step="0.000001" className="input font-mono"
                  value={selectedChainConfig.maxPerTrade}
                  onChange={event => updateChainConfig(selectedChain, 'maxPerTrade', Number(event.target.value))} />
              </label>
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">每日资金上限，含费 ({selectedChainConfig.nativeSymbol})</span>
                <input type="number" min="0.000001" step="0.000001" className="input font-mono"
                  value={selectedChainConfig.dailyBudget}
                  onChange={event => updateChainConfig(selectedChain, 'dailyBudget', Number(event.target.value))} />
              </label>
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">每周资金上限，含费 ({selectedChainConfig.nativeSymbol})</span>
                <input type="number" min="0.000001" step="0.000001" className="input font-mono"
                  value={selectedChainConfig.weeklyBudget}
                  onChange={event => updateChainConfig(selectedChain, 'weeklyBudget', Number(event.target.value))} />
              </label>
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">最大同时持仓数</span>
                <input type="number" min="1" step="1" className="input font-mono"
                  value={selectedChainConfig.maxOpenPositions}
                  onChange={event => updateChainConfig(selectedChain, 'maxOpenPositions', Number(event.target.value))} />
              </label>
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">每日亏损熔断 ({selectedChainConfig.nativeSymbol})</span>
                <input type="number" min="0.000001" step="0.000001" className="input font-mono"
                  value={selectedChainConfig.dailyLossLimit}
                  onChange={event => updateChainConfig(selectedChain, 'dailyLossLimit', Number(event.target.value))} />
              </label>
            </div>
            <div className="chain-config-actions">
              <button type="button" className="btn btn-secondary"
                disabled={!selectedChainHasChanges || savingChain !== null}
                onClick={() => resetChainConfig(selectedChain)}>
                <RotateCcw size={15} /> 撤销修改
              </button>
              <button type="button" className="btn btn-primary"
                disabled={!selectedChainHasChanges || savingChain !== null}
                onClick={() => void saveChainConfig(selectedChain)}>
                <Save size={15} /> {savingChain === selectedChain ? '保存中' : `保存 ${selectedChain.toUpperCase()} 参数`}
              </button>
            </div>
          </section>
        )}
      </div>

      <div className="card flex flex-col gap-md">
        <div className="flex justify-between items-center border-b pb-sm" style={{ borderColor: 'var(--color-border)', gap: '12px', flexWrap: 'wrap' }}>
          <h3 className="text-lg font-bold flex items-center gap-sm"><ShieldCheck size={18} /> 实盘执行策略</h3>
          <button type="button" className="btn btn-primary flex items-center gap-xs" onClick={saveLivePolicy}>
            <Save size={15} /> 保存策略并停止新买入
          </button>
        </div>

        <div className="flex flex-col gap-sm">
          <span className="text-xs text-secondary font-medium">允许的数据源</span>
          <label className="flex items-center gap-sm text-sm">
            <input type="checkbox" checked={livePolicy.providers.includes('6551')}
              onChange={() => togglePolicyValue('providers', '6551')} />
            <span className="font-mono">6551 Max</span>
          </label>
        </div>

        <div className="border-t pt-sm flex flex-col gap-sm" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-xs text-secondary font-medium">允许自动执行的事件类型</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: '8px' }}>
            {['tweet', 'retweet', 'quote', 'reply', 'follow'].map(eventType => {
              const verified = runtimePolicy?.readiness.policy?.verifiedEventTypes?.includes(eventType) || false;
              return (
                <label key={eventType} className="flex items-center gap-sm text-sm font-mono">
                  <input type="checkbox" checked={livePolicy.event_types.includes(eventType)}
                    disabled={!verified}
                    onChange={() => togglePolicyValue('event_types', eventType)} />
                  <span className={verified ? '' : 'text-secondary'}>{eventTypeLabel(eventType)}</span>
                </label>
              );
            })}
          </div>
        </div>

        <div className="border-t pt-sm flex flex-col gap-sm" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-xs text-secondary font-medium">允许链</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(70px, 1fr))', gap: '8px' }}>
            {['sol', 'bsc', 'base', 'eth'].map(chain => (
              <label key={chain} className="flex items-center gap-sm text-sm font-mono">
                <input type="checkbox" checked={livePolicy.chains.includes(chain)}
                  onChange={() => togglePolicyValue('chains', chain)} />
                {chain.toUpperCase()}
              </label>
            ))}
          </div>
        </div>

        <label className="border-t pt-sm flex flex-col gap-xs" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-xs text-secondary font-medium">信号最大时效（秒）</span>
          <input type="number" min={1} max={300} className="input font-mono text-sm" style={{ maxWidth: '180px' }}
            value={livePolicy.max_signal_age_seconds}
            onChange={event => setLivePolicy({ ...livePolicy, max_signal_age_seconds: Number(event.target.value) })} />
        </label>

        <div className="border-t pt-sm flex flex-col gap-sm" style={{ borderColor: 'var(--color-border)' }}>
          <span className="text-xs text-secondary font-medium">允许 CA</span>
          <div className="flex flex-col gap-xs" style={{ maxHeight: '240px', overflowY: 'auto' }}>
            {policyWhitelists.map(whitelist => (
              <label key={whitelist.id} className="flex items-center gap-sm text-sm" style={{ minWidth: 0 }}>
                <input type="checkbox" checked={livePolicy.whitelist_ids.includes(Number(whitelist.id))}
                  onChange={() => togglePolicyValue('whitelist_ids', Number(whitelist.id))} />
                <strong className="font-mono" style={{ minWidth: '72px' }}>{whitelist.symbol || `#${whitelist.id}`}</strong>
                <span className="text-xs text-secondary font-mono">{whitelist.chain_id.toUpperCase()}</span>
                <span className="text-xs text-secondary font-mono" style={{ overflowWrap: 'anywhere' }}>{whitelist.contract_address}</span>
              </label>
            ))}
            {policyWhitelists.length === 0 && <span className="text-sm text-secondary">暂无白名单 CA</span>}
          </div>
        </div>
      </div>

      {x6551Status && (
        <div className="card flex flex-col gap-md">
          <div className="flex justify-between items-center border-b pb-sm" style={{ borderColor: 'var(--color-border)', gap: '12px', flexWrap: 'wrap' }}>
            <h3 className="text-lg font-bold flex items-center gap-sm">
              <Radio size={18} /> 6551 Max
            </h3>
            <div className="flex gap-sm">
              <button type="button" className="btn flex items-center gap-xs" onClick={refresh6551Status}>
                <RefreshCw size={15} /> 刷新
              </button>
              <button type="button" className="btn flex items-center gap-xs" onClick={run6551WatchDryRun}
                disabled={envConfig.X_DATA_PROVIDER !== '6551' || watchPlanLoading}>
                <ListChecks size={15} /> {watchPlanLoading ? '查询中' : '预览监控变更'}
              </button>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '12px' }}>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">数据源</span>
              <strong className="font-mono text-sm">{x6551Status.provider}</strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">实时连接</span>
              <strong className={`font-mono text-sm ${x6551Status.wss.status === 'subscribed' ? 'text-success' : 'text-secondary'}`}>
                {statusLabel(x6551Status.wss.status)}
              </strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">采集进程心跳</span>
              <strong className={`font-mono text-sm ${x6551Status.wss.heartbeatFresh ? 'text-success' : 'text-danger'}`}>
                {x6551Status.wss.heartbeatFresh
                  ? `${Math.max(0, Math.round(Number(x6551Status.wss.heartbeatAgeMs || 0) / 1000))} 秒前`
                  : '已失效'}
              </strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">交易引擎</span>
              <strong className="font-mono text-sm">{x6551Status.safety.engineArmed ? '真实交易运行中' : '已停止新买入'}</strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">已管理 / 远端监控</span>
              <strong className="font-mono text-sm">{x6551Status.watches.managed} / {x6551Status.watches.total}</strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">今日接收事件</span>
              <strong className="font-mono text-sm">{x6551Status.inbox.today}</strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">处理失败事件</span>
              <strong className={`font-mono text-sm ${Number(x6551Status.inbox.byStatus.dead_letter || 0) > 0 ? 'text-danger' : ''}`}>
                {x6551Status.inbox.byStatus.dead_letter || 0}
              </strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">未知事件</span>
              <strong className={`font-mono text-sm ${x6551Status.inbox.unknown > 0 ? 'text-danger' : ''}`}>
                {x6551Status.inbox.unknown}
              </strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">本月消息用量</span>
              <strong className="font-mono text-sm">{x6551Status.usage.messages.observedMonth} / {x6551Status.usage.messages.monthlyLimit}</strong>
            </div>
          </div>

          {x6551Status.wss.lastError && (
            <div className="text-sm text-danger border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
              {x6551Status.wss.lastError}
            </div>
          )}

          {watchPlan && (
            <div className="flex flex-col gap-sm border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
              <div className="flex justify-between text-sm" style={{ flexWrap: 'wrap', gap: '8px' }}>
                <span>期望监控 <strong>{watchPlan.desiredCount}</strong></span>
                <span>远端已有 <strong>{watchPlan.remoteCount}</strong></span>
                <span>计划变更 <strong>{watchPlan.actions.length}</strong></span>
                <span>需要接管 <strong>{watchPlan.adoptionRequired.length}</strong></span>
                <span>阻断项 <strong>{watchPlan.blockers.length}</strong></span>
                <span>预计消耗 <strong>{watchPlan.estimatedPoints} 点</strong></span>
              </div>
              <div style={{ maxHeight: '240px', overflow: 'auto' }}>
                {watchPlan.entries.filter(entry => entry.action !== 'none').map(entry => (
                  <div key={entry.username} className="flex justify-between items-center py-sm border-t text-sm"
                    style={{ borderColor: 'var(--color-border)', gap: '12px' }}>
                    <span className="font-mono">@{entry.username}</span>
                    <span className={entry.blocker ? 'text-danger' : 'text-secondary'}>{watchActionLabel(entry.action)}</span>
                    <span className="font-mono">{entry.estimatedPoints} 点</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-lg">
        {/* Risk Config */}
        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Settings size={18} /> 风险控制</h3>
          <div className="flex flex-col gap-sm">
            <label className="flex items-center justify-between" style={{ padding: '4px 0' }}>
              <span className="text-sm font-medium">启用安全检查</span>
              <input type="checkbox" checked disabled style={{ width: '16px', height: '16px', accentColor: 'var(--color-accent)' }} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">买入税告警阈值 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_buy_tax}
                onChange={e => setRiskConfig({ ...riskConfig, max_buy_tax: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">卖出税告警阈值 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_sell_tax}
                onChange={e => setRiskConfig({ ...riskConfig, max_sell_tax: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最大跑路风险比例</span>
              <input type="number" min="0" max="1" step="0.01" className="input font-mono" value={riskConfig.max_rug_ratio ?? 0.3}
                onChange={e => setRiskConfig({ ...riskConfig, max_rug_ratio: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最小流动性 (USD)</span>
              <input type="number" className="input font-mono" value={riskConfig.min_liquidity_usd}
                onChange={e => setRiskConfig({ ...riskConfig, min_liquidity_usd: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最大滑点 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_slippage_pct}
                onChange={e => setRiskConfig({ ...riskConfig, max_slippage_pct: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">连续亏损熔断数</span>
              <input type="number" className="input font-mono" value={riskConfig.consecutive_loss_limit}
                onChange={e => setRiskConfig({ ...riskConfig, consecutive_loss_limit: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">CA 冷却时间 (分钟)</span>
              <input type="number" className="input font-mono" value={riskConfig.ca_cooldown_min}
                onChange={e => setRiskConfig({ ...riskConfig, ca_cooldown_min: Number(e.target.value) })} />
            </label>
          </div>
          <button className="btn btn-primary mt-2" onClick={saveRisk}>保存风控设置</button>
        </div>

        {/* X Monitor Config */}
        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Server size={18} /> X 监控配置</h3>
          <div className="flex flex-col gap-sm">
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">推文轮询间隔 (秒)</span>
              <input type="number" className="input font-mono" value={xConfig.timeline_poll_interval_sec}
                onChange={e => setXConfig({ ...xConfig, timeline_poll_interval_sec: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">关注轮询间隔 (秒)</span>
              <input type="number" className="input font-mono" value={xConfig.follows_poll_interval_sec}
                onChange={e => setXConfig({ ...xConfig, follows_poll_interval_sec: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">每轮最大 KOL 数</span>
              <input type="number" className="input font-mono" value={xConfig.max_kol_per_round}
                onChange={e => setXConfig({ ...xConfig, max_kol_per_round: Number(e.target.value) })} />
            </label>
          </div>
          <button className="btn btn-primary mt-2" onClick={saveXConfig}>保存监控设置</button>
        </div>

        {/* API Credentials and Environment config */}
        <div className="card flex flex-col gap-md" style={{ gridColumn: '1 / -1' }}>
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Key size={18} /> API 密钥与环境变量管理 (.env)</h3>
          
          <div className="grid grid-cols-2 gap-lg">
            {/* Left Block: External Integrations */}
            <div className="flex flex-col gap-sm">
              <h4 className="text-sm font-semibold text-secondary mb-xs">接口授权与数据源</h4>
              
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  GMGN API 密钥
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('GMGN_API_KEY')}>
                    {showSecrets['GMGN_API_KEY'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['GMGN_API_KEY'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['GMGN_API_KEY'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.GMGN_API_KEY || ''}
                  onChange={e => setEnvConfig({ ...envConfig, GMGN_API_KEY: e.target.value })} placeholder="输入 GMGN OpenAPI 授权密匙" />
              </label>

              <div className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  GMGN API 签名私钥 (Ed25519 PEM)
                  <span className="flex items-center gap-xs"><LockKeyhole size={12} /> {envConfig.GMGN_PRIVATE_KEY_CONFIGURED ? '已配置' : '未配置'}</span>
                </span>
                <textarea className="input font-mono text-sm" value={privateKeyDraft}
                  onChange={e => setPrivateKeyDraft(e.target.value)} placeholder="粘贴新的 PEM 私钥" rows={3} />
                <button type="button" className="btn btn-secondary" onClick={replacePrivateKey} disabled={!privateKeyDraft.trim()}>替换私钥并停止新买入</button>
              </div>

              <label className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">GMGN API 密钥仅由 XBOT 使用</span>
                <input type="checkbox" checked={envConfig.GMGN_KEY_EXCLUSIVE === 'true'}
                  onChange={e => setEnvConfig({ ...envConfig, GMGN_KEY_EXCLUSIVE: String(e.target.checked) })} />
              </label>

              <div className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">外部资金告警已验证（后续增强）</span>
                <div className="flex items-center gap-sm">
                  <button type="button" className="btn btn-secondary" onClick={async () => {
                    const response = await api.system.testTradeAlert();
                    toast(response.ok ? '测试告警已进入发送队列' : response.error || '测试告警失败', response.ok ? 'success' : 'error');
                  }}>发送测试</button>
                  <input type="checkbox" checked={envConfig.TRADE_ALERTS_VERIFIED === 'true'}
                    onChange={e => setEnvConfig({ ...envConfig, TRADE_ALERTS_VERIFIED: String(e.target.checked) })} />
                </div>
              </div>

              <label className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">紧急停止</span>
                <input type="checkbox" checked={envConfig.EMERGENCY_STOP === 'true'}
                  onChange={e => setEnvConfig({ ...envConfig, EMERGENCY_STOP: String(e.target.checked) })} />
              </label>

              <div className="grid grid-cols-2 gap-sm">
                <label className="flex flex-col gap-xs"><span className="text-xs text-secondary">全局每日 USD 上限</span><input type="number" className="input font-mono text-sm" value={envConfig.GMGN_GLOBAL_DAILY_USD_LIMIT || '0'} onChange={e => setEnvConfig({ ...envConfig, GMGN_GLOBAL_DAILY_USD_LIMIT: e.target.value })} /></label>
                <label className="flex flex-col gap-xs"><span className="text-xs text-secondary">全局每周 USD 上限</span><input type="number" className="input font-mono text-sm" value={envConfig.GMGN_GLOBAL_WEEKLY_USD_LIMIT || '0'} onChange={e => setEnvConfig({ ...envConfig, GMGN_GLOBAL_WEEKLY_USD_LIMIT: e.target.value })} /></label>
              </div>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">X 数据提供源 (X_DATA_PROVIDER)</span>
                <select className="input text-sm" value={envConfig.X_DATA_PROVIDER || 'mock'}
                  onChange={e => setEnvConfig({
                    ...envConfig,
                    X_DATA_PROVIDER: e.target.value,
                    TWITTER_STREAM_ENABLED: e.target.value === 'twitterapi' ? envConfig.TWITTER_STREAM_ENABLED : 'false'
                  })}>
                  <option value="mock">模拟数据源</option>
                  <option value="socialdata">SocialData（第三方 X 数据源）</option>
                  <option value="twitterapi">TwitterAPI.io（推文流与关注列表）</option>
                  <option value="6551">6551 Max（实时监控与推送）</option>
                </select>
              </label>

              {envConfig.X_DATA_PROVIDER === 'socialdata' && (
                <label className="flex flex-col gap-xs">
                  <span className="text-xs text-secondary font-medium flex items-center justify-between">
                    SocialData API 密钥
                    <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('SOCIALDATA_API_KEY')}>
                      {showSecrets['SOCIALDATA_API_KEY'] ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showSecrets['SOCIALDATA_API_KEY'] ? '隐藏' : '显示'}
                    </button>
                  </span>
                  <input type={showSecrets['SOCIALDATA_API_KEY'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.SOCIALDATA_API_KEY || ''}
                    onChange={e => setEnvConfig({ ...envConfig, SOCIALDATA_API_KEY: e.target.value })} placeholder="输入 SocialData API Key" />
                </label>
              )}

              {envConfig.X_DATA_PROVIDER === 'twitterapi' && (
                <label className="flex flex-col gap-xs">
                  <span className="text-xs text-secondary font-medium flex items-center justify-between">
                    TwitterAPI.io API 密钥
                    <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('TWITTERAPI_IO_API_KEY')}>
                      {showSecrets['TWITTERAPI_IO_API_KEY'] ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showSecrets['TWITTERAPI_IO_API_KEY'] ? '隐藏' : '显示'}
                    </button>
                  </span>
                  <input type={showSecrets['TWITTERAPI_IO_API_KEY'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.TWITTERAPI_IO_API_KEY || ''}
                    onChange={e => setEnvConfig({ ...envConfig, TWITTERAPI_IO_API_KEY: e.target.value })} placeholder="输入 TwitterAPI.io API Key" />
                </label>
              )}

              {envConfig.X_DATA_PROVIDER === '6551' && (
                <>
                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium flex items-center justify-between">
                      OPENNEWS 访问口令
                      <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('OPENNEWS_TOKEN')}>
                        {showSecrets['OPENNEWS_TOKEN'] ? <EyeOff size={12} /> : <Eye size={12} />}
                        {showSecrets['OPENNEWS_TOKEN'] ? '隐藏' : '显示'}
                      </button>
                    </span>
                    <input type={showSecrets['OPENNEWS_TOKEN'] ? 'text' : 'password'} className="input font-mono text-sm"
                      value={envConfig.OPENNEWS_TOKEN || ''}
                      onChange={e => setEnvConfig({ ...envConfig, OPENNEWS_TOKEN: e.target.value })} />
                  </label>

                  <label className="flex items-center justify-between gap-sm">
                    <span className="text-xs text-secondary font-medium">启用 6551 WSS</span>
                    <input type="checkbox" checked={envConfig.X_6551_WSS_ENABLED === 'true'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_WSS_ENABLED: String(e.target.checked) })} />
                  </label>

                  <label className="flex items-center justify-between gap-sm">
                    <span className="text-xs text-secondary font-medium">允许应用监控变更</span>
                    <input type="checkbox" checked={envConfig.X_6551_WATCH_APPLY_ENABLED === 'true'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_WATCH_APPLY_ENABLED: String(e.target.checked) })} />
                  </label>

                  <label className="flex items-center justify-between gap-sm">
                    <span className="text-xs text-secondary font-medium">监控取消关注</span>
                    <input type="checkbox" checked={envConfig.X_6551_WATCH_UNFOLLOW_ENABLED === 'true'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_WATCH_UNFOLLOW_ENABLED: String(e.target.checked) })} />
                  </label>

                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">连接心跳间隔（毫秒）</span>
                    <input type="number" min={5000} step={1000} className="input font-mono text-sm"
                      value={envConfig.X_6551_HEARTBEAT_MS || '20000'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_HEARTBEAT_MS: e.target.value })} />
                  </label>

                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">最大重连等待（毫秒）</span>
                    <input type="number" min={1000} step={1000} className="input font-mono text-sm"
                      value={envConfig.X_6551_RECONNECT_MAX_MS || '30000'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_RECONNECT_MAX_MS: e.target.value })} />
                  </label>

                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">每月消息上限</span>
                    <input type="number" min={1} className="input font-mono text-sm"
                      value={envConfig.X_6551_MONTHLY_MESSAGE_LIMIT || '2000000'}
                      onChange={e => setEnvConfig({ ...envConfig, X_6551_MONTHLY_MESSAGE_LIMIT: e.target.value })} />
                  </label>
                </>
              )}

              {envConfig.X_DATA_PROVIDER === 'twitterapi' && (
                <>
                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">关注关系检查间隔（毫秒）</span>
                    <input type="number" min={30000} step={1000} className="input font-mono text-sm"
                      value={envConfig.TWITTERAPI_IO_FOLLOW_INTERVAL_MS || '60000'}
                      onChange={e => setEnvConfig({ ...envConfig, TWITTERAPI_IO_FOLLOW_INTERVAL_MS: e.target.value })} />
                  </label>

                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">TwitterAPI.io 每日点数上限</span>
                    <input type="number" min={1} className="input font-mono text-sm"
                      value={envConfig.TWITTERAPI_IO_DAILY_CREDIT_LIMIT || '50000'}
                      onChange={e => setEnvConfig({ ...envConfig, TWITTERAPI_IO_DAILY_CREDIT_LIMIT: e.target.value })} />
                  </label>

                  <label className="flex items-center justify-between gap-sm">
                    <span className="text-xs text-secondary font-medium">启用实时推文流</span>
                    <input type="checkbox" checked={envConfig.TWITTER_STREAM_ENABLED === 'true'}
                      onChange={e => setEnvConfig({ ...envConfig, TWITTER_STREAM_ENABLED: String(e.target.checked) })} />
                  </label>

                  {envConfig.TWITTER_STREAM_ENABLED === 'true' && (
                    <label className="flex flex-col gap-xs">
                      <span className="text-xs text-secondary font-medium flex items-center justify-between">
                        回调验证密钥
                        <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('TWITTERAPI_IO_WEBHOOK_SECRET')}>
                          {showSecrets['TWITTERAPI_IO_WEBHOOK_SECRET'] ? <EyeOff size={12} /> : <Eye size={12} />}
                          {showSecrets['TWITTERAPI_IO_WEBHOOK_SECRET'] ? '隐藏' : '显示'}
                        </button>
                      </span>
                      <input type={showSecrets['TWITTERAPI_IO_WEBHOOK_SECRET'] ? 'text' : 'password'} className="input font-mono text-sm"
                        value={envConfig.TWITTERAPI_IO_WEBHOOK_SECRET || ''}
                        onChange={e => setEnvConfig({ ...envConfig, TWITTERAPI_IO_WEBHOOK_SECRET: e.target.value })} />
                    </label>
                  )}
                </>
              )}

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  看板登录鉴权口令 (ADMIN_TOKEN)
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('ADMIN_TOKEN')}>
                    {showSecrets['ADMIN_TOKEN'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['ADMIN_TOKEN'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['ADMIN_TOKEN'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.ADMIN_TOKEN || ''}
                  onChange={e => setEnvConfig({ ...envConfig, ADMIN_TOKEN: e.target.value })} placeholder="输入管理员看板口令" />
              </label>
              <button type="button" className="btn" onClick={() => {
                if (envConfig.ADMIN_TOKEN && envConfig.ADMIN_TOKEN !== '********') {
                  setAdminToken(envConfig.ADMIN_TOKEN);
                  window.location.reload();
                }
              }}>
                使用此口令登录
              </button>
            </div>

            {/* Right Block: System Core (Port / Database) */}
            <div className="flex flex-col gap-sm">
              <h4 className="text-sm font-semibold text-secondary mb-xs">🗄️ 系统核心与数据库</h4>

              {([
                ['SOLANA_RPC_URL', 'Solana 链上验真 RPC（只读，不用于下单）'],
                ['BSC_RPC_URL', 'BSC 链上验真 RPC（只读，不用于下单）'],
                ['BASE_RPC_URL', 'Base 链上验真 RPC（只读，不用于下单）'],
                ['ETH_RPC_URL', 'Ethereum 链上验真 RPC（只读，不用于下单）'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-xs">
                  <span className="text-xs text-secondary font-medium">{label}</span>
                  <input className="input font-mono text-sm" value={envConfig[key] || ''}
                    onChange={e => setEnvConfig({ ...envConfig, [key]: e.target.value })} placeholder="https://" />
                </label>
              ))}
              
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">后台服务端口 (BACKEND_PORT)</span>
                <input type="number" className="input font-mono text-sm" value={envConfig.BACKEND_PORT || '3011'}
                  onChange={e => setEnvConfig({ ...envConfig, BACKEND_PORT: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">后台监听地址 (BACKEND_HOST)</span>
                <input className="input font-mono text-sm" value={envConfig.BACKEND_HOST || '127.0.0.1'}
                  onChange={e => setEnvConfig({ ...envConfig, BACKEND_HOST: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库主机 (DB_HOST)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_HOST || 'localhost'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_HOST: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库端口 (DB_PORT)</span>
                <input type="number" className="input font-mono text-sm" value={envConfig.DB_PORT || '5432'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_PORT: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库库名 (DB_NAME)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_NAME || 'xbot'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_NAME: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库用户名 (DB_USER)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_USER || 'pm_user'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_USER: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  数据库密码 (DB_PASSWORD)
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('DB_PASSWORD')}>
                    {showSecrets['DB_PASSWORD'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['DB_PASSWORD'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['DB_PASSWORD'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.DB_PASSWORD || ''}
                  onChange={e => setEnvConfig({ ...envConfig, DB_PASSWORD: e.target.value })} placeholder="PostgreSQL 用户密码" />
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-sm border-t pt-md mt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <button className="btn btn-primary" style={{ padding: '10px 20px', fontWeight: 600 }} onClick={saveEnv}>
              保存配置并热重启后台
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
