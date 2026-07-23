import React, { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, Search, X } from 'lucide-react';
import { api } from '../lib/api';
import type { TradeAttempt } from '../lib/types';
import { ChainIcon } from '../components/ui/ChainIcon';
import { TableSkeleton } from '../components/ui/Skeleton';
import { queryStageLabel, sideLabel, statusLabel } from '../lib/display-labels';

function explorerUrl(chain: string, hash: string) {
  const base: Record<string, string> = {
    sol: 'https://solscan.io/tx/',
    bsc: 'https://bscscan.com/tx/',
    base: 'https://basescan.org/tx/',
    eth: 'https://etherscan.io/tx/'
  };
  return `${base[chain] || ''}${hash}`;
}

function short(value?: string) {
  if (!value) return '-';
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function ageLabel(timestamp?: string, now = Date.now()) {
  if (!timestamp) return '-';
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function pollingIntervalLabel(order: any) {
  if (['confirmed', 'failed', 'expired'].includes(order.normalized_status)) return '已停止查询';
  if (order.last_queried_at && order.next_query_at) {
    const seconds = Math.max(0, Math.round(
      (new Date(order.next_query_at).getTime() - new Date(order.last_queried_at).getTime()) / 1000
    ));
    return `${seconds}s`;
  }
  return '等待首次查询';
}

function JsonSection({ title, rows }: { title: string; rows?: any[] }) {
  if (!rows?.length) return null;
  return (
    <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
      <span className="text-xs text-secondary">{title}</span>
      {rows.map((row: any, index: number) => (
        <pre key={row.id || `${title}-${index}`} className="font-mono text-xs"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '10px 0' }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      ))}
    </div>
  );
}

export default function TradeLog() {
  const [attempts, setAttempts] = useState<TradeAttempt[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<any>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    setLoading(true);
    const response = await api.trade.attempts(200);
    if (response.ok && response.data) setAttempts(response.data);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openDetail = async (id: string) => {
    setDetailLoading(true);
    setSelected({ id });
    const response = await api.trade.attempt(id);
    if (response.ok && response.data) setSelected(response.data);
    setDetailLoading(false);
  };

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center" style={{ flexWrap: 'wrap', gap: '12px' }}>
        <div className="flex gap-md text-sm text-secondary">
          <span>交易尝试 <strong className="text-white">{attempts.length}</strong></span>
          <span>待确认 <strong className="text-white">{attempts.filter(item => ['submitted', 'confirming', 'submission_uncertain'].includes(item.status)).length}</strong></span>
          <span>人工复核 <strong className="text-danger">{attempts.filter(item => item.requires_manual_review).length}</strong></span>
        </div>
        <button className="btn btn-secondary" onClick={refresh}><RefreshCw size={15} /> 刷新</button>
      </div>

      {loading ? <TableSkeleton rows={6} cols={9} /> : (
        <div className="table-container">
          <table className="table">
            <thead><tr>
              <th>编号</th><th>链</th><th>方向</th><th>交易尝试</th><th>交易订单</th>
              <th>查询阶段</th><th>上次 / 下次查询</th><th>交易哈希</th><th></th>
            </tr></thead>
            <tbody>
              {attempts.map(attempt => (
                <tr key={attempt.id}>
                  <td className="font-mono text-sm">#{attempt.id}</td>
                  <td><ChainIcon chain={attempt.chain} size="sm" /></td>
                  <td className="font-mono text-sm">{sideLabel(attempt.side)}</td>
                  <td>
                    <span className={attempt.requires_manual_review ? 'text-danger' : 'text-white'}>{statusLabel(attempt.status)}</span>
                    {attempt.error_code && <div className="text-xs text-danger font-mono">{attempt.error_code}</div>}
                  </td>
                  <td>
                    <span className="text-sm">{attempt.order_status ? statusLabel(attempt.order_status) : '未生成'}</span>
                    <button type="button" className="text-xs text-accent font-mono" title={attempt.provider_order_id}
                      style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer' }}
                      onClick={() => openDetail(attempt.id)}>{short(attempt.provider_order_id)}</button>
                  </td>
                  <td className="font-mono text-xs">{queryStageLabel(attempt.query_stage)}<div className="text-secondary">{attempt.query_count || 0} 次</div></td>
                  <td className="font-mono text-xs text-secondary">
                    <div>{attempt.last_queried_at ? new Date(attempt.last_queried_at).toLocaleTimeString() : '-'}</div>
                    <div>{attempt.query_stage === 'stopped' ? '已停止查询' : attempt.next_query_at ? new Date(attempt.next_query_at).toLocaleTimeString() : '-'}</div>
                  </td>
                  <td>
                    {attempt.tx_hash ? <a className="text-accent font-mono text-xs flex items-center gap-xs" href={explorerUrl(attempt.chain, attempt.tx_hash)} target="_blank" rel="noreferrer">{short(attempt.tx_hash)} <ExternalLink size={12} /></a> : '-'}
                  </td>
                  <td><button className="btn btn-secondary" title="订单详情" onClick={() => openDetail(attempt.id)}><Search size={15} /></button></td>
                </tr>
              ))}
              {attempts.length === 0 && <tr><td colSpan={9} className="text-center text-secondary" style={{ padding: '48px' }}>暂无交易尝试记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <div className="modal-overlay" onMouseDown={() => setSelected(null)}>
          <div className="modal-content" onMouseDown={event => event.stopPropagation()}>
            <div className="flex justify-between items-center border-b p-md" style={{ borderColor: 'var(--color-border)' }}>
              <strong>交易尝试 #{selected.id}</strong>
              <button className="btn btn-secondary" title="关闭" onClick={() => setSelected(null)}><X size={16} /></button>
            </div>
            <div className="p-md flex flex-col gap-md">
              {detailLoading ? <div className="text-secondary">加载中...</div> : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                    <div><span className="text-xs text-secondary">状态</span><div className="font-mono text-sm">{statusLabel(selected.status)}</div></div>
                    <div><span className="text-xs text-secondary">方向</span><div className="font-mono text-sm">{sideLabel(selected.side)}</div></div>
                    <div><span className="text-xs text-secondary">钱包</span><div className="font-mono text-xs" style={{ overflowWrap: 'anywhere' }}>{selected.wallet_address}</div></div>
                    <div><span className="text-xs text-secondary">创建时间</span><div className="font-mono text-xs">{selected.created_at ? new Date(selected.created_at).toLocaleString() : '-'}</div></div>
                  </div>
                  <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-xs text-secondary">交易订单</span>
                    {(selected.orders || []).map((order: any) => (
                      <div key={order.id} className="border-t py-sm" style={{ borderColor: 'var(--color-border)' }}>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                          <div><span className="text-xs text-secondary">订单编号</span><div className="font-mono text-xs" style={{ overflowWrap: 'anywhere' }}>{order.provider_order_id || '-'}</div></div>
                          <div><span className="text-xs text-secondary">年龄</span><div className="font-mono text-xs">{ageLabel(order.submitted_at, now)}</div></div>
                          <div><span className="text-xs text-secondary">状态</span><div className="font-mono text-xs">{statusLabel(order.normalized_status)}</div></div>
                          <div><span className="text-xs text-secondary">当前间隔</span><div className="font-mono text-xs">{pollingIntervalLabel(order)}</div></div>
                          <div><span className="text-xs text-secondary">上次 / 下次</span><div className="font-mono text-xs">{order.last_queried_at ? new Date(order.last_queried_at).toLocaleTimeString() : '-'} / {order.next_query_at ? new Date(order.next_query_at).toLocaleTimeString() : '-'}</div></div>
                          <div><span className="text-xs text-secondary">查询次数</span><div className="font-mono text-xs">{order.query_count || 0}</div></div>
                        </div>
                        {order.tx_hash && <a className="text-accent font-mono text-xs flex items-center gap-xs mt-1" href={explorerUrl(selected.chain, order.tx_hash)} target="_blank" rel="noreferrer">{order.tx_hash} <ExternalLink size={12} /></a>}
                        <pre className="font-mono text-xs" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', paddingTop: '10px' }}>{JSON.stringify({ report: order.report_json, fee_native: order.gas_native, fee_usd: order.gas_usd }, null, 2)}</pre>
                      </div>
                    ))}
                  </div>
                  <JsonSection title="策略组" rows={selected.strategy_groups} />
                  <JsonSection title="策略明细" rows={selected.strategy_legs} />
                  <JsonSection title="持仓批次" rows={selected.position_lots} />
                  <JsonSection title="链上回执" rows={selected.chain_receipts} />
                  <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-xs text-secondary">状态历史</span>
                    {(selected.events || []).sort((a: any, b: any) => Number(a.id) - Number(b.id)).map((event: any) => (
                      <div key={event.id} className="flex justify-between gap-sm py-sm text-xs border-t" style={{ borderColor: 'var(--color-border)' }}>
                        <span className="font-mono">{event.from_status ? statusLabel(event.from_status) : '新建'} → {statusLabel(event.to_status)}</span>
                        <span className="text-secondary">{new Date(event.created_at).toLocaleString()}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
