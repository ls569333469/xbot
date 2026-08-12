import { ArrowLeft, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

export interface WorkspaceSummaryItem {
  label: string;
  value: ReactNode;
  detail: string;
}

interface StrategyWorkspaceLayoutProps {
  eyebrow: string;
  title: string;
  description: string;
  status: string;
  statusTone?: 'active' | 'warning' | 'muted';
  summary: WorkspaceSummaryItem[];
  onRefresh?: () => void | Promise<void>;
  refreshing?: boolean;
  children: ReactNode;
}

export default function StrategyWorkspaceLayout({
  eyebrow,
  title,
  description,
  status,
  statusTone = 'active',
  summary,
  onRefresh,
  refreshing = false,
  children,
}: StrategyWorkspaceLayoutProps) {
  return (
    <div className="strategy-workspace-page">
      <header className="strategy-workspace-header">
        <div>
          <Link className="strategy-workspace-back" to="/strategies"><ArrowLeft size={15} />返回策略中心</Link>
          <span className="strategy-center-eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        <div className="strategy-workspace-header-actions">
          <span className={`strategy-center-status ${statusTone}`}><i />{status}</span>
          {onRefresh && <button type="button" className="p16-icon-button" title="刷新工作区" aria-label="刷新工作区" onClick={() => void onRefresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? 'icon-spin' : ''} /></button>}
        </div>
      </header>

      <section className="strategy-workspace-summary" aria-label={`${title}状态摘要`}>
        {summary.map((item) => <div key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.detail}</small></div>)}
      </section>

      <section className="strategy-workspace-panel">
        {children}
      </section>
    </div>
  );
}
