import React, { FormEvent, useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { useWebSocket } from './hooks/useWebSocket';
import { useToast } from './components/ui/ToastContext';
import { api, clearAdminToken, getAuthToken, setAdminToken, validateAdminToken } from './lib/api';
import { Activity, Eye, EyeOff, History, KeyRound, LayoutDashboard, List, LogIn, Settings, ShieldAlert, ShieldCheck, TrendingUp, Users, Wifi, WifiOff } from 'lucide-react';

type AuthState = 'checking' | 'authenticated' | 'signed_out';

function AuthenticationScreen({ checking, initialError }: { checking: boolean; initialError?: string }) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(initialError || '');

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = token.trim();
    if (!candidate) {
      setError('请输入管理员口令');
      return;
    }

    setSubmitting(true);
    setError('');
    const response = await validateAdminToken(candidate);
    setSubmitting(false);
    if (!response.ok) {
      setError(response.error === 'Unauthorized' ? '管理员口令无效' : (response.error || '无法连接服务器'));
      return;
    }

    setAdminToken(candidate);
    window.location.reload();
  };

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-mark"><KeyRound size={22} /></div>
        <div>
          <h1 id="auth-title">XBOT 管理登录</h1>
          <p>{checking ? '正在验证登录状态' : '请输入生产环境管理员口令'}</p>
        </div>
        {!checking && <form onSubmit={handleSubmit} className="auth-form">
          <label htmlFor="admin-token">管理员口令</label>
          <div className="auth-token-input">
            <input
              id="admin-token"
              type={showToken ? 'text' : 'password'}
              value={token}
              autoComplete="current-password"
              autoFocus
              onChange={(event) => setToken(event.target.value)}
            />
            <button type="button" onClick={() => setShowToken((value) => !value)} title={showToken ? '隐藏口令' : '显示口令'} aria-label={showToken ? '隐藏口令' : '显示口令'}>
              {showToken ? <EyeOff size={17} /> : <Eye size={17} />}
            </button>
          </div>
          {error && <p className="auth-error" role="alert">{error}</p>}
          <button className="btn btn-primary auth-submit" type="submit" disabled={submitting}>
            <LogIn size={16} /> {submitting ? '验证中' : '进入系统'}
          </button>
        </form>}
        {checking && <div className="auth-checking" aria-label="正在验证" />}
      </section>
    </main>
  );
}

export default function Layout() {
  const { isConnected, lastEvent } = useWebSocket();
  const { toast } = useToast();
  const [authState, setAuthState] = useState<AuthState>(() => getAuthToken() ? 'checking' : 'signed_out');
  const [authError, setAuthError] = useState('');
  const [engineStatus, setEngineStatus] = useState<
    'stopped' | 'recovering' | 'running' | 'paused_transient' | 'fault_protected'
  >('stopped');
  const location = useLocation();

  useEffect(() => {
    let active = true;
    const handleUnauthorized = () => {
      clearAdminToken();
      setAuthError('登录已失效，请重新输入管理员口令');
      setAuthState('signed_out');
    };
    window.addEventListener('xbot:unauthorized', handleUnauthorized);

    const token = getAuthToken();
    if (!token) {
      setAuthState('signed_out');
    } else {
      void validateAdminToken(token).then((response) => {
        if (!active) return;
        if (response.ok) {
          setAuthState('authenticated');
        } else if (response.error !== 'Unauthorized') {
          setAuthError(response.error || '无法连接服务器');
          setAuthState('signed_out');
        }
      });
    }

    return () => {
      active = false;
      window.removeEventListener('xbot:unauthorized', handleUnauthorized);
    };
  }, []);

  useEffect(() => {
    if (authState !== 'authenticated') return;

    let active = true;
    const refreshEngineStatus = async () => {
      const res = await api.system.engineStatus();
      if (!active || !res.ok || !res.data) return;
      setEngineStatus(res.data.status || (res.data.armed ? 'running' : 'stopped'));
    };
    void refreshEngineStatus();
    const timer = window.setInterval(() => void refreshEngineStatus(), 10000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [authState]);

  useEffect(() => {
    if (lastEvent?.type === 'engine:status') {
      const status = lastEvent.payload.status;
      if (['stopped', 'recovering', 'running', 'paused_transient', 'fault_protected'].includes(status)) {
        setEngineStatus(status);
      }
    }
  }, [lastEvent]);

  useEffect(() => {
    if (lastEvent?.type !== 'trade:alert') return;
    const topic = lastEvent.payload?.topic;
    const reason = lastEvent.payload?.payload?.reason;
    if (topic === 'trade.auto_disarmed') {
      if (reason === 'TRANSIENT_READINESS_FAILURE') {
        toast('外部服务短暂异常，新买入已暂停并等待自动恢复', 'warning');
      } else {
        toast('交易安全门禁失败，新买入已停止，请检查系统状态', 'error');
      }
    } else if (topic === 'trade.transient_pause_reminder') {
      toast('外部服务仍未恢复，新买入继续暂停，持仓保护正常运行', 'warning');
    } else if (topic === 'trade.auto_resumed') {
      toast('外部服务已恢复，真实交易已自动继续', 'success');
    }
  }, [lastEvent, toast]);

  const engineRunning = engineStatus === 'running';
  const engineFaulted = engineStatus === 'fault_protected';
  const engineLabel = engineRunning
    ? '真实交易运行中'
    : engineFaulted
      ? '故障保护'
      : engineStatus === 'paused_transient'
        ? '暂停等待恢复'
      : engineStatus === 'recovering'
        ? '正在恢复'
        : '已停止';

  const navItems = [
    { path: '/', label: '总览', icon: LayoutDashboard },
    { path: '/strategies', label: '策略中心', icon: List },
    { path: '/kol', label: 'KOL', icon: Users },
    { path: '/signals', label: '信号', icon: Activity },
    { path: '/positions', label: '持仓', icon: TrendingUp },
    { path: '/history', label: '交易记录', icon: History },
    { path: '/settings', label: '设置', icon: Settings },
  ];

  const getPageTitle = () => {
    const current = navItems.find(item => item.path === location.pathname);
    if (current) return current.label;
    if (location.pathname === '/whitelist' || location.pathname === '/strategies/fixed') return '固定 CA / 项目策略';
    if (location.pathname === '/strategies/dynamic') return '动态喊单策略';
    return 'xbot';
  };

  if (authState !== 'authenticated') {
    return <AuthenticationScreen checking={authState === 'checking'} initialError={authError} />;
  }

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
