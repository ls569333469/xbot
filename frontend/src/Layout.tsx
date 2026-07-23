import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import { api, getAuthToken } from './lib/api';
import { LayoutDashboard, List, Users, Activity, Settings, ShieldAlert, ShieldCheck, Wifi, WifiOff, TrendingUp, History } from 'lucide-react';

export default function Layout() {
  const { isConnected, lastEvent } = useWebSocket();
  const [engineStatus, setEngineStatus] = useState<'stopped' | 'recovering' | 'running' | 'fault_protected'>('stopped');
  const location = useLocation();

  useEffect(() => {
    if (!getAuthToken()) return;

    let active = true;
    const refreshEngineStatus = async () => {
      const res = await api.system.engineStatus();
      if (!active || !res.ok || !res.data) return;
      setEngineStatus(res.data.status || (res.data.armed ? 'running' : 'stopped'));
    };
    void refreshEngineStatus();
    const timer = window.setInterval(() => void refreshEngineStatus(), 2000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (lastEvent?.type === 'engine:status') {
      const status = lastEvent.payload.status;
      if (['stopped', 'recovering', 'running', 'fault_protected'].includes(status)) {
        setEngineStatus(status);
      }
    }
  }, [lastEvent]);

  const engineRunning = engineStatus === 'running';
  const engineFaulted = engineStatus === 'fault_protected';
  const engineLabel = engineRunning
    ? '真实交易运行中'
    : engineFaulted
      ? '故障保护'
      : engineStatus === 'recovering'
        ? '正在恢复'
        : '已停止';

  const navItems = [
    { path: '/', label: '总览', icon: LayoutDashboard },
    { path: '/whitelist', label: '白名单', icon: List },
    { path: '/kol', label: 'KOL', icon: Users },
    { path: '/signals', label: '信号', icon: Activity },
    { path: '/positions', label: '持仓', icon: TrendingUp },
    { path: '/history', label: '交易记录', icon: History },
    { path: '/settings', label: '设置', icon: Settings },
  ];

  const getPageTitle = () => {
    const current = navItems.find(item => item.path === location.pathname);
    return current ? current.label : 'xbot';
  };

  return (
    <div className="flex h-full app-shell" style={{ minHeight: '100vh' }}>
      {/* Sidebar - Ghost Style */}
      <div style={{ width: '240px', background: 'hsl(240 10% 5%)', borderRight: '1px solid var(--color-border)' }} className="flex flex-col app-sidebar">
        <div style={{ padding: 'var(--space-lg)', borderBottom: '1px solid var(--color-border)' }} className="flex items-center gap-sm app-sidebar-brand">
          <div className="flex items-center justify-center rounded-sm" style={{ width: '26px', height: '26px', background: 'linear-gradient(135deg, var(--color-accent) 0%, #a29bfe 100%)', color: 'white' }}>
            <TrendingUp size={16} />
          </div>
          <h1 className="text-xl font-bold tracking-tight app-brand-label" style={{ color: 'var(--color-text-primary)' }}>xbot.</h1>
        </div>
        
        <nav className="flex-1 flex flex-col app-nav" style={{ padding: 'var(--space-md)', gap: 'var(--space-4)' }}>
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <NavLink
                key={item.path}
                to={item.path}
                className="flex items-center gap-md rounded-md app-nav-link"
                style={({ isActive }) => ({
                  padding: 'var(--space-sm) var(--space-md)',
                  textDecoration: 'none',
                  fontSize: '0.875rem',
                  fontWeight: 500,
                  color: isActive ? '#ffffff' : 'var(--color-text-secondary)',
                  background: isActive ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
                  borderLeft: isActive ? '3px solid var(--color-accent)' : '3px solid transparent',
                  borderRadius: 'var(--radius-sm)',
                  transition: 'all var(--transition-fast)'
                })}
              >
                <span className="flex items-center justify-center" style={{ width: '18px', height: '18px' }}>
                  <Icon size={18} />
                </span>
                <span className="app-nav-label">{item.label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Engine Status */}
        <div className="app-engine-status" style={{ padding: 'var(--space-md)', borderTop: '1px solid var(--color-border)' }}>
          <div className="flex items-center gap-sm" style={{ color: engineRunning ? 'var(--color-success)' : engineFaulted ? 'var(--color-danger)' : 'var(--color-warning)' }}>
            <span className="flex items-center justify-center" style={{ width: '18px', height: '18px' }}>
              {engineRunning ? <ShieldCheck size={18} /> : <ShieldAlert size={18} />}
            </span>
            <span className="font-semibold text-sm app-engine-label">{engineLabel}</span>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col app-main-shell">
        <header 
          className="flex items-center justify-between app-topbar"
          style={{ 
            height: '73px', 
            padding: '0 var(--space-lg)', 
            background: 'var(--color-background)', 
            borderBottom: '1px solid var(--color-border)' 
          }}
        >
          <h2 className="text-xl font-bold tracking-tight">{getPageTitle()}</h2>
          <div className="flex items-center gap-md">
            <div className="flex items-center gap-xs" style={{ color: isConnected ? 'var(--color-success)' : 'var(--color-danger)' }}>
              <span className="flex items-center justify-center" style={{ width: '18px', height: '18px' }}>
                {isConnected ? <Wifi size={16} /> : <WifiOff size={16} />}
              </span>
              <span className="text-sm font-medium">{isConnected ? '已连接' : '已断开'}</span>
            </div>
          </div>
        </header>

        <main className="app-main-panel" style={{ padding: 'var(--space-lg)', flex: 1, overflowY: 'auto' }}>
          <div key={location.pathname} className="page-transition-container">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );
}
