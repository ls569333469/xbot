import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Layout from './Layout';
import Dashboard from './pages/Dashboard';
import WhitelistPage from './pages/WhitelistPage';
import KolPage from './pages/KolPage';
import SignalLog from './pages/SignalLog';
import SettingsPage from './pages/SettingsPage';
import PositionsPage from './pages/PositionsPage';
import TradeLog from './pages/TradeLog';

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Layout />}>
          <Route index element={<Dashboard />} />
          <Route path="whitelist" element={<WhitelistPage />} />
          <Route path="kol" element={<KolPage />} />
          <Route path="signals" element={<SignalLog />} />
          <Route path="positions" element={<PositionsPage />} />
          <Route path="history" element={<TradeLog />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
