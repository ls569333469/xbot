import React, { useState, useEffect, useCallback } from 'react';
import { ArrowRight, Plus, X } from 'lucide-react';
import { api } from '../lib/api';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { ProgressBar } from '../components/ui/ProgressBar';
import { Modal } from '../components/ui/Modal';
import { useToast } from '../components/ui/ToastContext';
import { TableSkeleton } from '../components/ui/Skeleton';
import { WhitelistEntry, ChainId, KolAccount, XSignalRelation } from '../lib/types';

const CHAINS = ['all', 'sol', 'bsc', 'base', 'eth', 'robinhood'] as const;

type ChainBudgetSettings = {
  maxPerTrade?: number;
  dailyBudget?: number;
  weeklyBudget?: number;
  nativeSymbol?: string;
};

function parseXHandles(value: string) {
  return [...new Set(
    value
      .split(/[,，;；\s]+/)
      .map(handle => handle
        .trim()
        .replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '')
        .split(/[/?#]/)[0]
        .replace(/^@+/, '')
        .toLowerCase())
      .filter(Boolean)
  )];
}

function isValidXHandle(handle: string) {
  return /^[a-z0-9_]{1,15}$/.test(handle);
}

function mergeRelationInput(
  existing: XSignalRelation[],
  actorInput: string,
  targetInput: string
) {
  const actors = parseXHandles(actorInput);
  const targets = parseXHandles(targetInput);
  if (actors.length !== 1) throw new Error('行为账号每次只能填写一个');
  if (targets.length === 0) throw new Error('请填写至少一个项目账号');
  if (!isValidXHandle(actors[0])) throw new Error(`行为账号格式不正确: @${actors[0]}`);

  const invalidTarget = targets.find(handle => !isValidXHandle(handle));
  if (invalidTarget) throw new Error(`项目账号格式不正确: @${invalidTarget}`);
  if (targets.includes(actors[0])) throw new Error('行为账号和项目账号不能相同');

  const merged = new Map(existing.map(relation => [
    `${relation.actor_handle}:${relation.target_x_handle}`,
    relation
  ]));
  targets.forEach(target => merged.set(`${actors[0]}:${target}`, {
    actor_handle: actors[0],
    target_x_handle: target,
    enabled: true,
  }));
  return [...merged.values()];
}

export default function WhitelistPage() {
  const [data, setData] = useState<WhitelistEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [chainFilter, setChainFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [isModalOpen, setModalOpen] = useState(false);
  const [editItem, setEditItem] = useState<WhitelistEntry | null>(null);
  const [loading, setLoading] = useState(true);
  const [kolAccounts, setKolAccounts] = useState<KolAccount[]>([]);
  const [actorHandleInput, setActorHandleInput] = useState('');
  const [targetHandleInput, setTargetHandleInput] = useState('');
  const [chainConfigs, setChainConfigs] = useState<Partial<Record<ChainId, ChainBudgetSettings>>>({});
  const { toast } = useToast();

  const [form, setForm] = useState({
    contract_address: '', chain_id: 'sol' as ChainId, symbol: '', project_name: '',
    relations: [] as XSignalRelation[],
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
  useEffect(() => {
    api.kol.list().then(res => {
      if (res.ok && res.data) setKolAccounts(res.data);
    });
  }, []);
  useEffect(() => {
    api.config.getChains().then(res => {
      if (res.ok && res.data) {
        setChainConfigs(res.data as Partial<Record<ChainId, ChainBudgetSettings>>);
      }
    });
  }, []);

  const openAdd = () => {
    setEditItem(null);
    setActorHandleInput('');
    setTargetHandleInput('');
    setForm({ contract_address: '', chain_id: 'sol', symbol: '', project_name: '', relations: [], budget_per_trade: '', total_budget: '', auto_tp_pct: '100', auto_sl_pct: '20', slippage: '10', allow_repeat_buy: false, max_repeat_buys: '1' });
    setModalOpen(true);
  };

  const openEdit = (item: WhitelistEntry) => {
    setEditItem(item);
    setActorHandleInput('');
    setTargetHandleInput('');
    setForm({
      contract_address: item.contract_address, chain_id: item.chain_id, symbol: item.symbol || '',
      project_name: item.project_name || '', relations: item.relations || [],
      budget_per_trade: String(item.budget_per_trade), total_budget: String(item.total_budget),
      auto_tp_pct: String(item.auto_tp_pct), auto_sl_pct: String(item.auto_sl_pct),
      slippage: String(item.slippage), allow_repeat_buy: item.allow_repeat_buy,
      max_repeat_buys: String(item.max_repeat_buys),
    });
    setModalOpen(true);
  };

  const addRelations = () => {
    try {
      const relations = mergeRelationInput(form.relations, actorHandleInput, targetHandleInput);
      setForm(current => ({ ...current, relations }));
      setActorHandleInput('');
      setTargetHandleInput('');
    } catch (error) {
      toast(error instanceof Error ? error.message : '账号关系格式不正确', 'error');
    }
  };

  const removeRelation = (relation: XSignalRelation) => {
    setForm(current => ({
      ...current,
      relations: current.relations.filter(item => !(
        item.actor_handle === relation.actor_handle
        && item.target_x_handle === relation.target_x_handle
      )),
    }));
  };

  const handleSave = async () => {
    let relations = form.relations;
    if (actorHandleInput.trim() || targetHandleInput.trim()) {
      try {
        relations = mergeRelationInput(relations, actorHandleInput, targetHandleInput);
      } catch (error) {
        toast(error instanceof Error ? error.message : '账号关系格式不正确', 'error');
        return;
      }
    }
    if (relations.length === 0) {
      toast('请至少添加一条账号关系', 'error');
      return;
    }

    const budgetPerTrade = Number(form.budget_per_trade);
    const totalBudget = Number(form.total_budget);
    if (!Number.isFinite(budgetPerTrade) || budgetPerTrade <= 0
      || !Number.isFinite(totalBudget) || totalBudget <= 0) {
      toast('单笔金额和累计预算必须大于 0', 'error');
      return;
    }
    if (budgetPerTrade > totalBudget) {
      toast('单笔金额不能超过累计预算', 'error');
      return;
    }
    const chainConfig = chainConfigs[form.chain_id];
    const maxPerTrade = Number(chainConfig?.maxPerTrade || 0);
    if (maxPerTrade > 0 && budgetPerTrade > maxPerTrade) {
      toast(`单笔金额不能超过 ${maxPerTrade} ${chainConfig?.nativeSymbol || form.chain_id.toUpperCase()}`, 'error');
      return;
    }

    const payload = {
      ...form,
      relations,
      budget_per_trade: budgetPerTrade,
      total_budget: totalBudget,
      auto_tp_pct: parseFloat(form.auto_tp_pct),
      auto_sl_pct: parseFloat(form.auto_sl_pct),
      slippage: parseFloat(form.slippage),
      max_repeat_buys: parseInt(form.max_repeat_buys),
    };

    try {
      const response = editItem
        ? await api.whitelist.update(editItem.id, payload)
        : await api.whitelist.create(payload);
      if (!response.ok) throw new Error(response.error || '保存失败');
      if (editItem) {
        toast('更新成功', 'success');
      } else if (response.meta?.merged_into_existing) {
        toast(
          response.meta.added_relations
            ? `已将 ${response.meta.added_relations} 条监控关系添加到现有白名单，资金参数未修改`
            : '该监控关系已存在，未重复添加',
          'success'
        );
      } else {
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
    { header: '监控关系', accessor: (row: WhitelistEntry) => {
      const relations = row.relations || [];
      if (relations.length === 0) return <span className="text-secondary">未配置</span>;
      return (
        <div className="flex flex-col gap-xs">
          {relations.slice(0, 2).map(relation => (
            <span key={`${relation.actor_handle}:${relation.target_x_handle}`} className="font-mono text-xs">
              @{relation.actor_handle} → @{relation.target_x_handle}
            </span>
          ))}
          {relations.length > 2 && <span className="text-xs text-secondary">另有 {relations.length - 2} 条</span>}
        </div>
      );
    } },
    { header: '单笔预算', accessor: (row: WhitelistEntry) => <span className="font-mono">{row.budget_per_trade}</span> },
    { header: 'CA 累计预算', accessor: (row: WhitelistEntry) => <div style={{ width: '100px' }}><ProgressBar value={parseFloat(row.spent_budget as any) || 0} max={parseFloat(row.total_budget as any)} /></div> },
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

  const selectedChainConfig = chainConfigs[form.chain_id];
  const nativeSymbol = selectedChainConfig?.nativeSymbol || form.chain_id.toUpperCase();
  const maxPerTrade = Number(selectedChainConfig?.maxPerTrade || 0);

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="flex gap-sm flex-wrap">
          {CHAINS.map(c => (
            <button key={c} className={`btn ${chainFilter === c ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setChainFilter(c); setPage(1); }}>
              {c === 'all' ? '全部' : c.toUpperCase()}
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
          <div className="flex flex-col gap-sm">
            <span className="text-sm text-secondary font-medium">触发关系</span>
            <div className="x-relation-builder">
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">行为账号</span>
                <input
                  className="input"
                  list="kol-handle-options"
                  value={actorHandleInput}
                  onChange={e => setActorHandleInput(e.target.value)}
                  placeholder="@elonmusk"
                />
                <datalist id="kol-handle-options">
                  {kolAccounts.map(kol => <option key={kol.id} value={`@${kol.x_handle}`} />)}
                </datalist>
              </label>
              <ArrowRight className="x-relation-arrow" size={18} aria-hidden="true" />
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary">项目账号</span>
                <input
                  className="input"
                  value={targetHandleInput}
                  onChange={e => setTargetHandleInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addRelations();
                    }
                  }}
                  placeholder="@cz_binance"
                />
              </label>
              <button
                type="button"
                className="btn btn-secondary flex items-center gap-xs"
                onClick={addRelations}
                disabled={!actorHandleInput.trim() || !targetHandleInput.trim()}
              >
                <Plus size={16} /> 添加关系
              </button>
            </div>
            {form.relations.length > 0 && (
              <div className="x-relation-list">
                {form.relations.map(relation => (
                  <div className="x-relation-row" key={`${relation.actor_handle}:${relation.target_x_handle}`}>
                    <span className="font-mono text-sm">@{relation.actor_handle}</span>
                    <ArrowRight size={15} className="text-secondary" aria-hidden="true" />
                    <span className="font-mono text-sm">@{relation.target_x_handle}</span>
                    <button
                      type="button"
                      className="x-relation-remove"
                      onClick={() => removeRelation(relation)}
                      title={`移除 @${relation.actor_handle} 到 @${relation.target_x_handle}`}
                      aria-label={`移除 @${relation.actor_handle} 到 @${relation.target_x_handle}`}
                    >
                      <X size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">单笔真实交易金额 ({nativeSymbol})</span>
              <input
                type="number"
                min="0.000001"
                max={maxPerTrade > 0 ? maxPerTrade : undefined}
                step="0.000001"
                className="input"
                value={form.budget_per_trade}
                onChange={e => setForm({ ...form, budget_per_trade: e.target.value })}
              />
              {maxPerTrade > 0 && (
                <span className="text-xs text-secondary">当前链单笔上限：{maxPerTrade} {nativeSymbol}</span>
              )}
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">该 CA 累计买入本金上限 ({nativeSymbol})</span>
              <input type="number" min="0.000001" step="0.000001" className="input" value={form.total_budget} onChange={e => setForm({ ...form, total_budget: e.target.value })} />
            </label>
          </div>
          {selectedChainConfig && (
            <div className="text-xs text-secondary font-mono">
              {form.chain_id.toUpperCase()} 链级上限：单笔 {selectedChainConfig.maxPerTrade ?? '-'} / 每日 {selectedChainConfig.dailyBudget ?? '-'} / 每周 {selectedChainConfig.weeklyBudget ?? '-'} {nativeSymbol}
            </div>
          )}
          <div className="flex gap-md">
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">止盈比例 %</span>
              <input type="number" className="input" value={form.auto_tp_pct} onChange={e => setForm({ ...form, auto_tp_pct: e.target.value })} />
            </label>
            <label className="flex-1 flex flex-col gap-xs">
              <span className="text-sm text-secondary font-medium">止损比例 %</span>
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
