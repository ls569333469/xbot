import { Check, Copy, FilePlus2, Layers3, Pause, Pencil, Play, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChainIcon } from '../components/ui/ChainIcon';
import { DataTable } from '../components/ui/DataTable';
import { ProgressBar } from '../components/ui/ProgressBar';
import { TableSkeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/ToastContext';
import { api } from '../lib/api';
import type {
  KolAccount,
  LaunchMonitor,
  WhitelistDraftPayload,
  WhitelistEntry,
  WhitelistTemplate,
  WhitelistTemplateSyncPlan,
} from '../lib/types';
import ResearchWorkspace from './whitelist/ResearchWorkspace';
import LaunchMonitorWorkspace from './whitelist/LaunchMonitorWorkspace';
import { strategySummary } from './whitelist/strategy-presets';
import WhitelistWorkspace from './whitelist/WhitelistWorkspace';

const CHAINS = ['all', 'sol', 'bsc', 'base', 'eth', 'robinhood'] as const;

function normalizeHandle(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

function TokenLogo({ url, symbol }: { url?: string | null; symbol?: string | null }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(url) && failedUrl !== url;
  return <span className="p16-token-logo">{showImage
    ? <img src={url || ''} alt="" referrerPolicy="no-referrer" onError={() => setFailedUrl(url || null)} />
    : <span>{symbol?.trim().slice(0, 1).toUpperCase() || '?'}</span>}</span>;
}

function statusLabel(status: WhitelistEntry['status']) {
  return {
    active: '已启用',
    paused: '已暂停',
    exhausted: '预算已用完',
    expired: '已过期',
    archived: '已归档',
  }[status];
}

function activationLabel(state: WhitelistEntry['live_activation_state']) {
  return {
    syncing: '同步中',
    live_ready: '可实盘',
    sync_failed: '同步失败',
  }[state] || '待同步';
}

function activationErrorLabel(item: WhitelistEntry) {
  const labels: Record<string, string> = {
    WATCH_SYNC_PENDING: '等待 6551 Watch 同步',
    ACTIVATION_QUOTE_EMPTY: 'GMGN 报价不可用',
    CHAIN_RPC_UNAVAILABLE: '链 RPC 暂不可用',
    WHITELIST_ACTIVATION_CONFIG_INVALID: '白名单交易配置无效',
    TOKEN_ADDRESS_INVALID: 'CA 格式无效',
    EXIT_STRATEGY_INVALID: '离场策略无效',
    LIVE_CHAIN_UNSUPPORTED: '该链尚未开放真实交易',
  };
  return labels[item.activation_error_code || '']
    || item.activation_error_detail
    || item.activation_error_code
    || '等待后台完成交易准备';
}

function launchStatusLabel(status: LaunchMonitor['status']) {
  return { active: '监控中', paused: '已暂停', triggered: '已发现', expired: '已过期' }[status];
}

interface WhitelistPageProps {
  initialWhitelistId?: string | null;
  onInitialWorkspaceClose?: () => void;
}

export default function WhitelistPage({ initialWhitelistId, onInitialWorkspaceClose }: WhitelistPageProps = {}) {
  const [data, setData] = useState<WhitelistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [chainFilter, setChainFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [templates, setTemplates] = useState<WhitelistTemplate[]>([]);
  const [kolAccounts, setKolAccounts] = useState<KolAccount[]>([]);
  const [productMode, setProductMode] = useState<'known' | 'launch'>('known');
  const [view, setView] = useState<'list' | 'workspace' | 'launch-workspace' | 'research'>('list');
  const [editing, setEditing] = useState<WhitelistEntry | null>(null);
  const [launchData, setLaunchData] = useState<LaunchMonitor[]>([]);
  const [launchTotal, setLaunchTotal] = useState(0);
  const [launchLoading, setLaunchLoading] = useState(false);
  const [editingLaunch, setEditingLaunch] = useState<LaunchMonitor | null>(null);
  const [draftSeed, setDraftSeed] = useState<WhitelistDraftPayload | null>(null);
  const [workspaceVersion, setWorkspaceVersion] = useState(0);
  const [activationRetryId, setActivationRetryId] = useState<string | null>(null);
  const [editLoadingId, setEditLoadingId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [syncTargetIds, setSyncTargetIds] = useState<string[]>([]);
  const [syncTemplateId, setSyncTemplateId] = useState('');
  const [syncPlan, setSyncPlan] = useState<WhitelistTemplateSyncPlan | null>(null);
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncExecuting, setSyncExecuting] = useState(false);
  const handledInitialId = useRef<string | null>(null);
  const { toast } = useToast();

  const fetchData = useCallback(async () => {
    setLoading(true);
    const params: Record<string, string> = { page: String(page), pageSize: '20', summary: 'true' };
    if (chainFilter !== 'all') params.chain_id = chainFilter;
    if (search.trim()) params.search = search.trim();
    const response = await api.whitelist.list(params);
    if (response.ok) {
      setData((response.data as unknown as WhitelistEntry[]) || []);
      setTotal(response.total || 0);
    }
    setLoading(false);
  }, [page, chainFilter, search]);

  const fetchTemplates = useCallback(async () => {
    const response = await api.whitelist.templates.list();
    if (response.ok && response.data) setTemplates(response.data);
  }, []);

  const fetchLaunchData = useCallback(async () => {
    if (productMode !== 'launch') return;
    setLaunchLoading(true);
    const params: Record<string, string> = { page: String(page), pageSize: '20' };
    if (chainFilter !== 'all') params.chain_id = chainFilter;
    if (search.trim()) params.search = search.trim();
    const response = await api.launchMonitors.list(params);
    if (response.ok) {
      setLaunchData(response.data || []);
      setLaunchTotal(response.total || 0);
    }
    setLaunchLoading(false);
  }, [chainFilter, page, productMode, search]);

  useEffect(() => { void fetchData(); }, [fetchData]);
  useEffect(() => { void fetchLaunchData(); }, [fetchLaunchData]);
  useEffect(() => { void fetchTemplates(); }, [fetchTemplates]);

  const toggleSelected = (id: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const togglePageSelection = () => {
    const pageIds = data.map((item) => item.id);
    const allSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    setSelectedIds((current) => {
      const next = new Set(current);
      pageIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  };

  const openTemplateSync = () => {
    const targetIds = [...selectedIds];
    if (targetIds.length === 0) return;
    const firstTarget = data.find((item) => item.id === targetIds[0]);
    const defaultTemplate = firstTarget
      ? templates.find((item) => item.chain_id === firstTarget.chain_id && item.is_default)
      : null;
    setSyncTargetIds(targetIds);
    setSyncTemplateId(defaultTemplate?.id || templates[0]?.id || '');
    setSyncPlan(null);
    setSyncOpen(true);
  };

  const closeTemplateSync = () => {
    if (syncLoading || syncExecuting) return;
    setSyncOpen(false);
    setSyncPlan(null);
    setSyncTargetIds([]);
  };

  const previewTemplateSync = async () => {
    if (!syncTemplateId || syncTargetIds.length === 0) return;
    setSyncLoading(true);
    const response = await api.whitelist.templateSync.preview({
      template_id: syncTemplateId,
      whitelist_ids: syncTargetIds,
    });
    setSyncLoading(false);
    if (!response.ok || !response.data) return toast(response.error || '同步预览失败', 'error');
    setSyncPlan(response.data);
  };

  const executeTemplateSync = async () => {
    if (!syncPlan || syncExecuting) return;
    setSyncExecuting(true);
    const response = await api.whitelist.templateSync.execute({
      template_id: syncPlan.template.id,
      whitelist_ids: syncTargetIds,
      expected_template_version: syncPlan.template.version,
    });
    setSyncExecuting(false);
    if (!response.ok || !response.data) return toast(response.error || '模板同步失败', 'error');
    setSyncPlan(response.data);
    setSelectedIds((current) => {
      const next = new Set(current);
      syncTargetIds.forEach((id) => next.delete(id));
      return next;
    });
    void fetchData();
    toast(`模板同步完成：${response.data.summary.updated} 个已更新，${response.data.summary.skipped} 个跳过`, 'success');
  };
  const ensureWorkspaceDependencies = useCallback(async () => {
    const [templateResponse, kolResponse] = await Promise.all([
      api.whitelist.templates.list(),
      api.kol.list(),
    ]);
    if (!templateResponse.ok || !kolResponse.ok) {
      toast(templateResponse.error || kolResponse.error || '白名单工作区数据加载失败', 'error');
      return false;
    }
    setTemplates(templateResponse.data || []);
    setKolAccounts(kolResponse.data || []);
    return true;
  }, [toast]);

  const openCreate = async () => {
    if (!await ensureWorkspaceDependencies()) return;
    setEditing(null);
    setDraftSeed(null);
    setWorkspaceVersion((value) => value + 1);
    setView('workspace');
  };

  const openEditById = useCallback(async (id: string) => {
    setEditLoadingId(id);
    const [response, dependenciesReady] = await Promise.all([
      api.whitelist.get(id),
      ensureWorkspaceDependencies(),
    ]);
    setEditLoadingId(null);
    if (!dependenciesReady || !response.ok || !response.data) {
      toast(response.error || '白名单详情加载失败', 'error');
      return false;
    }
    setEditing(response.data);
    setDraftSeed(response.data);
    setWorkspaceVersion((value) => value + 1);
    setView('workspace');
    return true;
  }, [ensureWorkspaceDependencies, toast]);

  const openEdit = async (item: WhitelistEntry) => {
    await openEditById(item.id);
  };

  useEffect(() => {
    const id = String(initialWhitelistId || '').trim();
    if (!id) {
      handledInitialId.current = null;
      return;
    }
    if (handledInitialId.current === id) return;
    handledInitialId.current = id;
    if (!/^[1-9]\d*$/.test(id)) {
      toast('固定项目链接无效，已返回项目列表', 'error');
      onInitialWorkspaceClose?.();
      return;
    }
    void openEditById(id).then((opened) => {
      if (!opened) onInitialWorkspaceClose?.();
    });
  }, [initialWhitelistId, onInitialWorkspaceClose, openEditById, toast]);

  const openResearch = (draft: WhitelistDraftPayload = {}) => {
    setDraftSeed(draft);
    setView('research');
  };

  const openLaunchCreate = async () => {
    if (!await ensureWorkspaceDependencies()) return;
    setEditingLaunch(null);
    setWorkspaceVersion((value) => value + 1);
    setView('launch-workspace');
  };

  const openLaunchEdit = async (item: LaunchMonitor) => {
    if (item.status === 'triggered') return;
    if (!await ensureWorkspaceDependencies()) return;
    setEditingLaunch(item);
    setWorkspaceVersion((value) => value + 1);
    setView('launch-workspace');
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除这条白名单？历史信号和交易记录会保留。')) return;
    const response = await api.whitelist.remove(id);
    if (!response.ok) return toast(response.error || '删除失败', 'error');
    toast('白名单已移除，历史记录已保留', 'success');
    void fetchData();
  };

  const handleToggleStatus = async (item: WhitelistEntry) => {
    const next = item.status === 'active' ? 'paused' : 'active';
    const response = await api.whitelist.updateStatus(item.id, next);
    if (!response.ok) return toast(response.error || '状态更新失败', 'error');
    toast(next === 'active' ? '白名单已启用' : '白名单已暂停', 'success');
    void fetchData();
  };

  const handleActivationRetry = async (item: WhitelistEntry) => {
    setActivationRetryId(item.id);
    const response = await api.whitelist.retryActivation(item.id);
    setActivationRetryId(null);
    if (!response.ok) return toast(response.error || '重新同步失败', 'error');
    toast('已重新同步该白名单', 'success');
    void fetchData();
  };

  const handleLaunchDelete = async (item: LaunchMonitor) => {
    if (item.status === 'triggered') return;
    if (!confirm('确认删除这条未发币监控？')) return;
    const response = await api.launchMonitors.remove(item.id);
    if (!response.ok) return toast(response.error || '删除失败', 'error');
    toast('未发币监控已删除', 'success');
    void fetchLaunchData();
  };

  const handleLaunchToggle = async (item: LaunchMonitor) => {
    if (item.status === 'triggered' || item.status === 'expired') return;
    const next = item.status === 'active' ? 'paused' : 'active';
    const response = await api.launchMonitors.updateStatus(item.id, next);
    if (!response.ok) return toast(response.error || '状态更新失败', 'error');
    toast(next === 'active' ? '未发币监控已启用' : '未发币监控已暂停', 'success');
    void fetchLaunchData();
  };

  if (view === 'research') {
    return <ResearchWorkspace draft={draftSeed || {}} onBack={() => void openCreate()} onUseDraft={(draft) => {
      void ensureWorkspaceDependencies().then((ready) => {
        if (!ready) return;
      setDraftSeed(draft);
      setWorkspaceVersion((value) => value + 1);
      setView('workspace');
      });
    }} />;
  }

  if (view === 'workspace') {
    return <WhitelistWorkspace key={workspaceVersion} seed={draftSeed} editing={editing} whitelists={data} templates={templates} kolAccounts={kolAccounts} onCancel={() => { setView('list'); onInitialWorkspaceClose?.(); }} onOpenResearch={openResearch} onSaved={() => {
      setView('list');
      onInitialWorkspaceClose?.();
      void fetchData();
    }} onTemplatesChanged={fetchTemplates} />;
  }

  if (view === 'launch-workspace') {
    return <LaunchMonitorWorkspace key={workspaceVersion} editing={editingLaunch} templates={templates} kolAccounts={kolAccounts} onCancel={() => setView('list')} onSaved={() => {
      setView('list');
      void fetchLaunchData();
    }} />;
  }

  const columns = [
    { header: '选择', accessor: (row: WhitelistEntry) => <input className="p42-row-checkbox" type="checkbox" checked={selectedIds.has(row.id)} onChange={() => toggleSelected(row.id)} aria-label={`选择 ${row.symbol || row.contract_address}`} /> },
    { header: '链', accessor: (row: WhitelistEntry) => <ChainIcon chain={row.chain_id} size="sm" /> },
    { header: '代币', accessor: (row: WhitelistEntry) => <div className="p16-table-token-cell"><TokenLogo url={row.token_logo_url} symbol={row.symbol} /><div className="p16-table-token"><strong>{row.symbol || '-'}</strong><span>{row.project_name || row.contract_address}</span></div></div> },
    { header: '触发规则', accessor: (row: WhitelistEntry) => {
      const ecosystemSources = (row.direct_sources || []).filter((item) => item.source_kind === 'ecosystem');
      const launchSources = (row.direct_sources || []).filter((item) => item.source_kind === 'launch');
      const ecosystemSourceCount = row.ecosystem_source_count ?? ecosystemSources.length;
      const launchSourceCount = row.launch_source_count ?? launchSources.length;
      const relationCount = row.relation_count ?? row.relations?.length ?? 0;
      const selectedHandles = new Set(row.selected_actor_handles?.map(normalizeHandle) || [
        ...ecosystemSources.map((item) => normalizeHandle(item.actor_handle)),
        ...(row.relations || []).map((item) => normalizeHandle(item.actor_handle)),
      ]);
      const coverage = `${selectedHandles.size} 个唯一账号`;
      return <div className="p16-table-rules"><strong>{ecosystemSourceCount} CA 动态 · {relationCount} 互动</strong><span>{launchSourceCount ? `含首发来源审计 · ${coverage}` : coverage}</span></div>;
    } },
    { header: '单笔金额', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.budget_per_trade}</span> },
    { header: '累计预算', accessor: (row: WhitelistEntry) => <div style={{ width: 110 }}><ProgressBar value={Number(row.spent_budget) || 0} max={Number(row.total_budget)} /></div> },
    { header: '离场策略', accessor: (row: WhitelistEntry) => <span className="p16-strategy-summary" title={strategySummary(row.exit_strategy)}>{row.exit_strategy?.legs?.length || 2} 条条件</span> },
    { header: '买入', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.current_buy_count || 0}/{row.max_repeat_buys}</span> },
    { header: '状态', accessor: (row: WhitelistEntry) => <div className="p17-whitelist-status">
      <button type="button" className={`p16-status-button ${row.status}`} onClick={() => handleToggleStatus(row)}>{statusLabel(row.status)}</button>
      {row.status === 'active' && <span className={`p17-activation-state ${row.live_activation_state || 'syncing'}`} title={activationErrorLabel(row)}>
        {activationLabel(row.live_activation_state || 'syncing')}
      </span>}
      {row.status === 'active' && row.live_activation_state === 'sync_failed' && <button type="button" className="p17-activation-retry"
        disabled={activationRetryId === row.id} onClick={() => void handleActivationRetry(row)}>
        <RefreshCw size={12} className={activationRetryId === row.id ? 'icon-spin' : ''} /> 重新同步
      </button>}
    </div> },
    { header: '操作', accessor: (row: WhitelistEntry) => <div className="p16-table-actions"><button type="button" className="p16-icon-button" title="复制 CA" aria-label="复制 CA" onClick={() => { void navigator.clipboard.writeText(row.contract_address); toast('CA 已复制', 'success'); }}><Copy size={15} /></button><button type="button" className="p16-icon-button" title="编辑白名单" aria-label="编辑白名单" disabled={editLoadingId !== null} onClick={() => void openEdit(row)}>{editLoadingId === row.id ? <RefreshCw size={15} className="icon-spin" /> : <Pencil size={15} />}</button><button type="button" className="p16-icon-button danger" title="删除白名单" aria-label="删除白名单" onClick={() => handleDelete(row.id)}><Trash2 size={15} /></button></div> },
  ];

  const launchColumns = [
    { header: '链', accessor: (row: LaunchMonitor) => <ChainIcon chain={row.chain_id} size="sm" /> },
    { header: '项目', accessor: (row: LaunchMonitor) => <div className="p16-table-token"><strong>{row.project_name || '未命名项目'}</strong><span>尚无 CA</span></div> },
    { header: '项目账号', accessor: (row: LaunchMonitor) => <div className="p161-account-stack">{row.sources.slice(0, 2).map((item) => <span key={item.id || item.actor_handle}>@{item.actor_handle}</span>)}{row.sources.length > 2 && <small>+{row.sources.length - 2}</small>}</div> },
    { header: '生态互动', accessor: (row: LaunchMonitor) => <span>{row.relations.length} 条</span> },
    { header: '单笔 / 上限', accessor: (row: LaunchMonitor) => <span className="font-mono">{row.budget_per_trade} / {row.total_budget}</span> },
    { header: '离场策略', accessor: (row: LaunchMonitor) => <span className="p16-strategy-summary" title={strategySummary(row.exit_strategy)}>{row.exit_strategy?.legs?.length || 0} 条条件</span> },
    { header: '发现结果', accessor: (row: LaunchMonitor) => {
      const discovery = row.discoveries?.[0];
      return discovery ? <button type="button" className="p161-ca-result" title="复制已发现 CA" onClick={() => { void navigator.clipboard.writeText(discovery.contract_address); toast('CA 已复制', 'success'); }}>{discovery.contract_address.slice(0, 7)}...{discovery.contract_address.slice(-5)}<Copy size={13} /></button> : <span className="p161-waiting">等待 CA</span>;
    } },
    { header: '状态', accessor: (row: LaunchMonitor) => row.status === 'active' || row.status === 'paused' ? <button type="button" className={`p16-status-button ${row.status}`} onClick={() => handleLaunchToggle(row)}>{launchStatusLabel(row.status)}</button> : <span className={`p16-status-button ${row.status}`}>{launchStatusLabel(row.status)}</span> },
    { header: '操作', accessor: (row: LaunchMonitor) => <div className="p16-table-actions">{(row.status === 'active' || row.status === 'paused') && <><button type="button" className="p16-icon-button" title={row.status === 'active' ? '暂停监控' : '启用监控'} aria-label={row.status === 'active' ? '暂停监控' : '启用监控'} onClick={() => handleLaunchToggle(row)}>{row.status === 'active' ? <Pause size={15} /> : <Play size={15} />}</button><button type="button" className="p16-icon-button" title="编辑未发币监控" aria-label="编辑未发币监控" onClick={() => openLaunchEdit(row)}><Pencil size={15} /></button><button type="button" className="p16-icon-button danger" title="删除未发币监控" aria-label="删除未发币监控" onClick={() => handleLaunchDelete(row)}><Trash2 size={15} /></button></>}</div> },
  ];

  const switchProductMode = (mode: 'known' | 'launch') => {
    setProductMode(mode);
    setPage(1);
    setSearch('');
  };

  return (
    <div className="flex flex-col gap-lg">
      <div className="p161-product-switch" aria-label="白名单类型">
        <button type="button" className={productMode === 'known' ? 'active' : ''} onClick={() => switchProductMode('known')}>已知 CA</button>
        <button type="button" className={productMode === 'launch' ? 'active' : ''} onClick={() => switchProductMode('launch')}>未发币监控</button>
      </div>
      {productMode === 'known' && <div className="p42-selection-bar"><span><strong>{selectedIds.size}</strong> 个固定 CA 已选择</span><div><button type="button" className="p42-selection-button" disabled={data.length === 0} onClick={togglePageSelection}><Check size={14} />选择本页</button><button type="button" className="p42-selection-button" disabled={selectedIds.size === 0} onClick={() => setSelectedIds(new Set())}>清除选择</button></div></div>}
      <div className="p16-list-toolbar">
        <div className="p16-chain-filter">{CHAINS.map((chain) => <button type="button" key={chain} className={chainFilter === chain ? 'active' : ''} onClick={() => { setChainFilter(chain); setPage(1); }}>{chain === 'all' ? '全部' : chain.toUpperCase()}</button>)}</div>
        <div className="p16-list-actions"><div className="p16-search-field"><Search size={16} /><input value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder={productMode === 'known' ? '搜索 CA / 代币 / 项目' : '搜索项目 / X 账号'} /></div>{productMode === 'known' ? <><button type="button" className="btn btn-secondary" disabled={selectedIds.size === 0} onClick={openTemplateSync}><Layers3 size={16} />模板同步</button><button type="button" className="btn btn-secondary" onClick={() => openResearch({})}><Search size={16} />快速投研</button><button type="button" className="btn btn-primary" onClick={() => void openCreate()}><FilePlus2 size={16} />添加白名单</button></> : <button type="button" className="btn btn-primary" onClick={() => void openLaunchCreate()}><FilePlus2 size={16} />添加未发币监控</button>}</div>
      </div>

      {productMode === 'known'
        ? loading ? <TableSkeleton rows={6} cols={9} /> : <DataTable data={data} columns={columns} />
        : launchLoading ? <TableSkeleton rows={6} cols={9} /> : <DataTable data={launchData} columns={launchColumns} />}
      {(productMode === 'known' ? total : launchTotal) > 20 && !(productMode === 'known' ? loading : launchLoading) && <div className="p16-pagination"><button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>上一页</button><span>第 {page} 页 / 共 {Math.ceil((productMode === 'known' ? total : launchTotal) / 20)} 页</span><button className="btn btn-secondary" disabled={page >= Math.ceil((productMode === 'known' ? total : launchTotal) / 20)} onClick={() => setPage((value) => value + 1)}>下一页</button></div>}
      {syncOpen && <div className="p42-sync-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeTemplateSync(); }}>
        <section className="p42-sync-panel" role="dialog" aria-modal="true" aria-label="模板同步">
          <div className="p42-sync-head"><div><strong>模板同步</strong><span>{syncTargetIds.length} 个固定 CA · 先预览，再确认</span></div><button type="button" className="p16-icon-button" title="关闭" aria-label="关闭模板同步" onClick={closeTemplateSync}><X size={16} /></button></div>
          {!syncPlan
            ? <div className="p42-sync-body"><label className="p42-sync-template-field"><span>选择配置模板</span><select className="input" value={syncTemplateId} onChange={(event) => setSyncTemplateId(event.target.value)}><option value="">请选择模板</option>{templates.map((template) => <option value={template.id} key={template.id}>{template.name} · {template.chain_id.toUpperCase()}{template.is_default ? ' · 默认' : ''}</option>)}</select></label><div className="p42-sync-notice"><Layers3 size={16} /><span>只同步金额、累计上限、重复买入、滑点和离场策略。不会修改 Watch、Signal、Engine、持仓或交易历史。</span></div></div>
            : <div className="p42-sync-body"><div className="p42-sync-plan-head"><div><strong>{syncPlan.template.name}</strong><span>{syncPlan.template.chain_id.toUpperCase()} · 模板版本 v{syncPlan.template.version}{syncPlan.run_id ? ` · 执行记录 #${syncPlan.run_id}` : ''}</span></div><button type="button" className="p42-sync-button" onClick={() => setSyncPlan(null)} disabled={syncExecuting}>重新预览</button></div><div className="p42-sync-summary"><div><strong>{syncPlan.summary.updated}</strong><span>将更新</span></div><div><strong>{syncPlan.summary.unchanged}</strong><span>无需更新</span></div><div><strong>{syncPlan.summary.skipped}</strong><span>已跳过</span></div></div><div className="p42-sync-results">{syncPlan.items.map((item) => <div className={`p42-sync-result ${item.outcome}`} key={item.whitelist_id}><div><strong>{item.symbol || item.contract_address || `CA #${item.whitelist_id}`}</strong><span>{item.chain_id?.toUpperCase() || '-'} · {item.changed_fields.length ? `将更新：${item.changed_fields.join('、')}` : item.reason_detail || (item.outcome === 'unchanged' ? '配置没有变化' : '未同步')}</span></div><em>{item.outcome === 'updated' ? '待同步' : item.outcome === 'unchanged' ? '无需更新' : '已跳过'}</em></div>)}</div></div>}
          <div className="p42-sync-foot"><button type="button" className="btn btn-secondary" onClick={closeTemplateSync} disabled={syncLoading || syncExecuting}>{syncPlan?.run_id ? '关闭' : '取消'}</button>{!syncPlan && <button type="button" className="btn btn-primary" disabled={!syncTemplateId || syncLoading} onClick={() => void previewTemplateSync()}><Layers3 size={15} />{syncLoading ? '预览中' : '预览同步'}</button>}{syncPlan && !syncPlan.run_id && <button type="button" className="btn btn-primary" disabled={syncExecuting || syncPlan.summary.updated === 0} onClick={() => void executeTemplateSync()}><Check size={15} />{syncExecuting ? '同步中' : '确认同步'}</button>}</div>
        </section>
      </div>}
    </div>
  );
}
