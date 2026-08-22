import { ArrowRight, Check, Layers3, Plus, RefreshCw, ShieldCheck, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useToast } from '../components/ui/ToastContext';
import { api } from '../lib/api';
import { dynamicPaperDisplay, dynamicResolutionDisplay } from '../lib/p20-runtime';
import type { DynamicPolicy, DynamicSignalStatus, FollowDiscoveryPolicy, KolAccount, WhitelistEntry } from '../lib/types';
import { strategySummary } from './whitelist/strategy-presets';

type StrategyTab = 'fixed' | 'dynamic' | 'follow' | 'new';
type NewStrategyType = 'fixed' | 'dynamic' | 'follow';

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

function policyStatus(policy: Pick<DynamicPolicy, 'mode' | 'enabled'>) {
  if (policy.mode === 'paused' || !policy.enabled) return '已暂停';
  if (policy.mode === 'live') return '实盘运行';
  if (policy.mode === 'paper') return '模拟运行';
  return '已启用';
}

function policyTerms(policy: DynamicPolicy) {
  const terms = policy.allowed_term_types.map((term) => TERM_LABELS[term] || term);
  return terms.length ? terms.join(' · ') : '未配置词条';
}

function policyChains(policy: DynamicPolicy) {
  return policy.allowed_chain_ids.map((chain) => chainLabel(chain)).join(' · ') || '未配置链';
}

function policyBudgetSummary(policy: DynamicPolicy) {
  const units: Record<string, string> = { sol: 'SOL', bsc: 'BNB', base: 'ETH', eth: 'ETH', robinhood: 'ETH' };
  const budgets = policy.allowed_chain_ids.map((chain) => {
    const budget = policy.chain_budgets?.[chain];
    if (!budget) return `${chainLabel(chain)} 待配置`;
    return `${chainLabel(chain)} ${budget.budget_per_trade}/${budget.daily_budget} ${units[chain]}`;
  });
  return budgets.join(' · ') || '未配置链预算';
}

