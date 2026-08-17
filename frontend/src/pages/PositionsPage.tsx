import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { ApiResponse, EntityId, Position } from '../lib/types';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../components/ui/ToastContext';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { TableSkeleton } from '../components/ui/Skeleton';
import { TrendingUp, TrendingDown, Power, RefreshCw } from 'lucide-react';
import { StatusBadge } from '../components/ui/StatusBadge';

const CLOSE_ERROR_MESSAGES: Record<string, string> = {
  ENGINE_LOCKED: '自动买入引擎已锁定，但已有仓位仍应允许平仓',
  LIVE_DISABLED: '实盘总开关未开启',
  LIVE_MODE_REQUIRED: '当前不是实盘模式',
  CLOSE_SLIPPAGE_INVALID: '平仓滑点配置无效，请检查白名单设置',
  POSITION_NOT_CLOSABLE: '该仓位当前不能平仓，请刷新仓位状态',
  POSITION_BALANCE_EMPTY: '交易钱包中没有可卖出的仓位余额',
  PREPARE_TOKEN_INVALID: '平仓确认已过期，请重新点击平仓',
  PREPARE_SNAPSHOT_CHANGED: '仓位或策略状态已变化，请重新点击平仓',
  STRATEGY_STATE_UNSAFE: '止盈止损策略正在变化，请稍后刷新再试',
  STRATEGY_CANCEL_UNCERTAIN: '止盈止损取消结果待确认，系统未继续卖出',
  STRATEGY_CANCEL_UNVERIFIED: '未能确认止盈止损已取消，系统未继续卖出',
  STRATEGY_TRIGGERED_DURING_CANCEL: '止盈止损在取消过程中已触发，请等待仓位对账'
};

