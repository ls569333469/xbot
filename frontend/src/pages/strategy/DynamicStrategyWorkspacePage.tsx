import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { dynamicResolutionDisplay } from '../../lib/p20-runtime';
import type { DynamicPolicy, DynamicSignalStatus, KolAccount } from '../../lib/types';
import { P20Operations } from '../kol/P20Operations';
import StrategyWorkspaceLayout, { type WorkspaceSummaryItem } from './StrategyWorkspaceLayout';

export default function DynamicStrategyWorkspacePage() {
  const [kols, setKols] = useState<KolAccount[]>([]);
  const [policies, setPolicies] = useState<DynamicPolicy[]>([]);
  const [runtime, setRuntime] = useState<DynamicSignalStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const [kolResponse, policyResponse, statusResponse] = await Promise.all([
      api.kol.list(),
      api.dynamicSignal.policies(),
      api.dynamicSignal.status(),
    ]);
    if (kolResponse.ok) setKols(kolResponse.data || []);
    if (policyResponse.ok) setPolicies(policyResponse.data || []);
    if (statusResponse.ok) setRuntime(statusResponse.data || null);
    setRefreshing(false);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const liveCount = policies.filter((item) => item.mode === 'live' && item.enabled
    && item.approval_id && item.approval_expires_at && Date.parse(item.approval_expires_at) > Date.now()).length;
  const resolutionRuntime = dynamicResolutionDisplay(runtime);
  const summaryItems: WorkspaceSummaryItem[] = [
    { label: 'KOL 账号', value: kols.length, detail: '可配置账号' },
    { label: '账号策略', value: policies.length, detail: `${policies.filter((item) => item.mode === 'record').length} 条记录 · ${policies.filter((item) => item.mode === 'paper').length} 条模拟` },
    { label: '解析任务', value: resolutionRuntime.shortLabel, detail: resolutionRuntime.detail },
    { label: '实盘授权', value: liveCount, detail: liveCount ? '账号级授权' : '未开启动态实盘' },
  ];

  return (
    <StrategyWorkspaceLayout
      eyebrow="动态策略工作区"
      title="动态喊单策略"
      description="管理账号级匹配规则、解析任务、模拟验收和实盘授权。"
      status={resolutionRuntime.label}
      statusTone={resolutionRuntime.tone}
      summary={summaryItems}
      onRefresh={refresh}
      refreshing={refreshing}
    >
      <div className="strategy-workspace-panel-note"><span aria-hidden="true">▣</span><span>动态喊单只解析账号发帖中的 CA、代币符号、话题标签和项目名称，不会修改固定 CA / 项目策略。</span></div>
      <P20Operations kols={kols} />
    </StrategyWorkspaceLayout>
  );
}
