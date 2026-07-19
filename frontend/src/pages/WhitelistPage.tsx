import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../lib/api';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/Toast';
import { TableSkeleton } from '../components/ui/Skeleton';
import { WhitelistEntry, ChainId } from '../lib/types';

const CHAINS = ['all', 'sol', 'bsc', 'base', 'eth', 'robinhood'] as const;

export default function WhitelistPage() {
  const [data, setData] = useState<WhitelistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [chainFilter, setChainFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [isModalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<WhitelistEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const [form, setForm] = useState({
    contract_address: '', chain_id: 'sol' as ChainId, symbol: '', project_name: '',
    project_x_handles: '',
    budget_per_trade: '', total_budget: '',
    auto_tp_pct: '100', auto_sl_pct: '20', slippage: '10',
    allow_repeat_buy: false, max_repeat_buys: '1',
  });

  const fetchData = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = { page: String(page), pageSize: '20' };
    if (chainFilter !== 'all') params.chain_id = chainFilter;
    if (search) params.search = search;
    api.whitelist.list(params).then(res => {
      if (res.ok) {
        setData((res.data as unknown as WhitelistEntry[]) || []);
        setTotal(res.total || 0);
      }
      setLoading(false);
    });
  }, [page, chainFilter, search]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const openAdd = () => {
    setEditItem(null);
    setForm({ contract_address: '', chain_id: 'sol', symbol: '', project_name: '', project_x_handles: '', budget_per_trade: '', total_budget: '', auto_tp_pct: '100', auto_sl_pct: '20', slippage: '10', allow_repeat_buy: false, max_repeat_buys: '1' });
    setModalOpen(true);
  };

  const openEdit = (item: WhitelistEntry) => {
    setEditItem(item);
    setForm({
      contract_address: item.contract_address, chain_id: item.chain_id, symbol: item.symbol || '',
      project_name: item.project_name || '', project_x_handles: (item.project_x_handles || []).join(', '),
      budget_per_trade: String(item.budget_per_trade), total_budget: String(item.total_budget),
      auto_tp_pct: String(item.auto_tp_pct), auto_sl_pct: String(item.auto_sl_pct),
      slippage: String(item.slippage), allow_repeat_buy: item.allow_repeat_buy,
      max_repeat_buys: String(item.max_repeat_buys),
    });
    setModalOpen(true);
  };

  const handleSave = async () => {
    const payload = {
      ...form,
      project_x_handles: form.project_x_handles ? form.project_x_handles.split(',').map(h => h.trim()).filter(Boolean) : [],
      budget_per_trade: parseFloat(form.budget_per_trade),
      total_budget: parseFloat(form.total_budget),
      auto_tp_pct: parseFloat(form.auto_tp_pct),
      auto_sl_pct: parseFloat(form.auto_sl_pct),
      slippage: parseFloat(form.slippage),
      max_repeat_buys: parseInt(form.max_repeat_buys),
    };

    try {
      if (editItem) {
        await api.whitelist.update(editItem.id, payload);
        toast('更新成功', 'success');
      } else {
        await api.whitelist.create(payload);
        toast('添加成功', 'success');
      }
      setModalOpen(false);
      fetchData();
    } catch (err: any) {
      toast(err.message || '操作失败', 'error');
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('确认删除？')) return;
    await api.whitelist.remove(id);
    toast('已删除', 'success');
    fetchData();
  };

  const handleToggleStatus = async (id: string, currentStatus: string) => {
    const newStatus = currentStatus === 'active' ? 'paused' : 'active';
    await api.whitelist.updateStatus(id, newStatus);
    toast(`已${newStatus === 'active' ? '启用' : '暂停'}`, 'success');
    fetchData();
  };

  const columns = [
    { header: '链', accessor: (row: WhitelistEntry) => <ChainIcon chain={row.chain_id} size="sm" /> },
    { header: '代币', accessor: (row: WhitelistEntry) => <span className="font-mono text-sm">{row.symbol || '-'}</span> },
    { header: '项目名', accessor: (row: WhitelistEntry) => row.project_name || '-' },
    { header: '项目X', accessor: (row: WhitelistEntry) => (row.project_x_handles || []).map((h: string) => `@${h}`).join(', ') || '-' },
    { header: '单笔预算', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.budget_per_trade}</span> },
    { header: '总预算', accessor: (row: WhitelistEntry) => <div style={{ width: '100px' }}><ProgressBar value={parseFloat(row.spent_budget as any) || 0} max={parseFloat(row.total_budget as any)} /></div> },
    { header: 'TP/SL', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.auto_tp_pct}% / {row.auto_sl_pct}%</span> },
    { header: '买入', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.current_buy_count || 0}/{row.max_repeat_buys}</span> },
    { header: '状态', accessor: (row: WhitelistEntry) => (
      <span style={{ cursor: 'pointer', color: row.status === 'active' ? 'var(--color-success)' : 'var(--color-text-secondary)', fontWeight: 600 }}
        onClick={() => handleToggleStatus(row.id, row.status)}>
        {row.status.toUpperCase()}
      </span>
    )},
    { header: '操作', accessor: (row: WhitelistEntry) => (
      <div className="flex gap-sm">
        <button className="btn btn-secondary text-xs p-1" style={{ padding: '4px 8px' }} onClick={() => openEdit(row)}>编辑</button>
        <button className="btn btn-secondary text-xs p-1" style={{ color: 'var(--color-danger)', padding: '4px 8px' }} onClick={() => handleDelete(row.id)}>删除</button>
      </div>
    )}
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="flex gap-sm flex-wrap">
          {CHAINS.map(c => (
            <button key={c} className={`btn ${chainFilter === c ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setChainFilter(c); setPage(1); }}>
              {c === 'all' ? 'All' : c.toUpperCase()}
            </button>
          ))}
        </div>
        <div className="flex gap-sm">
          <input className="input" style={{ width: '200px' }} placeholder="搜索 CA / 代币 / 项目..."
            value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
          <button className="btn btn-primary" onClick={openAdd}>+ 添加白名单</button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={6} cols={10} />
      ) : (
        <DataTable data={data} columns={columns} />
      )}

      {total > 20 && !loading && (
        <div className="flex justify-center gap-sm" style={{ marginTop: 'var(--space-md)' }}>
          <button className="btn btn-secondary" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>上一页</button>
          <span className="text-sm text-secondary" style={{ lineHeight: '36px' }}>第 {page} 页 / 共 {Math.ceil(total / 20)} 页</span>
          <button className="btn btn-secondary" disabled={page >= Math.ceil(total / 20)} onClick={() => setPage(p => p + 1)}>下一页</button>
        </div>
      )}

      <Modal isOpen={isModalOpen} onClose={() => setModalOpen(false)} title={editItem ? '编辑白名单' : '添加白名单'}>
        <div className="flex flex-col gap-md">
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">合约地址 (CA)</span>
              <input className="input font-mono" value={form.contract_address} onChange={e => setForm({ ...form, contract_address: e.target.value })} placeholder="0x... 或 base58" />
            </label>
            <label className="flex flex-col gap-xs" style={{ width: '120px' }}>
              <span className="text-sm text-secondary font-medium">链</span>
              <select className="input" value={form.chain_id} onChange={e => setForm({ ...form, chain_id: e.target.value as ChainId })}>
                <option value="sol">SOL</option><option value="bsc">BSC</option><option value="base">Base</option>
                <option value="eth">ETH</option><option value="robinhood">Robin</option>
              </select>
            </label>
          </div>
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">代币符号</span>
              <input className="input" value={form.symbol} onChange={e => setForm({ ...form, symbol: e.target.value.toUpperCase() })} placeholder="PEPE" />
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">项目名称</span>
              <input className="input" value={form.project_name} onChange={e => setForm({ ...form, project_name: e.target.value })} placeholder="Pepe Coin" />
            </label>
          </div>
          <label className="flex flex-col gap-xs">
            <span className="text-sm text-secondary font-medium">项目方 X Handle（逗号分隔）</span>
            <input className="input" value={form.project_x_handles} onChange={e => setForm({ ...form, project_x_handles: e.target.value })} placeholder="pepecoin, pepe_official" />
          </label>
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">单笔预算</span>
              <input type="number" step="0.01" className="input" value={form.budget_per_trade} onChange={e => setForm({ ...form, budget_per_trade: e.target.value })} />
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">总预算</span>
              <input type="number" step="0.01" className="input" value={form.total_budget} onChange={e => setForm({ ...form, total_budget: e.target.value })} />
            </label>
          </div>
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">TP %</span>
              <input type="number" className="input" value={form.auto_tp_pct} onChange={e => setForm({ ...form, auto_tp_pct: e.target.value })} />
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">SL %</span>
              <input type="number" className="input" value={form.auto_sl_pct} onChange={e => setForm({ ...form, auto_sl_pct: e.target.value })} />
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">滑点 %</span>
              <input type="number" className="input" value={form.slippage} onChange={e => setForm({ ...form, slippage: e.target.value })} />
            </label>
          </div>
          <div className="flex items-center gap-md">
            <label className="flex items-center gap-xs">
              <input type="checkbox" checked={form.allow_repeat_buy} onChange={e => setForm({ ...form, allow_repeat_buy: e.target.checked })} />
              <span className="text-sm font-medium">允许重复买入</span>
            </label>
            {form.allow_repeat_buy && (
              <label className="flex items-center gap-xs">
                <span className="text-sm text-secondary font-medium">最大次数</span>
                <input type="number" className="input" style={{ width: '80px' }} value={form.max_repeat_buys} onChange={e => setForm({ ...form, max_repeat_buys: e.target.value })} />
              </label>
            )}
          </div>
          <div className="flex justify-end mt-4 gap-sm">
            <button className="btn btn-secondary" onClick={() => setModalOpen(false)}>取消</button>
            <button className="btn btn-primary" onClick={handleSave}>{editItem ? '更新' : '保存'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