export default function StrategyCenterPage() {
  const [tab, setTab] = useState<StrategyTab>('fixed');
  const [newType, setNewType] = useState<NewStrategyType>('fixed');
  const [fixedEntries, setFixedEntries] = useState<WhitelistEntry[]>([]);
  const [policies, setPolicies] = useState<DynamicPolicy[]>([]);
  const [followPolicies, setFollowPolicies] = useState<FollowDiscoveryPolicy[]>([]);
  const [kols, setKols] = useState<KolAccount[]>([]);
  const [runtime, setRuntime] = useState<DynamicSignalStatus | null>(null);
  const [selectedFixedId, setSelectedFixedId] = useState('');
  const [selectedDynamicKey, setSelectedDynamicKey] = useState('');
  const [selectedFollowId, setSelectedFollowId] = useState('');
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const navigate = useNavigate();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [fixedResponse, policyResponse, followResponse, kolResponse, statusResponse] = await Promise.all([
      api.whitelist.list({ page: '1', pageSize: '50', summary: 'true' }),
      api.dynamicSignal.policies(),
      api.followDiscovery.policies(),
      api.kol.list(),
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
    } else {
      toast(policyResponse.error || '动态策略加载失败', 'error');
    }
    if (followResponse.ok) {
      const next = followResponse.data || [];
      setFollowPolicies(next);
      setSelectedFollowId((current) => current || next[0]?.id || '');
    } else toast(followResponse.error || '新关注发现策略加载失败', 'error');
    if (kolResponse.ok) setKols(kolResponse.data || []);
    else toast(kolResponse.error || 'KOL 账号加载失败', 'error');
    if (statusResponse.ok) setRuntime(statusResponse.data || null);
    setLoading(false);
  }, [toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const selectedFixed = useMemo(
    () => fixedEntries.find((item) => item.id === selectedFixedId) || fixedEntries[0] || null,
    [fixedEntries, selectedFixedId],
  );
  const configuredKolIds = useMemo(() => new Set(policies.map((item) => String(item.kol_id))), [policies]);
  const unconfiguredKols = useMemo(
    () => kols.filter((item) => !configuredKolIds.has(String(item.id))),
    [configuredKolIds, kols],
  );
  useEffect(() => {
    const selectionExists = policies.some((item) => selectedDynamicKey === `policy:${item.id}`)
      || unconfiguredKols.some((item) => selectedDynamicKey === `kol:${item.id}`);
    if (selectionExists || (!policies.length && !unconfiguredKols.length)) return;
    setSelectedDynamicKey(policies[0] ? `policy:${policies[0].id}` : `kol:${unconfiguredKols[0].id}`);
  }, [policies, selectedDynamicKey, unconfiguredKols]);
  const selectedPolicy = useMemo(() => {
    if (!selectedDynamicKey.startsWith('policy:')) return null;
    return policies.find((item) => item.id === selectedDynamicKey.slice(7)) || null;
  }, [policies, selectedDynamicKey]);
  const selectedUnconfiguredKol = useMemo(() => {
    if (!selectedDynamicKey.startsWith('kol:')) return null;
    return unconfiguredKols.find((item) => String(item.id) === selectedDynamicKey.slice(4)) || null;
  }, [selectedDynamicKey, unconfiguredKols]);
  const paperCount = policies.filter((item) => item.mode === 'paper').length;
  const liveCount = policies.filter((item) => item.mode === 'live' && item.enabled).length;
  const selectedFollow = followPolicies.find((item) => item.id === selectedFollowId) || followPolicies[0] || null;
  const followLiveCount = followPolicies.filter((item) => item.mode === 'live' && item.enabled).length;
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
    navigate('/strategies/follow-discovery');
  };

  return (
    <div className="strategy-center-page">
      <section className="strategy-center-summary" aria-label="策略状态摘要">
        <div><span>全部策略</span><strong>{fixedEntries.length + policies.length + followPolicies.length}</strong><small>固定 {fixedEntries.length} · 动态 {policies.length} · 发现 {followPolicies.length}</small></div>
        <div><span>固定目标</span><strong>{fixedEntries.length}</strong><small>CA、项目和生态关系</small></div>
        <div><span>动态账号</span><strong>{policies.length}</strong><small>已配置 {policies.length} · 待配置 {unconfiguredKols.length}</small></div>
        <div><span>模拟策略</span><strong>{paperCount}</strong><small>仅产生模拟交易</small></div>
        <div><span>实盘策略</span><strong className={liveCount + followLiveCount ? 'danger' : ''}>{liveCount + followLiveCount}</strong><small>{liveCount + followLiveCount ? '仍受全局 Engine 门禁' : '未配置实盘策略'}</small></div>
      </section>

      <section className="strategy-center-shell">
        <header className="strategy-center-header">
          <div><span className="strategy-center-eyebrow">统一策略入口</span><h1>策略中心</h1><p>这里只查看策略状态；固定策略和动态策略进入各自工作区编辑。</p></div>
          <div className="strategy-center-header-actions"><span className="strategy-center-status"><i />{resolutionRuntime.label}</span><button type="button" className="p16-icon-button" title="刷新策略中心" aria-label="刷新策略中心" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'icon-spin' : ''} /></button></div>
        </header>

        <nav className="strategy-center-tabs" aria-label="策略类型">
          <button type="button" className={tab === 'fixed' ? 'active' : ''} onClick={() => setTab('fixed')}>固定 CA / 项目策略</button>
          <button type="button" className={tab === 'dynamic' ? 'active' : ''} onClick={() => setTab('dynamic')}>动态喊单策略</button>
          <button type="button" className={tab === 'follow' ? 'active' : ''} onClick={() => setTab('follow')}>新关注发现策略</button>
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
                <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>固定目标不经过动态 CA 解析，工作区保存后沿用现有 6551 Watch 同步和交易链路。</span></div>
                <div className="strategy-center-detail-actions"><Link className="btn btn-primary" to={`/strategies/fixed?whitelistId=${encodeURIComponent(selectedFixed.id)}`}>编辑当前项目 <ArrowRight size={15} /></Link></div>
              </> : <div className="p16-empty-line">选择一个固定策略查看详情</div>}
            </div>
          </div>}
        </section>}

        {tab === 'dynamic' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>动态喊单策略</h2><p>账号发帖后才解析 CA，动态解析结果不会修改固定 CA / 项目策略。</p></div><Link className="btn btn-primary" to="/strategies/dynamic"><Layers3 size={16} />进入动态策略工作区</Link></div>
          <div className="strategy-center-runtime"><span>解析任务：{resolutionRuntime.shortLabel}</span><span>模拟任务：{paperRuntime.shortLabel}</span><span>动态策略：{policies.length} 条</span><span>待配置账号：{unconfiguredKols.length} 个</span><span>实盘策略：{liveCount} 条</span></div>
          {loading ? <div className="p16-empty-line">加载动态策略中...</div> : <div className="strategy-center-split">
            <div className="strategy-center-list">
              <div className="strategy-center-list-head"><strong>动态账号列表</strong><span>{policies.length} 已配置 · {unconfiguredKols.length} 待配置</span></div>
              {policies.map((policy) => <button type="button" key={policy.id} className={`strategy-center-row ${selectedDynamicKey === `policy:${policy.id}` ? 'selected' : ''}`} onClick={() => setSelectedDynamicKey(`policy:${policy.id}`)}>
                <span className="strategy-center-row-mark">X</span><span><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><small>{modeLabel(policy.mode)} · {policyChains(policy)}</small></span><em className={policy.enabled && policy.mode !== 'paused' ? 'active' : ''}>{policyStatus(policy)}</em>
              </button>)}
              {unconfiguredKols.map((kol) => <button type="button" key={kol.id} className={`strategy-center-row ${selectedDynamicKey === `kol:${kol.id}` ? 'selected' : ''}`} onClick={() => setSelectedDynamicKey(`kol:${kol.id}`)}>
                <span className="strategy-center-row-mark">X</span><span><strong>@{kol.x_handle.replace(/^@+/, '')}</strong><small>{kol.chain_ids?.length ? kol.chain_ids.map((chain) => chainLabel(chain)).join(' · ') : '尚未设置允许链'}</small></span><em className="pending">{kol.enabled ? '待配置' : '账号已禁用'}</em>
              </button>)}
              {!policies.length && !unconfiguredKols.length && <div className="p16-empty-line">暂无可配置的 KOL 账号</div>}
            </div>
            <div className="strategy-center-detail">
              {selectedPolicy ? <>
                <div className="strategy-center-detail-head"><div><span className="strategy-center-eyebrow">账号级策略</span><h3>@{selectedPolicy.x_handle.replace(/^@+/, '')}</h3><p>{selectedPolicy.display_name || '动态喊单账号'} · 版本 {selectedPolicy.revision}</p></div><span className={`strategy-center-badge ${selectedPolicy.enabled ? 'active' : ''}`}>{policyStatus(selectedPolicy)}</span></div>
                <div className="strategy-center-detail-grid"><div><span>允许链</span><strong>{policyChains(selectedPolicy)}</strong></div><div><span>匹配词条</span><strong>{policyTerms(selectedPolicy)}</strong></div><div><span>运行阶段</span><strong>{modeLabel(selectedPolicy.mode)}</strong></div><div><span>按链预算</span><strong>{policyBudgetSummary(selectedPolicy)}</strong></div><div className="wide"><span>安全边界</span><strong>先逐帖解析和验收，再由账号级策略决定是否进入交易链路。</strong></div></div>
                <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>动态策略只在独立工作区编辑和保存；实盘策略随全局 Engine 运行，不会覆盖固定 CA、项目关系或生态互动策略。</span></div>
                <div className="strategy-center-detail-actions"><Link className="btn btn-primary" to={`/strategies/dynamic?kolId=${selectedPolicy.kol_id}`}>进入工作区 <ArrowRight size={15} /></Link></div>
              </> : selectedUnconfiguredKol ? <>
                <div className="strategy-center-detail-head"><div><span className="strategy-center-eyebrow">待配置账号</span><h3>@{selectedUnconfiguredKol.x_handle.replace(/^@+/, '')}</h3><p>{selectedUnconfiguredKol.display_name || '动态喊单账号'} · KOL 账号已保存</p></div><span className="strategy-center-badge pending">待配置</span></div>
                <div className="strategy-center-detail-grid"><div><span>生态标签</span><strong>{selectedUnconfiguredKol.chain_ids?.length ? selectedUnconfiguredKol.chain_ids.map((chain) => chainLabel(chain)).join(' · ') : '未分类'}</strong></div><div><span>账号状态</span><strong>{selectedUnconfiguredKol.enabled ? '已启用' : '已禁用'}</strong></div><div><span>6551 核验</span><strong>{selectedUnconfiguredKol.profile_status === 'verified' ? '已核验' : '等待核验'}</strong></div><div><span>账号权重</span><strong>{selectedUnconfiguredKol.weight}</strong></div><div className="wide"><span>策略状态</span><strong>尚未创建动态策略，不会进入发帖解析或交易链路。</strong></div></div>
                <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>保存账号不会自动开启动态喊单。进入工作区确认允许链、内容类型、词条、金额和运行阶段后，才会创建账号策略。</span></div>
                <div className="strategy-center-detail-actions"><Link className="btn btn-primary" to={`/strategies/dynamic?kolId=${selectedUnconfiguredKol.id}`}><Plus size={15} />配置动态策略</Link></div>
              </> : <div className="p16-empty-line">选择一个动态账号查看详情</div>}
            </div>
          </div>}
        </section>}

        {tab === 'follow' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>新关注发现策略</h2><p>高权重 KOL 主动关注新账号后，验证项目身份和唯一可信 CA。</p></div><Link className="btn btn-primary" to="/strategies/follow-discovery"><UserPlus size={16} />进入发现策略工作区</Link></div>
          {loading ? <div className="p16-empty-line">加载发现策略中...</div> : <div className="strategy-center-split">
            <div className="strategy-center-list"><div className="strategy-center-list-head"><strong>监控账号</strong><span>{followPolicies.length} 条</span></div>
              {followPolicies.map((policy) => <button type="button" key={policy.id} className={`strategy-center-row ${selectedFollow?.id === policy.id ? 'selected' : ''}`} onClick={() => setSelectedFollowId(policy.id)}><span className="strategy-center-row-mark">F</span><span><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><small>{modeLabel(policy.mode)} · {policy.allowed_chain_ids.map(chainLabel).join(' · ')}</small></span><em className={policy.enabled && policy.mode !== 'paused' ? 'active' : ''}>{policyStatus(policy)}</em></button>)}
              {!followPolicies.length && <div className="p16-empty-line">暂无新关注发现策略</div>}</div>
            <div className="strategy-center-detail">{selectedFollow ? <><div className="strategy-center-detail-head"><div><span className="strategy-center-eyebrow">Follow 事件策略</span><h3>@{selectedFollow.x_handle.replace(/^@+/, '')}</h3><p>{selectedFollow.display_name || '高权重 KOL'} · Revision {selectedFollow.revision}</p></div><span className={`strategy-center-badge ${selectedFollow.enabled ? 'active' : ''}`}>{policyStatus(selectedFollow)}</span></div>
              <div className="strategy-center-detail-grid"><div><span>运行阶段</span><strong>{modeLabel(selectedFollow.mode)}</strong></div><div><span>允许链</span><strong>{selectedFollow.allowed_chain_ids.map(chainLabel).join(' · ')}</strong></div><div><span>交易模板</span><strong>{selectedFollow.trade_template_name || 'Record 未配置模板'}</strong></div><div><span>Watch</span><strong>{selectedFollow.watch_sync_status || '等待同步'}</strong></div><div className="wide"><span>安全边界</span><strong>稳定 User ID、官方来源完整 CA、GMGN 地址回显和唯一候选全部通过后才物化 Signal。</strong></div></div>
              <div className="strategy-center-detail-note"><ShieldCheck size={16} /><span>首次保存建立 Baseline，不扫描历史关注；记录阶段不交易，实盘阶段仍受全局 Engine 和当前运行条件控制。</span></div><div className="strategy-center-detail-actions"><Link className="btn btn-primary" to={`/strategies/follow-discovery?policyId=${selectedFollow.id}`}>进入工作区 <ArrowRight size={15} /></Link></div></> : <div className="p16-empty-line">选择一个策略查看详情</div>}</div>
          </div>}
        </section>}

        {tab === 'new' && <section className="strategy-center-view">
          <div className="strategy-center-view-head"><div><h2>新增策略</h2><p>后续增加新的触发逻辑时，从这里选择策略类型，再进入对应工作区。</p></div><span className="strategy-center-info"><Check size={15} />统一创建入口</span></div>
          <div className="strategy-center-new-grid">
            <button type="button" className={`strategy-center-new-card ${newType === 'fixed' ? 'selected' : ''}`} onClick={() => setNewType('fixed')}><span className="strategy-center-new-icon">CA</span><strong>固定 CA / 项目策略</strong><p>已知 CA、项目账号、生态互动和未发币项目监控。</p><small>当前可用 · 进入固定工作区</small></button>
            <button type="button" className={`strategy-center-new-card ${newType === 'dynamic' ? 'selected' : ''}`} onClick={() => setNewType('dynamic')}><span className="strategy-center-new-icon">X</span><strong>动态喊单策略</strong><p>账号发帖后匹配 CA、代币符号或话题标签，再按所选运行阶段处理。</p><small>当前可用 · 进入动态工作区</small></button>
            <button type="button" className={`strategy-center-new-card ${newType === 'follow' ? 'selected' : ''}`} onClick={() => setNewType('follow')}><span className="strategy-center-new-icon">F</span><strong>新关注发现策略</strong><p>KOL 主动关注新账号后，验证项目身份和唯一可信 CA。</p><small>当前可用 · 进入发现工作区</small></button>
          </div>
          <div className="strategy-center-new-footer"><span>策略类型确定后不直接转换，改变语义请复制为新策略并保留历史版本。</span><button type="button" className="btn btn-primary" onClick={continueNew}>继续配置 <ArrowRight size={15} /></button></div>
        </section>}
      </section>
    </div>
  );
}
