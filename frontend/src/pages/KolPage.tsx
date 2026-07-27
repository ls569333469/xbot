import { Pencil, Plus, RefreshCw, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import { DataTable } from '../components/ui/DataTable';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/ToastContext';
import { TableSkeleton } from '../components/ui/Skeleton';
import type { EcosystemTag, KolAccount } from '../lib/types';

const TAG_OPTIONS: Array<{ value: EcosystemTag | 'all' | 'unclassified'; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'sol', label: 'SOL' },
  { value: 'bsc', label: 'BSC' },
  { value: 'base', label: 'BASE' },
  { value: 'eth', label: 'ETH' },
  { value: 'robinhood', label: 'ROBINHOOD' },
  { value: 'cross_chain', label: '跨链' },
  { value: 'unclassified', label: '未分类' },
];

const TAG_LABELS = Object.fromEntries(TAG_OPTIONS.map((item) => [item.value, item.label]));

function normalizeHandle(value: string) {
  return value.trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^@+/, '')
    .toLowerCase();
}

const PROFILE_ERROR_LABELS: Record<string, string> = {
  X6551_AUTH_ERROR: '6551 授权失败',
  X6551_RATE_LIMITED: '6551 请求限流',
  X6551_TIMEOUT: '6551 请求超时',
  X6551_NETWORK_ERROR: '6551 网络异常',
  X6551_HTTP_ERROR: '6551 服务异常',
  X6551_PROFILE_MISMATCH: '返回账号与填写账号不一致',
  X6551_SCHEMA_ERROR: '6551 返回资料无法识别',
};

function profileState(row: KolAccount, retrying: boolean) {
  if (row.profile_status === 'verified') {
    return { className: 'verified', label: '6551 已核验', title: '账号资料已通过 6551 核验' };
  }
  if (retrying) {
    return { className: 'pending', label: '6551 正在核验', title: '已提交立即核验请求' };
  }
  if (row.profile_last_error_code) {
    const retryAt = row.profile_next_retry_at ? new Date(row.profile_next_retry_at) : null;
    const retryLabel = retryAt && !Number.isNaN(retryAt.getTime()) && retryAt.getTime() > Date.now()
      ? retryAt.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : null;
    const reason = PROFILE_ERROR_LABELS[row.profile_last_error_code] || row.profile_last_error_code;
    return {
      className: 'failed',
      label: retryLabel ? `核验失败，${retryLabel} 重试` : '核验失败，等待重试',
      title: `${reason}；可点击右侧刷新按钮立即重试`,
    };
  }
  return { className: 'pending', label: '等待 6551 核验', title: '账号已保存，等待后台核验' };
}

