import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { useWebSocket } from '../hooks/useWebSocket';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ChainIcon } from '../components/ui/ChainIcon';
import { Skeleton } from '../components/ui/Skeleton';
import { TradeSignal } from '../lib/types';

export default function SignalLog() {
  const [signals, setSignals] = useState<TradeSignal[]>([]);
  const [chainFilter, setChainFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const { lastEvent } = useWebSocket();

  const fetchSignals = () => {
    setLoading(true);
    const params: Record<string, string> = { pageSize: '50' };
    if (chainFilter) params.chain_id = chainFilter;
    if (statusFilter) params.status = statusFilter;
    api.signals.list(params).then(res => {
      if (res.ok && res.data) setSignals(res.data as unknown as TradeSignal[]);
      setLoading(false);
    });
  };

  useEffect(() => { fetchSignals(); }, [chainFilter, statusFilter]);

  useEffect(() => {
    if (lastEvent?.type === 'signal:matched') {
      fetchSignals();
    }
  }, [lastEvent]);

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex gap-sm">
        <select className="input" style={{ width: '150px' }} value={chainFilter} onChange={e => setChainFilter(e.target.value)}>
          <option value="">所有链</option>
          <option value="sol">SOL</option>
          <option value="bsc">BSC</option>
          <option value="base">Base</option>
          <option value="eth">ETH</option>
        </select>
        <select className="input" style={{ width: '150px' }} value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">所有状态</option>
          <option value="recorded">已记录</option>
          <option value="pending">待处理</option>
          <option value="executed">已执行</option>
          <option value="rejected">已拒绝</option>
        </select>
        <div className="text-sm text-secondary" style={{ lineHeight: '36px', marginLeft: 'auto' }}>
          {loading ? '加载中...' : `共 ${signals.length} 条信号`}
        </div>
      </div>

      <div className="flex flex-col gap-md">
        {loading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="card flex items-start gap-md">
              <Skeleton width={32} height={32} circle />
              <div className="flex-1 flex flex-col gap-xs">
                <div className="flex justify-between items-center mb-xs">
                  <Skeleton width="30%" height={16} />
                  <Skeleton width="10%" height={16} />
                </div>
                <Skeleton width="45%" height={12} className="mb-sm" />
                <Skeleton width="100%" height={40} />
              </div>
            </div>
          ))
        ) : (
          <>
            {signals.length === 0 && (
              <div className="card text-center text-secondary" style={{ padding: '48px' }}>暂无信号记录</div>
            )}
            {signals.map((sig, idx) => (
              <div key={sig.id} className="card animate-slide-in flex items-start gap-md" style={{ animationDelay: `${Math.min(idx, 10) * 50}ms` }}>
                <div style={{ marginTop: '4px' }}>
                  <ChainIcon chain={(sig as any).chain_id || 'sol'} size="lg" />
                </div>
                <div className="flex-1 flex flex-col gap-xs">
                  <div className="flex justify-between items-start">
                    <div className="flex items-center gap-sm">
                      <span className="font-bold text-lg">@{sig.kol_handle}</span>
                      <span className="text-xs text-secondary font-mono" style={{ background: 'rgba(255,255,255,0.06)', padding: '2px 8px', borderRadius: '4px' }}>
                        W:{sig.kol_weight || 5}
                      </span>
                    </div>
                    <div className="flex flex-col items-end gap-xs">
                      <StatusBadge status={sig.status} />
                      {sig.status === 'rejected' && sig.reject_reason && (
                        <span className="text-xs text-danger font-mono font-medium">{sig.reject_reason}</span>
                      )}
                    </div>
                  </div>
                  <div className="text-sm text-secondary">
                    匹配类型: <span className="font-mono" style={{ color: 'var(--color-accent)', background: 'rgba(108,92,231,0.1)', padding: '2px 8px', borderRadius: '4px', fontSize: '0.75rem', fontWeight: 600 }}>{(sig as any).signal_type || sig.type}</span>
                  </div>
                  <div className="mt-2 p-3 rounded" style={{ background: 'rgba(0,0,0,0.2)', border: '1px solid var(--color-border)' }}>
                    <div className="font-semibold text-sm">{sig.project_name || (sig as any).symbol || 'Unknown Token'}
                      <span className="text-xs text-secondary font-mono ml-2">({sig.match_detail})</span>
                    </div>
                  </div>
                  <div className="text-xs text-muted font-mono mt-1">{new Date(sig.created_at || (sig as any).timestamp).toLocaleString()}</div>
                </div>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
