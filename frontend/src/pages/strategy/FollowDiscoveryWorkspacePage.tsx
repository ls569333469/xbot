import { ArrowRight, Check, Save, ShieldAlert, Trash2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type { ChainId, DynamicPolicyTemplate, FollowDiscoveryEvent, FollowDiscoveryPolicy, KolAccount } from '../../lib/types';
import { strategySummary } from '../whitelist/strategy-presets';
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
  const labels: Record<string, string> = { baseline: '基线', pending: '等待', processing: '分析中', resolved: '已解析', rejected: '已拒绝', failed: '失败', cancelled: '已取消' };
  return labels[value] || value;
}

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

  useEffect(() => {
    if (!selected) return;
    setDraft({ kol_id: String(selected.kol_id), mode: selected.mode, enabled: selected.enabled,
      allowed_chain_ids: [...selected.allowed_chain_ids], trade_template_id: String(selected.trade_template_id || ''),
      resolver_options: { ...selected.resolver_options } });
  }, [selected]);

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

  const policyEvents = events.filter((item) => !selected || item.policy_id === selected.id);
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
        <div className="p21-policy-selector"><div><strong>发现策略</strong><button type="button" onClick={newPolicy}>新增</button></div>
          {policies.map((policy) => <button type="button" key={policy.id} className={selectedPolicyId === policy.id ? 'selected' : ''} onClick={() => { setSelectedPolicyId(policy.id); setStep(1); }}><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><span>{modeLabel(policy.mode)} · Revision {policy.revision}</span></button>)}</div>
        {STEPS.map(([title, detail], index) => <button type="button" key={title} className={`p16-step-button ${step === index + 1 ? 'active' : step > index + 1 ? 'complete' : ''}`} onClick={() => setStep(index + 1)}><span>{step > index + 1 ? <Check size={14} /> : index + 1}</span><div><strong>{title}</strong><small>{detail}</small></div></button>)}
      </aside>
      <main className="p16-step-content">
        {step === 1 && <><div className="p16-step-title"><div><span>步骤 1 / 4</span><h3>选择监控账号和运行阶段</h3></div><em className={draft.kol_id ? 'ready' : ''}>{draft.kol_id ? '账号已选择' : '等待账号'}</em></div>
          <div className="p20-form-row"><label><span>高权重 KOL</span><select value={draft.kol_id} disabled={Boolean(selected)} onChange={(event) => setDraft({ ...draft, kol_id: event.target.value })}><option value="">选择 KOL</option>{kols.map((kol) => <option key={kol.id} value={kol.id}>@{kol.x_handle.replace(/^@+/, '')}{kol.profile_status === 'verified' ? '' : '（身份待核验）'}</option>)}</select></label><label><span>运行阶段</span><select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Draft['mode'] })}><option value="record">记录：只分析不交易</option><option value="paper">模拟：产生模拟信号</option><option value="live">实盘：进入 P19</option><option value="paused">暂停</option></select></label></div>
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
          {selectedTemplate ? <div className="p21-template-summary"><div><span>逐链金额</span><strong>{draft.allowed_chain_ids.map((chainId) => { const chain = CHAINS.find((item) => item.id === chainId)!; const budget = selectedTemplate.config.chain_budgets?.[chainId]; return `${chain.label} ${budget?.budget_per_trade || 0}/${budget?.daily_budget || 0} ${chain.unit}`; }).join(' · ')}</strong></div><div><span>次数与滑点</span><strong>每日新币 {selectedTemplate.config.daily_new_token_limit || '不限制'} · 单币累计 {selectedTemplate.config.per_token_buy_limit} · 滑点 {selectedTemplate.config.slippage}%</strong></div><div><span>离场策略</span><strong>{strategySummary(selectedTemplate.config.exit_strategy)}</strong></div></div> : <div className="p16-empty-line">选择现有模板后显示逐链金额、预算、重复买入和离场配置；P21 不新增另一套交易字段。</div>}
          {draft.mode === 'live' && <div className="p20-live-notice"><ShieldAlert size={15} /><span>保存不会启动 Engine。只有 P21 能力开关、Watch、Whitelist Activation、链生产授权和全局 Engine 均有效时，Signal 才能提交。</span></div>}</>}
        {step === 4 && <><div className="p16-step-title"><div><span>步骤 4 / 4</span><h3>确认并保存策略</h3></div><em className="ready">可以保存</em></div>
          <div className="p16-review-list"><div><span>监控账号</span><strong>{selectedKol ? `@${selectedKol.x_handle.replace(/^@+/, '')}` : '--'}</strong></div><div><span>运行阶段</span><strong>{modeLabel(draft.mode)}</strong></div><div><span>允许链</span><strong>{draft.allowed_chain_ids.map((id) => CHAINS.find((item) => item.id === id)?.label).join(' · ')}</strong></div><div><span>交易模板</span><strong>{selectedTemplate ? `${selectedTemplate.name} · v${selectedTemplate.version}` : 'Record 不配置交易模板'}</strong></div><div><span>Baseline</span><strong>{selected ? new Date(selected.baseline_at).toLocaleString('zh-CN') : '首次保存时建立，不扫描历史关注'}</strong></div><div><span>Revision</span><strong>{selected ? `保存变更后 ${selected.revision + 1}` : '创建 Revision 1'}</strong></div></div>
          <div className="p16-save-note">策略保存采用热更新并同步 Follow Watch，不会自动启动 Engine。Record 不创建交易 Signal；旧 Revision 的排队事件会自动取消。</div></>}
        <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? newPolicy() : setStep(step - 1)}>{step === 1 ? '重置草稿' : '上一步'}</button>{step < 4 ? <button type="button" className="btn btn-primary" onClick={goNext}>下一步<ArrowRight size={16} /></button> : <div>{selected && <button type="button" className="p16-icon-button danger" title="停用并归档策略" aria-label="停用并归档策略" onClick={remove}><Trash2 size={15} /></button>}<button type="button" className="btn btn-primary" disabled={saving} onClick={save}><Save size={15} />{saving ? '保存中' : '保存策略'}</button></div>}</div>
      </main>
    </section>
    <section className="p20-runtime-grid p21-follow-events"><section><div className="p20-section-title"><strong>最近发现记录</strong><span>{policyEvents.length} 条</span></div><div className="p20-audit-list">{policyEvents.slice(0, 20).map((event) => <div key={event.id}><span><strong>@{event.target_handle}</strong><small>{event.chain_id?.toUpperCase() || '--'} · {event.failure_code || event.contract_address || event.stage}</small></span><i className={event.status === 'resolved' ? 'active' : ''}>{eventStatusLabel(event.status)}</i></div>)}{!policyEvents.length && <div className="p16-empty-line">暂无新关注发现记录</div>}</div></section><section><div className="p20-section-title"><strong>安全边界</strong><span>失败关闭</span></div><div className="p20-authorization-note"><ShieldAlert size={15} /><span>回复区、转发引用、名称或 Symbol 猜测、多候选、RPC 链不唯一和缺少稳定 User ID 均不会进入交易。</span></div></section></section>
  </StrategyWorkspaceLayout>;
}
