import { Activity, Archive, RefreshCw, Save, SearchCheck, ShieldAlert, ShieldCheck, XCircle } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type {
  ActorScreeningRun, ChainId, DynamicPaperSession, DynamicPolicy,
  DynamicResolution, DynamicSignalStatus, ExitStrategy, KolAccount,
} from '../../lib/types';
import { useToast } from '../../components/ui/ToastContext';
import StrategyEditor from '../whitelist/StrategyEditor';
import { cloneStrategy, STRATEGY_PRESETS, strategySummary } from '../whitelist/strategy-presets';
import DynamicTradeConfigMatrix from '../strategy/DynamicTradeConfigMatrix';

const CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const TERM_TYPES = [
  ['ca', '完整 CA'], ['cashtag', '$ 代币符号'], ['hashtag', '# 话题标签'], ['approved_name', '项目名称'],
] as const;
const EVENT_TYPES = [
  ['tweet', '原创帖'], ['quote', '引用帖'], ['reply', '回复'],
] as const;

type Draft = Pick<DynamicPolicy, 'mode' | 'enabled' | 'allowed_chain_ids' |
  'allowed_event_types' | 'allowed_term_types' | 'approved_aliases' | 'chain_budgets' |
  'daily_new_token_limit' | 'per_token_buy_limit' | 'slippage' | 'exit_strategy'>;

function emptyChainBudgets(): DynamicPolicy['chain_budgets'] {
  return Object.fromEntries(CHAINS.map((chain) => [chain, {
    budget_per_trade: 0,
    daily_budget: 0,
  }])) as DynamicPolicy['chain_budgets'];
}

function normalizeChainBudgets(value?: Partial<DynamicPolicy['chain_budgets']>) {
  return Object.fromEntries(CHAINS.map((chain) => [chain, {
    budget_per_trade: Number(value?.[chain]?.budget_per_trade || 0),
    daily_budget: Number(value?.[chain]?.daily_budget || 0),
  }])) as DynamicPolicy['chain_budgets'];
}

const DEFAULT_DRAFT: Draft = {
  mode: 'record', enabled: true, allowed_chain_ids: ['bsc'],
  allowed_event_types: ['tweet'], allowed_term_types: ['ca', 'cashtag', 'hashtag'],
  approved_aliases: [],
  chain_budgets: emptyChainBudgets(), daily_new_token_limit: 0,
  per_token_buy_limit: 1, slippage: 10, exit_strategy: cloneStrategy(STRATEGY_PRESETS[0].value),
};

function handles(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/).map((item) => item.trim().replace(/^@+/, '').toLowerCase()).filter(Boolean))];
}

function pct(value?: number | null) {
  return value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
}

function modeLabel(mode: DynamicPolicy['mode']) {
  return mode === 'record' ? '记录' : mode === 'paper' ? '模拟' : mode === 'live' ? '实盘' : '暂停';
}

function aliasesText(values: DynamicPolicy['approved_aliases']) {
  return (values || []).map((item) => typeof item === 'string' ? item : item.name).join('\n');
}

