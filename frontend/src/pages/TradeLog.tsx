import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, RefreshCw, RotateCcw, Search, ShieldAlert, Unlock, X } from 'lucide-react';
import { api } from '../lib/api';
import type {
  ChainTradeCircuit, TradeAttempt, TradeAttemptDetails,
  TradeRetryRuntime, WalletWriteLane
} from '../lib/types';
import { ChainIcon } from '../components/ui/ChainIcon';
import { TableSkeleton } from '../components/ui/Skeleton';
import { useToast } from '../components/ui/ToastContext';
import { queryStageLabel, sideLabel, statusLabel } from '../lib/display-labels';

function explorerUrl(chain: string, hash: string) {
  const base: Record<string, string> = {
    sol: 'https://solscan.io/tx/',
    bsc: 'https://bscscan.com/tx/',
    base: 'https://basescan.org/tx/',
    eth: 'https://etherscan.io/tx/'
  };
  return base[chain] ? `${base[chain]}${hash}` : null;
}

function short(value?: string | null) {
  if (!value) return '-';
  return value.length > 18 ? `${value.slice(0, 8)}...${value.slice(-6)}` : value;
}

function ageLabel(timestamp?: string | null, now = Date.now()) {
  if (!timestamp) return '-';
  const seconds = Math.max(0, Math.floor((now - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function nativeSymbol(chain: string) {
  return ({ sol: 'SOL', bsc: 'BNB', base: 'ETH', eth: 'ETH', robinhood: 'ETH' } as Record<string, string>)[chain] || '';
}

function numberLabel(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return '-';
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString('en-US', { maximumFractionDigits: 9 }) : String(value);
}

function pollingIntervalLabel(order: Record<string, any>) {
  if (['confirmed', 'failed', 'expired'].includes(order.normalized_status)) return '已停止查询';
  if (order.normalized_status === 'definitive_failed_no_fill') return '15-30 分钟终态审计';
  if (order.last_queried_at && order.next_query_at) {
    const seconds = Math.max(0, Math.round(
      (new Date(order.next_query_at).getTime() - new Date(order.last_queried_at).getTime()) / 1000
    ));
    return `${seconds}s`;
  }
  return '等待首次查询';
}

function JsonSection({ title, rows }: { title: string; rows?: Array<Record<string, unknown>> }) {
  if (!rows?.length) return null;
  return (
    <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
      <span className="text-xs text-secondary">{title}</span>
      {rows.map((row, index) => (
        <pre key={String(row.id || `${title}-${index}`)} className="font-mono text-xs"
          style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', padding: '10px 0' }}>
          {JSON.stringify(row, null, 2)}
        </pre>
      ))}
    </div>
  );
}

export default function TradeLog() {
  const [attempts, setAttempts] = useState<TradeAttempt[]>([]);
  const [runtime, setRuntime] = useState<TradeRetryRuntime | null>(null);
  const [lanes, setLanes] = useState<WalletWriteLane[]>([]);
  const [loading, setLoading] = useState(true);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [selected, setSelected] = useState<TradeAttemptDetails | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionKey, setActionKey] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    setLoading(true);
    const [attemptResponse, runtimeResponse, laneResponse] = await Promise.all([
      api.trade.attempts(200),
      api.trade.retryRuntime(),
      api.trade.walletLanes()
    ]);
    if (attemptResponse.ok && attemptResponse.data) setAttempts(attemptResponse.data);
    if (runtimeResponse.ok && runtimeResponse.data) setRuntime(runtimeResponse.data);
    if (laneResponse.ok && laneResponse.data) setLanes(laneResponse.data);
    setLoading(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const openDetail = async (id: string) => {
    setDetailId(id);
    setSelected(null);
    setDetailLoading(true);
    const response = await api.trade.attempt(id);
    if (response.ok && response.data) setSelected(response.data);
    else toast(response.error || '交易详情加载失败', 'error');
    setDetailLoading(false);
  };

  const releaseQuarantine = async (lane: WalletWriteLane) => {
    const reason = window.prompt('填写解除隔离原因（将写入审计记录）');
    if (!reason?.trim()) return;
    const evidence = window.prompt('填写已核对的 GMGN Order、Tx Hash、Receipt 或余额证据');
    if (!evidence?.trim()) return;
    if (!window.confirm(`确认解除 ${lane.chain.toUpperCase()} ${lane.wallet_masked || short(lane.wallet_address)} 的资金写入隔离？`)) return;
    const key = `lane:${lane.chain}:${lane.wallet_address}`;
    setActionKey(key);
    const response = await api.trade.releaseWalletLane(lane, reason.trim(), evidence.trim());
    setActionKey(null);
    if (!response.ok) return toast(response.error || '解除钱包隔离失败', 'error');
    toast('钱包隔离已解除，审计记录已保存', 'success');
    await refresh();
  };

  const resetCircuit = async (circuit: ChainTradeCircuit) => {
    const reason = window.prompt('填写链级熔断重置原因（将写入审计记录）');
    if (!reason?.trim()) return;
    if (!window.confirm(`确认重置 ${circuit.chain.toUpperCase()} 连续失败熔断？`)) return;
    const key = `circuit:${circuit.chain}`;
    setActionKey(key);
    const response = await api.trade.resetChainCircuit(circuit.chain, reason.trim());
    setActionKey(null);
    if (!response.ok) return toast(response.error || '重置链级熔断失败', 'error');
    toast(`${circuit.chain.toUpperCase()} 连续失败熔断已重置`, 'success');
    await refresh();
  };

  const quarantinedLanes = lanes.filter(lane => lane.state === 'quarantined');
  const trippedCircuits = runtime?.circuits.filter(circuit => circuit.state === 'tripped') || [];

  return (
    <div className="flex flex-col gap-lg">
      <div className="flex justify-between items-center" style={{ flexWrap: 'wrap', gap: '12px' }}>
        <div className="flex gap-md text-sm text-secondary" style={{ flexWrap: 'wrap' }}>
          <span>交易尝试 <strong className="text-white">{attempts.length}</strong></span>
          <span>待核对 <strong className="text-white">{attempts.filter(item => ['submitted', 'confirming', 'submission_uncertain', 'failure_verifying'].includes(item.status)).length}</strong></span>
          <span>待重试 <strong className="text-warning">{runtime?.backlog.reduce((sum, row) => sum + Number(row.count), 0) || 0}</strong></span>
          <span>扫描 / 恢复 <strong className="text-white">{runtime ? `${runtime.scanIntervalMs}ms / ${runtime.maintenanceIntervalMs / 1000}s` : '-'}</strong></span>
          <span>钱包隔离 <strong className="text-danger">{quarantinedLanes.length}</strong></span>
          <span>链熔断 <strong className="text-danger">{trippedCircuits.length}</strong></span>
        </div>
        <button className="btn btn-secondary" onClick={() => void refresh()}><RefreshCw size={15} /> 刷新</button>
      </div>

      {(quarantinedLanes.length > 0 || trippedCircuits.length > 0) && (
        <div className="flex flex-col gap-sm">
          {quarantinedLanes.map(lane => (
            <div key={`${lane.chain}:${lane.wallet_address}`} className="card flex justify-between items-center"
              style={{ gap: '12px', flexWrap: 'wrap', borderColor: 'var(--color-danger)' }}>
              <div className="flex items-center gap-sm">
                <ShieldAlert size={18} className="text-danger" />
                <div>
                  <strong>{lane.chain.toUpperCase()} 钱包资金写入已隔离</strong>
                  <div className="text-xs text-secondary font-mono">{lane.wallet_masked || short(lane.wallet_address)} · {lane.reason_code || '-'} · {lane.quarantined_at ? new Date(lane.quarantined_at).toLocaleString() : '-'}</div>
                </div>
              </div>
              <button className="btn btn-secondary" disabled={actionKey !== null}
                onClick={() => void releaseQuarantine(lane)}><Unlock size={15} /> 解除隔离</button>
            </div>
          ))}
          {trippedCircuits.map(circuit => (
            <div key={circuit.chain} className="card flex justify-between items-center"
              style={{ gap: '12px', flexWrap: 'wrap', borderColor: 'var(--color-danger)' }}>
              <div className="flex items-center gap-sm">
                <ShieldAlert size={18} className="text-danger" />
                <div>
                  <strong>{circuit.chain.toUpperCase()} 新买入已熔断</strong>
                  <div className="text-xs text-secondary">连续明确失败 {circuit.consecutive_failures} / {circuit.threshold} · {circuit.reason_code || '-'}</div>
                </div>
              </div>
              <button className="btn btn-secondary" disabled={actionKey !== null}
                onClick={() => void resetCircuit(circuit)}><RotateCcw size={15} /> 重置熔断</button>
            </div>
          ))}
        </div>
      )}

      {loading ? <TableSkeleton rows={6} cols={10} /> : (
        <div className="table-container">
          <table className="table">
            <thead><tr>
              <th>Intent / Attempt</th><th>链</th><th>方向</th><th>状态</th><th>重试</th>
              <th>本金 / 费用</th><th>订单</th><th>查询阶段</th><th>交易哈希</th><th></th>
            </tr></thead>
            <tbody>
              {attempts.map(attempt => {
                const remaining = Math.max(0, Number(attempt.max_retries || 0) - Number(attempt.retry_count || 0));
                const symbol = nativeSymbol(attempt.chain);
                const url = attempt.tx_hash ? explorerUrl(attempt.chain, attempt.tx_hash) : null;
                return (
                  <tr key={attempt.id}>
                    <td className="font-mono text-xs">
                      <div>Intent #{attempt.intent_id}</div>
                      <div className="text-secondary">Attempt {attempt.attempt_no} · 记录 #{attempt.id}</div>
                    </td>
                    <td><ChainIcon chain={attempt.chain} size="sm" /></td>
                    <td className="font-mono text-sm">{sideLabel(attempt.side)}</td>
                    <td>
                      <span className={attempt.requires_manual_review ? 'text-danger' : 'text-white'}>{statusLabel(attempt.status)}</span>
                      <div className="text-xs text-secondary">Intent: {statusLabel(attempt.intent_status)}</div>
                      {(attempt.error_code || attempt.failure_class) && <div className="text-xs text-danger font-mono">{attempt.error_code || attempt.failure_class}</div>}
                    </td>
                    <td className="text-xs">
                      <div>第 {attempt.attempt_no} 次提交</div>
                      <div className="text-secondary">剩余 {remaining} 次</div>
                      {attempt.next_retry_at && <div className="font-mono">{new Date(attempt.next_retry_at).toLocaleTimeString()}</div>}
                    </td>
                    <td className="font-mono text-xs">
                      <div>{numberLabel(attempt.principal_reserved_native)} {symbol}</div>
                      <div className="text-secondary">费用 {numberLabel(attempt.fee_used_native)} / {numberLabel(attempt.retry_fee_envelope_native)}</div>
                    </td>
                    <td>
                      <span className="text-sm">{attempt.order_status ? statusLabel(attempt.order_status) : '未生成'}</span>
                      <button type="button" className="text-xs text-accent font-mono" title={attempt.provider_order_id}
                        style={{ border: 0, padding: 0, background: 'transparent', cursor: 'pointer', display: 'block' }}
                        onClick={() => void openDetail(attempt.id)}>{short(attempt.provider_order_id)}</button>
                    </td>
                    <td className="font-mono text-xs">{queryStageLabel(attempt.query_stage)}<div className="text-secondary">{attempt.query_count || 0} 次</div></td>
                    <td>
                      {attempt.tx_hash && url ? <a className="text-accent font-mono text-xs flex items-center gap-xs" href={url} target="_blank" rel="noreferrer">{short(attempt.tx_hash)} <ExternalLink size={12} /></a> : short(attempt.tx_hash)}
                    </td>
                    <td><button className="btn btn-secondary" title="订单详情" onClick={() => void openDetail(attempt.id)}><Search size={15} /></button></td>
                  </tr>
                );
              })}
              {attempts.length === 0 && <tr><td colSpan={10} className="text-center text-secondary" style={{ padding: '48px' }}>暂无交易尝试记录</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {detailId && (
        <div className="modal-overlay" onMouseDown={() => setDetailId(null)}>
          <div className="modal-content" onMouseDown={event => event.stopPropagation()}>
            <div className="flex justify-between items-center border-b p-md" style={{ borderColor: 'var(--color-border)' }}>
              <strong>交易 Intent {selected ? `#${selected.intent_id} · Attempt ${selected.attempt_no}` : `· 记录 #${detailId}`}</strong>
              <button className="btn btn-secondary" title="关闭" onClick={() => setDetailId(null)}><X size={16} /></button>
            </div>
            <div className="p-md flex flex-col gap-md">
              {detailLoading || !selected ? <div className="text-secondary">加载中...</div> : (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px' }}>
                    <div><span className="text-xs text-secondary">Attempt 状态</span><div className="font-mono text-sm">{statusLabel(selected.status)}</div></div>
                    <div><span className="text-xs text-secondary">Intent 状态</span><div className="font-mono text-sm">{statusLabel(selected.intent.status)}</div></div>
                    <div><span className="text-xs text-secondary">提交序号</span><div className="font-mono text-sm">{selected.attempt_no} / {Number(selected.intent.max_retries) + 1}</div></div>
                    <div><span className="text-xs text-secondary">钱包写入状态</span><div className="font-mono text-sm">{selected.wallet_lane ? statusLabel(selected.wallet_lane.state) : '未占用'}</div></div>
                    <div><span className="text-xs text-secondary">失败分类</span><div className="font-mono text-xs">{selected.failure_class || selected.error_code || '-'}</div></div>
                    <div><span className="text-xs text-secondary">创建时间</span><div className="font-mono text-xs">{new Date(selected.created_at).toLocaleString()}</div></div>
                  </div>
                  <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-xs text-secondary">资金预留</span>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '12px', marginTop: '8px' }}>
                      <div><span className="text-xs text-secondary">本金</span><div className="font-mono text-sm">{numberLabel(selected.budget_reservation?.amount_native)} {nativeSymbol(selected.chain)}</div></div>
                      <div><span className="text-xs text-secondary">费用 Envelope</span><div className="font-mono text-sm">{numberLabel(selected.budget_reservation?.fee_native)} {nativeSymbol(selected.chain)}</div></div>
                      <div><span className="text-xs text-secondary">已用失败 Gas</span><div className="font-mono text-sm">{numberLabel(selected.budget_reservation?.fee_used_native)} {nativeSymbol(selected.chain)}</div></div>
                      <div><span className="text-xs text-secondary">费用升档</span><div className="font-mono text-sm">Level {selected.fee_escalation_level || 0}</div></div>
                    </div>
                  </div>
                  <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-xs text-secondary">交易订单</span>
                    {selected.orders.map((order: Record<string, any>) => {
                      const url = order.tx_hash ? explorerUrl(selected.chain, order.tx_hash) : null;
                      return (
                        <div key={order.id} className="border-t py-sm" style={{ borderColor: 'var(--color-border)' }}>
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: '8px' }}>
                            <div><span className="text-xs text-secondary">订单编号</span><div className="font-mono text-xs" style={{ overflowWrap: 'anywhere' }}>{order.provider_order_id || '-'}</div></div>
                            <div><span className="text-xs text-secondary">年龄</span><div className="font-mono text-xs">{ageLabel(order.submitted_at, now)}</div></div>
                            <div><span className="text-xs text-secondary">状态</span><div className="font-mono text-xs">{statusLabel(order.normalized_status)}</div></div>
                            <div><span className="text-xs text-secondary">当前间隔</span><div className="font-mono text-xs">{pollingIntervalLabel(order)}</div></div>
                            <div><span className="text-xs text-secondary">查询次数</span><div className="font-mono text-xs">{order.query_count || 0}</div></div>
                          </div>
                          {order.tx_hash && url && <a className="text-accent font-mono text-xs flex items-center gap-xs mt-1" href={url} target="_blank" rel="noreferrer">{order.tx_hash} <ExternalLink size={12} /></a>}
                        </div>
                      );
                    })}
                  </div>
                  <JsonSection title="失败证据（追加式）" rows={selected.failure_evidence as unknown as Array<Record<string, unknown>>} />
                  <JsonSection title="重试决策（追加式）" rows={selected.retry_decisions as unknown as Array<Record<string, unknown>>} />
                  <JsonSection title="晚到成交 / 多重成交事故" rows={selected.reconciliation_incidents as unknown as Array<Record<string, unknown>>} />
                  <JsonSection title="策略组" rows={selected.strategy_groups} />
                  <JsonSection title="策略明细" rows={selected.strategy_legs} />
                  <JsonSection title="持仓批次" rows={selected.position_lots} />
                  <JsonSection title="链上回执" rows={selected.chain_receipts} />
                  <div className="border-t pt-sm" style={{ borderColor: 'var(--color-border)' }}>
                    <span className="text-xs text-secondary">状态历史</span>
                    {[...selected.events].sort((a, b) => Number(a.id) - Number(b.id)).map((event: Record<string, any>) => (
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
