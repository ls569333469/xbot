import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Position } from '../lib/types';
import { DataTable } from '../components/ui/DataTable';
import { ChainIcon } from '../components/ui/ChainIcon';
import { StatusBadge } from '../components/ui/StatusBadge';
import { TableSkeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/Toast';
import { Download } from 'lucide-react';

export default function TradeLog() {
  const [history, setHistory] = useState<Position[]>([]);
  const [chainFilter, setChainFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  const fetchHistory = useCallback(() => {
    setLoading(true);
    const params: Record<string, string> = {};
    if (chainFilter) params.chain_id = chainFilter;

    api.trade.history(params)
      .then(res => {
        if (res.ok && res.data) {
          setHistory(res.data as unknown as Position[]);
        }
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [chainFilter]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

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

  const handleExportCSV = async () => {
    const token = localStorage.getItem('xbot_admin_token') || 'xbot_admin_2026';
    try {
      const res = await fetch('/api/trade/history/export-csv', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (!res.ok) {
        throw new Error('HTTP status ' + res.status);
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'xbot-trade-history.csv';
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
      toast('交易历史 CSV 导出成功！', 'success');
    } catch (err: any) {
      toast('导出 CSV 失败: ' + err.message, 'error');
    }
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
          <span className="text-xs text-secondary font-mono">
            {row.contract_address.slice(0, 4)}...{row.contract_address.slice(-4)}
          </span>
        </div>
      )
    },
    {
      header: '状态',
      accessor: (row: Position) => <StatusBadge status={row.status} />
    },
    {
      header: '投入额',
      accessor: (row: Position) => (
        <span className="text-white font-mono font-semibold text-sm">
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
      header: '出场价',
      accessor: (row: Position) => (
        <span className="text-white font-mono text-sm">
          ${row.exit_price ? Number(row.exit_price).toFixed(6) : '-'}
        </span>
      )
    },
    {
      header: '实盘盈亏',
      accessor: (row: Position) => {
        const pnl = Number(row.pnl || 0);
        const pnlPct = Number(row.pnl_pct || 0);
        const isProfit = pnl >= 0;
        const nativeSymbol = getChainNativeSymbol(row.chain_id);
        
        return (
          <div className="flex flex-col font-mono text-sm" style={{ color: isProfit ? 'var(--color-success)' : 'var(--color-danger)' }}>
            <span className="font-bold">{isProfit ? '+' : ''}{pnl.toFixed(5)} {nativeSymbol}</span>
            <span className="text-xs">{isProfit ? '+' : ''}{pnlPct.toFixed(2)}%</span>
          </div>
        );
      }
    },
    {
      header: '历史极值 (Max/Min)',
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
      header: '触发 KOL',
      accessor: (row: Position) => (
        <span className="text-sm font-semibold text-secondary">
          {row.kol_handle ? `@${row.kol_handle}` : '未知'}
        </span>
      )
    },
    {
      header: '持仓时长',
      accessor: (row: Position) => {
        if (!row.closed_at) return <span className="text-xs font-mono">-</span>;
        const openTime = new Date(row.opened_at).getTime();
        const closeTime = new Date(row.closed_at).getTime();
        const diffSec = Math.max(0, Math.floor((closeTime - openTime) / 1000));
        
        if (diffSec < 60) return <span className="text-xs font-mono">{diffSec}秒</span>;
        const diffMin = Math.floor(diffSec / 60);
        const remSec = diffSec % 60;
        return <span className="text-xs font-mono">{diffMin}分{remSec}秒</span>;
      }
    },
    {
      header: '结束时间',
      accessor: (row: Position) => {
        if (!row.closed_at) return <span className="text-xs font-mono">-</span>;
        return (
          <span className="text-xs text-secondary font-mono">
            {new Date(row.closed_at).toLocaleString()}
          </span>
        );
      }
    }
  ];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center">
        <div className="flex flex-col gap-xs">
          <p className="text-secondary text-sm">显示已结转平仓的实盘与历史记录</p>
        </div>
        <div className="flex gap-sm">
          <select 
            className="input" 
            style={{ width: '150px' }} 
            value={chainFilter} 
            onChange={e => setChainFilter(e.target.value)}
          >
            <option value="">所有链</option>
            <option value="sol">Solana</option>
            <option value="bsc">BSC</option>
            <option value="base">Base</option>
            <option value="eth">Ethereum</option>
          </select>
          <button className="btn btn-secondary text-sm flex items-center gap-xs" onClick={handleExportCSV}>
            <Download size={14} /> 导出 CSV
          </button>
          <button className="btn btn-secondary text-sm" onClick={fetchHistory}>刷新</button>
        </div>
      </div>

      {loading ? (
        <TableSkeleton rows={5} cols={11} />
      ) : history.length === 0 ? (
        <div className="card text-center text-secondary py-lg" style={{ padding: '64px' }}>
          暂无已平仓交易历史记录。
        </div>
      ) : (
        <DataTable data={history} columns={columns} />
      )}
    </div>
  );
}
