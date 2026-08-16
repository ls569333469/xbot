import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api, getAuthToken, setAdminToken } from '../lib/api';
import { Shield, Server, Key, Eye, EyeOff, RefreshCw, ListChecks, Radio, Gauge, LockKeyhole, Search, X, Save, RotateCcw } from 'lucide-react';
import type { ArmPreparation, ChainConfig, ChainId, FollowDiscoveryPrompts, RuntimePolicyDetailPage, RuntimeScope, TradeRuntimePolicy, X6551Status, X6551WatchPlan } from '../lib/types';
import { useToast } from '../components/ui/ToastContext';
import { FormSkeleton } from '../components/ui/Skeleton';
import { advisoryActionLabel, advisoryLabel, blockerActionLabel, blockerLabel, statusLabel, watchActionLabel } from '../lib/display-labels';

interface LiveEngineRuntime {
  armed: boolean;
  status: 'stopped' | 'recovering' | 'running' | 'paused_transient' | 'fault_protected';
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
  ['4', 'P4 低优先级读取'],
] as const;

const RETRY_CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
type SettingsSection = 'trading' | 'status' | 'system';

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
    OPENNEWS_TOKEN: '',
    P21_FOLLOW_DISCOVERY_ENABLED: 'false',
    LIVE_TRADING_ENABLED: 'false',
    ADMIN_TOKEN: ''
  });

  const [loading, setLoading] = useState(true);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState('');
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const [x6551Status, setX6551Status] = useState<X6551Status | null>(null);
  const [x6551Loading, setX6551Loading] = useState(false);
  const [x6551Error, setX6551Error] = useState('');
  const [watchPlan, setWatchPlan] = useState<X6551WatchPlan | null>(null);
  const [watchPlanLoading, setWatchPlanLoading] = useState(false);
  const [runtimePolicy, setRuntimePolicy] = useState<TradeRuntimePolicy | null>(null);
  const [privateKeyDraft, setPrivateKeyDraft] = useState('');
  const [armPreparation, setArmPreparation] = useState<ArmPreparation | null>(null);
  const [runtimeScopes, setRuntimeScopes] = useState<RuntimeScope[]>([]);
  const [selectedScope, setSelectedScope] = useState<{ scope_type: RuntimeScope['scope_type']; scope_id: number | null }>({ scope_type: 'combined', scope_id: null });
  const [armChecking, setArmChecking] = useState(false);
  const [showArmDialog, setShowArmDialog] = useState(false);
  const [showScopeDrawer, setShowScopeDrawer] = useState(false);
  const [scopeDetail, setScopeDetail] = useState<RuntimePolicyDetailPage | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [scopePage, setScopePage] = useState(1);
  const [scopeChain, setScopeChain] = useState('');
  const [scopeSearch, setScopeSearch] = useState('');
  const [schedulerNow, setSchedulerNow] = useState(Date.now());
  const [chainConfigs, setChainConfigs] = useState<Partial<Record<ChainId, ChainConfig>>>({});
  const [followPrompts, setFollowPrompts] = useState<FollowDiscoveryPrompts | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('trading');
  const [savingManagedRetry, setSavingManagedRetry] = useState(false);
  const [loginToken, setLoginToken] = useState('');
  const { toast } = useToast();
  const activeRuntimeScope = runtimePolicy?.readiness.scope;
  const runtimeScopeChainCount = activeRuntimeScope?.counts?.chains
    ?? activeRuntimeScope?.chains.length
    ?? runtimePolicy?.readiness.policy?.chains.length
    ?? 0;
  const runtimeScopeFixedCount = activeRuntimeScope?.counts?.whitelists
    ?? activeRuntimeScope?.whitelist_ids?.length
    ?? runtimePolicy?.readiness.policy?.whitelistIds.length
    ?? 0;
  const runtimeScopeDynamicCount = activeRuntimeScope?.counts?.dynamic_policies
    ?? activeRuntimeScope?.dynamic_policy_ids?.length
    ?? 0;
  const runtimeScopeFollowCount = activeRuntimeScope?.counts?.follow_policies
    ?? activeRuntimeScope?.follow_policy_ids?.length
    ?? 0;

  const applyEngineStatus = (data: any) => {
    const armed = Boolean(data?.armed);
    setIsArmed(armed);
    if (armed) {
      setArmChecking(false);
      setShowArmDialog(false);
    }
    setEngineMode(data?.mode || 'signal');
    setEngineRuntime(previous => ({
      ...previous,
      ...data,
      armed,
      status: data?.status || (data?.armed ? 'running' : 'stopped'),
      desiredRunning: Boolean(data?.desiredRunning)
    }));
  };

  useEffect(() => {
    if (!getAuthToken()) {
      setLoading(false);
      return;
    }

    setPromptLoading(true);
    Promise.all([
      api.system.runtimeSummary(),
      api.system.getEnv(),
      api.trade.runtimePolicy(),
      api.config.getChains(),
      api.system.runtimeScopes(),
      api.followDiscovery.prompts(),
    ]).then(([summaryRes, envRes, runtimeRes, chainConfigRes, scopesRes, promptsRes]) => {
      if (summaryRes.ok && summaryRes.data) {
        applyEngineStatus(summaryRes.data.engine);
      }
      if (envRes.ok && envRes.data) setEnvConfig((previous: any) => ({ ...previous, ...envRes.data }));
      if (runtimeRes.ok && runtimeRes.data) setRuntimePolicy(runtimeRes.data);
      if (chainConfigRes.ok && chainConfigRes.data) {
        setChainConfigs(chainConfigRes.data);
      }
      if (scopesRes.ok && scopesRes.data) setRuntimeScopes(scopesRes.data);
      if (promptsRes.ok && promptsRes.data) setFollowPrompts(promptsRes.data);
      setPromptLoading(false);
      setLoading(false);
    }).catch(() => {
      setPromptLoading(false);
      setLoading(false);
    });
  }, []);

  useEffect(() => {
    if (settingsSection !== 'status' || x6551Status || !getAuthToken()) return;
    let active = true;
    setX6551Loading(true);
    setX6551Error('');
    void api.xMonitor.status6551().then((response) => {
      if (!active) return;
      if (response.ok && response.data) setX6551Status(response.data);
      else setX6551Error(response.error || '6551 状态读取失败');
    }).finally(() => {
      if (active) setX6551Loading(false);
    });
    return () => {
      active = false;
      setX6551Loading(false);
    };
  }, [settingsSection, x6551Status]);

  useEffect(() => {
    if (!getAuthToken()) return;

    let active = true;
    let inFlight = false;
    const refreshRuntime = async () => {
      setSchedulerNow(Date.now());
      if (inFlight) return;
      inFlight = true;
      try {
        const engineResponse = await api.system.runtimeSummary();
        if (!active) return;
        if (engineResponse.ok && engineResponse.data) applyEngineStatus(engineResponse.data.engine);
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(() => void refreshRuntime(), 3000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const handleToggle = async () => {
    if (!isArmed) {
      setArmChecking(true);
      try {
                    const preparation = await api.system.prepareArm(selectedScope);
        if (!preparation.ok || !preparation.data) {
          toast(preparation.error || '实盘准备状态检查失败', 'error');
          return;
        }
        setArmPreparation(preparation.data);
        setShowArmDialog(true);
      } finally {
        setArmChecking(false);
      }
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
    if (!armPreparation?.summary.readyToArm || !armPreparation.arm_token) return;
    const res = await api.system.confirmArm(armPreparation);
    if (res.ok && res.data) {
      applyEngineStatus(res.data);
      setShowArmDialog(false);
      toast('真实交易已启动', 'success');
    } else {
      if (['ARM_PREPARATION_STALE', 'ARM_SCOPE_CHANGED', 'ARM_SNAPSHOT_STALE'].includes(res.code || '')) {
        toast('自动交易范围已变化，请重新检查', 'warning');
      } else {
        toast(res.error || '启动真实交易失败', 'error');
      }
    }
  };

  const loadRuntimeScope = async (nextPage = 1, nextChain = scopeChain, nextSearch = scopeSearch) => {
    setScopeLoading(true);
    const params: Record<string, string> = {
      page: String(nextPage),
      page_size: '20',
      scope_type: selectedScope.scope_type
    };
    if (selectedScope.scope_id !== null) params.scope_id = String(selectedScope.scope_id);
    if (nextChain) params.chain = nextChain;
    if (nextSearch.trim()) params.search = nextSearch.trim();
    const response = await api.trade.runtimePolicyDetail(params);
    setScopeLoading(false);
    if (!response.ok || !response.data) {
      toast(response.error || '交易范围读取失败', 'error');
      return;
    }
    setScopeDetail(response.data);
    setScopePage(response.data.page);
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
    setX6551Loading(true);
    setX6551Error('');
    const res = await api.xMonitor.status6551(true);
    setX6551Loading(false);
    if (res.ok && res.data) setX6551Status(res.data);
    else {
      setX6551Error(res.error || '6551 状态刷新失败');
      toast(`6551 状态刷新失败: ${res.error || 'Unknown error'}`, 'error');
    }
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

  const refreshRuntimePolicy = async () => {
    const response = await api.trade.runtimePolicy();
    if (response.ok && response.data) setRuntimePolicy(response.data);
    return response;
  };

  const toggleManagedRetry = async () => {
    const currentlyEnabled = RETRY_CHAINS.every(chain => chainConfigs[chain]?.retryEnabled);
    const nextEnabled = !currentlyEnabled;
    const confirmed = window.confirm(nextEnabled
      ? '确认开启失败后自动重试？系统只会在确认未成交后重试，并会停止新的真实买入以应用配置。'
      : '确认关闭失败后自动重试？系统会停止新的真实买入以应用配置。');
    if (!confirmed) return;

    setSavingManagedRetry(true);
    const response = await api.config.setManagedRetry(nextEnabled);
    setSavingManagedRetry(false);
    if (!response.ok || !response.data) {
      toast(response.error || '失败重试设置更新失败', 'error');
      return;
    }
    setChainConfigs(response.data);
    setIsArmed(false);
    setEngineRuntime(previous => ({
      ...previous,
      armed: false,
      status: 'fault_protected',
      desiredRunning: false,
      lastError: 'CHAIN_CONFIGURATION_CHANGED'
    }));
    await refreshRuntimePolicy();
    toast(nextEnabled ? '失败后自动重试已开启' : '失败后自动重试已关闭', 'success');
  };

  const saveFollowPrompts = async () => {
    if (!followPrompts || promptSaving) return;
    setPromptSaving(true);
    const response = await api.followDiscovery.updatePrompts({
      version: followPrompts.version,
      fast_prompt: followPrompts.fast_prompt,
      relationship_prompt: followPrompts.relationship_prompt,
      kol_research_prompt: followPrompts.kol_research_prompt
    });
    setPromptSaving(false);
    if (!response.ok || !response.data) {
      if (response.code === 'FOLLOW_PROMPT_VERSION_CONFLICT') {
        const latest = await api.followDiscovery.prompts();
        if (latest.ok && latest.data) setFollowPrompts(latest.data);
        toast('提示词已被其他操作更新，已载入最新版本', 'warning');
      } else {
        toast(response.error || 'Grok 提示词保存失败', 'error');
      }
      return;
    }
    setFollowPrompts(response.data);
    toast('Grok 提示词已保存，后续新关注研究和 KOL 投研将使用新版本', 'success');
  };

  const resetFollowPrompts = async () => {
    if (!followPrompts || promptSaving) return;
    if (!window.confirm('确认恢复 Grok 提示词默认版本？当前自定义内容将被替换。')) return;
    setPromptSaving(true);
    const response = await api.followDiscovery.resetPrompts(followPrompts.version);
    setPromptSaving(false);
    if (!response.ok || !response.data) {
      toast(response.error || 'Grok 提示词恢复失败', 'error');
      return;
    }
    setFollowPrompts(response.data);
    toast('Grok 提示词已恢复默认版本', 'success');
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
            api.system.getEnv(),
            api.xMonitor.status6551(),
          ]).then(([eR, evR, sR]) => {
            if (eR.ok && eR.data) {
              applyEngineStatus(eR.data);
            }
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
      <div className="settings-page flex flex-col gap-lg">
        <div className="card flex justify-between items-center" style={{ minHeight: '110px' }}>
          <div className="flex-1">
            <div className="skeleton mb-xs" style={{ width: '40%', height: '20px' }}></div>
            <div className="skeleton" style={{ width: '70%', height: '14px' }}></div>
          </div>
          <div className="skeleton settings-loading-skeleton" style={{ width: '150px', height: '52px' }}></div>
        </div>
        <div className="grid grid-cols-2 gap-lg">
          <FormSkeleton />
          <FormSkeleton />
        </div>
      </div>
    );
  }

  if (!getAuthToken()) {
    const login = () => {
      const token = loginToken.trim();
      if (!token) return;
      setAdminToken(token);
      window.location.reload();
    };
    return (
      <div className="settings-page flex flex-col gap-lg">
        <div className="card flex flex-col gap-md" style={{ width: 'min(420px, 100%)' }}>
          <h2 className="text-lg font-bold flex items-center gap-sm"><LockKeyhole size={18} /> 看板登录</h2>
          <label className="flex flex-col gap-xs">
            <span className="text-xs text-secondary font-medium">管理口令</span>
            <input type="password" className="input font-mono text-sm" value={loginToken}
              onChange={event => setLoginToken(event.target.value)}
              onKeyDown={event => { if (event.key === 'Enter') login(); }}
              autoComplete="current-password" autoFocus />
          </label>
          <button type="button" className="btn btn-primary" onClick={login} disabled={!loginToken.trim()}>
            <Key size={15} /> 登录
          </button>
        </div>
      </div>
    );
  }

  const retryEnabledCount = RETRY_CHAINS.filter(chain => chainConfigs[chain]?.retryEnabled).length;
  const managedRetryEnabled = retryEnabledCount === RETRY_CHAINS.length;
  const managedRetryPartial = retryEnabledCount > 0 && !managedRetryEnabled;
  return (
    <div className="settings-page flex flex-col gap-lg">
      
      {/* Restart Overlay overlay */}
      {isRestarting && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(10, 10, 15, 0.85)', backdropFilter: 'blur(20px)',
          zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', color: '#ffffff'
        }}>
          <div className="engine-start-copy flex flex-col items-center gap-md">
            <div className="engine-start-visual">
              <div className="loading-ring"></div>
              <Server className="loading-ring-icon text-secondary" size={16} />
            </div>
            <h3 className="text-lg font-bold">后台进程重载中</h3>
            <p className="text-secondary text-sm">{restartMessage}</p>
          </div>
        </div>
      )}

      {showArmDialog && armPreparation && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9000, background: 'rgba(10, 10, 15, 0.78)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px'
        }}>
          <div className="card" role="dialog" aria-modal="true" aria-label="启动真实交易"
            style={{ width: 'min(620px, 100%)', maxHeight: '82vh', padding: 0, overflow: 'hidden', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr) auto' }}>
            <div className="arm-dialog-header">
              <div>
                <h3 className="text-lg font-bold">启动真实交易</h3>
                <span className={`text-xs font-mono ${armPreparation.summary.readyToArm ? 'text-success' : 'text-danger'}`}>
                  {armPreparation.summary.readyToArm ? '检查通过' : '检查未通过'}
                </span>
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setShowArmDialog(false)} title="关闭">
                <X size={16} />
              </button>
            </div>

            <div className="flex flex-col gap-md" style={{ overflowY: 'auto', padding: '16px 18px' }}>
              {armPreparation.summary.scope && <div className="section-heading section-divider-bottom text-sm">
                <span className="text-secondary">本次作用域：</span>
                <strong>{armPreparation.summary.scope.label}</strong>
                {armPreparation.summary.scope.revision !== null && armPreparation.summary.scope.revision !== undefined
                  && <span className="text-secondary"> · Revision {armPreparation.summary.scope.revision}</span>}
              </div>}

              <div className="settings-summary-grid">
                <div><span className="text-xs text-secondary">交易链</span><strong className="metric-value font-mono text-sm">{armPreparation.summary.counts.chains}</strong></div>
                <div><span className="text-xs text-secondary">可实盘 CA</span><strong className="metric-value font-mono text-sm">{armPreparation.summary.counts.whitelists}</strong></div>
                <div><span className="text-xs text-secondary">唯一 Watch</span><strong className="metric-value font-mono text-sm">{armPreparation.summary.counts.watches}</strong></div>
                <div><span className="text-xs text-secondary">触发关系</span><strong className="metric-value font-mono text-sm">{armPreparation.summary.counts.relations}</strong></div>
              </div>

              {armPreparation.summary.blockers.length > 0 && (
                <div className="flex flex-col gap-xs">
                  <strong className="text-sm text-danger">还需处理 {armPreparation.summary.blockers.length} 项</strong>
                  {armPreparation.summary.blockers.map(blocker => (
                    <div key={blocker} className="subsection-row">
                      <div className="text-sm font-medium">{blockerLabel(blocker)}</div>
                      <div className="text-xs text-secondary">{blockerActionLabel(blocker)}</div>
                    </div>
                  ))}
                </div>
              )}

              <div className="settings-chain-strip">
                {armPreparation.summary.chains.map(chain => (
                  <div key={chain.chain}>
                    <strong className="font-mono text-sm">{chain.chain.toUpperCase()}</strong>
                    <span className={`text-xs ${chain.ready ? 'text-success' : 'text-danger'}`}>
                      {chain.ready ? '可实盘' : chain.blockers.map(blockerLabel).join('、') || '未通过'}
                    </span>
                  </div>
                ))}
              </div>

              {armPreparation.summary.advisories.length > 0 && (
                <div className="flex flex-col gap-xs text-xs text-secondary">
                  <strong>观察项</strong>
                  {armPreparation.summary.advisories.map(advisory => (
                    <div key={advisory}><span>{advisoryLabel(advisory)}</span> · {advisoryActionLabel(advisory)}</div>
                  ))}
                </div>
              )}
            </div>

            <div className="arm-dialog-actions">
              <div className="flex gap-sm" style={{ flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-secondary" onClick={() => {
                  setShowScopeDrawer(true);
                  void loadRuntimeScope(1);
                }}>
                  <ListChecks size={15} /> 查看详细范围
                </button>
                <button type="button" className="btn btn-secondary" disabled={armChecking} onClick={async () => {
                  setArmChecking(true);
                  try {
                     const response = await api.system.prepareArm(selectedScope, { probe: false });
                    if (response.ok && response.data) setArmPreparation(response.data);
                    else toast(response.error || '重新检查失败', 'error');
                  } finally {
                    setArmChecking(false);
                  }
                }}>
                  <RefreshCw size={15} className={armChecking ? 'icon-spin' : ''} /> {armChecking ? '检查中' : '重新检查'}
                </button>
              </div>
              <div className="flex gap-sm">
                <button type="button" className="btn btn-secondary" onClick={() => setShowArmDialog(false)}>返回</button>
                <button type="button" className="btn btn-primary"
                  disabled={armChecking || !armPreparation.summary.readyToArm || !armPreparation.arm_token}
                  onClick={confirmArm}>
                  <Shield size={15} /> 确认启动
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {showScopeDrawer && (
        <>
          <button type="button" className="settings-scope-overlay" aria-label="关闭交易范围" onClick={() => setShowScopeDrawer(false)} />
          <aside className="settings-scope-drawer" role="dialog" aria-modal="true" aria-label="真实交易详细范围">
            <div className="settings-scope-drawer__head">
              <div>
                <strong>真实交易详细范围</strong>
                <span>{scopeDetail ? `${scopeDetail.total} 个可实盘 CA` : '正在读取'}</span>
              </div>
              <button type="button" className="p16-icon-button" title="关闭" aria-label="关闭" onClick={() => setShowScopeDrawer(false)}><X size={16} /></button>
            </div>
            <div className="settings-scope-drawer__filters">
              <select value={scopeChain} onChange={(event) => {
                const next = event.target.value;
                setScopeChain(next);
                void loadRuntimeScope(1, next, scopeSearch);
              }} aria-label="按链筛选">
                <option value="">全部链</option>
                {RETRY_CHAINS.map(chain => <option key={chain} value={chain}>{chain.toUpperCase()}</option>)}
              </select>
              <div className="settings-scope-search">
                <Search size={15} />
                <input value={scopeSearch} onChange={(event) => setScopeSearch(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void loadRuntimeScope(1); }}
                  placeholder="搜索 CA / 代币 / 项目" />
                <button type="button" className="p16-icon-button" title="搜索" aria-label="搜索" onClick={() => void loadRuntimeScope(1)}><Search size={14} /></button>
              </div>
            </div>
            <div className="settings-scope-drawer__body">
              {scopeLoading && <div className="text-sm text-secondary">读取中...</div>}
              {!scopeLoading && scopeDetail?.items.length === 0 && <div className="text-sm text-secondary">没有符合条件的 CA</div>}
              {!scopeLoading && scopeDetail?.items.map(item => (
                <div className="settings-scope-row" key={item.id}>
                  <div className="settings-scope-row__title">
                    <strong>{item.symbol || item.project_name || '未命名'}</strong>
                    <span>{item.chain_id.toUpperCase()}</span>
                  </div>
                  <code>{item.contract_address}</code>
                  <div className="settings-scope-row__meta">
                    <span>单笔 {item.budget_per_trade}</span>
                    <span>累计 {item.total_budget}</span>
                    <span>{item.unique_actor_count} 个账号</span>
                    <span>{item.source_count + item.relation_count} 条触发</span>
                  </div>
                  {item.actor_handles.length > 0 && <div className="settings-scope-row__actors">
                    {item.actor_handles.map(handle => <span key={handle}>@{handle.replace(/^@+/, '')}</span>)}
                    {item.unique_actor_count > item.actor_handles.length && <span>+{item.unique_actor_count - item.actor_handles.length}</span>}
                  </div>}
                </div>
              ))}
            </div>
            <div className="settings-scope-drawer__foot">
              <button type="button" className="btn btn-secondary" disabled={!scopeDetail || scopePage <= 1 || scopeLoading}
                onClick={() => void loadRuntimeScope(scopePage - 1)}>上一页</button>
              <span className="text-xs text-secondary">第 {scopeDetail?.page || 1} / {Math.max(1, Math.ceil((scopeDetail?.total || 0) / (scopeDetail?.page_size || 20)))} 页</span>
              <button type="button" className="btn btn-secondary" disabled={!scopeDetail || scopePage >= Math.ceil(scopeDetail.total / scopeDetail.page_size) || scopeLoading}
                onClick={() => void loadRuntimeScope(scopePage + 1)}>下一页</button>
            </div>
          </aside>
        </>
      )}

      <div className="settings-section-tabs" role="tablist" aria-label="设置分类">
        {([
          ['trading', '交易', Shield],
          ['status', '运行状态', Gauge],
          ['system', '系统维护', Server],
        ] as const).map(([section, label, Icon]) => (
          <button key={section} type="button" role="tab" aria-selected={settingsSection === section}
            className="settings-section-tab" onClick={() => setSettingsSection(section)}>
            <Icon size={16} /> {label}
          </button>
        ))}
      </div>

      {/* Live trading control */}
      {settingsSection === 'trading' && <div className="card flex justify-between items-center settings-live-control" style={{ background: isArmed ? 'rgba(0, 214, 143, 0.04)' : 'rgba(255, 71, 87, 0.04)', borderColor: isArmed ? 'rgba(0, 214, 143, 0.15)' : 'rgba(255, 71, 87, 0.15)', flexWrap: 'wrap', gap: '16px' }}>
        <div className="flex flex-col gap-xs settings-live-control__copy">
          <h2 className="text-xl font-bold flex items-center gap-sm">
            <Shield className={isArmed ? 'text-success' : 'text-danger'} />
            {isArmed
              ? '真实交易运行中'
              : engineRuntime.status === 'paused_transient'
                ? '数据源短暂恢复中'
                : engineRuntime.status === 'fault_protected' ? '故障保护' : '已停止'}
          </h2>
          <div className="flex gap-md text-sm" style={{ flexWrap: 'wrap' }}>
            <span><span className="text-secondary">新买入：</span><strong>{isArmed ? '自动执行' : '已停止'}</strong></span>
            <span><span className="text-secondary">已有订单与持仓：</span><strong>持续对账和保护</strong></span>
            {engineRuntime.operator && <span><span className="text-secondary">最近操作人：</span><strong>{engineRuntime.operator}</strong></span>}
          </div>
          <p className="text-secondary text-sm">
            {isArmed
              ? '新的合格 6551 信号会自动提交 GMGN 真实订单。'
              : engineRuntime.status === 'paused_transient'
                ? '系统已暂停新买入，连接连续稳定后会自动恢复；已有持仓保护继续运行。'
                : engineRuntime.status === 'fault_protected'
                ? `系统已停止新买入：${engineRuntime.lastError ? blockerLabel(engineRuntime.lastError) : '实时检查未通过'}`
                : '不接收新的真实买入；订单查询、持仓保护和退出继续运行。'}
          </p>
        </div>
        {!isArmed && runtimeScopes.length > 0 && (
          <label className="flex flex-col gap-xs" style={{ minWidth: '220px' }}>
            <span className="text-xs text-secondary">本次启动范围</span>
            <select className="input text-sm" value={`${selectedScope.scope_type}:${selectedScope.scope_id ?? ''}`}
              onChange={(event) => {
                const [scopeType, rawId] = event.target.value.split(':');
                setSelectedScope({
                  scope_type: scopeType as RuntimeScope['scope_type'],
                  scope_id: rawId ? Number(rawId) : null
                });
              }}>
              {runtimeScopes.map((scope) => (
                <option key={`${scope.scope_type}:${scope.scope_id ?? ''}`} value={`${scope.scope_type}:${scope.scope_id ?? ''}`}>
                  {scope.label}
                </option>
              ))}
            </select>
          </label>
        )}
        <button className={`btn settings-live-control__action ${isArmed ? 'btn-danger' : 'btn-primary'}`}
          style={{ padding: '12px 24px', fontSize: '1.05rem', fontWeight: 700 }} onClick={handleToggle}
          disabled={armChecking}>
          {isArmed ? '停止新买入' : armChecking ? '检查中...' : '启动真实交易'}
        </button>
      </div>}

      {settingsSection === 'status' && runtimePolicy && (
        <div className="card flex flex-col gap-md">
          <div className="settings-section-header">
            <h3 className="text-lg font-bold flex items-center gap-sm"><Gauge size={18} /> 交易通道</h3>
            <button className="btn btn-secondary" onClick={async () => {
              const res = await api.trade.runtimePolicy();
              if (res.ok && res.data) setRuntimePolicy(res.data);
            }}><RefreshCw size={15} /> 刷新</button>
          </div>
          <div className="settings-summary-grid">
            <div><span className="text-xs text-secondary">GMGN 调度</span><strong className="metric-value font-mono text-sm">{statusLabel(runtimePolicy.scheduler.state)}</strong></div>
            <div><span className="text-xs text-secondary">实时信号</span><strong className={`metric-value font-mono text-sm ${runtimePolicy.live_queue.listenerConnected ? 'text-success' : 'text-danger'}`}>{runtimePolicy.live_queue.listenerConnected ? '已连接' : '扫描后备'}</strong></div>
            <div><span className="text-xs text-secondary">最近 429</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.last429At ? '有' : '无'}</strong></div>
            <div><span className="text-xs text-secondary">排队请求</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.queueDepth}</strong></div>
          </div>
          <div className="settings-chain-strip">
            {runtimePolicy.readiness.chains.map(chain => (
              <div key={chain.chain}>
                <strong className="font-mono text-sm">{chain.chain.toUpperCase()}</strong>
                <span className={`text-xs ${chain.ready || chain.strategy_ready ? 'text-success' : 'text-danger'}`}>
                  {chain.ready ? '可以实盘' : chain.strategy_ready ? 'P20/P21 策略可用' : '不可交易'}
                </span>
              </div>
            ))}
          </div>
          <details className="settings-diagnostics">
            <summary>查看诊断详情</summary>
            <div className="diagnostic-body flex flex-col gap-md">
          <div className="settings-metrics-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: '12px' }}>
            <div><span className="text-xs text-secondary">请求调度器</span><strong className="metric-value font-mono text-sm">{statusLabel(runtimePolicy.scheduler.state)}</strong></div>
            <div><span className="text-xs text-secondary">官方桶</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.officialRate}/{runtimePolicy.scheduler.officialCapacity}</strong></div>
            <div><span className="text-xs text-secondary">内部桶</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.currentRate}/{runtimePolicy.scheduler.configuredCapacity}</strong></div>
            <div><span className="text-xs text-secondary">可用权重</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.availableWeight.toFixed(2)}</strong></div>
            <div><span className="text-xs text-secondary">当前预留</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.reservedWeight.toFixed(2)}</strong></div>
            <div><span className="text-xs text-secondary">近 1 秒预留 / 消耗</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.reservedLastSecond} / {runtimePolicy.scheduler.consumedLastSecond}</strong></div>
            <div><span className="text-xs text-secondary">新交易预留</span><strong className="metric-value font-mono text-sm">{runtimePolicy.new_trade_reservation_weight} 权重</strong></div>
            <div><span className="text-xs text-secondary">报价 / 下单权重</span><strong className="metric-value font-mono text-sm">2 / 5</strong></div>
            <div><span className="text-xs text-secondary">队列</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.queueDepth}</strong></div>
            <div><span className="text-xs text-secondary">实时信号通道</span><strong className={`metric-value font-mono text-sm ${runtimePolicy.live_queue.listenerConnected ? 'text-success' : 'text-danger'}`}>{runtimePolicy.live_queue.listenerConnected ? '已连接' : '扫描后备'}</strong></div>
            <div><span className="text-xs text-secondary">当前降级上限</span><strong className="metric-value font-mono text-sm">每秒 {runtimePolicy.scheduler.currentRate} 权重</strong></div>
            <div><span className="text-xs text-secondary">最近 429</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.last429At ? new Date(runtimePolicy.scheduler.last429At).toLocaleString() : '无'}</strong></div>
            <div><span className="text-xs text-secondary">429 冷却倒计时</span><strong className="metric-value font-mono text-sm">{runtimePolicy.scheduler.cooldownUntil ? `${Math.max(0, Math.ceil((runtimePolicy.scheduler.cooldownUntil - schedulerNow) / 1000))} 秒` : '无'}</strong></div>
          </div>
          <div className="section-divider-top">
            <span className="text-xs text-secondary">优先级队列</span>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '8px', marginTop: '8px' }}>
              {SCHEDULER_PRIORITIES.map(([priority, label]) => (
                <div key={priority} className="font-mono text-xs">{label}: {runtimePolicy.scheduler.queueByPriority[priority] || 0}</div>
              ))}
            </div>
          </div>
          <div className="section-divider-top">
            <span className="text-xs text-secondary">订单查询阶段</span>
            <div className="detail-line font-mono text-sm">1 秒 → 2 秒 → 5 秒 → 15-30 秒</div>
            <div className="detail-line font-mono text-xs text-secondary">运行中策略：5-10 分钟 · 持仓余额：仅按恢复任务检查</div>
          </div>
          <div className="section-divider-top">
            <div className="flex justify-between text-xs"><span className="text-secondary">快速交易时延指标 · 24 小时</span><strong className={runtimePolicy.readiness.latencySlo.passed ? 'text-success' : 'text-secondary'}>{runtimePolicy.readiness.latencySlo.passed ? '已达标' : '等待验证'}</strong></div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(135px, 1fr))', gap: '8px', marginTop: '8px' }}>
              {([
                ['事件入库', runtimePolicy.readiness.latencySlo.inbox],
                ['信号生成', runtimePolicy.readiness.latencySlo.signal],
                ['执行准备', runtimePolicy.readiness.latencySlo.execution],
                ['接收事件 → 发起下单', runtimePolicy.readiness.latencySlo.receiveToSwap],
                ['接收事件 → GMGN 接单', runtimePolicy.readiness.latencySlo.receiveToSubmitted]
              ] as const).map(([label, metric]) => (
                <div key={label} className="font-mono text-xs">
                  <span className="text-secondary">{label}</span>
                  <div>{metric.count} · {metric.p50 ?? '-'} / {metric.p95 ?? '-'} / {metric.p99 ?? '-'} ms</div>
                </div>
              ))}
            </div>
          </div>
          <div className="section-divider-top">
            <div className="flex justify-between text-sm"><span>真实交易实时检查</span><strong className={runtimePolicy.readiness.readyToArm ? 'text-success' : 'text-danger'}>{runtimePolicy.readiness.readyToArm ? '可以启动' : '未通过'}</strong></div>
            {runtimePolicy.readiness.blockers.length > 0 && <div className="detail-line text-xs text-secondary font-mono" style={{ overflowWrap: 'anywhere' }}>{runtimePolicy.readiness.blockers.map(blockerLabel).join(' · ')}</div>}
            {runtimePolicy.readiness.advisories.length > 0 && <div className="detail-line text-xs text-secondary font-mono" style={{ overflowWrap: 'anywhere' }}>观察项：{runtimePolicy.readiness.advisories.map(advisoryLabel).join(' · ')}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '12px' }}>
              <div className="section-divider-top">
                <strong className="font-mono text-sm">快速交易缓存</strong>
                <div className={`text-xs ${runtimePolicy.readiness.cacheRequired.ready ? 'text-success' : 'text-secondary'}`}>
                  {runtimePolicy.readiness.cacheRequired.ready ? '已就绪' : `缺少 ${runtimePolicy.readiness.cacheRequired.missing.length} 项`} · {runtimePolicy.readiness.cache.fresh}/{runtimePolicy.readiness.cacheRequired.total}
                </div>
              </div>
              <div className="section-divider-top">
                <strong className="font-mono text-sm">策略对账积压</strong>
                <div className="text-xs text-secondary">
                  {runtimePolicy.readiness.reconciler.strategyBacklog.reduce((total, item) => total + item.count, 0)}
                </div>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px', marginTop: '12px' }}>
              {runtimePolicy.readiness.chains.map(chain => (
                <div key={chain.chain} className="section-divider-top">
                  <strong className="font-mono text-sm">{chain.chain.toUpperCase()}</strong>
                  <div className={`text-xs ${chain.ready || chain.strategy_ready ? 'text-success' : 'text-secondary'}`}>
                    {chain.ready
                      ? '可以实盘'
                      : chain.strategy_ready
                        ? 'P20/P21 策略可用；固定 CA 仍需合约验收'
                        : chain.blockers.map(blockerLabel).join('，')}
                  </div>
                  <div className="detail-line text-xs font-mono">
                    真实买入 {chain.trade_evidence.confirmedBuys} · 真实卖出 {chain.trade_evidence.confirmedSells}
                  </div>
                  <div className="text-xs text-secondary font-mono">
                    GMGN 订单 {chain.trade_evidence.confirmedOrders} · RPC 回执 {chain.trade_evidence.confirmedReceipts}
                  </div>
                </div>
              ))}
            </div>
            {runtimePolicy.readiness.latestEvidence && (
              <div className="section-divider-top detail-section">
                <span className="text-xs text-secondary">最近一条实盘链路证据</span>
                <div className="detail-line text-xs font-mono" style={{ overflowWrap: 'anywhere' }}>
                  Provider Event {runtimePolicy.readiness.latestEvidence.providerEventId || '-'} · Activity #{runtimePolicy.readiness.latestEvidence.activityId || '-'} · Signal #{runtimePolicy.readiness.latestEvidence.signalId || '-'} ({statusLabel(runtimePolicy.readiness.latestEvidence.signalStatus || 'unknown')})
                </div>
                <div className="text-xs font-mono" style={{ overflowWrap: 'anywhere' }}>
                  Attempt #{runtimePolicy.readiness.latestEvidence.attemptId || '-'} · GMGN Order {runtimePolicy.readiness.latestEvidence.providerOrderId || '-'} · Tx {runtimePolicy.readiness.latestEvidence.txHash || '-'} · RPC {statusLabel(runtimePolicy.readiness.latestEvidence.receiptStatus || 'unknown')}
                </div>
              </div>
            )}
          </div>
            </div>
          </details>
        </div>
      )}

      {settingsSection === 'trading' && (
        <div className="card flex flex-col gap-md">
          <div className="settings-section-header">
            <h3 className="text-lg font-bold flex items-center gap-sm"><RefreshCw size={18} /> 自动交易行为</h3>
            <span className="text-xs text-secondary">只保留用户决策</span>
          </div>
          <div className="settings-decision-row">
            <div>
              <strong className="text-sm">失败后自动重试</strong>
              <div className="settings-field-help text-xs text-secondary">
                仅在确认未成交后重试；状态不确定、限流、鉴权和余额错误不会重试。
              </div>
              {managedRetryPartial && (
                <div className="settings-field-help text-xs text-warning">当前只有 {retryEnabledCount}/{RETRY_CHAINS.length} 条链开启，切换后将统一全部链。</div>
              )}
            </div>
            <label className="settings-switch" title="失败后自动重试">
              <input type="checkbox" role="switch" aria-label="失败后自动重试"
                checked={managedRetryEnabled} disabled={savingManagedRetry}
                onChange={() => void toggleManagedRetry()} />
              <span aria-hidden="true" />
            </label>
          </div>
          <div className="settings-decision-row">
            <div>
              <strong className="text-sm">成交状态保护</strong>
              <div className="settings-field-help text-xs text-secondary">系统强制开启，无法通过前端关闭。</div>
            </div>
            <strong className="text-sm text-success">已开启</strong>
          </div>
        </div>
      )}

      {settingsSection === 'trading' && runtimePolicy && (
        <div className="card flex flex-col gap-md">
          <div className="settings-section-header">
            <h3 className="text-lg font-bold flex items-center gap-sm"><Shield size={18} /> 自动交易范围</h3>
            <span className="text-xs text-success">当前 Engine Scope</span>
          </div>
          <div className="settings-summary-grid">
            <div><span className="text-xs text-secondary">数据源</span><strong className="metric-value font-mono text-sm">{runtimePolicy.readiness.policy?.providers.join(', ') || '-'}</strong></div>
            <div><span className="text-xs text-secondary">交易链</span><strong className="metric-value font-mono text-sm">{runtimeScopeChainCount} 条</strong></div>
            <div><span className="text-xs text-secondary">固定 CA</span><strong className="metric-value font-mono text-sm">{runtimeScopeFixedCount} 个</strong></div>
            <div><span className="text-xs text-secondary">动态 / 关注</span><strong className="metric-value font-mono text-sm">{runtimeScopeDynamicCount} / {runtimeScopeFollowCount}</strong></div>
          </div>
          <div className="actions-end section-divider-top">
            <Link className="btn btn-secondary" to="/strategies">管理策略</Link>
          </div>
        </div>
      )}

      {settingsSection === 'status' && !x6551Status && (
        <div className="card flex items-center justify-between gap-md" style={{ minHeight: '88px' }}>
          <div className="flex flex-col gap-xs">
            <h3 className="text-lg font-bold flex items-center gap-sm"><Radio size={18} /> 6551 Max</h3>
            <span className={`text-sm ${x6551Error ? 'text-danger' : 'text-secondary'}`}>
              {x6551Error || '正在读取远端监控状态...'}
            </span>
          </div>
          {x6551Error
            ? <button type="button" className="btn btn-secondary" onClick={() => void refresh6551Status()}><RefreshCw size={15} /> 重试</button>
            : <RefreshCw size={18} className={x6551Loading ? 'animate-spin text-secondary' : 'text-secondary'} />}
        </div>
      )}

      {settingsSection === 'status' && x6551Status && (
        <div className="card flex flex-col gap-md">
          <div className="settings-section-header">
            <h3 className="text-lg font-bold flex items-center gap-sm">
              <Radio size={18} /> 6551 Max
            </h3>
            <div className="flex gap-sm">
              <button type="button" className="btn flex items-center gap-xs" disabled={x6551Loading} onClick={() => void refresh6551Status()}>
                <RefreshCw size={15} className={x6551Loading ? 'animate-spin' : ''} /> 刷新
              </button>
              <button type="button" className="btn flex items-center gap-xs" onClick={run6551WatchDryRun}
                disabled={watchPlanLoading}>
                <ListChecks size={15} /> {watchPlanLoading ? '查询中' : '预览监控变更'}
              </button>
            </div>
          </div>

          <div className="settings-summary-grid">
            <div><span className="text-xs text-secondary">实时连接</span><strong className={`metric-value font-mono text-sm ${x6551Status.wss.status === 'subscribed' ? 'text-success' : 'text-danger'}`}>{statusLabel(x6551Status.wss.status)}</strong></div>
            <div><span className="text-xs text-secondary">同步失败</span><strong className={`metric-value font-mono text-sm ${x6551Status.watchSync.failed > 0 ? 'text-danger' : ''}`}>{x6551Status.watchSync.failed}</strong></div>
            <div><span className="text-xs text-secondary">未知事件</span><strong className={`metric-value font-mono text-sm ${x6551Status.inbox.unknown > 0 ? 'text-danger' : ''}`}>{x6551Status.inbox.unknown}</strong></div>
            <div><span className="text-xs text-secondary">消息用量</span><strong className="metric-value font-mono text-sm">{x6551Status.usage.messages.observedMonth} / {x6551Status.usage.messages.monthlyLimit}</strong></div>
          </div>

          <details className="settings-diagnostics">
            <summary>查看诊断详情</summary>
            <div className="diagnostic-body flex flex-col gap-md">
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
              <strong className="font-mono text-sm">
                {x6551Status.watches.managed} / {x6551Status.watches.remoteAvailable
                  ? x6551Status.watches.remoteTotal
                  : '未知'}
              </strong>
            </div>
            <div className="flex flex-col gap-xs">
              <span className="text-xs text-secondary">监控同步待处理 / 失败</span>
              <strong className={`font-mono text-sm ${x6551Status.watchSync.failed > 0 ? 'text-danger' : ''}`}>
                {x6551Status.watchSync.pending} / {x6551Status.watchSync.failed}
              </strong>
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

          <div className="section-divider-top text-sm">
            <div className="flex items-center gap-sm">
              <Gauge size={15} />
              <strong>实时接收方式：6551 WSS 事件推送</strong>
            </div>
            <div className="settings-field-help text-xs text-secondary">
              正常事件不走 60 秒或 3600 秒轮询，也没有“每轮最大 KOL 数”。本地信号处理目标 ≤ 300ms，GMGN 接受订单目标 ≤ 1s；心跳只用于检测连接存活，断线重连等待上限为 1s。
            </div>
          </div>

          {x6551Status.wss.lastError && (
            <div className="text-sm text-danger section-divider-top">
              {x6551Status.wss.lastError}
            </div>
          )}
            </div>
          </details>

          {watchPlan && (
            <div className="flex flex-col gap-sm section-divider-top">
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
                  <div key={entry.username} className="event-row text-sm"
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

      {settingsSection === 'system' && <div className="grid grid-cols-2 gap-lg">
        <div className="card flex flex-col gap-md" style={{ gridColumn: '1 / -1' }}>
          <div className="flex justify-between align-start gap-md" style={{ flexWrap: 'wrap' }}>
            <div>
              <h3 className="text-lg font-bold flex items-center gap-sm">
                <Search size={18} /> Grok 关注发现提示词
              </h3>
              <p className="settings-field-help text-sm text-secondary">
                这里维护 Grok 在 X 上检索项目、CA、链和团队关系的自然语言任务。提示词只负责研究，不包含 GMGN 或交易执行逻辑。
              </p>
            </div>
            {followPrompts && (
              <span className="text-xs text-secondary font-mono">
                {followPrompts.prompt_version} · {followPrompts.source === 'stored' ? '已保存' : '默认'}
              </span>
            )}
          </div>

          {promptLoading && <div className="text-sm text-secondary">正在读取提示词...</div>}
          {!promptLoading && followPrompts && (
            <div className="grid grid-cols-2 gap-lg">
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">快速研究提示词</span>
                <textarea
                  className="input font-mono text-sm"
                  rows={8}
                  value={followPrompts.fast_prompt}
                  onChange={event => setFollowPrompts({ ...followPrompts, fast_prompt: event.target.value })}
                />
                <span className="text-xs text-secondary">默认先执行这一段；找到唯一可信结果时直接结束。</span>
              </label>
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">人物关系补充提示词</span>
                <textarea
                  className="input font-mono text-sm"
                  rows={8}
                  value={followPrompts.relationship_prompt}
                  onChange={event => setFollowPrompts({ ...followPrompts, relationship_prompt: event.target.value })}
                />
                <span className="text-xs text-secondary">只有首次研究无结果、结果不唯一或证据冲突时才执行。</span>
              </label>
              <label className="flex flex-col gap-xs" style={{ gridColumn: '1 / -1' }}>
                <span className="text-xs text-secondary font-medium">KOL 账号投研提示词</span>
                <textarea
                  className="input font-mono text-sm"
                  rows={7}
                  value={followPrompts.kol_research_prompt}
                  onChange={event => setFollowPrompts({ ...followPrompts, kol_research_prompt: event.target.value })}
                />
                <span className="text-xs text-secondary">用于 KOL 页面直接检索账号身份、项目关系、CA、链和公开证据。</span>
              </label>
            </div>
          )}

          <div className="settings-footer-actions">
            <span className="text-xs text-secondary">修改仅影响后续研究任务；正在处理的任务保持原提示词版本，不重启服务、不改变真实交易状态。</span>
            <div className="flex gap-sm">
              <button type="button" className="btn btn-secondary" onClick={resetFollowPrompts} disabled={!followPrompts || promptSaving}>
                <RotateCcw size={15} /> 恢复默认
              </button>
              <button type="button" className="btn btn-primary" onClick={saveFollowPrompts} disabled={!followPrompts || promptSaving}>
                <Save size={15} /> {promptSaving ? '保存中...' : '保存提示词'}
              </button>
            </div>
          </div>
        </div>

        {/* API Credentials and Environment config */}
        <div className="card flex flex-col gap-md" style={{ gridColumn: '1 / -1' }}>
          <h3 className="text-lg font-bold flex items-center gap-sm section-heading section-divider-bottom"><Key size={18} /> 接口与系统连接</h3>
          
          <div className="grid grid-cols-2 gap-lg">
            {/* Left Block: External Integrations */}
            <div className="flex flex-col gap-sm">
              <h4 className="text-sm font-semibold text-secondary mb-xs">接口授权与数据源</h4>
              
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  GMGN API 密钥
                  <button type="button" className="secret-toggle" onClick={() => toggleSecretVisibility('GMGN_API_KEY')}>
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
                  <input aria-label="外部资金告警已验证" type="checkbox" checked={envConfig.TRADE_ALERTS_VERIFIED === 'true'}
                    onChange={e => setEnvConfig({ ...envConfig, TRADE_ALERTS_VERIFIED: String(e.target.checked) })} />
                </div>
              </div>

              <label className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">紧急停止</span>
                <input type="checkbox" checked={envConfig.EMERGENCY_STOP === 'true'}
                  onChange={e => setEnvConfig({ ...envConfig, EMERGENCY_STOP: String(e.target.checked) })} />
              </label>

              <div className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">X 实时数据源</span>
                <strong className="font-mono text-sm">6551 Max</strong>
              </div>

              <label className="flex items-center justify-between gap-sm">
                <span className="text-xs text-secondary font-medium">新关注发现能力</span>
                <input type="checkbox" checked={envConfig.P21_FOLLOW_DISCOVERY_ENABLED === 'true'}
                  onChange={e => setEnvConfig({ ...envConfig, P21_FOLLOW_DISCOVERY_ENABLED: String(e.target.checked) })} />
              </label>

                  <label className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium flex items-center justify-between">
                      OPENNEWS 访问口令
                      <button type="button" className="secret-toggle" onClick={() => toggleSecretVisibility('OPENNEWS_TOKEN')}>
                        {showSecrets['OPENNEWS_TOKEN'] ? <EyeOff size={12} /> : <Eye size={12} />}
                        {showSecrets['OPENNEWS_TOKEN'] ? '隐藏' : '显示'}
                      </button>
                    </span>
                    <input type={showSecrets['OPENNEWS_TOKEN'] ? 'text' : 'password'} className="input font-mono text-sm"
                      value={envConfig.OPENNEWS_TOKEN || ''}
                      onChange={e => setEnvConfig({ ...envConfig, OPENNEWS_TOKEN: e.target.value })} />
                  </label>


              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  看板登录鉴权口令 (ADMIN_TOKEN)
                  <button type="button" className="secret-toggle" onClick={() => toggleSecretVisibility('ADMIN_TOKEN')}>
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
              <h4 className="text-sm font-semibold text-secondary mb-xs">链连接与本地服务</h4>

              {([
                ['SOLANA_RPC_URL', 'Solana 链上验真 RPC（只读，不用于下单）'],
                ['BSC_RPC_URL', 'BSC 链上验真 RPC（只读，不用于下单）'],
                ['BASE_RPC_URL', 'Base 链上验真 RPC（只读，不用于下单）'],
                ['ETH_RPC_URL', 'Ethereum 链上验真 RPC（只读，不用于下单）'],
                ['ROBINHOOD_RPC_URL', 'Robinhood Chain 生产验真 RPC（只读，不用于下单）'],
              ] as const).map(([key, label]) => (
                <label key={key} className="flex flex-col gap-xs">
                  <span className="text-xs text-secondary font-medium">{label}</span>
                  <input className="input font-mono text-sm" value={envConfig[key] || ''}
                    onChange={e => setEnvConfig({ ...envConfig, [key]: e.target.value })} placeholder="https://" />
                </label>
              ))}

              <div className="section-divider-top detail-section flex flex-col gap-sm">
                <span className="text-xs text-secondary font-medium">Robinhood Chain 真实验收资金保护</span>
                {([
                  ['GMGN_MAX_FEE_RESERVE_ROBINHOOD', '单次提交最大费用预留（ETH）'],
                  ['GMGN_MIN_GAS_RESERVE_ROBINHOOD', '交易后钱包最低 Gas 保留（ETH）'],
                ] as const).map(([key, label]) => (
                  <label key={key} className="flex flex-col gap-xs">
                    <span className="text-xs text-secondary font-medium">{label}</span>
                    <input type="number" min="0" step="any" className="input font-mono text-sm"
                      value={envConfig[key] || ''}
                      onChange={e => setEnvConfig({ ...envConfig, [key]: e.target.value })}
                      placeholder="真实验收前必须填写大于 0 的数值" />
                  </label>
                ))}
                <span className="text-xs text-secondary">这两项只预留交易费和退出 Gas，不会改变白名单中的单笔买入金额。</span>
              </div>
              
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
                  <button type="button" className="secret-toggle" onClick={() => toggleSecretVisibility('DB_PASSWORD')}>
                    {showSecrets['DB_PASSWORD'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['DB_PASSWORD'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['DB_PASSWORD'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.DB_PASSWORD || ''}
                  onChange={e => setEnvConfig({ ...envConfig, DB_PASSWORD: e.target.value })} placeholder="PostgreSQL 用户密码" />
              </label>
            </div>
          </div>

          <div className="actions-end settings-save-actions">
            <button className="btn btn-primary" style={{ padding: '10px 20px', fontWeight: 600 }} onClick={saveEnv}>
              保存配置并热重启后台
            </button>
          </div>
        </div>
      </div>}
    </div>
  );
}
