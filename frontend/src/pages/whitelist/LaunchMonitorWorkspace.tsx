import { ArrowLeft, ArrowRight, Check, Plus, Save, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import { eventTypeLabel } from '../../lib/display-labels';
import type {
  ActivityType,
  ChainId,
  KolAccount,
  LaunchMonitor,
  LaunchMonitorRelation,
  LaunchMonitorSource,
  WhitelistTemplate,
} from '../../lib/types';
import StrategyEditor from './StrategyEditor';
import { cloneStrategy, STRATEGY_PRESETS, strategySummary } from './strategy-presets';

const CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const NATIVE_SYMBOLS: Record<ChainId, string> = {
  sol: 'SOL', bsc: 'BNB', base: 'ETH', eth: 'ETH', robinhood: 'ETH',
};
const SOURCE_EVENTS: Array<Exclude<ActivityType, 'follow' | 'unfollow'>> = ['tweet', 'retweet', 'quote', 'reply'];
const RELATION_EVENTS: Array<Extract<ActivityType, 'retweet' | 'quote' | 'reply'>> = ['retweet', 'quote', 'reply'];

function normalizeHandle(value: string) {
  return value.trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^@+/, '')
    .toLowerCase();
}

function validHandle(value: string) {
  return /^[a-z0-9_]{1,15}$/.test(value);
}

function toggleEvent<T extends string>(current: T[], event: T, allowed: T[]) {
  const safeCurrent = Array.isArray(current) ? current : [];
  return safeCurrent.includes(event)
    ? safeCurrent.length === 1 ? safeCurrent : safeCurrent.filter((item) => item !== event)
    : allowed.filter((item) => [...safeCurrent, event].includes(item));
}

interface FormState {
  chain_id: ChainId;
  project_name: string;
  sources: LaunchMonitorSource[];
  relations: LaunchMonitorRelation[];
  budget_per_trade: string;
  total_budget: string;
  slippage: string;
  allow_repeat_buy: boolean;
  max_repeat_buys: string;
  exit_strategy: LaunchMonitor['exit_strategy'];
}

function emptyForm(item?: LaunchMonitor | null): FormState {
  return {
    chain_id: item?.chain_id || 'sol',
    project_name: item?.project_name || '',
    sources: (item?.sources || []).map((source) => ({
      ...source,
      event_types: Array.isArray(source.event_types) && source.event_types.length
        ? source.event_types
        : ['tweet'],
    })),
    relations: (item?.relations || []).map((relation) => ({
      ...relation,
      event_types: Array.isArray(relation.event_types) && relation.event_types.length
        ? relation.event_types
        : ['retweet', 'quote', 'reply'],
    })),
    budget_per_trade: item?.budget_per_trade == null ? '' : String(item.budget_per_trade),
    total_budget: item?.total_budget == null ? '' : String(item.total_budget),
    slippage: item?.slippage == null ? '10' : String(item.slippage),
    allow_repeat_buy: Boolean(item?.allow_repeat_buy),
    max_repeat_buys: item?.max_repeat_buys == null ? '1' : String(item.max_repeat_buys),
    exit_strategy: item?.exit_strategy || cloneStrategy(STRATEGY_PRESETS[0].value),
  };
}

interface Props {
  editing?: LaunchMonitor | null;
  templates: WhitelistTemplate[];
  kolAccounts: KolAccount[];
  onCancel: () => void;
  onSaved: () => void;
}