function parseAliases(value: string) {
  return [...new Set(value.split(/[\n,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function resolutionLabel(status: DynamicResolution['status']) {
  return status === 'resolved' ? '已解析' : status === 'ambiguous' ? '存在歧义'
    : status === 'not_found' ? '未找到' : status === 'provider_failed' ? '数据源失败'
      : status === 'rejected' ? '已拒绝' : '处理中';
}

function normalizeExitStrategy(value: unknown): ExitStrategy {
  const candidate = value as Partial<ExitStrategy> | null | undefined;
  if (candidate?.version === 1 && candidate.sell_ratio_type === 'buy_amount' && Array.isArray(candidate.legs) && candidate.legs.length > 0) {
    return candidate as ExitStrategy;
  }
  return cloneStrategy(STRATEGY_PRESETS[0].value);
}

export function P20Operations({ kols, initialKolId }: { kols: KolAccount[]; initialKolId?: string }) {
  const [policies, setPolicies] = useState<DynamicPolicy[]>([]);
  const [kolId, setKolId] = useState('');
  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [saving, setSaving] = useState(false);
  const [screenInput, setScreenInput] = useState('');
  const [runs, setRuns] = useState<ActorScreeningRun[]>([]);
  const [activeRun, setActiveRun] = useState<ActorScreeningRun | null>(null);
  const [resolutions, setResolutions] = useState<DynamicResolution[]>([]);
  const [sessions, setSessions] = useState<DynamicPaperSession[]>([]);
  const [runtime, setRuntime] = useState<DynamicSignalStatus | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const [policyResponse, runResponse, resolutionResponse, sessionResponse, statusResponse] = await Promise.all([
      api.dynamicSignal.policies(), api.actorScreening.list(),
      api.dynamicSignal.resolutions({ limit: '50' }), api.dynamicSignal.paperSessions(),
      api.dynamicSignal.status(),
    ]);
    if (policyResponse.ok) setPolicies(policyResponse.data || []);
    if (runResponse.ok) setRuns(runResponse.data || []);
    if (resolutionResponse.ok) setResolutions(resolutionResponse.data || []);
    if (sessionResponse.ok) setSessions(sessionResponse.data || []);
    if (statusResponse.ok) setRuntime(statusResponse.data || null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (!activeRun || !['pending', 'running'].includes(activeRun.status)) return undefined;
    const timer = window.setInterval(async () => {
      const response = await api.actorScreening.get(activeRun.id);
      if (response.ok && response.data) {
        setActiveRun(response.data);
        if (!['pending', 'running'].includes(response.data.status)) void refresh();
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [activeRun, refresh]);

  const selected = useMemo(
    () => policies.find((item) => String(item.kol_id) === kolId),
    [kolId, policies],
  );
  useEffect(() => {
    if (kolId) return;
    const requestedKolId = initialKolId && kols.some((item) => String(item.id) === initialKolId)
      ? initialKolId : '';
    setKolId(requestedKolId || String(policies[0]?.kol_id || kols[0]?.id || ''));
  }, [initialKolId, kolId, kols, policies]);
  useEffect(() => {
    if (!kolId) return;
    setDraft(selected ? {
      mode: selected.mode, enabled: selected.enabled,
      allowed_chain_ids: selected.allowed_chain_ids,
      allowed_event_types: selected.allowed_event_types,
      allowed_term_types: selected.allowed_term_types,
      approved_aliases: selected.approved_aliases || [],
      chain_budgets: normalizeChainBudgets(selected.chain_budgets),
      daily_new_token_limit: Number(selected.daily_new_token_limit),
      per_token_buy_limit: Number(selected.per_token_buy_limit), slippage: Number(selected.slippage),
      exit_strategy: normalizeExitStrategy(selected.exit_strategy),
    } : { ...DEFAULT_DRAFT, exit_strategy: cloneStrategy(DEFAULT_DRAFT.exit_strategy) });
  }, [kolId, selected]);

  const toggle = <T extends string>(field: 'allowed_event_types' | 'allowed_term_types', value: T) => {
    setDraft((current) => {
      const values = current[field] as string[];
      return { ...current, [field]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] };
    });
  };

  const save = async () => {
    if (!kolId || draft.allowed_chain_ids.length === 0) return toast('请选择账号和至少一条链', 'error');
    if (!draft.allowed_event_types.length || !draft.allowed_term_types.length) return toast('请至少选择一种内容类型和词条类型', 'error');
    if (draft.allowed_term_types.includes('approved_name') && !draft.approved_aliases.length) return toast('启用项目名称时必须填写至少一个批准别名', 'error');
    const invalidChainBudget = draft.allowed_chain_ids.some((chain) => {
      const budget = draft.chain_budgets[chain];
      return !budget || budget.budget_per_trade <= 0 || budget.daily_budget < budget.budget_per_trade;
    });
    if (['paper', 'live'].includes(draft.mode) && (invalidChainBudget || draft.slippage <= 0)) {
      return toast('模拟或实盘必须为每条已启用链填写有效金额和每日上限', 'error');
    }
    setSaving(true);
    try {
      const response = await api.dynamicSignal.savePolicy(kolId, draft);
      if (!response.ok) return toast(response.error || '策略保存失败', 'error');
      toast('动态策略已保存，新版本需要重新完成模拟验收', 'success');
      await refresh();
    } finally { setSaving(false); }
  };

  const archivePolicy = async () => {
    if (!selected || !window.confirm(`确认停用并归档 @${selected.x_handle.replace(/^@+/, '')} 的动态策略？已有仓位仍会保留离场能力。`)) return;
    setActionBusy(true);
    try {
      const response = await api.dynamicSignal.removePolicy(selected.id);
      if (!response.ok) return toast(response.error || '策略归档失败', 'error');
      toast('动态策略已停用并归档', 'success');
      await refresh();
    } finally { setActionBusy(false); }
  };

  const approveLive = async () => {
    if (!selected || !window.confirm('确认创建短时动态实盘授权？保存策略本身不会开启全局实盘。')) return;
    setActionBusy(true);
    try {
      const response = await api.dynamicSignal.approveLive(selected.id, {
        confirmation: 'APPROVE P20 DYNAMIC LIVE', duration_minutes: 30,
        approval_note: 'operator workspace approval',
      });
      if (!response.ok) return toast(response.error || '实盘授权失败', 'error');
      toast('动态策略已获得 30 分钟授权', 'success');
      await refresh();
    } finally { setActionBusy(false); }
  };

  const revokeLive = async () => {
    if (!selected) return;
    setActionBusy(true);
    try {
      const response = await api.dynamicSignal.revokeLive(selected.id);
      if (!response.ok) return toast(response.error || '撤销授权失败', 'error');
      toast('动态实盘授权已撤销', 'success');
      await refresh();
    } finally { setActionBusy(false); }
  };

  const startScreening = async () => {
    const values = handles(screenInput);
    if (!values.length) return toast('请输入至少一个 X 账号', 'error');
    const response = await api.actorScreening.create({ handles: values });
    if (!response.ok || !response.data) return toast(response.error || '账号清洗任务创建失败', 'error');
    setActiveRun(response.data);
    setScreenInput('');
    toast('账号清洗任务已进入队列', 'success');
    await refresh();
  };

  const visibleRun = activeRun || runs[0] || null;
  const policyResolutions = selected
    ? resolutions.filter((item) => item.actor_policy_id === selected.id).slice(0, 8) : [];
  const policySessions = selected
    ? sessions.filter((item) => item.actor_policy_id === selected.id).slice(0, 4) : [];
  const approvalActive = Boolean(selected?.approval_id
    && selected.approval_expires_at && Date.parse(selected.approval_expires_at) > Date.now());
  const acceptedPaper = Boolean(selected && policySessions.some((session) => (
    session.status === 'completed' && Number(session.policy_revision) === Number(selected.revision)
  )));
  return (
    <section className="p20-operations">
      <div className="p20-operations-header">
        <div><Activity size={18} /><strong>动态喊单策略</strong></div>
        <button type="button" className="p16-icon-button" title="刷新动态策略" onClick={() => void refresh()}><RefreshCw size={15} /></button>
      </div>
      <div className="p20-operations-grid">
        <div className="p20-policy-editor">
          <div className="p20-section-title"><strong>账号策略</strong><span>{policies.length} 个已配置</span></div>
          <div className="p20-policy-list">
            {policies.map((policy) => <button type="button" key={policy.id} className={String(policy.kol_id) === kolId ? 'selected' : ''} onClick={() => setKolId(String(policy.kol_id))}><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><span>{modeLabel(policy.mode)} · 版本 {policy.revision}</span></button>)}
            {!policies.length && <div className="p16-empty-line">还没有动态策略，请先选择账号并保存。</div>}
          </div>
          <div className="p20-form-row">
            <label><span>X 账号</span><select value={kolId} onChange={(event) => setKolId(event.target.value)}><option value="">选择账号</option>{kols.map((kol) => <option key={kol.id} value={String(kol.id)}>@{kol.x_handle.replace(/^@+/, '')}</option>)}</select></label>
            <label><span>运行阶段</span><select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Draft['mode'] })}><option value="record">记录：仅记录</option><option value="paper">模拟：模拟交易</option><option value="live">实盘：需单独授权</option><option value="paused">暂停</option></select></label>
          </div>
          <div className="p20-choice-row"><span>状态</span><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用该账号策略</label></div>
          <div className="p20-choice-row"><span>内容</span>{EVENT_TYPES.map(([value, label]) => <label key={value}><input type="checkbox" checked={draft.allowed_event_types.includes(value)} onChange={() => toggle('allowed_event_types', value)} />{label}</label>)}</div>
           <div className="p20-choice-row"><span>词条</span>{TERM_TYPES.map(([value, label]) => <label key={value}><input type="checkbox" checked={draft.allowed_term_types.includes(value)} onChange={() => toggle('allowed_term_types', value)} />{label}</label>)}</div>
           {draft.allowed_term_types.includes('approved_name') && <label className="p20-alias-field"><span>批准项目名 / 别名</span><textarea rows={3} value={aliasesText(draft.approved_aliases)} onChange={(event) => setDraft({ ...draft, approved_aliases: parseAliases(event.target.value) })} placeholder="每行一个完整项目名" /></label>}
           <DynamicTradeConfigMatrix allowedChainIds={draft.allowed_chain_ids} chainBudgets={draft.chain_budgets} mode={draft.mode} onChange={(value) => setDraft((current) => ({ ...current, ...value }))} />
           <div className="p20-number-grid">
             <label><span>每日新币上限</span><input type="number" min="0" value={draft.daily_new_token_limit} onChange={(e) => setDraft({ ...draft, daily_new_token_limit: Number(e.target.value) })} /></label>
            <label><span>单币买入次数</span><input type="number" min="1" value={draft.per_token_buy_limit} onChange={(e) => setDraft({ ...draft, per_token_buy_limit: Number(e.target.value) })} /></label>
            <label><span>滑点 %</span><input type="number" min="0.01" max="100" step="0.01" value={draft.slippage} onChange={(e) => setDraft({ ...draft, slippage: Number(e.target.value) })} /></label>
          </div>
          {draft.mode === 'live' && <div className="p20-live-notice"><ShieldAlert size={15} /><span>保存实盘配置不会自动开启交易；必须通过独立实盘授权、模拟验收和全局安全门。</span></div>}
          <div className="p20-exit-section"><div className="p20-section-title"><strong>共用离场策略</strong><span>{strategySummary(draft.exit_strategy)}</span></div><StrategyEditor value={draft.exit_strategy} onChange={(exit_strategy) => setDraft((current) => ({ ...current, exit_strategy }))} saveHint="动态策略修改后需要重新完成模拟验收" /></div>
          <div className="p20-policy-footer"><span>{selected ? `版本 ${selected.revision}` : '未配置'}</span><div className="p20-policy-actions">{selected && <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={archivePolicy}><Archive size={15} />停用归档</button>}<button type="button" className="btn btn-primary" disabled={saving || actionBusy || !kolId} onClick={save}><Save size={15} />{saving ? '保存中' : '保存策略'}</button></div></div>
        </div>
        <div className="p20-screening">
          <div className="p20-section-title"><strong>账号清洗</strong><span>{visibleRun?.status || '空闲'}</span></div>
          <div className="p20-screen-input"><textarea rows={3} value={screenInput} onChange={(event) => setScreenInput(event.target.value)} placeholder="@account1  @account2" /><button type="button" className="btn btn-secondary" onClick={startScreening}><SearchCheck size={15} />开始</button></div>
          <div className="p20-screen-results">
            {visibleRun?.results?.length ? visibleRun.results.map((result) => <button type="button" key={result.id} className="p20-result-row"><strong>@{result.x_handle}</strong><span>{result.sample_size} 帖</span><span>意图 {pct(result.direct_intent_rate)}</span><span>解析 {pct(result.ca_resolution_rate)}</span><span>胜率 {pct(result.executable_win_rate)}</span><i>{result.recommendation === 'approve_for_record' ? '建议记录' : result.recommendation === 'watch' ? '继续观察' : result.recommendation === 'reject' ? '不建议' : '数据不足'}</i></button>) : <div className="p16-empty-line">暂无清洗结果</div>}
          </div>
        </div>
      </div>
      <div className="p20-runtime-grid">
        <section>
          <div className="p20-section-title"><strong>解析记录</strong><span>{policyResolutions.length ? `最近 ${policyResolutions.length} 条` : '暂无记录'}</span></div>
          <div className="p20-audit-list">{policyResolutions.map((item) => <div key={item.id}><span><strong>{item.symbol || item.contract_address || '未解析词条'}</strong><small>{item.chain_id?.toUpperCase() || '--'} · {item.failure_code || item.intent_class}</small></span><i className={item.status === 'resolved' ? 'active' : ''}>{resolutionLabel(item.status)}</i></div>)}{!policyResolutions.length && <div className="p16-empty-line">该策略还没有解析记录</div>}</div>
        </section>
        <section>
          <div className="p20-section-title"><strong>模拟验收与实盘授权</strong><span>{runtime?.features.P20_LIVE_ENABLED ? '全局实盘能力已开启' : '全局实盘能力关闭'}</span></div>
          <div className="p20-acceptance-status"><div><span>当前 Revision</span><strong>{selected?.revision || '--'}</strong></div><div><span>7 天模拟</span><strong>{acceptedPaper ? '已完成' : policySessions[0]?.status === 'running' ? '运行中' : '未完成'}</strong></div><div><span>账号授权</span><strong>{approvalActive ? '有效' : '未授权'}</strong></div></div>
          <div className="p20-authorization-note">{approvalActive ? <><ShieldCheck size={15} /><span>授权有效至 {new Date(selected!.approval_expires_at!).toLocaleString('zh-CN')}</span></> : <><ShieldAlert size={15} /><span>必须以目标 Live 配置完成同 Revision 的 7 天模拟，才能创建短时授权。</span></>}</div>
          <div className="p20-authorization-actions">{approvalActive ? <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={revokeLive}><XCircle size={15} />撤销授权</button> : <button type="button" className="btn btn-secondary" disabled={actionBusy || selected?.mode !== 'live' || !acceptedPaper} onClick={approveLive}><ShieldCheck size={15} />授权 30 分钟</button>}</div>
        </section>
      </div>
    </section>
  );
}