function closeErrorMessage(response: ApiResponse<unknown>, fallback: string) {
  return CLOSE_ERROR_MESSAGES[response.code || ''] || response.error || fallback;
}

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const [closingIds, setClosingIds] = useState<Set<EntityId>>(new Set());
  const [syncingIds, setSyncingIds] = useState<Set<EntityId>>(new Set());
  const { toast } = useToast();
  const { lastEvent } = useWebSocket();

  const fetchPositions = useCallback(() => {
    setLoading(true);
    api.trade.positions()
      .then(res => {
        if (res.ok && res.data) {
          setPositions(res.data);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchPositions();
  }, [fetchPositions]);

  useEffect(() => {
    if (!lastEvent) return;

    const { type, payload } = lastEvent;
    if (type === 'entity:changed'
        && ['position', 'attempt', 'order'].includes(payload.entity_type || '')) {
      void fetchPositions();
      return;
    }
    
    if (type === 'trade:executed') {
      void fetchPositions();
      toast(`新实盘开仓: ${typeof payload.symbol === 'string' ? payload.symbol : '代币'}`, 'success');
    } else if (type === 'position:update'
        || type === 'trade:order-updated'
        || type === 'position:close_confirmed') {
      void fetchPositions();
    } else if (['position:tp_hit', 'position:sl_hit', 'position:manual_close'].includes(type)) {
      void fetchPositions();
      const reasonMap: Record<string, string> = {
        'position:tp_hit': '止盈平仓',
        'position:sl_hit': '止损平仓',
        'position:manual_close': '手动平仓'
      };
      const pnlPct = typeof payload.pnl_pct === 'number' ? payload.pnl_pct : 0;
      toast(`持仓已结束 [${reasonMap[type]}]: ${typeof payload.symbol === 'string' ? payload.symbol : '代币'} (${pnlPct}%)`, pnlPct >= 0 ? 'success' : 'warning');
    }
  }, [lastEvent, toast, fetchPositions]);

  const handleWalletSync = async (id: EntityId, confirmed = false) => {
    if (!confirmed && !confirm(
      '确认同步交易钱包？\n\n系统将查询该代币余额和卖出记录；如发现遗留保护策略，会先核验并取消。只有找到唯一链上卖出证据后才会更新仓位。'
    )) return;
    setSyncingIds(previous => new Set(previous).add(id));
    try {
      const response = await api.trade.reconcileExternalClose(id);
      if (!response.ok || !response.data) {
        throw new Error(closeErrorMessage(response, '钱包同步失败'));
      }
      const messages: Record<string, { message: string; type: 'success' | 'warning' | 'info' }> = {
        matched: { message: '钱包仍持有完整仓位，无需同步', type: 'info' },
        external_balance_present: { message: '钱包余额不少于系统仓位，未修改仓位记录', type: 'info' },
        no_open_lot: { message: '该仓位已经完成同步', type: 'success' },
        chain_verifying: { message: '已找到钱包卖出交易，正在等待链上确认', type: 'success' },
        protection_close_detected: { message: '检测到保护策略成交，正在等待链上确认', type: 'success' },
        manual_reconciliation_required: { message: '卖出记录无法唯一匹配，仓位已转为待人工核对', type: 'warning' }
      };
      const feedback = messages[response.data.status]
        || { message: `钱包同步状态：${response.data.status}`, type: 'info' as const };
      toast(feedback.message, feedback.type);
      void fetchPositions();
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : '钱包同步异常', 'error');
      void fetchPositions();
    } finally {
      setSyncingIds(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const handleClose = async (id: EntityId) => {
    const position = positions.find(item => item.id === id);
    if (!position) return;
    if (position.execution_mode === 'paper') {
      if (!confirm('确认平仓模拟交易仓位？')) return;
      const response = await api.trade.close(id);
      if (response.ok) void fetchPositions();
      else toast(response.error || '模拟交易平仓失败', 'error');
      return;
    }
    setClosingIds(previous => new Set(previous).add(id));
    try {
      const prepared = await api.trade.prepareClose(id, 100);
      if (!prepared.ok || !prepared.data) {
        if (prepared.code === 'POSITION_BALANCE_EMPTY') {
          if (confirm(
            '交易钱包中已没有该代币。是否立即同步钱包卖出记录，并清理遗留保护策略？'
          )) {
            await handleWalletSync(id, true);
          }
          return;
        }
        throw new Error(closeErrorMessage(prepared, '平仓准备失败'));
      }
      const summary = prepared.data;
      const confirmed = confirm(
        `确认提交真实平仓？\n\n链: ${summary.chain}\n卖出: ${summary.sell_amount}\n钱包可用 raw: ${summary.wallet_available_raw}\n策略动作: ${summary.strategy_action}\n\n提交后仓位会保持显示，直到链上确认。`
      );
      if (!confirmed) return;
      const executed = await api.trade.executeClose(id, summary.prepare_token);
      if (!executed.ok) throw new Error(closeErrorMessage(executed, '平仓提交失败'));
      toast('平仓订单已提交，等待交易服务与链上确认', 'success');
      setPositions(previous => previous.map(item => item.id === id ? { ...item, status: 'closing' } : item));
    } catch (err: unknown) {
      toast(err instanceof Error ? err.message : '平仓异常', 'error');
    } finally {
      setClosingIds(previous => {
        const next = new Set(previous);
        next.delete(id);
        return next;
      });
    }
  };

  const getChainNativeSymbol = (chain: string): string => {
    const symbolMap: Record<string, string> = {
      sol: 'SOL',
      bsc: 'BNB',
      base: 'ETH',
      eth: 'ETH',
      robinhood: 'ETH'
    };
    return symbolMap[chain] || 'SOL';
  };

  const columns = [
    {
      header: '链',
      accessor: (row: Position) => <ChainIcon chain={row.chain_id} size="sm" />
    },
    {
      header: '代币',
      accessor: (row: Position) => (
        <div className="flex flex-col">
          <span className="font-semibold text-strong text-sm">{row.asset.display_label}</span>
          <span className="text-xs text-secondary font-mono" title={row.contract_address}>
            {row.contract_address.slice(0, 4)}...{row.contract_address.slice(-4)}
          </span>
        </div>
      )
    },
    {
      header: '投入金额',
      accessor: (row: Position) => (
        <span className="text-strong font-mono text-sm">
          {row.amount_in} {getChainNativeSymbol(row.chain_id)}
        </span>
      )
    },
    {
      header: '状态',
      accessor: (row: Position) => (
        <div className="flex flex-col gap-xs">
          <StatusBadge status={row.status} />
          {row.trade_intent_id && (
            <span className="text-xs text-secondary font-mono">
              Intent #{row.trade_intent_id} · Attempt {row.attempt_no || '-'}
            </span>
          )}
          {(row.failure_class || row.trade_error_code) && (
            <span className="text-xs text-danger font-mono">{row.failure_class || row.trade_error_code}</span>
          )}
        </div>
      )
    },
    {
      header: '入场价',
      accessor: (row: Position) => (
        <span className="text-secondary font-mono text-sm">
          ${Number(row.entry_price).toFixed(6)}
        </span>
      )
    },
    {
      header: '当前价',
      accessor: (row: Position) => (
        <span className="text-strong font-mono text-sm">
          ${row.exit_price ? Number(row.exit_price).toFixed(6) : Number(row.entry_price).toFixed(6)}
        </span>
      )
    },
    {
      header: '浮动盈亏 %',
      accessor: (row: Position) => {
        const pct = row.pnl_pct || 0;
        const isProfit = pct >= 0;
        return (
          <div className="flex items-center gap-xs font-mono font-bold text-sm" style={{ color: isProfit ? 'var(--color-success)' : 'var(--color-danger)' }}>
            {isProfit ? <TrendingUp size={14} /> : <TrendingDown size={14} />}
            {isProfit ? '+' : ''}{pct.toFixed(2)}%
          </div>
        );
      }
    },
    {
      header: '最高/最低涨幅',
      accessor: (row: Position) => {
        const peaks = row.sim_peaks;
        if (!peaks) return <span className="text-muted text-xs font-mono">-</span>;
        return (
          <div className="text-xs flex flex-col font-mono">
            <span className="text-success">最高: +{(peaks.max_gain_pct || 0).toFixed(2)}%</span>
            <span className="text-danger">最低: {(peaks.max_loss_pct || 0).toFixed(2)}%</span>
          </div>
        );
      }
    },
    {
      header: '止盈/止损目标',
      accessor: (row: Position) => (
        <span className="text-secondary text-sm font-mono">
          +{row.tp_pct}% / -{row.sl_pct}%
        </span>
      )
    },
    {
      header: '触发 KOL',
      accessor: (row: Position) => (
        <span className="text-sm font-semibold text-secondary">
          {row.kol_handle ? `@${row.kol_handle}` : '未知'}
        </span>
      )
    },
    {
      header: '开仓时间',
      accessor: (row: Position) => (
        <span className="text-xs text-secondary font-mono">
          {new Date(row.opened_at).toLocaleTimeString()}
        </span>
      )
    },
    {
      header: '操作',
      accessor: (row: Position) => (
        <div className="flex items-center gap-xs" style={{ minWidth: 112 }}>
          <button
            className="btn btn-danger text-xs flex items-center gap-xs"
            style={{ padding: '6px 10px' }}
            onClick={() => handleClose(row.id)}
            disabled={closingIds.has(row.id) || syncingIds.has(row.id) || ['closing', 'close_uncertain'].includes(row.status)}
          >
            <Power size={12} /> {closingIds.has(row.id) ? '准备中' : row.status === 'closing' ? '确认中' : '平仓'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ width: 30, height: 30, padding: 0 }}
            onClick={() => handleWalletSync(row.id)}
            disabled={syncingIds.has(row.id) || closingIds.has(row.id)}
            title="同步交易钱包"
            aria-label="同步交易钱包"
          >
            <RefreshCw size={13} className={syncingIds.has(row.id) ? 'spin' : ''} />
          </button>
        </div>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="flex flex-col gap-xs">
          <p className="text-secondary text-sm">仓位、保护策略与链上确认状态</p>
        </div>
        <button className="btn btn-secondary text-sm" onClick={fetchPositions}>刷新</button>
      </div>

      {loading ? (
          <TableSkeleton rows={3} cols={12} />
      ) : positions.length === 0 ? (
        <div className="card empty-state text-secondary">
          暂无活跃仓位。
        </div>
      ) : (
        <DataTable data={positions} columns={columns} />
      )}
    </div>
  );
}
