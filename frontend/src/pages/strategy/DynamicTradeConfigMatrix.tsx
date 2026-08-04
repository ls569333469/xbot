import { ListChecks } from 'lucide-react';
import { useMemo } from 'react';
import type { ChainId, DynamicChainBudget, DynamicPolicy } from '../../lib/types';

export type DynamicChainBudgetMap = Record<ChainId, DynamicChainBudget>;

interface ChainMeta {
  id: ChainId;
  name: string;
  unit: string;
  mark: string;
}

interface Props {
  allowedChainIds: ChainId[];
  chainBudgets: DynamicChainBudgetMap;
  mode: DynamicPolicy['mode'];
  onChange: (value: { allowed_chain_ids: ChainId[]; chain_budgets: DynamicChainBudgetMap }) => void;
}

const CHAINS: ChainMeta[] = [
  { id: 'sol', name: 'Solana', unit: 'SOL', mark: 'SOL' },
  { id: 'bsc', name: 'BNB Smart Chain', unit: 'BNB', mark: 'BNB' },
  { id: 'base', name: 'Base', unit: 'ETH', mark: 'BA' },
  { id: 'eth', name: 'Ethereum', unit: 'ETH', mark: 'ETH' },
  { id: 'robinhood', name: 'Robinhood Chain', unit: 'ETH', mark: 'RH' },
];

function emptyBudgets(value?: Partial<DynamicChainBudgetMap>): DynamicChainBudgetMap {
  return Object.fromEntries(CHAINS.map(({ id }) => [id, {
    budget_per_trade: Number(value?.[id]?.budget_per_trade || 0),
    daily_budget: Number(value?.[id]?.daily_budget || 0),
  }])) as DynamicChainBudgetMap;
}

function money(value: number, unit: string) {
  return `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 8 })} ${unit}`;
}

const EMPTY_CHAIN_IDS: ChainId[] = [];

export default function DynamicTradeConfigMatrix({
  allowedChainIds,
  chainBudgets,
  mode,
  onChange,
}: Props) {
  const safeAllowedChainIds = Array.isArray(allowedChainIds) ? allowedChainIds : EMPTY_CHAIN_IDS;
  const safeChainBudgets = useMemo(() => emptyBudgets(chainBudgets), [chainBudgets]);
  const selected = new Set(safeAllowedChainIds);
  const allSelected = safeAllowedChainIds.length === CHAINS.length;

  const update = (ids: ChainId[], budgets: Partial<DynamicChainBudgetMap> = safeChainBudgets) => {
    onChange({ allowed_chain_ids: [...new Set(ids)], chain_budgets: emptyBudgets(budgets) });
  };

  const setQuickSelection = (kind: 'all' | 'evm' | 'sol' | 'clear') => {
    const ids: ChainId[] = kind === 'all' ? CHAINS.map(({ id }) => id)
      : kind === 'evm' ? ['bsc', 'base', 'eth', 'robinhood'] as ChainId[]
        : kind === 'sol' ? ['sol'] : [];
    update(ids);
  };

  const toggle = (id: ChainId) => {
    const ids: ChainId[] = selected.has(id) ? safeAllowedChainIds.filter((item) => item !== id) : [...safeAllowedChainIds, id];
    update(ids);
  };

  const updateBudget = (id: ChainId, field: keyof DynamicChainBudget, raw: string) => {
    const next = emptyBudgets(safeChainBudgets);
    next[id] = { ...next[id], [field]: raw === '' ? 0 : Number(raw) };
    onChange({ allowed_chain_ids: safeAllowedChainIds, chain_budgets: next });
  };

  return (
    <section className="p20-chain-matrix" aria-label="方案 A 多链资金矩阵">
      <div className="p20-matrix-head">
        <div><strong>资金与买入</strong><span>每条链使用自己的原生币金额，不做 USD 换算。</span></div>
        <span className="p20-matrix-badge">原生币计价</span>
      </div>
      <div className="p20-matrix-quick-actions" aria-label="快速选择允许链">
        <span><ListChecks size={14} />快速选择</span>
        <button type="button" className={allSelected ? 'active' : ''} onClick={() => setQuickSelection('all')}>全选支持链</button>
        <button type="button" onClick={() => setQuickSelection('evm')}>EVM 链</button>
        <button type="button" onClick={() => setQuickSelection('sol')}>仅 Solana</button>
        <button type="button" onClick={() => setQuickSelection('clear')}>清空</button>
      </div>
      <div className="p20-chain-table">
        <div className="p20-chain-row p20-chain-row-head"><span>启用</span><span>链</span><span>单笔买入金额</span><span>每日动态上限</span><span>状态</span></div>
        {CHAINS.map((chain) => {
          const enabled = selected.has(chain.id);
          const budget = safeChainBudgets[chain.id];
          const configured = enabled && budget.budget_per_trade > 0 && budget.daily_budget >= budget.budget_per_trade;
          return <div className={`p20-chain-row ${enabled ? '' : 'disabled'}`} key={chain.id}>
            <label className="p20-chain-toggle"><input type="checkbox" checked={enabled} onChange={() => toggle(chain.id)} aria-label={`启用 ${chain.name}`} /><span /></label>
            <div className="p20-chain-name"><b>{chain.mark}</b><span><strong>{chain.name}</strong><small>原生币：{chain.unit}</small></span></div>
            <label className="p20-chain-amount"><span className="sr-only">{chain.name} 单笔买入金额</span><input type="number" min="0" step="0.000001" value={budget.budget_per_trade} onChange={(event) => updateBudget(chain.id, 'budget_per_trade', event.target.value)} /><em>{chain.unit}</em></label>
            <label className="p20-chain-amount"><span className="sr-only">{chain.name} 每日动态上限</span><input type="number" min="0" step="0.000001" value={budget.daily_budget} onChange={(event) => updateBudget(chain.id, 'daily_budget', event.target.value)} /><em>{chain.unit}</em></label>
            <span className={`p20-chain-status ${configured ? 'ready' : ''}`}>{mode === 'record' ? '仅记录' : configured ? '已配置' : '待配置'}</span>
          </div>;
        })}
      </div>
      <div className="p20-matrix-note">解析流程先确定唯一的「链 + CA」，再读取对应链的预算；启用多条链不会对同一个目标重复买入。</div>
      <div className="p20-matrix-summary"><span>已启用 {safeAllowedChainIds.length} / {CHAINS.length} 条链</span><span>{safeAllowedChainIds.length ? safeAllowedChainIds.map((id) => { const chain = CHAINS.find((item) => item.id === id); return chain ? money(safeChainBudgets[id]?.budget_per_trade || 0, chain.unit) : null; }).filter(Boolean).join(' · ') : '尚未选择链'}</span></div>
    </section>
  );
}
