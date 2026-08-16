import {
  ArrowUpDown,
  BrainCircuit,
  ExternalLink,
  FileText,
  LoaderCircle,
  RefreshCw,
  SearchCheck,
  Users,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type {
  AccountResearchGrokResult,
  ChainId,
  KolPerformanceAsset,
  KolPerformanceEvent,
  KolPerformanceMode,
  KolPerformanceRun,
  KolProfileRun,
} from '../../lib/types';

type WindowRange = '7d' | '30d' | 'all';
type SortKey = 'source_occurred_at' | 'peak_multiple';

function cleanHandle(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function dateRange(range: WindowRange) {
  if (range === 'all') return null;
  const days = range === '7d' ? 7 : 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

function statusLabel(status?: KolPerformanceRun['status']) {
  const labels: Record<string, string> = {
    pending: '等待运行', extracting: '采样解析中', pricing: '回放行情中', completed: '已结束（完整）',
    no_samples: '已结束（无样本）', partial: '已结束（部分结果）', price_retry: '已暂停（待重试）',
    price_unavailable: '已结束（无行情）', failed: '已结束（失败）',
  };
  return labels[status || ''] || '未开始';
}

function isActiveStatus(status?: KolPerformanceRun['status']) {
  return status === 'pending' || status === 'extracting' || status === 'pricing';
}

function duration(start?: string | null, end?: string | number | null) {
  if (!start) return '--';
  const startedAt = new Date(start).getTime();
  const endedAt = typeof end === 'number' ? end : new Date(end || Date.now()).getTime();
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return '--';
  const seconds = Math.floor((endedAt - startedAt) / 1000);
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}分${remaining ? `${remaining}秒` : ''}`;
  return `${Math.floor(minutes / 60)}小时${minutes % 60}分`;
}

function progressStageLabel(run: KolPerformanceRun) {
  const stage = run.metrics?.progress?.stage;
  if (run.status === 'pending') return '等待 Worker 接管';
  if (run.status === 'pricing') return 'GMGN 历史行情回放';
  if (stage === 'follow_research') return '逐个研究关注账号并核验 CA';
  if (stage === 'ca_extraction') return '整理 CA 识别结果';
  return run.mode === 'post_calls' ? '6551 采样与 Grok 识别' : '读取已监听关注事件';
}

function terminalSummary(run: KolPerformanceRun) {
  const metrics = run.metrics || {};
  if (run.status === 'completed') return `任务已结束，${metrics.price_ready_ca_count || 0} 个 CA 全部完成行情回放。`;
  if (run.status === 'partial') return `任务已结束，不会继续运行。${metrics.unique_ca_count || 0} 个 CA 中 ${metrics.price_ready_ca_count || 0} 个完成，${metrics.missing_price_ca_count || 0} 个缺少有效行情。`;
  if (run.status === 'no_samples' && Number(metrics.raw_event_count || 0) > 0) {
    return `任务已结束，读取到 ${metrics.raw_event_count} 条关注事件，但没有确认出可回放的 CA。`;
  }
  if (run.status === 'no_samples') return '任务已结束，当前窗口没有发现实际关注事件。';
  if (run.status === 'price_unavailable') return `任务已结束，发现 ${metrics.unique_ca_count || 0} 个 CA，但均未获得有效历史行情。`;
  if (run.status === 'price_retry') return '本轮已经暂停，当前没有后台任务运行；点击“重试行情”后才会继续。';
  return '任务已结束，当前没有后台任务运行。';
}

function followEventStatus(event: KolPerformanceEvent) {
  return ({
    resolved: '已确认 CA', no_match: '未确认 CA', ambiguous: '存在歧义', provider_failed: '研究失败',
  } as Record<string, string>)[event.extraction_status] || event.extraction_status;
}

function followEventDetail(event: KolPerformanceEvent) {
  const evidence = event.evidence_json || {};
  const code = typeof evidence.code === 'string' ? evidence.code : '';
  const detail = typeof evidence.detail === 'string' ? evidence.detail : '';
  const labels: Record<string, string> = {
    FOLLOW_ACCOUNT_NOT_PROJECT: '未确认该账号属于加密项目或核心人员',
    FOLLOW_PROJECT_RELATION_NOT_VERIFIED: '未确认人物与项目官方账号的关系',
    FOLLOW_CA_NOT_FOUND: '公开证据中没有找到账号自有的完整 CA',
    FOLLOW_CA_AMBIGUOUS: '发现多个候选 CA，无法唯一确认',
    FOLLOW_CA_CHAIN_AMBIGUOUS: '同一地址存在多链歧义',
    FOLLOW_CA_CHAIN_UNRESOLVED: '链上只读核验未找到该合约',
    FOLLOW_RESEARCH_LIMIT_REACHED: '本批次达到关注账号研究上限',
    FOLLOW_RESEARCH_SKIPPED_AFTER_PROVIDER_ERROR: '外部研究服务异常，后续账号未继续请求',
  };
  if (code && labels[code]) return labels[code];
  if (detail) return detail;
  return event.extraction_status === 'resolved' ? 'Grok 证据与链上合约已核验' : code || '--';
}

function profileStatusLabel(status?: KolProfileRun['status']) {
  return ({ pending: '准备中', running: '研究中', completed: '已完成', failed: '失败' } as Record<string, string>)[status || ''] || '未开始';
}

function chainLabel(value?: ChainId | null) {
  const labels: Record<string, string> = { sol: 'Solana', bsc: 'BSC', base: 'Base', eth: 'Ethereum', robinhood: 'Robinhood' };
  return value ? labels[value] || value : '--';
}

function sourceLabel(asset: KolPerformanceAsset) {
  if (asset.source_type === 'follow') return asset.target_handle ? `关注 @${asset.target_handle}` : '关注事件';
  return ({ tweet: '原帖', reply: '回复', quote: '引用帖' } as Record<string, string>)[asset.source_type] || asset.source_type;
}

function percent(value?: number | null) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '--' : `${(Number(value) * 100).toFixed(2)}%`;
}

function multiple(value?: number | string | null) {
  return value === null || value === undefined || !Number.isFinite(Number(value)) ? '--' : `${Number(value).toFixed(2)}x`;
}

function price(value?: number | string | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '--';
  const numeric = Number(value);
  return Math.abs(numeric) < 0.0001 && numeric !== 0 ? numeric.toExponential(4) : numeric.toLocaleString('en-US', { maximumFractionDigits: 8 });
}

function time(value?: string | null) {
  if (!value) return '--';
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '--';
}

function shortAddress(value: string) {
  return value.length > 20 ? `${value.slice(0, 9)}...${value.slice(-7)}` : value;
}

function reasonLabel(value: string) {
  const labels: Record<string, string> = {
    KOL_PERFORMANCE_SOURCE_EMPTY: '当前窗口没有可用的原始事件',
    KOL_PERFORMANCE_CA_EMPTY: '原始事件中没有可确认的 CA',
    KOL_PERFORMANCE_GMGN_PRICE_RETRY: 'GMGN 历史行情暂不可用',
    KOL_PERFORMANCE_GMGN_BATCH_SHORT_CIRCUITED: '本轮已停止后续行情请求',
    KOL_PERFORMANCE_GROK_FAILED: 'Grok 未返回可用的 CA 研究结果',
    KOL_PERFORMANCE_SOURCE_PARTIAL: '数据源或研究过程未完整覆盖所选窗口',
    KOL_PERFORMANCE_GMGN_PRICE_UNAVAILABLE: 'GMGN 成功响应，但没有可用历史 K 线',
    KOL_PERFORMANCE_PARTIAL_RESULT: '当前批次只有部分可用结果',
    KOL_PERFORMANCE_GMGN_PRICE_PARTIAL: '部分 CA 缺少有效历史行情',
  };
  return labels[value] || value;
}

function profileType(value?: AccountResearchGrokResult['account_type']) {
  return ({ kol: 'KOL', trader: '交易者', researcher: '研究员', project: '项目账号', person: '核心人物', organization: '组织账号', unknown: '身份未确认' } as Record<string, string>)[value || 'unknown'];
}

function ModeIcon({ mode }: { mode: KolPerformanceMode }) {
  return mode === 'post_calls' ? <FileText size={15} /> : <Users size={15} />;
}

export default function AccountResearchPanel() {
  const [mode, setMode] = useState<KolPerformanceMode>('post_calls');
  const [view, setView] = useState<'performance' | 'profile'>('performance');
  const [handle, setHandle] = useState('');
  const [range, setRange] = useState<WindowRange>('30d');
  const [runs, setRuns] = useState<KolPerformanceRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRun, setSelectedRun] = useState<KolPerformanceRun | null>(null);
  const [profileRuns, setProfileRuns] = useState<KolProfileRun[]>([]);
  const [selectedProfileRunId, setSelectedProfileRunId] = useState('');
  const [profileRun, setProfileRun] = useState<KolProfileRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>('source_occurred_at');
  const [clock, setClock] = useState(Date.now());
  const { toast } = useToast();

  const refreshRuns = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await api.kolPerformance.list(mode);
      if (!response.ok) return toast(response.error || '研究批次加载失败', 'error');
      const next = response.data || [];
      setRuns(next);
      setSelectedRunId((current) => current || next[0]?.id || '');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [mode, toast]);

  useEffect(() => { void refreshRuns(true); }, [refreshRuns]);

  const refreshProfileRuns = useCallback(async (showLoading = false) => {
    if (showLoading) setProfileLoading(true);
    try {
      const response = await api.kolResearch.listProfileRuns();
      if (!response.ok) return toast(response.error || '账号画像历史加载失败', 'error');
      const next = response.data || [];
      setProfileRuns(next);
      setSelectedProfileRunId((current) => (
        current && next.some((run) => run.id === current) ? current : next[0]?.id || ''
      ));
    } finally {
      if (showLoading) setProfileLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    if (view === 'profile') void refreshProfileRuns(true);
  }, [refreshProfileRuns, view]);

  useEffect(() => {
    setSelectedRun(null);
    if (!selectedRunId || view !== 'performance') return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      const response = await api.kolPerformance.get(selectedRunId);
      if (cancelled) return;
      if (!response.ok || !response.data) {
        toast(response.error || '研究详情加载失败', 'error');
        return;
      }
      setSelectedRun(response.data);
      setRuns((current) => current.map((run) => run.id === response.data?.id ? {
        ...run,
        ...response.data,
        unique_ca_count: response.data.assets?.length ?? run.unique_ca_count,
        price_ready_count: response.data.assets?.filter((asset) => asset.price_status === 'completed').length
          ?? run.price_ready_count,
      } : run));
      if (['pending', 'extracting', 'pricing'].includes(response.data.status)) {
        timer = window.setTimeout(() => { void load(); }, 3_000);
      } else {
        void refreshRuns();
      }
    };
    void load();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [refreshRuns, selectedRunId, toast, view]);

  useEffect(() => {
    if (!isActiveStatus(selectedRun?.status)) return undefined;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [selectedRun?.id, selectedRun?.status]);

  useEffect(() => {
    setProfileRun(null);
    if (!selectedProfileRunId || view !== 'profile') return undefined;
    let cancelled = false;
    let timer: number | undefined;
    const load = async () => {
      const response = await api.kolResearch.getProfileRun(selectedProfileRunId);
      if (cancelled) return;
      if (!response.ok || !response.data) {
        toast(response.error || '账号画像详情加载失败', 'error');
        return;
      }
      setProfileRun(response.data);
      if (['pending', 'running'].includes(response.data.status)) {
        timer = window.setTimeout(() => { void load(); }, 3_000);
      } else {
        void refreshProfileRuns();
      }
    };
    void load();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [refreshProfileRuns, selectedProfileRunId, toast, view]);

  const assets = useMemo(() => {
    const next = [...(selectedRun?.assets || [])];
    return next.sort((left, right) => {
      if (sortKey === 'peak_multiple') return Number(right.peak_multiple || -Infinity) - Number(left.peak_multiple || -Infinity);
      return new Date(left.source_occurred_at).getTime() - new Date(right.source_occurred_at).getTime();
    });
  }, [selectedRun?.assets, sortKey]);

  const followEvents = useMemo(() => [...(selectedRun?.events || [])]
    .filter((event) => event.source_type === 'follow')
    .sort((left, right) => new Date(left.source_occurred_at).getTime() - new Date(right.source_occurred_at).getTime()),
  [selectedRun?.events]);

  const createPerformanceRun = async () => {
    const actor_handle = cleanHandle(handle);
    if (!actor_handle) return toast('请输入一个 X 账号', 'error');
    setCreating(true);
    try {
      const data = { actor_handle, sample_started_at: dateRange(range), sample_ended_at: null };
      const response = mode === 'post_calls'
        ? await api.kolPerformance.createPostRun(data) : await api.kolPerformance.createFollowRun(data);
      if (!response.ok || !response.data) return toast(response.error || '研究任务创建失败', 'error');
      setSelectedRunId(response.data.id);
      setSelectedRun(response.data);
      toast(response.data.deduplicated ? '已打开进行中的同一研究批次' : '研究任务已创建', 'success');
      void refreshRuns();
    } finally { setCreating(false); }
  };

  const createProfileRun = async () => {
    const actor_handle = cleanHandle(handle);
    if (!actor_handle) return toast('请输入一个 X 账号', 'error');
    setCreating(true);
    try {
      const response = await api.kolResearch.createProfileRun({ actor_handle });
      if (!response.ok || !response.data) return toast(response.error || '账号画像任务创建失败', 'error');
      setSelectedProfileRunId(response.data.id);
      setProfileRun(response.data);
      toast(response.data.deduplicated ? '已打开进行中的账号画像' : '账号画像任务已创建', 'success');
      void refreshProfileRuns();
    } finally { setCreating(false); }
  };

  const retryPrice = async () => {
    if (!selectedRun) return;
    setRetrying(true);
    try {
      const response = await api.kolPerformance.retryPrice(selectedRun.id);
      if (!response.ok) return toast(response.error || '行情重试不可用', 'error');
      setSelectedRun({ ...selectedRun, status: 'pending' });
      toast('缺失行情已重新进入只读回放队列', 'success');
    } finally { setRetrying(false); }
  };

  const switchMode = (next: KolPerformanceMode) => {
    setView('performance'); setMode(next); setSelectedRunId(''); setSelectedRun(null);
  };

  const metrics = selectedRun?.metrics || {};
  const progress = metrics.progress || {};
  const activeRun = isActiveStatus(selectedRun?.status);
  const totalAssets = Number(progress.total_assets ?? metrics.unique_ca_count ?? assets.length);
  const processedAssets = Number(progress.processed_assets ?? assets.filter((asset) => asset.price_status !== 'pending').length);
  const successfulAssets = Number(progress.successful_assets ?? metrics.price_ready_ca_count ?? 0);
  const unavailableAssets = Number(progress.unavailable_assets ?? metrics.missing_price_ca_count ?? 0);
  const currentAsset = assets.find((asset) => String(asset.id) === String(progress.current_asset_id || ''));
  const currentContract = progress.current_contract_address || currentAsset?.contract_address || null;
  const currentChain = progress.current_chain_id || currentAsset?.chain_id || null;
  const currentSymbol = progress.current_token_symbol || currentAsset?.token_symbol || currentAsset?.token_name || null;
  const currentAssetIndex = Number(progress.current_asset_index || 0);
  const totalFollowEvents = Number(progress.total_follow_events ?? progress.source_event_count ?? 0);
  const processedFollowEvents = Number(progress.processed_follow_events ?? 0);
  const currentFollowIndex = Number(progress.current_follow_index || 0);
  const currentTargetHandle = progress.current_target_handle || null;
  const pricingProgressPercent = totalAssets > 0
    ? Math.min(100, (processedAssets / totalAssets) * 100) : 0;
  const profile = profileRun?.result_json;

  return (
    <section className="kol-performance-shell">
      <div className="kol-performance-tabs" role="tablist" aria-label="KOL 账号研究模式">
        <button type="button" className={view === 'performance' && mode === 'post_calls' ? 'active' : ''} onClick={() => switchMode('post_calls')}><FileText size={15} />帖子喊单分析</button>
        <button type="button" className={view === 'performance' && mode === 'follow_discovery' ? 'active' : ''} onClick={() => switchMode('follow_discovery')}><Users size={15} />关注策略分析</button>
        <button type="button" className={`profile-tab${view === 'profile' ? ' active' : ''}`} onClick={() => setView('profile')}><BrainCircuit size={15} />账号画像</button>
      </div>

      {view === 'profile' ? (
        <div className="kol-performance-layout">
          <aside className="kol-performance-runs">
            <div className="kol-performance-runs-heading"><strong>账号画像批次</strong><span>{profileRuns.length} 条</span></div>
            <div className="kol-performance-run-list">
              {profileRuns.map((run) => <button type="button" key={run.id} className={selectedProfileRunId === run.id ? 'selected' : ''} onClick={() => setSelectedProfileRunId(run.id)}><span><BrainCircuit size={15} />{profileStatusLabel(run.status)}</span><strong>@{run.actor_handle}</strong><small>{time(run.created_at)}</small></button>)}
              {!profileLoading && !profileRuns.length && <div className="p16-empty-line">暂无账号画像批次</div>}
            </div>
          </aside>
          <div className="kol-profile-workspace">
            <header className="kol-performance-header"><div><h2>账号画像</h2><p>独立的 Grok 公开证据研究，不参与 CA 统计或收益计算。</p></div></header>
            <div className="kol-performance-input"><input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="输入 X 账号，例如 xueqiu88" /><button type="button" className="btn btn-primary" disabled={creating} onClick={createProfileRun}><SearchCheck size={15} />{creating ? '创建中...' : '开始账号画像'}</button></div>
            {!profileRun && <div className="p16-empty-line">{profileLoading ? '正在加载账号画像历史...' : '选择历史批次或创建新的账号画像'}</div>}
            {profileRun && <article className="kol-profile-result">
              <header><div><strong>@{profileRun.actor_handle}</strong><span>{profileStatusLabel(profileRun.status)}</span></div><small>{time(profileRun.created_at)}</small></header>
              {profile ? <div className="kol-profile-body">
                <div className="kol-profile-identity"><strong>{profileType(profile.account_type)}</strong><span>{profile.qualitative_rating === 'promising' ? '值得继续研究' : profile.qualitative_rating === 'high_risk' ? '风险较高' : profile.qualitative_rating === 'watch' ? '保持观察' : '证据不足'}</span></div>
                {profile.summary && <p>{profile.summary}</p>}
                {profile.relationship && <div className="kol-performance-note"><strong>关联</strong><span>{profile.relationship}</span></div>}
                {!!profile.evidence?.length && <div className="kol-profile-evidence">{profile.evidence.slice(0, 6).map((evidence) => <div key={evidence.evidence_id}><span>{evidence.handle ? `@${evidence.handle}` : evidence.source_type}</span><p>{evidence.excerpt || '已记录公开来源'}</p>{evidence.url && <a href={evidence.url} target="_blank" rel="noreferrer" title="打开证据来源"><ExternalLink size={13} /></a>}</div>)}</div>}
              </div> : profileRun.status === 'failed' ? <div className="kol-performance-error"><strong>{profileRun.error_code || 'PROFILE_FAILED'}</strong><span>{profileRun.last_error}</span></div> : <div className="p16-empty-line">正在检索公开证据...</div>}
            </article>}
          </div>
        </div>
      ) : (
        <div className="kol-performance-layout">
          <aside className="kol-performance-runs">
            <div className="kol-performance-runs-heading"><strong>{mode === 'post_calls' ? '帖子喊单批次' : '关注策略批次'}</strong><span>{runs.length} 条</span></div>
            <div className="kol-performance-run-list">
              {runs.map((run) => <button type="button" key={run.id} className={selectedRunId === run.id ? 'selected' : ''} onClick={() => setSelectedRunId(run.id)}><span><ModeIcon mode={run.mode} />{statusLabel(run.status)}</span><strong>@{run.actor_handle}</strong><small>{time(run.created_at)} · {run.unique_ca_count ?? 0} CA</small></button>)}
              {!loading && !runs.length && <div className="p16-empty-line">暂无研究批次</div>}
            </div>
          </aside>
          <div className="kol-performance-main">
            <header className="kol-performance-header">
              <div><h2>{mode === 'post_calls' ? '帖子喊单分析' : '关注策略分析'}</h2><p>{mode === 'post_calls' ? '帖子时间作为入场基准，回放至本批次固定截止时间。' : '读取系统实际观察到的关注事件；优先复用已有解析结果，缺失时使用 Grok 与链上只读核验补充 CA。'}</p></div>
              {selectedRun && ['price_retry', 'price_unavailable'].includes(selectedRun.status) && <button type="button" className="btn btn-secondary" disabled={retrying} onClick={retryPrice}><RefreshCw size={15} className={retrying ? 'spin' : ''} />重试行情</button>}
            </header>
            <div className="kol-performance-input">
              <input value={handle} onChange={(event) => setHandle(event.target.value)} placeholder="输入一个 X 账号，例如 xueqiu88" />
              <div className="kol-performance-range" aria-label="样本时间"><button type="button" className={range === '7d' ? 'active' : ''} onClick={() => setRange('7d')}>7天</button><button type="button" className={range === '30d' ? 'active' : ''} onClick={() => setRange('30d')}>30天</button><button type="button" className={range === 'all' ? 'active' : ''} onClick={() => setRange('all')}>至今</button></div>
              <button type="button" className="btn btn-primary" disabled={creating} onClick={createPerformanceRun}><SearchCheck size={15} />{creating ? '创建中...' : '开始分析'}</button>
            </div>
            <div className="kol-performance-meta">{selectedRun ? <><span className={`kol-performance-state is-${selectedRun.status}`}>{activeRun && <LoaderCircle size={13} className="spin" />}{statusLabel(selectedRun.status)}</span>{activeRun ? <><span>已运行 {duration(selectedRun.started_at || selectedRun.created_at, clock)}</span><span>最后更新 {time(progress.updated_at || selectedRun.updated_at)}</span></> : <><span>完成于 {time(selectedRun.completed_at)}</span><span>总耗时 {duration(selectedRun.started_at || selectedRun.created_at, selectedRun.completed_at)}</span></>}{selectedRun.last_error && <span className="is-error">{selectedRun.error_code ? `${selectedRun.error_code}：${selectedRun.last_error}` : selectedRun.last_error}</span>}</> : <span>选择历史批次或创建新的分析</span>}</div>
            {selectedRun && activeRun && <section className="kol-run-progress" aria-live="polite">
              <header><div><LoaderCircle size={16} className="spin" /><strong>任务运行中</strong><span>{progressStageLabel(selectedRun)}</span></div><b>{selectedRun.status === 'pricing' ? `已完成 ${processedAssets}/${totalAssets}` : selectedRun.status === 'extracting' && mode === 'follow_discovery' ? `已检查 ${processedFollowEvents}/${totalFollowEvents}` : selectedRun.status === 'extracting' ? '阶段 1/2' : '等待启动'}</b></header>
              <div className={`kol-run-progress-track${selectedRun.status === 'pricing' ? '' : ' is-indeterminate'}`}><i style={selectedRun.status === 'pricing' ? { width: `${pricingProgressPercent}%` } : undefined} /></div>
              <div className="kol-run-progress-stats">
                <div><span>当前阶段</span><strong>{progressStageLabel(selectedRun)}</strong></div>
                <div><span>{selectedRun.status === 'extracting' && mode === 'follow_discovery' ? '关注进度' : 'CA 进度'}</span><strong>{selectedRun.status === 'pricing' ? currentContract ? `处理中 ${currentAssetIndex || processedAssets + 1}/${totalAssets}` : `已完成 ${processedAssets}/${totalAssets}` : selectedRun.status === 'extracting' && mode === 'follow_discovery' ? currentTargetHandle ? `处理中 ${currentFollowIndex}/${totalFollowEvents}` : `已检查 ${processedFollowEvents}/${totalFollowEvents}` : '等待识别完成'}</strong></div>
                <div><span>{selectedRun.status === 'extracting' && mode === 'follow_discovery' ? '已确认 / 失败' : '成功 / 缺失'}</span><strong>{selectedRun.status === 'extracting' && mode === 'follow_discovery' ? `${progress.resolved_follow_events ?? 0} / ${progress.failed_follow_events ?? 0}` : `${successfulAssets} / ${unavailableAssets}`}</strong></div>
                <div><span>本阶段耗时</span><strong>{duration(progress.current_started_at || progress.updated_at || selectedRun.started_at, clock)}</strong></div>
              </div>
              {selectedRun.status === 'pricing' && <div className="kol-run-current-ca">
                <div><strong>{currentContract ? `正在处理 CA ${progress.current_asset_index || processedAssets + 1}/${totalAssets}` : `准备下一个 CA（已处理 ${processedAssets}/${totalAssets}）`}</strong><span>{currentContract ? `${chainLabel(currentChain)}${currentSymbol ? ` · ${currentSymbol}` : ''}` : '进度将在下一个 GMGN 请求发出前更新'}</span></div>
                <code title={currentContract || undefined}>{currentContract || '--'}</code>
              </div>}
              {selectedRun.status === 'extracting' && mode === 'follow_discovery' && <div className="kol-run-current-ca">
                <div><strong>{currentTargetHandle ? `正在研究关注账号 ${currentFollowIndex}/${totalFollowEvents}` : `准备下一个关注账号（已检查 ${processedFollowEvents}/${totalFollowEvents}）`}</strong><span>优先复用已有策略结果；缺失时调用 Grok 并做链上只读核验</span></div>
                <code title={currentTargetHandle ? `@${currentTargetHandle}` : undefined}>{currentTargetHandle ? `@${currentTargetHandle}` : '--'}</code>
              </div>}
            </section>}
            {selectedRun && !activeRun && <section className={`kol-run-terminal is-${selectedRun.status}`}>
              <div><strong>{statusLabel(selectedRun.status)}</strong><span>{terminalSummary(selectedRun)}</span></div>
              <div><span>行情截止</span><strong>{time(selectedRun.as_of_at)}</strong></div>
            </section>}
            <div className="kol-performance-metrics">
              <div><span>{mode === 'post_calls' ? '原始帖子' : '实际关注事件'}</span><strong>{metrics.raw_event_count ?? '--'}</strong></div><div><span>解析成功 CA</span><strong>{metrics.parsed_ca_count ?? '--'}</strong></div><div><span>唯一 CA</span><strong>{metrics.unique_ca_count ?? '--'}</strong></div><div><span>有效价格 CA</span><strong>{metrics.price_ready_ca_count ?? '--'}</strong></div><div><span>胜率</span><strong className="is-positive">{percent(metrics.win_rate)}</strong></div><div><span>平均最高倍数</span><strong>{multiple(metrics.average_peak_multiple)}</strong></div><div><span>中位最高倍数</span><strong>{multiple(metrics.median_peak_multiple)}</strong></div><div><span>最高最高倍数</span><strong className="is-positive">{multiple(metrics.best_peak_multiple)}</strong></div>
            </div>
            <div className="kol-performance-summary">
              <div><strong>采样覆盖</strong><span>{mode === 'follow_discovery' ? `已监听事件 ${metrics.raw_event_count ?? 0} 条` : `${time(metrics.source_earliest_at)} 至 ${time(metrics.source_latest_at)}；主体${metrics.source_coverage_complete === false ? '覆盖不完整' : '覆盖完整'}；6551 共 ${metrics.source_request_count ?? 0} 次`}</span></div>
              <div><strong>{mode === 'post_calls' ? '帖子构成' : '解析结果'}</strong><span>{mode === 'post_calls' ? `原帖 ${metrics.source_type_counts?.tweet ?? 0} · 引用 ${metrics.source_type_counts?.quote ?? 0} · 回复 ${metrics.source_type_counts?.reply ?? 0}` : `已确认 CA ${metrics.parsed_ca_count ?? 0} · 未确认 ${Math.max(0, Number(metrics.raw_event_count || 0) - Number(metrics.parsed_ca_count || 0))}`}</span></div>
              {mode === 'post_calls' ? <div><strong>6551 请求构成</strong><span>{`主体 ${metrics.source_primary_request_count ?? 0} 次 · 成功 ${metrics.source_successful_request_count ?? 0} 次 · 回复补采 ${metrics.reply_sample_request_count ?? 0} 次 / ${metrics.reply_sample_count ?? 0} 条${metrics.reply_sample_complete ? '（完整）' : '（近期样本）'}`}</span></div> : null}
              <div><strong>{mode === 'post_calls' ? 'Grok 语义研究' : '历史行情'}</strong><span>{mode === 'post_calls' ? `本地 CA ${metrics.direct_ca_count ?? 0} · 送研 ${metrics.grok_post_count ?? 0} 帖 / ${metrics.grok_batch_count ?? 0} 批 · xAI ${metrics.grok_request_count ?? 0} 次 · 搜索 ${metrics.grok_search_tool_calls ?? 0} 次 · 失败 ${metrics.provider_failed_count ?? 0}` : `有效 ${metrics.price_ready_ca_count ?? 0} · 缺失 ${metrics.missing_price_ca_count ?? 0}`}</span></div>
              {mode === 'post_calls' && (metrics.source_error_code || metrics.reply_sample_error_code) ? <div><strong>数据源诊断</strong><span className="is-error">{metrics.source_error_code ? `${metrics.source_error_code}：${metrics.source_error_detail || '主体采样中断'}` : `${metrics.reply_sample_error_code}：${metrics.reply_sample_error_detail || '回复补采失败'}`}</span></div> : null}
              {selectedRun?.reason_codes?.length ? <div><strong>批次说明</strong><span>{selectedRun.reason_codes.map(reasonLabel).join('；')}</span></div> : null}
            </div>
            {mode === 'follow_discovery' && <article className="kol-performance-table-panel">
              <header><h3>关注事件解析明细</h3><span>{followEvents.length} 条实际关注</span></header>
              <div className="kol-performance-table-wrap"><table><thead><tr><th>关注账号</th><th>关注时间</th><th>解析状态</th><th>链 / CA</th><th>说明</th></tr></thead><tbody>{followEvents.map((event) => <tr key={event.id}><td><strong>@{event.target_handle || '--'}</strong></td><td>{time(event.source_occurred_at)}</td><td><strong className={event.extraction_status === 'resolved' ? 'is-positive' : event.extraction_status === 'provider_failed' ? 'is-negative' : ''}>{followEventStatus(event)}</strong></td><td>{event.contract_address ? <small><span>{chainLabel(event.chain_id)}</span> · <code title={event.contract_address}>{shortAddress(event.contract_address)}</code></small> : '--'}</td><td><small>{followEventDetail(event)}</small></td></tr>)}</tbody></table></div>
              {!followEvents.length && <div className="p16-empty-line">所选窗口内没有系统实际监听到的关注事件</div>}
            </article>}
            <article className="kol-performance-table-panel">
              <header><h3>逐 CA 回放明细</h3><span>{assets.length} 个唯一 CA</span></header>
              <div className="kol-performance-table-wrap"><table><thead><tr><th>来源</th><th>链 / 代币 / CA</th><th><button type="button" onClick={() => setSortKey('source_occurred_at')}>触发时间 <ArrowUpDown size={12} /></button></th><th>入场价</th><th>最高价</th><th><button type="button" onClick={() => setSortKey('peak_multiple')}>最高倍数 <ArrowUpDown size={12} /></button></th><th>最高点时间</th><th>证据</th></tr></thead><tbody>{assets.map((asset) => { const evidence = asset.evidence_json || {}; const url = typeof evidence.url === 'string' ? evidence.url : asset.source_url; const isCurrent = activeRun && String(progress.current_asset_id || '') === String(asset.id); const priceState = isCurrent ? `正在回放 ${progress.current_asset_index || ''}/${totalAssets}` : asset.price_status === 'completed' ? '已回放' : asset.price_status === 'retry' ? '已暂停，等待重试' : asset.price_status === 'no_data' ? '无有效行情' : asset.price_status === 'failed' ? '行情失败' : activeRun ? '排队中' : '未完成'; return <tr key={asset.id} className={isCurrent ? 'is-current' : ''}><td><strong>{sourceLabel(asset)}</strong><small title={asset.price_error_detail || undefined}>{priceState}</small></td><td><strong>{asset.token_symbol || asset.token_name || chainLabel(asset.chain_id)}</strong><small><span>{chainLabel(asset.chain_id)}</span> · <code title={asset.contract_address}>{shortAddress(asset.contract_address)}</code></small></td><td>{time(asset.source_occurred_at)}</td><td>{price(asset.entry_price)}</td><td>{price(asset.peak_price)}</td><td className={Number(asset.peak_multiple) > 1 ? 'is-positive' : Number.isFinite(Number(asset.peak_multiple)) ? 'is-negative' : ''}>{multiple(asset.peak_multiple)}</td><td>{time(asset.peak_candle_at)}</td><td>{url ? <a href={url} target="_blank" rel="noreferrer" title="打开原始证据"><ExternalLink size={14} /></a> : '--'}</td></tr>; })}</tbody></table></div>
              {!assets.length && <div className="p16-empty-line">{selectedRun?.status === 'no_samples' ? (mode === 'follow_discovery' ? followEvents.length ? '关注事件已完成解析，但没有可确认的 CA；请查看上方逐条说明' : '所选窗口内没有系统已监听的关注事件' : '已完成采样和 Grok 研究，没有可确认的 CA') : selectedRun?.status === 'failed' ? '研究 Provider 失败，请查看上方错误详情' : '等待研究结果'}</div>}
            </article>
          </div>
        </div>
      )}
    </section>
  );
}
