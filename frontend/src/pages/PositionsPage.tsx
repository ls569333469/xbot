import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Position } from '../lib/types';
import { useWebSocket } from '../hooks/useWebSocket';
import { useToast } from '../components/ui/Toast';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { TableSkeleton } from '../components/ui/Skeleton';
import { Play, TrendingUp, TrendingDown, Power } from 'lucide-react';

export default function PositionsPage() {
  const [positions, setPositions] = useState<Position[]>([]);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();
  const { lastEvent } = useWebSocket();

  const fetchPositions = useCallback(() => {
    setLoading(true);
    api.trade.positions()
      .then(res => {
        if (res.ok && res.data) {
          setPositions(res.data as unknown as Position[]);
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
    
    if (type === 'trade:executed') {
      setPositions(prev => [payload, ...prev]);
      toast(`新实盘开仓: ${payload.symbol || '代币'}`, 'success');
    } else if (type === 'position:update') {
      setPositions(prev => 
        prev.map(pos => 
          pos.id === payload.id 
            ? { ...pos, exit_price: payload.exit_price, pnl: payload.pnl, pnl_pct: payload.pnl_pct, sim_peaks: payload.sim_peaks }
            : pos
        )
      );
    } else if (['position:tp_hit', 'position:sl_hit', 'position:manual_close'].includes(type)) {
      setPositions(prev => prev.filter(pos => pos.id !== payload.id));
      const reasonMap: Record<string, string> = {
        'position:tp_hit': '止盈平仓',
        'position:sl_hit': '止损平仓',
        'position:manual_close': '手动平仓'
      };
      toast(`持仓已结束 [${reasonMap[type]}]: ${payload.symbol || '代币'} (${payload.pnl_pct}%)`, payload.pnl_pct >= 0 ? 'success' : 'warning');
    }
  }, [lastEvent, toast]);

  const handleClose = async (id: string) => {
    if (!confirm('确认要手动平仓此仓位吗？平仓将撤销在途条件单并以市价成交。')) return;
    try {
      const res = await api.trade.close(id);
      if (res.ok) {
        toast('平仓指令提交成功', 'success');
        setPositions(prev => prev.filter(pos => pos.id !== id));
      } else {
        toast(res.error || '平仓失败', 'error');
      }
    } catch (err: any) {
      toast(err.message || '平仓异常', 'error');
    }
  };

  const getChainNativeSymbol = (chain: string): string => {
    const symbolMap: Record<string, string> = {
      sol: 'SOL',
      bsc: 'BNB',
      base: 'ETH',
      eth: 'ETH',
      robinhood: 'USD'
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
          <span className="font-semibold text-white text-sm">{row.symbol || 'Unknown'}</span>
          <span className="text-xs text-secondary font-mono" title={row.contract_address}>
            {row.contract_address.slice(0, 4)}...{row.contract_address.slice(-4)}
          </span>
        </div>
      )
    },
    {
      header: '投入金额',
      accessor: (row: Position) => (
        <span className="text-white font-mono text-sm">
          {row.amount_in} {getChainNativeSymbol(row.chain_id)}
        </span>
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
        <span className="text-white font-mono text-sm">
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
      header: '极值记录 (Max/Min)',
      accessor: (row: Position) => {
        const peaks = row.sim_peaks;
        if (!peaks) return <span className="text-muted text-xs font-mono">-</span>;
        return (
          <div className="text-xs flex flex-col font-mono">
            <span className="text-success">Max: +{(peaks.max_gain_pct || 0).toFixed(2)}%</span>
            <span className="text-danger">Min: {(peaks.max_loss_pct || 0).toFixed(2)}%</span>
          </div>
        );
      }
    },
    {
      header: 'TP/SL 目标',
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
        <button
          className="btn btn-danger text-xs flex items-center gap-xs"
          style={{ padding: '6px 10px' }}
          onClick={() => handleClose(row.id)}
        >
          <Power size={12} /> 平仓
        </button>
      )
    }
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="flex flex-col gap-xs">
          <p className="text-secondary text-sm">实盘条件单及价格追踪，刷新频率为 10 秒</p>
        </div>
        <button className="btn btn-secondary text-sm" onClick={fetchPositions}>刷新</button>
      </div>

      {loading ? (
        <TableSkeleton rows={3} cols={11} />
      ) : positions.length === 0 ? (
        <div className="card text-center text-secondary py-lg" style={{ padding: '64px' }}>
          暂无活跃持仓。当系统武装（Armed）且 KOL 活动匹配白名单 CA 通过风控时将自动触发实盘交易并建立仓位。
        </div>
      ) : (
        <DataTable data={positions} columns={columns} />
      )}
    </div>
  );
}
