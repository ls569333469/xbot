import { RefreshCw, SearchCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type { ActorScreeningRun } from '../../lib/types';

function parseHandles(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/)
    .map((item) => item.trim().replace(/^@+/, '').toLowerCase())
    .filter(Boolean))];
}

function percentage(value?: number | null) {
  return value === null || value === undefined ? '--' : `${(Number(value) * 100).toFixed(1)}%`;
}

function recommendationLabel(value?: string | null) {
  if (value === 'approve_for_record') return '建议记录';
  if (value === 'watch') return '继续观察';
  if (value === 'reject') return '不建议';
  return '数据不足';
}

function statusLabel(value?: ActorScreeningRun['status']) {
  if (value === 'pending') return '等待处理';
  if (value === 'running') return '研究中';
  if (value === 'completed') return '已完成';
  if (value === 'partial') return '部分完成';
  if (value === 'failed') return '失败';
  if (value === 'cancelled') return '已取消';
  return '空闲';
}

export default function AccountResearchPanel() {
  const [input, setInput] = useState('');
  const [runs, setRuns] = useState<ActorScreeningRun[]>([]);
  const [selectedRunId, setSelectedRunId] = useState('');
  const [selectedRunDetail, setSelectedRunDetail] = useState<ActorScreeningRun | null>(null);
  const [detailRevision, setDetailRevision] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const response = await api.actorScreening.list();
      if (!response.ok) {
        toast(response.error || '账号研究记录加载失败', 'error');
        return;
      }
      const nextRuns = response.data || [];
      setRuns(nextRuns);
      setSelectedRunId((current) => current || nextRuns[0]?.id || '');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [toast]);

  useEffect(() => { void refresh(true); }, [refresh]);

  const selectedRunSummary = useMemo(
    () => runs.find((item) => item.id === selectedRunId) || runs[0] || null,
    [runs, selectedRunId],
  );
  const selectedRun = selectedRunDetail?.id === selectedRunId
    ? selectedRunDetail
    : selectedRunSummary;

  useEffect(() => {
    if (!selectedRunId) {
      setSelectedRunDetail(null);
      setDetailError('');
      setDetailLoading(false);
      return undefined;
    }

    let cancelled = false;
    let timer: number | undefined;

    const loadDetail = async (showLoading: boolean) => {
      if (showLoading) setDetailLoading(true);
      const response = await api.actorScreening.get(selectedRunId);
      if (cancelled) return;
      if (!response.ok || !response.data) {
        setDetailError(response.error || '研究批次详情加载失败');
        setDetailLoading(false);
        return;
      }
      setSelectedRunDetail(response.data);
      setDetailError('');
      setDetailLoading(false);
      if (['pending', 'running'].includes(response.data.status)) {
        timer = window.setTimeout(() => { void loadDetail(false); }, 3000);
      } else {
        void refresh();
      }
    };

    setSelectedRunDetail(null);
    setDetailError('');
    void loadDetail(true);
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [detailRevision, refresh, selectedRunId]);

  const startResearch = async () => {
    const values = parseHandles(input);
    if (!values.length) return toast('请输入至少一个 X 账号', 'error');
    setCreating(true);
    try {
      const response = await api.actorScreening.create({ handles: values });
      if (!response.ok || !response.data) return toast(response.error || '账号研究任务创建失败', 'error');
      setSelectedRunId(response.data.id);
      setInput('');
      toast('账号研究任务已进入队列', 'success');
      await refresh();
    } finally {
      setCreating(false);
    }
  };

  const retryRun = async () => {
    if (!selectedRun) return;
    setRetrying(true);
    try {
      const response = await api.actorScreening.retry(selectedRun.id);
      if (!response.ok) return toast(response.error || '失败任务重试失败', 'error');
      toast('失败账号已重新进入研究队列', 'success');
      setSelectedRunDetail({ ...selectedRun, status: 'pending' });
      setDetailRevision((current) => current + 1);
    } finally {
      setRetrying(false);
    }
  };

  const results = selectedRun?.results || [];
  const hasDetails = selectedRunDetail?.id === selectedRunId;
  const completed = hasDetails
    ? results.filter((item) => item.status === 'completed').length
    : Number(selectedRunSummary?.completed_count || 0);
  const recommended = hasDetails
    ? results.filter((item) => item.recommendation === 'approve_for_record').length
    : Number(selectedRunSummary?.recommended_count || 0);

  return (
    <section className="account-research-shell">
      <aside className="account-research-runs">
        <div className="account-research-heading"><strong>研究批次</strong><span>{runs.length} 个</span></div>
        <div className="account-research-run-list">
          {runs.map((run) => <button type="button" key={run.id} className={selectedRunId === run.id ? 'selected' : ''} onClick={() => setSelectedRunId(run.id)}>
            <strong>{new Date(run.created_at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</strong>
            <span>{run.input_handles.length} 个账号 · {statusLabel(run.status)}</span>
          </button>)}
          {!loading && !runs.length && <div className="p16-empty-line">暂无研究批次</div>}
        </div>
      </aside>

      <div className="account-research-main">
        <header className="account-research-header">
          <div><h2>账号研究</h2><p>批量分析发帖样本、直接意图、CA 解析率和历史可执行胜率。</p></div>
          {selectedRun && ['failed', 'partial'].includes(selectedRun.status) && <button type="button" className="btn btn-secondary" disabled={retrying} onClick={retryRun}><RefreshCw size={15} className={retrying ? 'spin' : ''} />重试失败账号</button>}
        </header>

        <div className="account-research-input">
          <textarea rows={3} value={input} onChange={(event) => setInput(event.target.value)} placeholder="每行一个 X 账号，例如：&#10;@account1&#10;@account2" />
          <button type="button" className="btn btn-primary" disabled={creating} onClick={startResearch}><SearchCheck size={15} />{creating ? '创建中' : '开始研究'}</button>
        </div>

        <div className="account-research-stats">
          <div><span>输入账号</span><strong>{selectedRun?.input_handles.length || 0}</strong></div>
          <div><span>完成分析</span><strong>{completed}</strong></div>
          <div><span>建议记录</span><strong>{recommended}</strong></div>
          <div><span>批次状态</span><strong>{statusLabel(selectedRun?.status)}</strong></div>
        </div>

        <div className="account-research-results">
          <div className="account-research-result-head"><span>账号</span><span>样本</span><span>直接意图率</span><span>CA 解析率</span><span>胜率</span><span>结论</span></div>
          {results.map((result) => {
            const failed = result.status === 'failed';
            return <div key={result.id} className={`account-research-result-row${failed ? ' is-failed' : ''}`}>
              <strong>@{result.x_handle}</strong><span>{result.sample_size} 帖</span><span>{percentage(result.direct_intent_rate)}</span><span>{percentage(result.ca_resolution_rate)}</span><span>{percentage(result.executable_win_rate)}</span>
              {failed
                ? <em className="account-research-error"><strong>研究失败</strong><small>{[result.error_code, result.last_error].filter(Boolean).join('：') || '未返回错误详情'}</small></em>
                : <em>{recommendationLabel(result.recommendation)}</em>}
            </div>;
          })}
          {!results.length && <div className={`p16-empty-line${detailError ? ' is-error' : ''}`}>
            {detailLoading || loading
              ? '加载研究详情中...'
              : detailError || (selectedRun ? '该批次暂无账号结果' : '选择历史批次或创建新的研究任务')}
          </div>}
        </div>
      </div>
    </section>
  );
}
