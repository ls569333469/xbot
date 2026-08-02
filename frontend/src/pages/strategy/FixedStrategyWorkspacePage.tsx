import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { X6551Status } from '../../lib/types';
import WhitelistPage from '../WhitelistPage';
import StrategyWorkspaceLayout, { type WorkspaceSummaryItem } from './StrategyWorkspaceLayout';

interface FixedSummary {
  fixedCount: number | null;
  launchCount: number | null;
  watchCount: number | null;
  watchAvailable: boolean;
}

const EMPTY_SUMMARY: FixedSummary = {
  fixedCount: null,
  launchCount: null,
  watchCount: null,
  watchAvailable: false,
};

function watchStatus(status: X6551Status | null) {
  if (!status) return '状态读取中';
  if (status.wss.status === 'connected') return '监听正常';
  if (status.wss.lastError) return '需要检查';
  return ({
    connecting: '连接中',
    reconnecting: '重连中',
    stopped: '已停止',
    disabled: '已禁用',
    disconnected: '未连接',
    error: '异常',
  } as Record<string, string>)[status.wss.status || ''] || '未连接';
}

export default function FixedStrategyWorkspacePage() {
  const [summary, setSummary] = useState<FixedSummary>(EMPTY_SUMMARY);
  const [watch, setWatch] = useState<X6551Status | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [fixedResponse, launchResponse, watchResponse] = await Promise.all([
      api.whitelist.list({ page: '1', pageSize: '1', summary: 'true' }),
      api.launchMonitors.list({ page: '1', pageSize: '1' }),
      api.xMonitor.status6551(),
    ]);
    setSummary({
      fixedCount: fixedResponse.ok ? fixedResponse.total || 0 : null,
      launchCount: launchResponse.ok ? launchResponse.total || 0 : null,
      watchCount: watchResponse.ok ? watchResponse.data?.watches.total ?? null : null,
      watchAvailable: watchResponse.ok,
    });
    if (watchResponse.ok) setWatch(watchResponse.data || null);
    setRefreshing(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const summaryItems: WorkspaceSummaryItem[] = [
    { label: '固定目标', value: summary.fixedCount ?? '--', detail: '已知 CA 与生态关系' },
    { label: '未发币监控', value: summary.launchCount ?? '--', detail: '项目身份与发 CA 监控' },
    { label: '6551 Watch', value: summary.watchCount ?? '--', detail: summary.watchAvailable ? '监听计划状态' : '状态暂不可用' },
    { label: '安全边界', value: '固定链路', detail: '不经过动态 CA 解析' },
  ];

  return (
    <StrategyWorkspaceLayout
      eyebrow="固定策略工作区"
      title="固定 CA / 项目策略"
      description="管理 CA、项目身份、生态账号互动和固定策略参数。"
      status={watchStatus(watch)}
      statusTone={watch?.wss.lastError ? 'warning' : 'active'}
      summary={summaryItems}
      onRefresh={async () => { await refresh(); setRefreshKey((value) => value + 1); }}
      refreshing={refreshing}
    >
      <WhitelistPage key={refreshKey} />
    </StrategyWorkspaceLayout>
  );
}
