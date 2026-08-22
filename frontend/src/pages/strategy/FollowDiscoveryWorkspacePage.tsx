import { ArrowRight, BadgeCheck, Check, Clock3, Info, Save, Search, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type { ChainId, DynamicPolicyTemplate, FollowDiscoveryEvent, FollowDiscoveryPolicy, KolAccount } from '../../lib/types';
import { strategySummary } from '../whitelist/strategy-presets';
import KolCategoryBar from '../kol/KolCategoryBar';
import {
  KOL_ECOSYSTEM_CATEGORIES,
  accountMatchesCategory,
  customCategoryKey,
  ecosystemCategoryKey,
  type KolCategoryKey,
} from '../kol/kol-category';
import StrategyWorkspaceLayout, { type WorkspaceSummaryItem } from './StrategyWorkspaceLayout';

const CHAINS: Array<{ id: ChainId; label: string; unit: string }> = [
  { id: 'sol', label: 'Solana', unit: 'SOL' }, { id: 'bsc', label: 'BNB Chain', unit: 'BNB' },
  { id: 'base', label: 'Base', unit: 'ETH' }, { id: 'eth', label: 'Ethereum', unit: 'ETH' },
  { id: 'robinhood', label: 'Robinhood', unit: 'ETH' },
];
const STEPS = [
  ['监控账号', 'KOL、运行阶段、Follow 方向'], ['发现与验证', '允许链、官方来源、唯一 CA'],
  ['交易配置', '现有模板、逐链金额、离场策略'], ['确认并保存', 'Baseline、Revision、Watch 影响'],
] as const;

type Draft = {
  kol_id: string;
  mode: FollowDiscoveryPolicy['mode'];
  enabled: boolean;
  allowed_chain_ids: ChainId[];
  trade_template_id: string;
  resolver_options: FollowDiscoveryPolicy['resolver_options'];
};

function freshDraft(): Draft {
  return { kol_id: '', mode: 'record', enabled: true, allowed_chain_ids: ['bsc'], trade_template_id: '',
    resolver_options: { event_ttl_seconds: 900, max_tweets: 20, minimum_account_age_days: 7,
      include_profile_website: true, require_original_content: true } };
}

function modeLabel(mode: FollowDiscoveryPolicy['mode']) {
  return mode === 'record' ? '记录' : mode === 'paper' ? '模拟' : mode === 'live' ? '实盘' : '暂停';
}

function eventStatusLabel(value: FollowDiscoveryEvent['status']) {
  const labels: Record<string, string> = { baseline: '基线已建立', pending: '等待处理', processing: '分析中', resolved: '已解析', rejected: '已拒绝', failed: '研究失败', cancelled: '已取消' };
  return labels[value] || '未知状态';
}

function eventFailureLabel(code?: string | null) {
  const labels: Record<string, string> = {
    FOLLOW_ACCOUNT_NOT_PROJECT: '未确认该账号属于加密项目或核心人员',
    FOLLOW_PROJECT_RELATION_NOT_VERIFIED: '未确认该人员与项目官方账号的关系',
    FOLLOW_CA_NOT_FOUND: '未找到该账号公开且可核验的完整 CA',
    FOLLOW_CA_AMBIGUOUS: '发现多个候选 CA，无法唯一确认',
    FOLLOW_CA_CHAIN_AMBIGUOUS: '该 CA 存在多个链，无法确定目标链',
    FOLLOW_CA_CHAIN_UNRESOLVED: '未在允许的区块链上核验到该 CA',
    FOLLOW_EVENT_EXPIRED: '关注事件已超过有效期',
    FOLLOW_CHAIN_RPC_UNAVAILABLE: '区块链核验服务暂不可用',
    XAI_CREDITS_EXHAUSTED: 'Grok 研究额度已用尽',
    XAI_SEARCH_TIMEOUT: 'Grok 搜索超时',
    XAI_SCHEMA_INVALID: 'Grok 返回结果格式不完整，无法生成可靠结果',
  };
  return code ? labels[code] || '研究未完成，请查看诊断记录' : null;
}

function eventMainMessage(event: FollowDiscoveryEvent) {
  if (event.status === 'resolved') return event.contract_address ? '已解析并完成唯一 CA 核验' : '已完成研究与身份核验';
  if (event.status === 'processing') return '正在研究项目身份和公开 CA';
  if (event.status === 'pending') return '等待研究队列处理';
  if (event.status === 'baseline') return '首次保存时建立关注基线';
  return eventFailureLabel(event.failure_code) || (event.status === 'cancelled' ? '该事件已取消处理' : '研究未完成，请查看诊断记录');
}

type PolicyModeFilter = 'all' | FollowDiscoveryPolicy['mode'];
type EventStatusFilter = 'all' | FollowDiscoveryEvent['status'];

const POLICY_MODE_ORDER: FollowDiscoveryPolicy['mode'][] = ['live', 'paper', 'record', 'paused'];
const MODE_OPTIONS: Array<{ value: FollowDiscoveryPolicy['mode']; label: string; detail: string }> = [
  { value: 'record', label: '记录', detail: '只分析不交易' },
  { value: 'paper', label: '模拟', detail: '产生模拟信号' },
  { value: 'live', label: '实盘交易', detail: '满足条件后提交交易' },
  { value: 'paused', label: '暂停', detail: '暂不处理新事件' },
];

export default function FollowDiscoveryWorkspacePage() {
  const [searchParams] = useSearchParams();
  const [kols, setKols] = useState<KolAccount[]>([]);
  const [policies, setPolicies] = useState<FollowDiscoveryPolicy[]>([]);
  const [templates, setTemplates] = useState<DynamicPolicyTemplate[]>([]);
  const [events, setEvents] = useState<FollowDiscoveryEvent[]>([]);
  const [selectedPolicyId, setSelectedPolicyId] = useState(searchParams.get('policyId') || '');
  const [draft, setDraft] = useState<Draft>(freshDraft());
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [policyQuery, setPolicyQuery] = useState('');
  const [policyModeFilter, setPolicyModeFilter] = useState<PolicyModeFilter>('all');
  const [activeCategoryKey, setActiveCategoryKey] = useState<KolCategoryKey>('all');
  const [kolQuery, setKolQuery] = useState('');
  const [eventQuery, setEventQuery] = useState('');
  const [eventStatusFilter, setEventStatusFilter] = useState<EventStatusFilter>('all');
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [kolResponse, policyResponse, templateResponse, eventResponse] = await Promise.all([
      api.kol.list(), api.followDiscovery.policies(), api.dynamicSignal.templates.list(),
      api.followDiscovery.events({ limit: '50' }),
    ]);
    if (kolResponse.ok) setKols(kolResponse.data || []);
    if (policyResponse.ok) setPolicies(policyResponse.data || []);
    if (templateResponse.ok) setTemplates(templateResponse.data || []);
    if (eventResponse.ok) setEvents(eventResponse.data || []);
    setRefreshing(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  const selected = useMemo(() => policies.find((item) => item.id === selectedPolicyId) || null, [policies, selectedPolicyId]);
  const selectedTemplate = useMemo(() => templates.find((item) => item.id === draft.trade_template_id) || null, [draft.trade_template_id, templates]);
  const selectedKol = useMemo(() => kols.find((item) => String(item.id) === draft.kol_id) || null, [draft.kol_id, kols]);
  const candidateKols = useMemo(
    () => kols.filter((item) => item.enabled !== false || String(item.id) === draft.kol_id),
    [draft.kol_id, kols],
  );
  const categoryLabels = useMemo(() => {
    const labels = new Map<string, { id: string; name: string; account_count: number }>();
    candidateKols.forEach((account) => (account.custom_labels || []).forEach((label) => {
      const current = labels.get(label.id);
      labels.set(label.id, { id: label.id, name: label.name, account_count: (current?.account_count || 0) + 1 });
    }));
    return [...labels.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [candidateKols]);
  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<KolCategoryKey, number>> = { all: candidateKols.length };
    KOL_ECOSYSTEM_CATEGORIES.forEach((category) => {
      const key = ecosystemCategoryKey(category.value);
      counts[key] = candidateKols.filter((account) => accountMatchesCategory(account, key)).length;
    });
    categoryLabels.forEach((label) => { counts[customCategoryKey(label.id)] = label.account_count; });
    return counts;
  }, [candidateKols, categoryLabels]);
  const visibleKols = useMemo(() => {
    const needle = kolQuery.trim().toLowerCase();
    return candidateKols.filter((account) => {
      const searchable = [account.x_handle, account.display_name, ...(account.chain_ids || []), ...(account.custom_labels || []).map((label) => label.name)]
        .join(' ').toLowerCase();
      return accountMatchesCategory(account, activeCategoryKey) && (!needle || searchable.includes(needle));
    });
  }, [activeCategoryKey, candidateKols, kolQuery]);
  const visiblePolicies = useMemo(() => {
    const needle = policyQuery.trim().toLowerCase();
    return policies.filter((policy) => (
      (!needle || `${policy.x_handle} ${policy.display_name || ''}`.toLowerCase().includes(needle))
      && (policyModeFilter === 'all' || policy.mode === policyModeFilter)
    ));
  }, [policies, policyModeFilter, policyQuery]);

  useEffect(() => {
    if (!selected) return;
    setDraft({ kol_id: String(selected.kol_id), mode: selected.mode, enabled: selected.enabled,
      allowed_chain_ids: [...selected.allowed_chain_ids], trade_template_id: String(selected.trade_template_id || ''),
      resolver_options: { ...selected.resolver_options } });
  }, [selected]);

  useEffect(() => {
    if (activeCategoryKey.startsWith('custom:') && !categoryLabels.some((label) => customCategoryKey(label.id) === activeCategoryKey)) {
      setActiveCategoryKey('all');
    }
  }, [activeCategoryKey, categoryLabels]);

  const newPolicy = () => { setSelectedPolicyId(''); setDraft(freshDraft()); setStep(1); };
  const toggleChain = (chain: ChainId) => setDraft((current) => ({ ...current,
    allowed_chain_ids: current.allowed_chain_ids.includes(chain)
      ? current.allowed_chain_ids.filter((item) => item !== chain) : [...current.allowed_chain_ids, chain] }));

  const goNext = () => {
    if (step === 1 && !draft.kol_id) return toast('请选择监控 KOL', 'error');
    if (step === 1 && selectedKol?.profile_status !== 'verified') return toast('该账号尚未完成 6551 稳定身份核验', 'error');
    if (step === 2 && !draft.allowed_chain_ids.length) return toast('请至少选择一条允许链', 'error');
    if (step === 3 && ['paper', 'live'].includes(draft.mode) && !draft.trade_template_id) return toast('模拟或实盘必须选择交易模板', 'error');
    setStep((value) => Math.min(4, value + 1));
  };

  const save = async () => {
    setSaving(true);
    try {
      const response = selected
        ? await api.followDiscovery.updatePolicy(selected.id, draft)
        : await api.followDiscovery.createPolicy(draft);
      if (!response.ok || !response.data) return toast(response.error || '策略保存失败', 'error');
      setSelectedPolicyId(response.data.id);
      toast(selected ? '策略已热更新' : '策略已保存并建立关注基线', 'success');
      await refresh();
    } finally { setSaving(false); }
  };

  const remove = async () => {
    if (!selected || !confirm('确认停用并归档这条新关注发现策略？历史事件和信号将继续保留。')) return;
    const response = await api.followDiscovery.removePolicy(selected.id);
    if (!response.ok) return toast(response.error || '策略归档失败', 'error');
    newPolicy();
    toast('策略已停用并归档', 'success');
    await refresh();
  };

  const policyEvents = events.filter((item) => {
    const searchable = `${item.actor_handle} ${item.target_handle} ${item.contract_address || ''}`.toLowerCase();
    return (!selected || item.policy_id === selected.id)
      && (eventStatusFilter === 'all' || item.status === eventStatusFilter)
      && (!eventQuery.trim() || searchable.includes(eventQuery.trim().toLowerCase()));
  });
  const summary: WorkspaceSummaryItem[] = [
    { label: '发现策略', value: policies.length, detail: `${policies.filter((item) => item.mode === 'record').length} 条记录策略` },
    { label: '今日事件', value: events.filter((item) => new Date(item.provider_created_at).toDateString() === new Date().toDateString()).length, detail: '新关注审计' },
    { label: '唯一 CA', value: events.filter((item) => item.status === 'resolved').length, detail: '累计通过验证' },
    { label: '实盘策略', value: policies.filter((item) => item.mode === 'live' && item.enabled).length, detail: '仍受全局 Engine 门禁' },
  ];

  return <StrategyWorkspaceLayout eyebrow="新关注发现工作区" title="新关注发现策略"
    description="监控高权重账号的新关注，验证项目身份和唯一可信 CA，再复用现有交易链路。"
    status="Record 默认关闭交易" statusTone="muted" summary={summary} onRefresh={refresh} refreshing={refreshing}>
    <div className="strategy-workspace-panel-note"><UserPlus size={16} /><span>首次保存只建立 Baseline；历史关注不产生 Signal，Record 模式的真实 Swap 调用始终为 0。</span></div>
    <section className="p16-workspace-grid p21-follow-workspace">
      <aside className="p16-step-rail">
        <div className="p40-policy-selector"><div className="p40-policy-selector-head"><strong>关注任务</strong><button type="button" onClick={newPolicy}>新增</button></div>
          <label className="p40-search-field"><Search size={14} /><input value={policyQuery} onChange={(event) => setPolicyQuery(event.target.value)} placeholder="搜索账号或显示名" aria-label="搜索关注任务" /></label>
          <div className="p40-filter-tabs" role="tablist" aria-label="运行阶段筛选">
            <button type="button" className={policyModeFilter === 'all' ? 'active' : ''} onClick={() => setPolicyModeFilter('all')}>全部</button>
            {POLICY_MODE_ORDER.map((mode) => <button type="button" key={mode} className={policyModeFilter === mode ? 'active' : ''} onClick={() => setPolicyModeFilter(mode)}>{modeLabel(mode)}</button>)}
          </div>
          {POLICY_MODE_ORDER.map((mode) => {
            const group = visiblePolicies.filter((policy) => policy.mode === mode);
            if (!group.length) return null;
            return <div key={mode} className="p40-policy-group"><span>{modeLabel(mode)}</span>{group.map((policy) => <button type="button" key={policy.id} className={selectedPolicyId === policy.id ? 'selected' : ''} onClick={() => { setSelectedPolicyId(policy.id); setStep(1); }}><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><span>{policy.display_name || '未设置显示名'} · Revision {policy.revision}</span><i className={policy.watch_sync_status === 'succeeded' ? 'synced' : ''}>{policy.watch_sync_status === 'succeeded' ? 'Watch 正常' : 'Watch 待同步'}</i></button>)}</div>;
          })}
          {!visiblePolicies.length && <div className="p16-empty-line">没有匹配的关注任务</div>}
        </div>
        {STEPS.map(([title, detail], index) => <button type="button" key={title} className={`p16-step-button ${step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}`} onClick={() => setStep(index + 1)}><span>{step > index + 1 ? <Check size={14} /> : index + 1}</span><div><strong>{title}</strong><small>{detail}</small></div></button>)}
      </aside>
      <main className="p16-step-content">
        {step === 1 && <><div className="p16-step-title"><div><span>步骤 1 / 4</span><h3>选择监控账号和运行阶段</h3></div><em className={draft.kol_id ? 'ready' : ''}>{draft.kol_id ? '账号已选择' : '等待账号'}</em></div>
          <div className="p40-follow-form-grid"><div><span className="p40-field-label">监控 KOL</span>{selected ? <div className="p40-current-account"><strong>@{selectedKol?.x_handle.replace(/^@+/, '') || selected.x_handle.replace(/^@+/, '')}</strong><span>{selectedKol?.display_name || selected.display_name || '未设置显示名'} · 编辑已有策略时账号不可更换</span></div> : <><KolCategoryBar value={activeCategoryKey} labels={categoryLabels} counts={categoryCounts} onChange={setActiveCategoryKey} variant="picker" preserveFocus /><label className="p40-search-field p40-account-search"><Search size={14} /><input value={kolQuery} onChange={(event) => setKolQuery(event.target.value)} placeholder="搜索 Handle、名称或标签" aria-label="搜索监控 KOL" /></label><div className="p40-kol-results">{visibleKols.map((kol) => <button type="button" key={kol.id} className={String(kol.id) === draft.kol_id ? 'selected' : ''} onClick={() => setDraft((current) => ({ ...current, kol_id: String(kol.id) }))}><span className="p40-kol-avatar">{kol.x_handle.replace(/^@+/, '').slice(0, 1).toUpperCase()}</span><span><strong>@{kol.x_handle.replace(/^@+/, '')}</strong><small>{kol.display_name} · {kol.chain_ids?.length ? kol.chain_ids.join(' / ').toUpperCase() : '未分类'}</small></span><span className="p40-kol-tags">{(kol.custom_labels || []).slice(0, 2).map((label) => <i key={label.id}>{label.name}</i>)}</span><span className={kol.profile_status === 'verified' ? 'p40-kol-verified' : 'p40-kol-pending'}>{kol.profile_status === 'verified' ? <><BadgeCheck size={13} />6551 已核验</> : <><Clock3 size={13} />待核验</>}</span></button>)}{!visibleKols.length && <div className="p16-empty-line">当前分类没有匹配的启用 KOL</div>}</div><div className="p40-selection-feedback">{selectedKol ? <><Check size={14} />已选择 @{selectedKol.x_handle.replace(/^@+/, '')}</> : '请选择一个监控账号'}</div></>}</div><div><span className="p40-field-label">运行阶段</span><div className="p40-mode-grid">{MODE_OPTIONS.map((option) => <button type="button" key={option.value} className={draft.mode === option.value ? 'selected' : ''} onClick={() => setDraft((current) => ({ ...current, mode: option.value }))}><strong>{option.label}</strong><small>{option.detail}</small></button>)}</div></div></div>
          <div className="p20-choice-row"><span>状态</span><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用该策略</label></div>
          <div className="p20-resolver-note"><strong>Follow 方向</strong><span>仅处理该 KOL 主动新关注的 Target。Actor 和 Target 必须同时拥有稳定 X User ID，同一行为永久去重。</span></div></>}
        {step === 2 && <><div className="p16-step-title"><div><span>步骤 2 / 4</span><h3>设置项目身份与唯一 CA 标准</h3></div><em>{draft.allowed_chain_ids.length} 条允许链</em></div>
          <div className="p20-choice-row"><span>允许链</span>{CHAINS.map((chain) => <label key={chain.id}><input type="checkbox" checked={draft.allowed_chain_ids.includes(chain.id)} onChange={() => toggleChain(chain.id)} />{chain.label}</label>)}</div>
          <div className="p20-number-grid"><label><span>事件有效期（秒）</span><input type="number" min="60" max="86400" value={draft.resolver_options.event_ttl_seconds} onChange={(event) => setDraft({ ...draft, resolver_options: { ...draft.resolver_options, event_ttl_seconds: Number(event.target.value) } })} /></label><label><span>近期原创样本</span><input type="number" min="1" max="100" value={draft.resolver_options.max_tweets} onChange={(event) => setDraft({ ...draft, resolver_options: { ...draft.resolver_options, max_tweets: Number(event.target.value) } })} /></label><label><span>账号最低年龄（天）</span><input type="number" min="0" max="3650" value={draft.resolver_options.minimum_account_age_days} onChange={(event) => setDraft({ ...draft, resolver_options: { ...draft.resolver_options, minimum_account_age_days: Number(event.target.value) } })} /></label></div>
          <div className="p20-choice-row"><span>官方来源</span><label><input type="checkbox" checked={draft.resolver_options.require_original_content} onChange={(event) => setDraft({ ...draft, resolver_options: { ...draft.resolver_options, require_original_content: event.target.checked } })} />要求近期原创内容</label><label><input type="checkbox" checked={draft.resolver_options.include_profile_website} onChange={(event) => setDraft({ ...draft, resolver_options: { ...draft.resolver_options, include_profile_website: event.target.checked } })} />检查 Profile 直连官网</label></div>
          <div className="p20-resolver-note"><strong>唯一 CA</strong><span>项目账号可从自己的 Bio、置顶原创、近期原创或 Profile 直连官网提供完整 CA；如果 Target 是创始人、CEO 或核心成员，则必须先发现与项目官方账号的双向关系，再从该官方账号取 CA。Grok 只辅助身份分类，不能授权 CA；GMGN 必须回显同一地址，多候选或证据冲突直接拒绝。</span></div>
          {draft.mode === 'live' && draft.allowed_chain_ids.length > 1 && <div className="p20-live-notice"><ShieldAlert size={15} /><span>当前选择了多条链。每个候选 CA 会按允许链逐条进行 GMGN 验证，请求量会按链数增加；本次实盘验证建议只保留目标链。</span></div>}</>}
        {step === 3 && <><div className="p16-step-title"><div><span>步骤 3 / 4</span><h3>复用现有交易配置模板</h3></div><em>{selectedTemplate ? `模板 v${selectedTemplate.version}` : '未选择模板'}</em></div>
          <div className="p20-form-row"><label><span>交易模板</span><select value={draft.trade_template_id} onChange={(event) => setDraft({ ...draft, trade_template_id: event.target.value })}><option value="">{draft.mode === 'record' ? 'Record 可不选择模板' : '选择交易模板'}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name} · v{template.version}</option>)}</select></label></div>
          {selectedTemplate ? <div className="p21-template-summary"><div><span>逐链金额</span><strong>{draft.allowed_chain_ids.map((chainId) => { const chain = CHAINS.find((item) => item.id === chainId)!; const budget = selectedTemplate.config.chain_budgets?.[chainId]; return `${chain.label} ${budget?.budget_per_trade || 0}/${budget?.daily_budget || 0} ${chain.unit}`; }).join(' · ')}</strong></div><div><span>次数与滑点</span><strong>每日新币 {selectedTemplate.config.daily_new_token_limit || '不限制'} · 单币累计 {selectedTemplate.config.per_token_buy_limit} · 滑点 {selectedTemplate.config.slippage}%</strong></div><div><span>离场策略</span><strong>{strategySummary(selectedTemplate.config.exit_strategy)}</strong></div></div> : <div className="p16-empty-line">选择现有模板后显示逐链金额、预算、重复买入和离场配置；关注策略不新增另一套交易字段。</div>}
          {draft.mode === 'live' && <div className="p20-live-notice"><ShieldAlert size={15} /><span>保存不会启动 Engine。只有能力开关、Watch、白名单激活、链生产授权和全局 Engine 均有效时，Signal 才能提交。</span></div>}</>}
        {step === 4 && <><div className="p16-step-title"><div><span>步骤 4 / 4</span><h3>确认并保存策略</h3></div><em className="ready">可以保存</em></div>
          <div className="p16-review-list"><div><span>监控账号</span><strong>{selectedKol ? `@${selectedKol.x_handle.replace(/^@+/, '')}` : '--'}</strong></div><div><span>运行阶段</span><strong>{modeLabel(draft.mode)}</strong></div><div><span>允许链</span><strong>{draft.allowed_chain_ids.map((id) => CHAINS.find((item) => item.id === id)?.label).join(' · ')}</strong></div><div><span>交易模板</span><strong>{selectedTemplate ? `${selectedTemplate.name} · v${selectedTemplate.version}` : 'Record 不配置交易模板'}</strong></div><div><span>Baseline</span><strong>{selected ? new Date(selected.baseline_at).toLocaleString('zh-CN') : '首次保存时建立，不扫描历史关注'}</strong></div><div><span>Revision</span><strong>{selected ? `保存变更后 ${selected.revision + 1}` : '创建 Revision 1'}</strong></div></div>
          <div className="p16-save-note">策略保存采用热更新并同步 Follow Watch，不会自动启动 Engine。Record 不创建交易 Signal；旧 Revision 的排队事件会自动取消。</div></>}
        <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? newPolicy() : setStep(step - 1)}>{step === 1 ? '重置草稿' : '上一步'}</button>{step < 4 ? <button type="button" className="btn btn-primary" onClick={goNext}>下一步<ArrowRight size={16} /></button> : <div>{selected && <button type="button" className="p16-icon-button danger" title="停用并归档策略" aria-label="停用并归档策略" onClick={remove}><Trash2 size={15} /></button>}<button type="button" className="btn btn-primary" disabled={saving} onClick={save}><Save size={15} />{saving ? '保存中' : '保存策略'}</button></div>}</div>
      </main>
    </section>
    <section className="p20-runtime-grid p21-follow-events"><section><div className="p20-section-title"><div><strong>最近发现记录</strong><small>只展示中文主文案，原始错误码保留在日志和诊断记录</small></div><span>{policyEvents.length} 条</span></div><div className="p40-event-toolbar"><label className="p40-search-field"><Search size={14} /><input value={eventQuery} onChange={(event) => setEventQuery(event.target.value)} placeholder="搜索目标账号或 CA" aria-label="搜索发现记录" /></label><div className="p40-filter-tabs" role="tablist" aria-label="发现记录状态筛选"><button type="button" className={eventStatusFilter === 'all' ? 'active' : ''} onClick={() => setEventStatusFilter('all')}>全部</button>{(['processing', 'resolved', 'rejected', 'failed'] as FollowDiscoveryEvent['status'][]).map((status) => <button type="button" key={status} className={eventStatusFilter === status ? 'active' : ''} onClick={() => setEventStatusFilter(status)}>{eventStatusLabel(status)}</button>)}</div></div><div className="p20-audit-list">{policyEvents.slice(0, 20).map((event) => <div key={event.id}><span><strong>@{event.target_handle}</strong><small>{event.chain_id?.toUpperCase() || '--'} · {event.contract_address || '尚未确定 CA'}</small><small>{eventMainMessage(event)}</small></span><i className={event.status === 'resolved' ? 'active' : event.status === 'rejected' || event.status === 'failed' ? 'danger' : ''}>{eventStatusLabel(event.status)}</i></div>)}{!policyEvents.length && <div className="p16-empty-line">暂无匹配的发现记录</div>}</div></section><section><div className="p20-section-title"><div><strong>安全边界</strong><small>观察问题只提示，不修改其他策略状态</small></div><span>失败关闭</span></div><div className="p20-authorization-note"><Info size={15} /><span>回复区、转发引用、名称或 Symbol 猜测、多候选、RPC 链不唯一和缺少稳定 User ID 均不会进入交易。健康异常不会自动暂停全局 Engine。</span></div></section></section>
  </StrategyWorkspaceLayout>;
}