export default function LaunchMonitorWorkspace({
  editing,
  templates,
  kolAccounts,
  onCancel,
  onSaved,
}: Props) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<FormState>(() => emptyForm(editing));
  const [sourceInput, setSourceInput] = useState('');
  const [sourceRole, setSourceRole] = useState('project');
  const [actorInput, setActorInput] = useState('');
  const [targetInput, setTargetInput] = useState('');
  const [sourceEvents, setSourceEvents] = useState<LaunchMonitorSource['event_types']>(['tweet']);
  const [relationEvents, setRelationEvents] = useState<LaunchMonitorRelation['event_types']>(['retweet', 'quote', 'reply']);
  const [saving, setSaving] = useState(false);
  const [watchImpact, setWatchImpact] = useState<{ unique_handles: number; reused_watches: number; new_watches: number } | null>(null);
  const { toast } = useToast();

  const nativeSymbol = NATIVE_SYMBOLS[form.chain_id];
  const chainTemplates = templates.filter((item) => item.chain_id === form.chain_id);
  const defaultTemplate = chainTemplates.find((item) => item.is_default);
  const projectHandles = useMemo(() => form.sources.map((item) => item.actor_handle), [form.sources]);

  useEffect(() => {
    if (editing || !defaultTemplate || form.budget_per_trade) return;
    const snapshot = defaultTemplate.template_snapshot;
    setForm((current) => ({
      ...current,
      budget_per_trade: String(snapshot.budget_per_trade),
      total_budget: String(snapshot.total_budget),
      slippage: String(snapshot.slippage),
      allow_repeat_buy: snapshot.allow_repeat_buy,
      max_repeat_buys: String(snapshot.max_repeat_buys),
      exit_strategy: cloneStrategy(snapshot.exit_strategy),
    }));
  }, [defaultTemplate, editing, form.budget_per_trade]);

  useEffect(() => {
    if (step !== 3) return;
    void api.launchMonitors.watchImpact({
      sources: form.sources,
      relations: form.relations,
    }).then((response) => setWatchImpact(response.ok && response.data ? response.data : null));
  }, [form.relations, form.sources, step]);

  const addSource = () => {
    const handle = normalizeHandle(sourceInput);
    if (!validHandle(handle)) return toast('请填写有效的项目 X 账号', 'error');
    const next = new Map(form.sources.map((item) => [item.actor_handle, item]));
    next.set(handle, {
      actor_handle: handle,
      role: sourceRole.trim() || 'project',
      event_types: [...sourceEvents],
    });
    setForm((current) => ({ ...current, sources: [...next.values()] }));
    setSourceInput('');
  };

  const removeSource = (handle: string) => {
    setForm((current) => ({
      ...current,
      sources: current.sources.filter((item) => item.actor_handle !== handle),
      relations: current.relations.filter((item) => item.target_x_handle !== handle),
    }));
  };

  const updateSourceEvent = (
    source: LaunchMonitorSource,
    event: LaunchMonitorSource['event_types'][number],
  ) => {
    setForm((current) => ({
      ...current,
      sources: current.sources.map((item) => item.actor_handle === source.actor_handle
        ? { ...item, event_types: toggleEvent(item.event_types, event, SOURCE_EVENTS) }
        : item),
    }));
  };

  const addRelation = () => {
    const actor = normalizeHandle(actorInput);
    const target = normalizeHandle(targetInput);
    if (!validHandle(actor) || !validHandle(target)) return toast('请填写有效的生态账号和项目账号', 'error');
    if (!projectHandles.includes(target)) return toast('互动目标必须先添加为项目账号', 'error');
    if (actor === target) return toast('生态账号和项目账号不能相同', 'error');
    const next = new Map(form.relations.map((item) => [`${item.actor_handle}:${item.target_x_handle}`, item]));
    next.set(`${actor}:${target}`, {
      actor_handle: actor,
      target_x_handle: target,
      event_types: [...relationEvents],
    });
    setForm((current) => ({ ...current, relations: [...next.values()] }));
    setActorInput('');
    setTargetInput('');
  };

  const updateRelationEvent = (
    relation: LaunchMonitorRelation,
    event: LaunchMonitorRelation['event_types'][number],
  ) => {
    setForm((current) => ({
      ...current,
      relations: current.relations.map((item) => (
        item.actor_handle === relation.actor_handle
          && item.target_x_handle === relation.target_x_handle
          ? { ...item, event_types: toggleEvent(item.event_types, event, RELATION_EVENTS) }
          : item
      )),
    }));
  };

  const applyTemplate = (id: string) => {
    const template = chainTemplates.find((item) => item.id === id);
    if (!template) return;
    const snapshot = template.template_snapshot;
    setForm((current) => ({
      ...current,
      budget_per_trade: String(snapshot.budget_per_trade),
      total_budget: String(snapshot.total_budget),
      slippage: String(snapshot.slippage),
      allow_repeat_buy: snapshot.allow_repeat_buy,
      max_repeat_buys: String(snapshot.max_repeat_buys),
      exit_strategy: cloneStrategy(snapshot.exit_strategy),
    }));
  };

  const validation = (target: number) => {
    if (target > 1 && form.sources.length === 0) return '请至少添加一个项目账号';
    if (target > 2) {
      const amount = Number(form.budget_per_trade);
      const total = Number(form.total_budget);
      if (!(amount > 0) || !(total >= amount)) return '请检查单笔金额与累计预算';
      if (!form.exit_strategy.legs.length || form.exit_strategy.legs.length > 10) return '离场策略需要 1 至 10 条条件';
    }
    return null;
  };

  const goToStep = (target: number) => {
    const error = target > step ? validation(target) : null;
    if (error) return toast(error, 'error');
    setStep(Math.max(1, Math.min(3, target)));
  };

  const save = async () => {
    const error = validation(3);
    if (error) return toast(error, 'error');
    setSaving(true);
    const payload = {
      ...form,
      budget_per_trade: Number(form.budget_per_trade),
      total_budget: Number(form.total_budget),
      slippage: Number(form.slippage),
      max_repeat_buys: form.allow_repeat_buy ? Number(form.max_repeat_buys) : 1,
    };
    const response = editing
      ? await api.launchMonitors.update(editing.id, payload)
      : await api.launchMonitors.create(payload);
    setSaving(false);
    if (!response.ok) return toast(response.error || '未发币监控保存失败', 'error');
    toast(editing ? '未发币监控已更新' : '未发币监控已启动', 'success');
    onSaved();
  };

  const steps = [
    ['项目与账号', '链、项目来源、生态互动'],
    ['资金与离场', '模板、金额、策略'],
    ['确认启动', 'Watch 影响、提交'],
  ];

  return (
    <div className="p16-workspace p161-launch-workspace">
      <div className="p16-workspace-head">
        <div><button type="button" className="p16-back-link" onClick={onCancel}><ArrowLeft size={16} />返回未发币监控</button><h2>{editing ? '编辑未发币监控' : '新增未发币监控'}</h2></div>
        <span className="p161-discovery-badge">等待首个唯一 CA</span>
      </div>
      <div className="p16-workspace-grid">
        <nav className="p16-step-rail" aria-label="未发币监控步骤">
          {steps.map(([title, detail], index) => {
            const number = index + 1;
            return <button type="button" key={title} className={`p16-step-button ${step === number ? 'active' : ''} ${step > number ? 'complete' : ''}`} onClick={() => goToStep(number)}><span>{step > number ? <Check size={14} /> : number}</span><div><strong>{title}</strong><small>{detail}</small></div></button>;
          })}
        </nav>
        <main className="p16-step-main">
          <div className="p16-step-content">
            {step === 1 && <>
              <div className="p16-step-title"><div><span>步骤 1 / 3</span><h3>监控谁发布新 CA</h3></div><em>{form.sources.length} 个项目账号</em></div>
              <div className="p16-form-grid token">
                <label><span>链</span><select className="input" value={form.chain_id} disabled={Boolean(editing)} onChange={(event) => setForm((current) => ({ ...current, chain_id: event.target.value as ChainId, budget_per_trade: '', total_budget: '' }))}>{CHAINS.map((chain) => <option value={chain} key={chain}>{chain.toUpperCase()}</option>)}</select></label>
                <label className="wide"><span>项目名称</span><input className="input" value={form.project_name} onChange={(event) => setForm((current) => ({ ...current, project_name: event.target.value }))} placeholder="可选，用于发现后的白名单名称" /></label>
              </div>
              <section className="p16-inline-section p16-rule-domain project">
                <div className="p16-domain-label"><span>A</span><div><strong>项目首发来源</strong><small>事件必须出现唯一完整 CA</small></div></div>
                <div className="p16-rule-builder launch-source">
                  <label><span>项目账号</span><input className="input" value={sourceInput} onChange={(event) => setSourceInput(event.target.value)} placeholder="@project" /></label>
                  <label><span>身份</span><select className="input" value={sourceRole} onChange={(event) => setSourceRole(event.target.value)}><option value="project">官方</option><option value="founder">Founder</option><option value="ceo">CEO</option><option value="core_team">核心团队</option></select></label>
                  <button type="button" className="btn btn-secondary" onClick={addSource}><Plus size={16} />添加</button>
                </div>
                <div className="p16-event-options" aria-label="新项目来源默认事件">{SOURCE_EVENTS.map((event) => <label key={event}><input type="checkbox" checked={sourceEvents.includes(event)} onChange={() => setSourceEvents(toggleEvent(sourceEvents, event, SOURCE_EVENTS))} />{eventTypeLabel(event)}</label>)}</div>
                <div className="p16-rule-list">{form.sources.map((source) => <div className="p16-rule-row" key={source.actor_handle}><strong>@{source.actor_handle}</strong><span>{source.role}</span><div className="p16-rule-event-editor">{SOURCE_EVENTS.map((event) => <label key={event}><input type="checkbox" checked={source.event_types?.includes(event) || false} onChange={() => updateSourceEvent(source, event)} />{eventTypeLabel(event)}</label>)}</div><button type="button" className="p16-icon-button" title="移除项目账号" aria-label="移除项目账号" onClick={() => removeSource(source.actor_handle)}><Trash2 size={16} /></button></div>)}{form.sources.length === 0 && <div className="p16-empty-line">至少添加一个项目官方或核心团队账号</div>}</div>
              </section>
              <section className="p16-inline-section p16-rule-domain ecosystem">
                <div className="p16-domain-label"><span>B</span><div><strong>可选生态互动</strong><small>互动本身也必须带出唯一 CA</small></div></div>
                <div className="p16-rule-builder interaction">
                  <label><span>生态账号</span><input className="input" list="p161-kol-options" value={actorInput} onChange={(event) => setActorInput(event.target.value)} placeholder="@ecosystem_actor" /></label><ArrowRight size={17} aria-hidden="true" /><label><span>项目账号</span><select className="input" value={targetInput} onChange={(event) => setTargetInput(event.target.value)}><option value="">选择项目账号</option>{projectHandles.map((handle) => <option value={`@${handle}`} key={handle}>@{handle}</option>)}</select></label><button type="button" className="btn btn-secondary" onClick={addRelation}><Plus size={16} />添加</button>
                  <datalist id="p161-kol-options">{kolAccounts.map((item) => <option value={`@${normalizeHandle(item.x_handle)}`} key={item.id} />)}</datalist>
                </div>
                <div className="p16-event-options">{RELATION_EVENTS.map((event) => <label key={event}><input type="checkbox" checked={relationEvents.includes(event)} onChange={() => setRelationEvents(toggleEvent(relationEvents, event, RELATION_EVENTS))} />{eventTypeLabel(event)}</label>)}</div>
                <div className="p16-rule-list">{form.relations.map((relation) => <div className="p16-rule-row relation" key={`${relation.actor_handle}:${relation.target_x_handle}`}><strong>@{relation.actor_handle} <ArrowRight size={13} /> @{relation.target_x_handle}</strong><div className="p16-rule-event-editor">{RELATION_EVENTS.map((event) => <label key={event}><input type="checkbox" checked={relation.event_types?.includes(event) || false} onChange={() => updateRelationEvent(relation, event)} />{eventTypeLabel(event)}</label>)}</div><button type="button" className="p16-icon-button" title="移除生态互动" aria-label="移除生态互动" onClick={() => setForm((current) => ({ ...current, relations: current.relations.filter((item) => item !== relation) }))}><Trash2 size={16} /></button></div>)}{form.relations.length === 0 && <div className="p16-empty-line">可留空；项目账号发布 CA 仍可直接触发</div>}</div>
              </section>
            </>}

            {step === 2 && <>
              <div className="p16-step-title"><div><span>步骤 2 / 3</span><h3>设置发现后的交易配置</h3></div></div>
              <label className="p161-template-select"><span>常用模板</span><select className="input" defaultValue="" onChange={(event) => applyTemplate(event.target.value)}><option value="">选择 {form.chain_id.toUpperCase()} 模板</option>{chainTemplates.map((item) => <option value={item.id} key={item.id}>{item.name}{item.is_default ? '（默认）' : ''}</option>)}</select></label>
              <div className="p16-form-grid money"><label><span>单笔金额 ({nativeSymbol})</span><input className="input" type="number" min="0.000001" value={form.budget_per_trade} onChange={(event) => setForm((current) => ({ ...current, budget_per_trade: event.target.value }))} /></label><label><span>该 CA 累计上限 ({nativeSymbol})</span><input className="input" type="number" min="0.000001" value={form.total_budget} onChange={(event) => setForm((current) => ({ ...current, total_budget: event.target.value }))} /></label><label><span>滑点 %</span><input className="input" type="number" min="0.01" max="100" value={form.slippage} onChange={(event) => setForm((current) => ({ ...current, slippage: event.target.value }))} /></label><label className="p16-repeat-field"><span>发现后重复买入</span><div><label><input type="checkbox" checked={form.allow_repeat_buy} onChange={(event) => setForm((current) => ({ ...current, allow_repeat_buy: event.target.checked, max_repeat_buys: event.target.checked ? current.max_repeat_buys : '1' }))} />允许后续生态互动继续买入</label><input className="input" type="number" min="1" disabled={!form.allow_repeat_buy} value={form.max_repeat_buys} onChange={(event) => setForm((current) => ({ ...current, max_repeat_buys: event.target.value }))} /></div></label></div>
              <section className="p16-inline-section"><div className="p16-section-heading"><div><h3>离场策略</h3><p>发现 CA 后固化到具体白名单快照。</p></div></div><StrategyEditor value={form.exit_strategy} onChange={(exit_strategy) => setForm((current) => ({ ...current, exit_strategy }))} /></section>
            </>}

            {step === 3 && <>
              <div className="p16-step-title"><div><span>步骤 3 / 3</span><h3>确认并启动监控</h3></div><em className="ready">发现后自动暂停</em></div>
              <div className="p16-review-list"><div><span>监控对象</span><strong>{form.chain_id.toUpperCase()} · {form.project_name || '未命名项目'}</strong></div><div><span>项目来源</span><strong>{form.sources.map((item) => `@${item.actor_handle}`).join('、')}</strong></div><div><span>生态互动</span><strong>{form.relations.length} 条，可选</strong></div><div><span>发现规则</span><strong>事件必须只有一个有效 CA；首个 CA 后暂停</strong></div><div><span>资金</span><strong>{form.budget_per_trade} {nativeSymbol} / 累计 {form.total_budget} {nativeSymbol}</strong></div><div><span>离场</span><strong>{strategySummary(form.exit_strategy)}</strong></div><div><span>6551 Watch</span><strong>{watchImpact ? `${watchImpact.unique_handles} 个唯一账号；复用 ${watchImpact.reused_watches}，新增 ${watchImpact.new_watches}` : '正在计算影响'}</strong></div></div>
              <div className="p16-save-note">保存后只同步账号 Watch，不会创建虚假 CA 白名单。只有真实事件出现唯一有效 CA 时，系统才原子生成具体白名单和 Signal。</div>
            </>}
          </div>
          <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? onCancel() : goToStep(step - 1)}>{step === 1 ? '取消' : '上一步'}</button>{step < 3 ? <button type="button" className="btn btn-primary" onClick={() => goToStep(step + 1)}>下一步<ArrowRight size={16} /></button> : <button type="button" className="btn btn-primary" disabled={saving} onClick={save}><Save size={16} />{saving ? '保存中' : '启动监控'}</button>}</div>
        </main>
        <aside className="p16-draft-aside"><h3>监控进度 <span>{step} / 3</span></h3><div className="p16-progress"><i style={{ width: `${step * 100 / 3}%` }} /></div><div className="p16-draft-token"><strong>{form.project_name || '未命名项目'}</strong><span>{form.chain_id.toUpperCase()} · 尚无 CA</span></div>{steps.map(([title], index) => <div className={`p16-draft-check ${step > index ? 'done' : ''}`} key={title}><i />{title}<span>{step > index + 1 ? '已完成' : step === index + 1 ? '进行中' : '待配置'}</span></div>)}</aside>
      </div>
    </div>
  );
}
