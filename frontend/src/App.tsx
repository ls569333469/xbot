import { lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './Layout';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const KolPage = lazy(() => import('./pages/KolPage'));
const SignalLog = lazy(() => import('./pages/SignalLog'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const PositionsPage = lazy(() => import('./pages/PositionsPage'));
const TradeLog = lazy(() => import('./pages/TradeLog'));
const StrategyCenterPage = lazy(() => import('./pages/StrategyCenterPage'));
const FixedStrategyWorkspacePage = lazy(() => import('./pages/strategy/FixedStrategyWorkspacePage'));
const DynamicStrategyWorkspacePage = lazy(() => import('./pages/strategy/DynamicStrategyWorkspacePage'));
const FollowDiscoveryWorkspacePage = lazy(() => import('./pages/strategy/FollowDiscoveryWorkspacePage'));

function App() {
  const basename = import.meta.env.BASE_URL === '/'
    ? undefined
    : import.meta.env.BASE_URL.replace(/\/$/, '');

  return (
    <BrowserRouter basename={basename}>
      <Suspense fallback={<div className="route-loading" role="status">页面加载中...</div>}>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Dashboard />} />
            <Route path="strategies" element={<StrategyCenterPage />} />
            <Route path="strategies/fixed" element={<FixedStrategyWorkspacePage />} />
            <Route path="strategies/dynamic" element={<DynamicStrategyWorkspacePage />} />
            <Route path="strategies/follow-discovery" element={<FollowDiscoveryWorkspacePage />} />
            <Route path="whitelist" element={<FixedStrategyWorkspacePage />} />
            <Route path="kol" element={<KolPage />} />
            <Route path="signals" element={<SignalLog />} />
            <Route path="positions" element={<PositionsPage />} />
            <Route path="history" element={<TradeLog />} />
            <Route path="settings" element={<SettingsPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