export default function KolPage() {
  const [data, setData] = useState<KolAccount[]>([]);
  const [isModalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<KolAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [retryingProfileId, setRetryingProfileId] = useState<string | null>(null);
  const [listError, setListError] = useState('');
  const [tag, setTag] = useState<EcosystemTag | 'all' | 'unclassified'>('all');
  const [search, setSearch] = useState('');
  const { toast } = useToast();

  const [form, setForm] = useState({
    x_handle: '', display_name: '', chain_ids: [] as EcosystemTag[], weight: 5,
  });

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setListError('');
    const params: Record<string, string> = {};
    if (tag !== 'all') params.tag = tag;
    if (search.trim()) params.search = search.trim();
    try {
      const response = await api.kol.list(params);
      if (response.ok && response.data) {
        setData(response.data);
      } else {
        setListError(response.error || 'KOL 列表加载失败');
      }
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [search, tag]);

  useEffect(() => {
    const timer = window.setTimeout(fetchData, 200);
    return () => window.clearTimeout(timer);
  }, [fetchData]);

  useEffect(() => {
    if (!data.some((item) => item.profile_status === 'pending')) return undefined;
    const timer = window.setInterval(() => void fetchData(false), 5000);
    return () => window.clearInterval(timer);
  }, [data, fetchData]);

  const openAdd = () => {
    setEditItem(null);
    setForm({ x_handle: '', display_name: '', chain_ids: [], weight: 5 });
    setModalOpen(true);
  };

  const openEdit = (item: KolAccount) => {
    setEditItem(item);
    setForm({
      x_handle: normalizeHandle(item.x_handle),
      display_name: item.display_name || '',
      chain_ids: item.chain_ids || [],
      weight: item.weight || 5,
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const xHandle = normalizeHandle(form.x_handle);
    if (!xHandle) return toast('Handle 不能为空', 'error');
    setSaving(true);
    try {
      const response = editItem
        ? await api.kol.update(editItem.id, { ...form, x_handle: xHandle })
        : await api.kol.create({ ...form, x_handle: xHandle });
      if (!response.ok || !response.data) {
        toast(response.error || '保存失败', 'error');
        return;
      }
      if (response.data.profile_status === 'pending') {
        toast(response.data.profile_warning || '账号已保存，6551 Profile 暂未核验', 'warning');
      } else {
        toast(editItem ? '更新成功' : '添加成功', 'success');
      }
      setModalOpen(false);
      await fetchData();
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (id: string) => {
    const response = await api.kol.toggle(id);
    if (!response.ok) return toast(response.error || '状态切换失败', 'error');
    fetchData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除？')) return;
    const response = await api.kol.remove(id);
    if (!response.ok) return toast(response.error || '删除失败', 'error');
    toast('已删除', 'success');
    fetchData();
  };

  const handleProfileRetry = async (id: string) => {
    setRetryingProfileId(id);
    try {
      const response = await api.kol.retryProfile(id);
      if (!response.ok) return toast(response.error || '安排核验失败', 'error');
      toast('已安排立即核验，结果会自动更新', 'success');
      await fetchData(false);
    } finally {
      setRetryingProfileId(null);
    }
  };

  const toggleTag = (value: EcosystemTag) => {
    setForm((current) => ({
      ...current,
      chain_ids: current.chain_ids.includes(value)
        ? current.chain_ids.filter((item) => item !== value)
        : [...current.chain_ids, value],
    }));
  };

  const columns = [
    { header: '账号', accessor: (row: KolAccount) => { const state = profileState(row, retryingProfileId === row.id); return <div className="kol-account-cell"><span>{normalizeHandle(row.x_handle).slice(0, 1).toUpperCase()}</span><div><strong>@{normalizeHandle(row.x_handle)}</strong><small>{row.display_name || '未命名'}</small><small className={`kol-profile-state ${state.className}`} title={state.title}>{state.label}</small></div></div>; } },
    { header: '生态标签', accessor: (row: KolAccount) => <div className="kol-tag-list">{row.chain_ids?.length ? row.chain_ids.map((item) => <span key={item}>{TAG_LABELS[item] || item}</span>) : <span>未分类</span>}</div> },
    { header: '权重', accessor: (row: KolAccount) => <div className="kol-weight"><strong>{row.weight}</strong><i><span style={{ width: `${row.weight * 10}%` }} /></i></div> },
    { header: '状态', accessor: (row: KolAccount) => <button type="button" className={`kol-status ${row.enabled ? 'active' : ''}`} onClick={() => handleToggle(row.id)}><i />{row.enabled ? '活跃' : '禁用'}</button> },
    { header: '操作', accessor: (row: KolAccount) => <div className="p16-table-actions">{row.profile_status !== 'verified' && <button type="button" className="p16-icon-button" title="立即核验 6551 Profile" aria-label="立即核验 6551 Profile" disabled={retryingProfileId === row.id} onClick={() => handleProfileRetry(row.id)}><RefreshCw size={15} className={retryingProfileId === row.id ? 'spin' : ''} /></button>}<button type="button" className="p16-icon-button" title="编辑 KOL" aria-label="编辑 KOL" onClick={() => openEdit(row)}><Pencil size={15} /></button><button type="button" className="p16-icon-button danger" title="删除 KOL" aria-label="删除 KOL" onClick={() => handleDelete(row.id)}><Trash2 size={15} /></button></div> },
  ];

  return (
    <div className="kol-page">
      <div className="kol-toolbar">
        <div className="p16-search-field"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索 Handle 或名称" /></div>
        <div className="kol-tag-filter">{TAG_OPTIONS.map((item) => <button type="button" key={item.value} className={tag === item.value ? 'active' : ''} onClick={() => setTag(item.value)}>{item.label}</button>)}</div>
        <button className="btn btn-primary" onClick={openAdd}><Plus size={16} />添加 KOL</button>
      </div>

      <div className="kol-list-meta">{loading ? '加载中' : `${data.length} 个账号`}<span>权重仅用于重要性标记和排序</span></div>
      {listError ? <div className="p16-empty-line">{listError}</div> : loading ? <TableSkeleton rows={5} cols={5} /> : <DataTable data={data} columns={columns} />}

      <Modal isOpen={isModalOpen} onClose={() => setModalOpen(false)} title={editItem ? '编辑 KOL' : '添加 KOL'}>
        <div className="flex flex-col gap-md">
          <label className="flex flex-col gap-xs"><span className="text-sm text-secondary font-medium">X 账号</span><div className="kol-handle-input"><span>@</span><input className="input" value={form.x_handle} onChange={(event) => setForm({ ...form, x_handle: normalizeHandle(event.target.value) })} placeholder="vladtenev" /></div></label>
          <label className="flex flex-col gap-xs"><span className="text-sm text-secondary font-medium">显示名称</span><input className="input" value={form.display_name} onChange={(event) => setForm({ ...form, display_name: event.target.value })} /></label>
          <div className="flex flex-col gap-xs"><span className="text-sm text-secondary font-medium">生态标签</span><div className="kol-tag-editor">{TAG_OPTIONS.filter((item) => !['all', 'unclassified'].includes(item.value)).map((item) => <button key={item.value} type="button" className={form.chain_ids.includes(item.value as EcosystemTag) ? 'active' : ''} onClick={() => toggleTag(item.value as EcosystemTag)}>{item.label}</button>)}</div></div>
          <label className="flex flex-col gap-xs"><span className="text-sm text-secondary font-medium">权重：<strong>{form.weight}</strong></span><input type="range" min="1" max="10" value={form.weight} onChange={(event) => setForm({ ...form, weight: Number(event.target.value) })} /><small className="text-secondary">只用于账号重要性和列表排序，不改变交易金额或优先级。</small></label>
          <div className="flex justify-end mt-4 gap-sm"><button className="btn btn-secondary" onClick={() => setModalOpen(false)}>取消</button><button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? '保存中' : '保存'}</button></div>
        </div>
      </Modal>
    </div>
  );
}
