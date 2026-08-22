import { AlertTriangle, ArrowLeft, ArrowRight, FlaskConical, RefreshCw, Search, Square } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import { researchRoleLabel } from '../../lib/display-labels';
import type {
  ChainId,
  ResearchJob,
  ResearchJobItem,
  WhitelistDraftPayload,
  WhitelistProjectAccount,
  XDirectSource,
} from '../../lib/types';

const CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const TERMINAL_JOB_STATES = new Set(['completed', 'partial', 'failed', 'cancelled']);
const LAST_JOB_STORAGE_KEY = 'xbot:p16:last-research-job';
const STAGE_LABELS: Record<ResearchJobItem['status'], string> = {
  queued: '等待',
  gmgn: 'GMGN 查询',
  grok: 'Grok 分析',
  verification: '6551 核验',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function socialResolutionLabel(status?: NonNullable<NonNullable<ResearchJobItem['report']>['social_resolution']>['status']) {
  if (!status) return '等待身份补全';
  return {
    pending: '等待身份补全',
    searching: '首次搜索中',
    format_repair: '正在整理首次结果',
    targeted_followup: '正在针对性补查',
    result_ready: '结果待核验',
    gmgn_confirmed: 'GMGN 官方账号已确认',
    grok_verified: 'Grok 官方账号已核验',
    grok_candidate: 'Grok 官方账号候选',
    insufficient: '未找到可靠证据',
    provider_failed: '身份补全失败',
  }[status];
}

function jobStatusLabel(status: ResearchJob['status']) {
  return {
    pending: '等待启动',
    running: '运行中',
    completed: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
  }[status];
}

function queueWaitLabel(job: ResearchJob | null) {
  if (!job || job.status !== 'pending') return '';
  const queue = job.queue_status;
  if (!queue) return '投研任务已进入队列，等待 Worker 领取';
  if (queue.wait_reason === 'GMGN_COOLDOWN') {
    const retryAt = queue.retry_at ? new Date(queue.retry_at).toLocaleTimeString('zh-CN') : '';
    return `GMGN 正在限流冷却，投研将在冷却结束后继续${retryAt ? `（预计 ${retryAt}）` : ''}`;
  }
  if (queue.wait_reason === 'TRADE_PROVIDER_LEASE_ACTIVE') {
    return '实盘交易正在使用 GMGN，投研会在本次交易请求完成后自动继续';
  }
  if (queue.wait_reason === 'TRADE_PROVIDER_QUEUE_ACTIVE') {
    return '交易或订单恢复请求优先，投研会在高优先级队列清空后自动继续';
  }
  if (queue.wait_reason === 'TRADE_CAPACITY_RESERVED') {
    return '正在为下一次实盘交易保留 GMGN 容量，投研将在容量恢复后自动继续';
  }
  if (queue.wait_reason === 'RESEARCH_WORKER_BUSY') return '前一项投研正在处理，本任务排队等待';
  return '调度资源可用，投研即将开始';
}

function addressInputStats(value: string, chain: ChainId) {
  const entries = value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
  const unique = new Map<string, string>();
  entries.forEach((entry) => {
    const normalized = chain === 'sol' ? entry : entry.toLowerCase();
    if (!unique.has(normalized)) unique.set(normalized, normalized);
  });
  return {
    addresses: [...unique.values()],
    duplicateCount: entries.length - unique.size,
  };
}

function shortAddress(value: string) {
  return value.length > 14 ? `${value.slice(0, 7)}...${value.slice(-5)}` : value;
}

function researchFailure(item: ResearchJobItem | null) {
  if (!item || item.status !== 'failed') return null;
  const code = item.error_code || 'RESEARCH_ITEM_FAILED';
  const known: Record<string, { stage: string; summary: string }> = {
    XAI_SCHEMA_INVALID: { stage: 'Grok 分析', summary: 'Grok 返回格式不完整，无法生成可靠的结构化结果' },
    XAI_SEARCH_NO_TOOL_USE: { stage: 'Grok 搜索', summary: 'Grok 未执行要求的公开搜索' },
    XAI_SEARCH_TIMEOUT: { stage: 'Grok 搜索', summary: 'Grok 搜索超时' },
    XAI_SEARCH_INCOMPLETE: { stage: 'Grok 搜索', summary: 'Grok 搜索结果不完整' },
    XAI_SEARCH_TOOL_BUDGET_EXCEEDED: { stage: 'Grok 搜索', summary: 'Grok 搜索超过本次允许的工具预算' },
    XAI_STRUCTURE_OUTPUT_EMPTY: { stage: 'Grok 结构化', summary: 'Grok 没有返回可整理的内容' },
    XAI_STRUCTURE_JSON_INVALID: { stage: 'Grok 结构化', summary: 'Grok 返回的 JSON 格式无效' },
    XAI_STRUCTURE_SCHEMA_INVALID: { stage: 'Grok 结构化', summary: 'Grok 返回字段不符合投研契约' },
    XAI_STRUCTURE_REPAIR_FAILED: { stage: 'Grok 结构化', summary: '首次证据的格式修复失败' },
    XAI_GROK_REQUEST_BUDGET_EXHAUSTED: { stage: 'Grok 分析', summary: '本次 CA 的两次 Grok 请求预算已用完' },
    XAI_GROK_REQUEST_IN_PROGRESS: { stage: 'Grok 分析', summary: '同一 CA 已有 Grok 请求正在执行' },
    XAI_RESPONSE_INCOMPLETE: { stage: 'Grok 分析', summary: 'Grok 响应中断，结果未生成完整' },
    XAI_OUTPUT_EMPTY: { stage: 'Grok 分析', summary: 'Grok 未返回可用的分析内容' },
    XAI_RATE_LIMITED: { stage: 'Grok 分析', summary: 'Grok 请求达到频率限制' },
    XAI_KEY_MISSING: { stage: 'Grok 分析', summary: 'Grok API 尚未配置' },
    XAI_AUTH_INVALID: { stage: 'Grok 分析', summary: 'Grok API Key 无效或已被撤销' },
    XAI_CREDITS_EXHAUSTED: { stage: 'Grok 分析', summary: 'xAI 额度已用尽或达到月度消费上限' },
    XAI_PERMISSION_DENIED: { stage: 'Grok 分析', summary: '当前 xAI 账户无权使用所需模型或 X 搜索工具' },
    XAI_MODEL_UNAVAILABLE: { stage: 'Grok 分析', summary: '当前配置的 Grok 模型不可用' },
    XAI_PROVIDER_UNAVAILABLE: { stage: 'Grok 分析', summary: '第三方 Grok 服务暂不可用，请稍后重试' },
    XAI_REQUEST_FAILED: { stage: 'Grok 分析', summary: 'Grok 请求失败' },
  };
  if (known[code]) return { code, ...known[code] };
  if (code.startsWith('GMGN')) return { code, stage: 'GMGN 查询', summary: item.error_message || 'GMGN 数据查询失败' };
  if (code.startsWith('X6551')) return { code, stage: '6551 核验', summary: item.error_message || 'X 账号核验失败' };
  return { code, stage: '投研任务', summary: item.error_message || '分析失败，未返回详细原因' };
}

function mergeSources(left: XDirectSource[] = [], right: XDirectSource[] = []) {
  const items = new Map([...right, ...left].map((item) => [item.actor_handle, {
    ...item,
    match_mode: 'ca_only' as const,
    source_kind: item.source_kind || 'project',
  }]));
  return [...items.values()];
}

function mergeProjectAccounts(
  left: WhitelistProjectAccount[] = [],
  right: WhitelistProjectAccount[] = [],
) {
  const items = new Map<string, WhitelistProjectAccount>();
  [...right, ...left].forEach((item) => {
    const key = `${item.handle.toLowerCase()}:${item.usage}`;
    const previous = items.get(key);
    items.set(key, {
      ...previous,
      ...item,
      evidence_snapshot: {
        ...(previous?.evidence_snapshot || {}),
        ...(item.evidence_snapshot || {}),
      },
    });
  });
  return [...items.values()];
}

function durationLabel(item: ResearchJobItem) {
  const durationMs = Number(item.duration_ms || (
    item.started_at ? Date.now() - new Date(item.started_at).getTime() : 0
  ));
  if (!durationMs) return '';
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  return seconds >= 60
    ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
    : `${seconds}s`;
}

interface Props {
  draft: WhitelistDraftPayload;
  onBack: () => void;
  onUseDraft: (draft: WhitelistDraftPayload) => void;
}

export default function ResearchWorkspace({ draft, onBack, onUseDraft }: Props) {
  const [mode, setMode] = useState<'single' | 'batch'>('single');
  const [chain, setChain] = useState<ChainId>(draft.chain_id || 'robinhood');
  const [input, setInput] = useState(draft.contract_address || '');
  const [job, setJob] = useState<ResearchJob | null>(null);
  const [selectedItemId, setSelectedItemId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { toast } = useToast();

  const inputStats = useMemo(() => addressInputStats(input, chain), [input, chain]);
  const requestedAddresses = mode === 'single' ? inputStats.addresses.slice(0, 1) : inputStats.addresses;
  const selectedItem = job?.items.find((item) => item.id === selectedItemId)
    || job?.items.find((item) => item.report)
    || job?.items[0]
    || null;
  const selected = selectedItem?.report || null;
  const selectedFailure = researchFailure(selectedItem);
  const queueWait = queueWaitLabel(job);
  const symbolCounts = useMemo(() => {
    const counts = new Map<string, number>();
    job?.items.forEach((item) => {
      const symbol = item.report?.provider_snapshot?.metadata?.symbol?.trim().toLowerCase();
      if (symbol) counts.set(symbol, (counts.get(symbol) || 0) + 1);
    });
    return counts;
  }, [job]);
  const running = Boolean(job && !TERMINAL_JOB_STATES.has(job.status));
  const retryableFailed = Boolean(job?.items.some((item) => (
    item.status === 'failed' && (item.report?.social_resolution?.retry_allowed ?? true)
  )));
  const jobId = job?.id;
  const jobStatus = job?.status;

  useEffect(() => {
    const storedJobId = window.sessionStorage.getItem(LAST_JOB_STORAGE_KEY);
    if (!storedJobId) return;
    let active = true;
    api.research.getJob(storedJobId).then((response) => {
      if (!active) return;
      if (response.ok && response.data) {
        setJob(response.data);
        setMode(response.data.mode);
        setChain(response.data.chain_id);
        setSelectedItemId(response.data.items.find((item) => item.report)?.id || response.data.items[0]?.id || '');
      } else {
        window.sessionStorage.removeItem(LAST_JOB_STORAGE_KEY);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!jobId || !jobStatus || TERMINAL_JOB_STATES.has(jobStatus)) return;
    const timer = window.setInterval(async () => {
      const response = await api.research.getJob(jobId);
      if (response.ok && response.data) setJob(response.data);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [jobId, jobStatus]);

  const runResearch = async () => {
    if (!requestedAddresses.length) return toast('请填写至少一个 CA', 'error');
    if (requestedAddresses.length > 30) return toast('批量投研最多支持 30 个唯一 CA', 'error');
    setSubmitting(true);
    const response = await api.research.createJob(chain, requestedAddresses);
    setSubmitting(false);
    if (!response.ok || !response.data) return toast(response.error || '投研任务创建失败', 'error');
    setJob(response.data);
    setSelectedItemId(response.data.items[0]?.id || '');
    window.sessionStorage.setItem(LAST_JOB_STORAGE_KEY, response.data.id);
  };

  const cancelResearch = async () => {
    if (!job || TERMINAL_JOB_STATES.has(job.status)) return;
    const response = await api.research.cancelJob(job.id);
    if (!response.ok || !response.data) return toast(response.error || '取消投研任务失败', 'error');
    setJob(response.data);
    toast('投研任务已取消', 'success');
  };

  const retryFailed = async () => {
    if (!job) return;
    const response = await api.research.retryFailed(job.id);
    if (!response.ok || !response.data) return toast(response.error || '失败项重试失败', 'error');
    setJob(response.data);
    toast('只重试失败的 CA，已完成结果保持不变', 'success');
  };

  const generateDraft = async () => {
    if (!selected) return;
    const response = await api.research.whitelistDraft(selected.id);
    if (!response.ok || !response.data) return toast(response.error || '草稿生成失败', 'error');
    const generated = response.data;
    const keepCurrentConfig = Boolean(draft.template_id)
      || (Number(draft.budget_per_trade) > 0 && Number(draft.total_budget) > 0)
      || Boolean(draft.direct_source_actor_handles?.length)
      || Boolean(draft.relation_actor_handles?.length);
    onUseDraft({
      ...generated,
      ...(keepCurrentConfig ? {
        template_id: draft.template_id,
        budget_per_trade: draft.budget_per_trade,
        total_budget: draft.total_budget,
        slippage: draft.slippage,
        allow_repeat_buy: draft.allow_repeat_buy,
        max_repeat_buys: draft.max_repeat_buys,
        exit_strategy: draft.exit_strategy,
        direct_source_rule_enabled: draft.direct_source_rule_enabled,
        direct_source_actor_handles: draft.direct_source_actor_handles,
        direct_source_event_types: draft.direct_source_event_types,
        relation_rule_enabled: draft.relation_rule_enabled,
        relation_actor_handles: draft.relation_actor_handles,
        relation_target_handles: draft.relation_target_handles,
        relation_target_policy: draft.relation_target_policy,
        relation_event_types: draft.relation_event_types,
      } : {}),
      direct_sources: mergeSources(draft.direct_sources, generated.direct_sources),
      relations: draft.relations || generated.relations || [],
      project_accounts: mergeProjectAccounts(draft.project_accounts, generated.project_accounts),
      candidates: generated.candidates,
    });
  };

  const metadata = selected?.provider_snapshot?.metadata;
  const security = selected?.provider_snapshot?.security || {};
  const pool = selected?.provider_snapshot?.pool || {};

  return (
    <div className="p16-research-workspace">
      <div className="p16-workspace-head">
        <div><button type="button" className="p16-back-link" onClick={onBack}><ArrowLeft size={16} />返回创建</button><h2>快速投研</h2></div>
        <span className="p16-readonly-badge"><FlaskConical size={15} />只读研究</span>
      </div>

      <div className="p16-research-controls">
        <div className="p16-segmented"><button type="button" className={mode === 'single' ? 'active' : ''} disabled={running} onClick={() => setMode('single')}>单个 CA</button><button type="button" className={mode === 'batch' ? 'active' : ''} disabled={running} onClick={() => setMode('batch')}>批量 CA</button></div>
        <select className="input" value={chain} disabled={running} onChange={(event) => setChain(event.target.value as ChainId)}>{CHAINS.map((item) => <option value={item} key={item}>{item.toUpperCase()}</option>)}</select>
        {mode === 'single' ? <input className="input font-mono" value={input} disabled={running} onChange={(event) => setInput(event.target.value)} placeholder="输入合约地址" /> : <textarea className="input font-mono" value={input} disabled={running} onChange={(event) => setInput(event.target.value)} placeholder="每行一个 CA，最多 30 个" />}
        <button type="button" className="btn btn-primary" disabled={submitting || running} onClick={runResearch}><Search size={16} />{submitting ? '创建中' : `开始投研${requestedAddresses.length ? ` (${requestedAddresses.length})` : ''}`}</button>
        <span className="p16-research-cost">{mode === 'batch' ? `已识别 ${requestedAddresses.length} 个唯一 CA${inputStats.duplicateCount ? `，已去重 ${inputStats.duplicateCount} 个重复输入` : ''}；` : ''}每个 CA 首次成功即停止，必要时最多补查 1 次；TTL 内结果自动复用。</span>
      </div>

      {!job ? <div className="p16-research-empty"><Search size={24} /><strong>输入 CA 开始查询</strong><span>每个 CA 独立执行 GMGN、Grok 和 6551；批量任务默认并发 3。</span></div> : <>
        <div className="p16-job-summary">
          <div><span>任务状态</span><strong>{jobStatusLabel(job.status)}</strong></div>
          <div><span>完成</span><strong>{job.completed_count} / {job.total_count}</strong></div>
          <div><span>失败</span><strong>{job.failed_count}</strong></div>
          <div><span>Grok 上限</span><strong>每 CA 2 次，共 {job.total_count * 2} 次，并发 {job.queue_status?.effective_concurrency || job.concurrency_limit || 3}</strong></div>
          {job.failed_count > 0 && retryableFailed && <button type="button" className="btn btn-secondary" onClick={retryFailed}><RefreshCw size={15} />继续剩余补查</button>}
          {job.failed_count > 0 && !retryableFailed && <span className="p16-research-cost">失败项的两次 Grok 预算已用完</span>}
          {running && <button type="button" className="p16-icon-button" title="取消投研任务" aria-label="取消投研任务" onClick={cancelResearch}><Square size={14} /></button>}
          {queueWait && <p className="p16-job-wait">{queueWait}</p>}
        </div>

        <div className="p16-research-grid">
          <aside className="p16-report-list">
            {job.items.map((item) => {
              const itemMetadata = item.report?.provider_snapshot?.metadata;
              const symbol = itemMetadata?.symbol?.trim().toLowerCase();
              const sameSymbol = symbol ? (symbolCounts.get(symbol) || 0) > 1 : false;
              const failure = researchFailure(item);
              return <button type="button" className={selectedItem?.id === item.id ? 'active' : ''} key={item.id} onClick={() => setSelectedItemId(item.id)} title={item.contract_address}><strong>{itemMetadata?.symbol || item.contract_address.slice(0, 9)}{sameSymbol && <i>同名不同 CA</i>}</strong><span>{itemMetadata?.name || '尚未识别'} · <code>{shortAddress(item.contract_address)}</code></span><em className={item.status}>{STAGE_LABELS[item.status]} {durationLabel(item)}</em>{failure && <small>{failure.summary}</small>}</button>;
            })}
          </aside>

          {selected ? <main className="p16-report-detail">
            <div className="p16-report-token">{metadata?.logo_url ? <img src={metadata.logo_url} alt="" /> : <span>{metadata?.symbol?.slice(0, 1) || '?'}</span>}<div><h3>{metadata?.symbol || '未命名'} <small>{metadata?.name}</small></h3><code>{selected.contract_address}</code></div><span className={`p16-stage-badge ${selectedItem?.status}`}>{selectedItem ? STAGE_LABELS[selectedItem.status] : ''}</span></div>
            {selectedFailure && <div className="p16-research-error"><AlertTriangle size={18} /><div><strong>{selectedFailure.stage}失败：{selectedFailure.summary}</strong><span>错误码 {selectedFailure.code}</span></div></div>}
            {selected.social_resolution && <section className="p16-inline-section"><div className="p16-section-heading"><div><h3>官方 X 身份补全</h3><p>{socialResolutionLabel(selected.social_resolution.status)}{selected.social_resolution.official_handle ? ` · @${selected.social_resolution.official_handle}` : ''}</p></div></div><div className="p16-fact-grid"><div><span>GMGN 来源</span><strong>{selected.social_resolution.gmgn_status === 'found' ? '已提供官方账号' : selected.social_resolution.gmgn_status === 'invalid' ? '返回值无效' : '本次未提供'}</strong></div><div><span>Grok 请求</span><strong>{selected.social_resolution.grok_request_attempts} / {selected.social_resolution.grok_request_limit}</strong></div><div><span>公开搜索</span><strong>{selected.social_resolution.search_tool_calls} / {selected.social_resolution.search_tool_call_limit}</strong></div><div><span>第二次原因</span><strong>{selected.social_resolution.second_request_reason === 'format_repair' ? '只整理首次证据' : selected.social_resolution.second_request_reason === 'targeted_followup' ? '针对性补查' : '未触发'}</strong></div></div></section>}
            <div className="p16-fact-grid"><div><span>流动性</span><strong>{pool.liquidity_usd == null ? '暂无' : `$${Number(pool.liquidity_usd).toLocaleString()}`}</strong></div><div><span>买入税</span><strong>{security.buy_tax == null ? '暂无' : `${security.buy_tax}%`}</strong></div><div><span>卖出税</span><strong>{security.sell_tax == null ? '暂无' : `${security.sell_tax}%`}</strong></div><div><span>蜜罐</span><strong>{security.is_honeypot == null ? '暂无' : security.is_honeypot ? '是' : '否'}</strong></div></div>

            <section className="p16-inline-section"><div className="p16-section-heading"><div><h3>项目团队候选</h3><p>官方、Founder、CEO 与核心团队。</p></div></div><div className="p16-candidate-list">{selected.candidates.length ? selected.candidates.map((candidate) => <div className="p16-candidate-row research" key={candidate.handle}><div><strong>@{candidate.handle}</strong><span>{candidate.display_name || researchRoleLabel(candidate.role)}</span></div><span>{researchRoleLabel(candidate.role)}</span><em>{candidate.confidence === 'verified' ? '已核验' : candidate.confidence === 'high' ? '高置信' : '待确认'}</em><small>{candidate.association || candidate.evidence?.[0]?.label || candidate.source}</small>{candidate.evidence?.[0]?.url && <a href={candidate.evidence[0].url} target="_blank" rel="noreferrer">查看证据</a>}</div>) : <div className="p16-empty-line">当前阶段尚未返回项目账号候选</div>}</div></section>
            <div className="p16-report-actions"><button type="button" className="btn btn-secondary" onClick={onBack}>仅保留报告</button><button type="button" className="btn btn-primary" disabled={selectedItem?.status !== 'completed'} onClick={generateDraft}>生成白名单草稿<ArrowRight size={16} /></button></div>
          </main> : <main className="p16-report-detail p16-report-waiting">{selectedFailure ? <AlertTriangle size={22} /> : <RefreshCw size={22} />}<strong>{selectedFailure ? `${selectedFailure.stage}失败：${selectedFailure.summary}` : queueWait || `${selectedItem ? STAGE_LABELS[selectedItem.status] : '等待'}...`}</strong>{selectedFailure && <small>错误码 {selectedFailure.code}</small>}<span>{selectedItem?.contract_address}</span></main>}
        </div>
      </>}
    </div>
  );
}
