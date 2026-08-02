import { ArrowRight, Check, Layers3, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/ui/ToastContext';
import { api } from '../lib/api';
import { dynamicPaperDisplay, dynamicResolutionDisplay } from '../lib/p20-runtime';
import type { DynamicPolicy, DynamicSignalStatus, WhitelistEntry } from '../lib/types';
import { strategySummary } from './whitelist/strategy-presets';

type StrategyTab = 'fixed' | 'dynamic' | 'new';
type NewStrategyType = 'fixed' | 'dynamic' | 'future';

const CHAIN_LABELS: Record<string, string> = {
  sol: 'SOL', bsc: 'BSC', base: 'BASE', eth: 'ETH', robinhood: 'Robinhood',
};

const TERM_LABELS: Record<string, string> = {
  ca: '完整 CA', cashtag: '$ 代币符号', hashtag: '# 话题标签', approved_name: '项目名称',
};

function chainLabel(chain?: string) {
  return CHAIN_LABELS[chain || ''] || chain?.toUpperCase() || '--';
}

function shortAddress(value?: string | null) {
  if (!value) return '尚未填写 CA';
  return value.length > 16 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function fixedTargetLabel(item: WhitelistEntry) {
  if (item.direct_sources?.some((source) => source.source_kind === 'launch')) return '未发币项目';
  if (item.relations?.length) return '生态互动';
  if (item.direct_sources?.some((source) => source.source_kind === 'ecosystem')) return '生态账号';
  return '固定 CA';
}

function modeLabel(mode: DynamicPolicy['mode']) {
  return mode === 'record' ? '记录' : mode === 'paper' ? '模拟' : mode === 'live' ? '实盘' : '暂停';
}

function policyStatus(policy: DynamicPolicy) {
  if (policy.mode === 'paused' || !policy.enabled) return '已暂停';
  if (policy.mode === 'live') return policy.approval_id ? '已授权' : '待授权';
  if (policy.mode === 'paper') return '待验收';
  return '已启用';
}

function policyTerms(policy: DynamicPolicy) {
  const terms = policy.allowed_term_types.map((term) => TERM_LABELS[term] || term);
  return terms.length ? terms.join(' · ') : '未配置词条';
}

function policyChains(policy: DynamicPolicy) {
  return policy.allowed_chain_ids.map((chain) => chainLabel(chain)).join(' · ') || '未配置链';
}

export default function StrategyCenterPage() {
  const [tab, setTab] = useState<StrategyTab>('fixed');
  const [newType, setNewType] = useState<NewStrategyType>('fixed');
  const [fixedEntries, setFixedEntries] = useState<WhitelistEntry[]>([]);
  const [policies, setPolicies] = useState<DynamicPolicy[]>([]);
  const [runtime, setRuntime] = useState<DynamicSignalStatus | null>(null);
  const [selectedFixedId, setSelectedFixedId] = useState('');
  const [selectedPolicyId, setSelectedPolicyId] = useState('');
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [fixedResponse, policyResponse, statusResponse] = await Promise.all([
      api.whitelist.list({ page: '1', pageSize: '50', summary: 'true' }),
      api.dynamicSignal.policies(),
      api.dynamicSignal.status(),
    ]);

    if (fixedResponse.ok) {
      const entries = (fixedResponse.data as unknown as WhitelistEntry[]) || [];
      setFixedEntries(entries);
      setSelectedFixedId((current) => current || entries[0]?.id || '');
    } else {
      toast(fixedResponse.error || '固定策略加载失败', 'error');
    }
    if (policyResponse.ok) {
      const nextPolicies = policyResponse.data || [];
      setPolicies(nextPolicies);
      setSelectedPolicyId((current) => current || nextPolicies[0]?.id || '');
    } else {
      toast(policyResponse.error || '动态策略加载失败', 'error');
    }
    if (statusResponse.ok) setRuntime(statusResponse.data || null);
    setLoading(false);
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedFixed = useMemo(
    () => fixedEntries.find((item) => item.id === selectedFixedId) || fixedEntries[0] || null,
    [fixedEntries, selectedFixedId],
  );
  const selectedPolicy = useMemo(
    () => policies.find((item) => item.id === selectedPolicyId) || policies[0] || null,
    [policies, selectedPolicyId],
  );
  const paperCount = policies.filter((item) => item.mode === 'paper').length;
  const liveCount = policies.filter((item) => item.mode === 'live' && item.enabled
    && item.approval_id && item.approval_expires_at && Date.parse(item.approval_expires_at) > Date.now()).length;
  const selectedActors = selectedFixed
    ? new Set([
      ...(selectedFixed.selected_actor_handles || []),
      ...(selectedFixed.direct_sources || []).map((item) => item.actor_handle),
      ...(selectedFixed.relations || []).map((item) => item.actor_handle),
    ]).size
    : 0;
  const resolutionRuntime = dynamicResolutionDisplay(runtime);
  const paperRuntime = dynamicPaperDisplay(runtime);

  const continueNew = () => {
    if (newType === 'fixed') {
      navigate('/strategies/fixed');
      return;
    }
    if (newType === 'dynamic') {
      navigate('/strategies/dynamic');
      return;
    }
    toast('该策略类型尚未实现，需要先完成接口、执行器和验收设计', 'info');
  };

  return (
    <div className="strategy-center-page">
      <section className="strategy-center-summary" aria-label="策略状态摘要">
        <div><span>全部策略</span><strong>{fixedEntries.length + policies.length}</strong><small>固定 {fixedEntries.length} · 动态 {policies.length}</small></div>
        <div><span>固定目标</span><strong>{fixedEntries.length}</strong><small>CA、项目和生态关系</small></div>
        <div><span>动态账号</span><strong>{policies.length}</strong><small>记录 {policies.filter((item) => item.mode === 'record').length} · 模拟 {paperCount}</small></div>
        <div><span>模拟验收</span><strong>{paperCount}</strong><small>修改后需重新验收</small></div>
        <div><span>实盘授权</span><strong className={liveCount ? 'danger' : ''}>{liveCount}</strong><small>{liveCount ? '动态策略已授权' : '未开启动态实盘'}</small></div>
      </section>

      <section className="strategy-center-shell">
        <header className="strategy-center-header">
          <div><span className="strategy-center-eyebrow">统一策略入口</span><h1>策略中心</h1><p>这里只查看策略状态；固定策略和动态策略进入各自工作区编辑。</p></div>
          <div className="strategy-center-header-actions"><span className="strategy-center-status"><i />{resolutionRuntime.label}</span><button type="button" className="p16-icon-button" title="刷新策略中心" aria-label="刷新策略中心" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'animate-spin' : ''} /></button></div>
        </header>

        <nav className="strategy-center-tabs" aria-label="策略类型">
          <button type="button" className={tab === 'fixed' ? 'active' : ''} onClick={() => setTab('fixed')}>固定 CA / 项目策略</button>
          <button type="button" className={tab === 'dynamic' ? 'active' : ''} onClick={() => setTab('dynamic')}>动态喊单策略</button>
          <button type="button" className={tab === 'new' ? 'active' : ''} onClick={() => setTab('new')}>新增策略</button>
        </nav>

        {tab === 'fixed' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>固定 CA / 项目策略</h2><p>原白名单工作区的固定 CA、未发币项目和生态互动策略。</p></div><Link className="btn btn-primary" to="/strategies/fixed"><Plus size={16} />进入固定策略工作区</Link></div>
          {loading ? <div className="p16-empty-line">加载固定策略中...</div> : <div className="strategy-center-split">
            <div className="strategy-center-list">
              <div className="strategy-center-list-head"><strong>固定目标列表</strong><span>{fixedEntries.length} 条</span></div>
              {fixedEntries.map((item) => <button type="button" key={item.id} className={`strategy-center-row ${selectedFixed?.id === item.id ? 'selected' : ''}`} onClick={() => setSelectedFixedId(item.id)}>
                <span className="strategy-center-row-mark">{(item.symbol || 'CA').slice(0, 2).toUpperCase()}</span><span><strong>{item.symbol || item.project_name || '未命名策略'}</strong><small>{chainLabel(item.chain_id)} · {fixedTargetLabel(item)}</small></span><em className={item.status === 'active' ? 'active' : ''}>{item.status === 'active' ? '运行中' : item.status === 'paused' ? '已暂停' : '已归档'}</em>
              </button>)}
              {!fixedEntries.length && <div className="p16-empty-line">暂无固定策略</div>}
            </div>
            <div className="strategy-center-detail">
              {selectedFixed ? <>
                <div className="strategy-center-detail-head"><div><span className="strategy-center-eyebrow">{fixedTargetLabel(selectedFixed)}</span><h3>{selectedFixed.symbol || selectedFixed.project_name || '未命名策略'}</h3><p>{chainLabel(selectedFixed.chain_id)} · {shortAddress(selectedFixed.contract_address)}</p></div><span className={`strategy-center-badge ${selectedFixed.status === 'active' ? 'active' : ''}`}>{selectedFixed.status === 'active' ? '运行中' : '已暂停'}</span></div>
                <div className="strategy-center-detail-grid"><div><span>触发账号</span><strong>{selectedActors} 个唯一账号</strong></div><div><span>生态 CA 动态</span><strong>{selectedFixed.ecosystem_source_count ?? selectedFixed.direct_sources?.filter((item) => item.source_kind === 'ecosystem').length ?? 0} 个</strong></div><div><span>生态互动</span><strong>{selectedFixed.relation_count ?? selectedFixed.relations?.length ?? 0} 条</strong></div><div><span>单笔 / 上限</span><strong>{selectedFixed.budget_per_trade} / {selectedFixed.total_budget}</strong></div><div className="wide"><span>离场策略</span><strong>{strategySummary(selectedFixed.exit_strategy)}</strong></div></div>
                <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>固定目标不经过动态 CA 解析，工作区保存后沿用现有 6551 Watch 同步和 P19 交易链路。</span></div>
                <div className="strategy-center-detail-actions"><Link className="btn btn-primary" to="/strategies/fixed">进入工作区 <ArrowRight size={15} /></Link></div>
              </> : <div className="p16-empty-line">选择一个固定策略查看详情</div>}
            </div>
          </div>}
        </section>}

        {tab === 'dynamic' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>动态喊单策略</h2><p>账号发帖后才解析 CA，动态解析结果不会修改固定 CA / 项目策略。</p></div><Link className="btn btn-primary" to="/strategies/dynamic"><Layers3 size={16} />进入动态策略工作区</Link></div>
          <div className="strategy-center-runtime"><span>解析任务：{resolutionRuntime.shortLabel}</span><span>模拟任务：{paperRuntime.shortLabel}</span><span>动态策略：{policies.length} 条</span><span>实盘授权：{liveCount} 条</span></div>
          {loading ? <div className="p16-empty-line">加载动态策略中...</div> : <div className="strategy-center-split">
            <div className="strategy-center-list">
              <div className="strategy-center-list-head"><strong>账号策略列表</strong><span>{policies.length} 条</span></div>
              {policies.map((policy) => <button type="button" key={policy.id} className={`strategy-center-row ${selectedPolicy?.id === policy.id ? 'selected' : ''}`} onClick={() => setSelectedPolicyId(policy.id)}>
                <span className="strategy-center-row-mark">X</span><span><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><small>{modeLabel(policy.mode)} · {policyChains(policy)}</small></span><em className={policy.enabled && policy.mode !== 'paused' ? 'active' : ''}>{policyStatus(policy)}</em>
              </button>)}
              {!policies.length && <div className="p16-empty-line">暂无动态账号策略</div>}
            </div>
            <div className="strategy-center-detail">
              {selectedPolicy ? <>
                <div className="strategy-center-detail-head"><div><span className="strategy-center-eyebrow">账号级策略</span><h3>@{selectedPolicy.x_handle.replace(/^@+/, '')}</h3><p>{selectedPolicy.display_name || '动态喊单账号'} · 版本 {selectedPolicy.revision}</p></div><span className={`strategy-center-badge ${selectedPolicy.enabled ? 'active' : ''}`}>{policyStatus(selectedPolicy)}</span></div>
                <div className="strategy-center-detail-grid"><div><span>允许链</span><strong>{policyChains(selectedPolicy)}</strong></div><div><span>匹配词条</span><strong>{policyTerms(selectedPolicy)}</strong></div><div><span>运行阶段</span><strong>{modeLabel(selectedPolicy.mode)}</strong></div><div><span>单笔 / 每日额度</span><strong>{selectedPolicy.budget_per_trade} / {selectedPolicy.daily_budget}</strong></div><div className="wide"><span>安全边界</span><strong>先逐帖解析和验收，再由账号级 Policy 决定是否进入交易链路。</strong></div></div>
                <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>动态策略只在独立工作区编辑、保存、验收和授权，不会覆盖固定 CA、项目关系或生态互动策略。</span></div>
                <div className="strategy-center-detail-actions"><Link className="btn btn-primary" to="/strategies/dynamic">进入工作区 <ArrowRight size={15} /></Link></div>
              </> : <div className="p16-empty-line">暂无动态策略，请进入工作区配置账号</div>}
            </div>
          </div>}
        </section>}

        {tab === 'new' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>新增策略</h2><p>后续增加新的触发逻辑时，从这里选择策略类型，再进入对应工作区。</p></div><span className="strategy-center-info"><Check size={15} />统一创建入口</span></div>
          <div className="strategy-center-new-grid">
            <button type="button" className={`strategy-center-new-card ${newType === 'fixed' ? 'selected' : ''}`} onClick={() => setNewType('fixed')}><span className="strategy-center-new-icon">CA</span><strong>固定 CA / 项目策略</strong><p>已知 CA、项目账号、生态互动和未发币项目监控。</p><small>当前可用 · 进入固定工作区</small></button>
            <button type="button" className={`strategy-center-new-card ${newType === 'dynamic' ? 'selected' : ''}`} onClick={() => setNewType('dynamic')}><span className="strategy-center-new-icon">X</span><strong>动态喊单策略</strong><p>账号发帖后匹配 CA、代币符号或话题标签，再经过解析和模拟验收。</p><small>当前可用 · 进入动态工作区</small></button>
            <button type="button" className={`strategy-center-new-card disabled ${newType === 'future' ? 'selected' : ''}`} onClick={() => setNewType('future')}><span className="strategy-center-new-icon">+</span><strong>后续扩展策略</strong><p>为链上事件、钱包行为或其他数据源预留统一入口。</p><small>暂未实现，需要单独评审</small></button>
          </div>
          <div className="strategy-center-new-footer"><span>策略类型确定后不直接转换，改变语义请复制为新策略并保留历史版本。</span><button type="button" className="btn btn-primary" onClick={continueNew}>继续配置 <ArrowRight size={15} /></button></div>
        </section>}
      </section>
    </div>
  );
}
