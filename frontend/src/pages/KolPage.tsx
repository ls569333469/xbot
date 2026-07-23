import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/ToastContext';
import { TableSkeleton } from '../components/ui/Skeleton';
import { KolAccount, ChainId } from '../lib/types';

export default function KolPage() {
  const [data, setData] = useState<KolAccount[]>([]);
  const [isModalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<KolAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const [form, setForm] = useState({
    x_handle: '', display_name: '', chain_ids: [] as ChainId[], weight: 5,
  });

  const fetchData = useCallback(() => {
    setLoading(true);
    api.kol.list().then(res => {
      if (res.ok && res.data) setData(res.data as unknown as KolAccount[]);
      setLoading(false);
    });
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openAdd = () => {
    setEditItem(null);
    setForm({ x_handle: '', display_name: '', chain_ids: [], weight: 5 });
    setModalOpen(true);
  };

  const openEdit = (item: KolAccount) => {
    setEditItem(item);
    setForm({ x_handle: item.x_handle, display_name: item.display_name || '', chain_ids: item.chain_ids || [], weight: item.weight || 5 });
    setModalOpen(true);
  };

  const handleSave = async () => {
    try {
      if (editItem) {
        await api.kol.update(editItem.id, form);
        toast('更新成功', 'success');
      } else {
        if (!form.x_handle) { toast('Handle 不能为空', 'error'); return; }
        await api.kol.create(form);
        toast('添加成功', 'success');
      }
      setModalOpen(false);
      fetchData();
    } catch (err: any) {
      toast(err.message || '操作失败', 'error');
    }
  };

  const handleToggle = async (id: string) => {
    await api.kol.toggle(id);
    toast('状态已切换', 'success');
    fetchData();
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除？')) return;
    await api.kol.remove(id);
    toast('已删除', 'success');
    fetchData();
  };

  const toggleChain = (chainId: ChainId) => {
    setForm(prev => ({
      ...prev,
      chain_ids: prev.chain_ids.includes(chainId)
        ? prev.chain_ids.filter(c => c !== chainId)
        : [...prev.chain_ids, chainId]
    }));
  };

  const columns = [
    { header: '头像', accessor: (row: KolAccount) => (
      <div className="flex items-center justify-center font-bold text-sm" style={{ width: '32px', height: '32px', borderRadius: '50%', background: 'var(--color-accent)', color: '#ffffff' }}>
        {(row.x_handle || '?').charAt(0).toUpperCase()}
      </div>
    )},
    { header: 'Handle', accessor: (row: KolAccount) => <span className="font-semibold text-sm">@{row.x_handle}</span> },
    { header: '显示名', accessor: (row: KolAccount) => row.display_name || '-' },
    { header: '关联链', accessor: (row: KolAccount) => (
      <div className="flex gap-xs">
        {(row.chain_ids || []).map((c: string) => <ChainIcon key={c} chain={c as any} size="sm" />)}
      </div>
    )},
    { header: '权重', accessor: (row: KolAccount) => (
      <div className="flex gap-xs items-center">
        <span className="text-sm font-mono">{row.weight}</span>
        <div style={{ width: '50px', height: '4px', background: 'rgba(255,255,255,0.1)', borderRadius: '2px' }}>
          <div style={{ width: `${(row.weight / 10) * 100}%`, height: '100%', background: 'var(--color-accent)', borderRadius: '2px' }} />
        </div>
      </div>
    )},
    { header: '状态', accessor: (row: KolAccount) => (
      <div className="flex items-center gap-xs" style={{ cursor: 'pointer', fontWeight: 600 }} onClick={() => handleToggle(row.id)}>
        <div style={{ width: '8px', height: '8px', borderRadius: '50%', background: row.enabled ? 'var(--color-success)' : 'var(--color-text-secondary)' }} />
        <span className="text-sm">{row.enabled ? '活跃' : '禁用'}</span>
      </div>
    )},
    { header: '操作', accessor: (row: KolAccount) => (
      <div className="flex gap-sm">
        <button className="btn btn-secondary text-xs" style={{ padding: '4px 8px' }} onClick={() => openEdit(row)}>编辑</button>
        <button className="btn btn-secondary text-xs" style={{ color: 'var(--color-danger)', padding: '4px 8px' }} onClick={() => handleDelete(row.id)}>删除</button>
      </div>
    )}
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="text-secondary text-sm">{loading ? '加载中...' : `共 ${data.length} 个 KOL`}</div>
        <button className="btn btn-primary" onClick={openAdd}>+ 添加 KOL</button>
      </div>

      {loading ? (
        <TableSkeleton rows={5} cols={7} />
      ) : (
        <DataTable data={data} columns={columns} />
      )}

      <Modal isOpen={isModalOpen} onClose={() => setModalOpen(false)} title={editItem ? '编辑 KOL' : '添加 KOL'}>
        <div className="flex flex-col gap-md">
          <label className="flex flex-col gap-xs">
            <span className="text-sm text-secondary font-medium">X 账号</span>
            <div className="flex items-center">
              <span style={{ padding: '0 12px', background: 'var(--color-input)', border: '1px solid var(--border-base)', borderRight: 'none', borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)', height: '38px', display: 'flex', alignItems: 'center', color: 'var(--color-text-secondary)' }}>@</span>
              <input className="input" style={{ borderRadius: '0 var(--radius-sm) var(--radius-sm) 0', height: '38px' }} value={form.x_handle}
                onChange={e => setForm({ ...form, x_handle: e.target.value })} placeholder="elonmusk" />
            </div>
          </label>
          <label className="flex flex-col gap-xs">
            <span className="text-sm text-secondary font-medium">显示名称</span>
            <input className="input" value={form.display_name} onChange={e => setForm({ ...form, display_name: e.target.value })} placeholder="Elon Musk" />
          </label>
          <div className="flex flex-col gap-xs">
            <span className="text-sm text-secondary font-medium">关联链</span>
            <div className="flex gap-sm">
              {['sol', 'bsc', 'base', 'eth', 'robinhood'].map(c => (
                <button key={c} type="button" className={`btn ${form.chain_ids.includes(c as ChainId) ? 'btn-primary' : 'btn-secondary'} text-xs`}
                  onClick={() => toggleChain(c as ChainId)}>
                  {c.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <label className="flex flex-col gap-xs">
            <span className="text-sm text-secondary font-medium">权重 (1-10): <span className="font-mono">{form.weight}</span></span>
            <input type="range" min="1" max="10" value={form.weight} style={{ accentColor: 'var(--color-accent)' }}
              onChange={e => setForm({ ...form, weight: parseInt(e.target.value) })} />
          </label>
          <div className="flex justify-end mt-4 gap-sm">
            <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleSave}>{editItem ? '更新' : '保存'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
