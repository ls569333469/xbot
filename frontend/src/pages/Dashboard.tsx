import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ChainIcon } from '../components/ui/ChainIcon';
import { ProgressBar } from '../components/ui/ProgressBar';
import { CardSkeleton, Skeleton } from '../components/ui/Skeleton';
import { Activity, DollarSign, Target, TrendingUp } from 'lucide-react';
import { TradeSignal } from '../lib/types';

export default function Dashboard() {
  const [stats, setStats] = useState({ signalsToday: 0, tradesToday: 0, activePositions: 0, totalPnl: 0 });
  const [chainConfigs, setChainConfigs] = useState<any>(null);
  const [budgetsSpent, setBudgetsSpent] = useState<any[]>([]);
  const [recentSignals, setRecentSignals] = useState<TradeSignal[]>([]);
  const [loading, setLoading] = useState(true);
  const { lastEvent } = useWebSocket();

  const fetchDashboardData = useCallback(() => {
    Promise.all([
      api.system.dashboard(),
      api.config.getChains(),
      api.system.budgets(),
      api.signals.list({ pageSize: '20' }),
    ]).then(([dashRes, chainsRes, budgetsRes, signalsRes]) => {
      if (dashRes.ok && dashRes.data) setStats(dashRes.data);
      if (chainsRes.ok && chainsRes.data) setChainConfigs(chainsRes.data);
      if (budgetsRes.ok && budgetsRes.data) setBudgetsSpent(budgetsRes.data);
      if (signalsRes.ok && signalsRes.data) setRecentSignals(signalsRes.data as unknown as TradeSignal[]);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    fetchDashboardData();
  }, [fetchDashboardData]);

  useEffect(() => {
    if (!lastEvent) return;
    
    const triggerEvents = [
      'signal:matched',
      'trade:executed',
      'trade:failed',
      'position:tp_hit',
      'position:sl_hit',
      'position:manual_close',
      'position:update'
    ];
    
    if (triggerEvents.includes(lastEvent.type)) {
      api.system.dashboard().then(res => {
        if (res.ok && res.data) setStats(res.data);
      });

      if (lastEvent.type === 'signal:matched' || lastEvent.type === 'trade:executed') {
        api.signals.list({ pageSize: '20' }).then(res => {
          if (res.ok && res.data) setRecentSignals(res.data as unknown as TradeSignal[]);
        });
      }
    }
  }, [lastEvent]);

  const budgets = chainConfigs
    ? Object.entries(chainConfigs).filter(([, v]: any) => (v as any).enabled).map(([k, v]: any) => {
        const spentEntry = budgetsSpent.find(b => b.chain_id === k && b.period_type === 'daily');
        return {
          chain: k,
          total: v.dailyBudget || 0,
          spent: spentEntry ? parseFloat(spentEntry.spent) : 0,
        };
      })
    : [];

  if (loading) {
    return (
      <div className="flex flex-col gap-lg">
        <div className="grid grid-cols-4 gap-lg">
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </div>
        <div className="grid grid-cols-2 gap-lg">
          <div className="card flex flex-col gap-md">
            <h3 className="text-lg font-bold border-b pb-2" style={{ borderColor: 'var(--color-border)' }}>当日预算进度</h3>
            <div className="flex flex-col gap-md">
              <div className="flex items-center gap-md">
                <Skeleton width={24} height={24} circle />
                <div className="flex-1"><Skeleton width="100%" height={12} /></div>
              </div>
              <div className="flex items-center gap-md">
                <Skeleton width={24} height={24} circle />
                <div className="flex-1"><Skeleton width="100%" height={12} /></div>
              </div>
            </div>
          </div>
          <div className="card flex flex-col gap-md">
            <h3 className="text-lg font-bold border-b pb-2" style={{ borderColor: 'var(--color-border)' }}>实时信号</h3>
            <div className="flex flex-col gap-sm">
              <Skeleton width="100%" height={40} />
              <Skeleton width="100%" height={40} />
              <Skeleton width="100%" height={40} />
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="grid grid-cols-4 gap-lg">
        <div className="card flex flex-col gap-sm">
          <div className="text-secondary text-sm flex items-center gap-xs"><Activity size={16} /> 今日信号</div>
          <div className="text-2xl font-bold">{stats.signalsToday}</div>
        </div>
        <div className="card flex flex-col gap-sm">
          <div className="text-secondary text-sm flex items-center gap-xs"><Target size={16} /> 今日交易</div>
          <div className="text-2xl font-bold">{stats.tradesToday}</div>
        </div>
        <div className="card flex flex-col gap-sm">
          <div className="text-secondary text-sm flex items-center gap-xs"><TrendingUp size={16} /> 活跃持仓</div>
          <div className="text-2xl font-bold">{stats.activePositions}</div>
        </div>
        <div className="card flex flex-col gap-sm">
          <div className="text-secondary text-sm flex items-center gap-xs"><DollarSign size={16} /> 总 PnL (USD)</div>
          <div className={`text-2xl font-bold ${stats.totalPnl >= 0 ? 'text-success' : 'text-danger'}`}>
            {stats.totalPnl >= 0 ? '+' : ''}${stats.totalPnl.toFixed(2)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-lg">
        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold border-b pb-2" style={{ borderColor: 'var(--color-border)' }}>当日预算进度</h3>
          <div className="flex flex-col gap-md">
            {budgets.length === 0 && <div className="text-secondary text-sm">无启用链</div>}
            {budgets.map(b => (
              <div key={b.chain} className="flex items-center gap-md">
                <ChainIcon chain={b.chain as any} />
                <div className="flex-1">
                  <ProgressBar value={b.spent} max={b.total} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold border-b pb-2" style={{ borderColor: 'var(--color-border)' }}>实时信号</h3>
          <div className="flex flex-col gap-sm" style={{ maxHeight: '300px', overflowY: 'auto' }}>
            {recentSignals.length === 0 && <div className="text-secondary text-sm">暂无信号</div>}
            {recentSignals.map(sig => (
              <div key={sig.id} className="flex justify-between items-center p-2 rounded" style={{ background: 'rgba(255,255,255,0.02)' }}>
                <div className="flex items-center gap-md">
                  <ChainIcon chain={(sig as any).chain_id || 'sol'} size="sm" />
                  <div className="flex flex-col">
                    <span className="font-semibold text-sm">@{sig.kol_handle}</span>
                    <span className="text-xs text-secondary">{sig.project_name || (sig as any).symbol || 'Unknown'} — {(sig as any).signal_type || sig.type}</span>
                  </div>
                </div>
                <StatusBadge status={sig.status} />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
