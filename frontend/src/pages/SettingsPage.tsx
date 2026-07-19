import React, { useState, useEffect } from 'react';
import { api } from '../lib/api';
import { Shield, Settings, Server, Key, Eye, EyeOff } from 'lucide-react';
import { useToast } from '../components/ui/Toast';
import { FormSkeleton } from '../components/ui/Skeleton';

export default function SettingsPage() {
  const [isArmed, setIsArmed] = useState(false);
  const [riskConfig, setRiskConfig] = useState<any>({
    security_check_enabled: true, max_buy_tax: 5, max_sell_tax: 10,
    min_liquidity_usd: 10000, max_slippage_pct: 15, consecutive_loss_limit: 5, ca_cooldown_min: 30,
  });
  const [xConfig, setXConfig] = useState<any>({
    timeline_poll_interval_sec: 60, follows_poll_interval_sec: 3600, max_kol_per_round: 3,
  });
  const [envConfig, setEnvConfig] = useState<any>({
    BACKEND_PORT: '3011',
    DB_HOST: 'localhost',
    DB_PORT: '5432',
    DB_NAME: 'xbot',
    DB_USER: 'pm_user',
    DB_PASSWORD: '',
    GMGN_API_KEY: '',
    GMGN_PRIVATE_KEY: '',
    X_DATA_PROVIDER: 'mock',
    SOCIALDATA_API_KEY: '',
    WALLET_SOL: '',
    WALLET_EVM: '',
    ADMIN_TOKEN: '',
    TG_BOT_TOKEN: '',
    TG_CHAT_ID: ''
  });

  const [loading, setLoading] = useState(true);
  const [isRestarting, setIsRestarting] = useState(false);
  const [restartMessage, setRestartMessage] = useState('');
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      api.system.engineStatus(),
      api.config.get('risk_config'),
      api.config.get('x_monitor_config'),
      api.system.getEnv(),
    ]).then(([engineRes, riskRes, xRes, envRes]) => {
      if (engineRes.ok && engineRes.data) setIsArmed((engineRes.data as any).armed);
      if (riskRes.ok && riskRes.data) setRiskConfig(riskRes.data);
      if (xRes.ok && xRes.data) setXConfig(xRes.data);
      if (envRes.ok && envRes.data) setEnvConfig(envRes.data);
      setLoading(false);
    });
  }, []);

  const handleToggle = async () => {
    const res = isArmed ? await api.system.disarm() : await api.system.arm();
    if (res.ok) {
      setIsArmed(!isArmed);
      toast(isArmed ? 'Engine Disarmed' : 'Engine Armed', isArmed ? 'warning' : 'success');
    } else {
      toast('操作失败', 'error');
    }
  };

  const saveRisk = async () => {
    const res = await api.config.set('risk_config', riskConfig);
    toast(res.ok ? '已保存风控设置' : '保存失败', res.ok ? 'success' : 'error');
  };

  const saveXConfig = async () => {
    const res = await api.config.set('x_monitor_config', xConfig);
    toast(res.ok ? '已保存监控设置' : '保存失败', res.ok ? 'success' : 'error');
  };

  const toggleSecretVisibility = (key: string) => {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const saveEnv = async () => {
    setIsRestarting(true);
    setRestartMessage('正在写入 .env 配置文件并请求系统自热重启...');
    const res = await api.system.saveEnv(envConfig);
    if (!res.ok) {
      setIsRestarting(false);
      toast('保存 API 环境变量失败: ' + res.error, 'error');
      return;
    }

    setRestartMessage('正在等待后台进程自重载并检验数据库健康连通性...');
    let pollCount = 0;
    const interval = setInterval(async () => {
      pollCount++;
      if (pollCount > 15) {
        clearInterval(interval);
        setIsRestarting(false);
        toast('服务重启超时，请在服务器后台终端检查 Express 进程状态', 'error');
        return;
      }

      try {
        const health = await api.system.engineStatus();
        if (health.ok) {
          clearInterval(interval);
          setIsRestarting(false);
          toast('API 与环境变量已成功载入并重启就绪！', 'success');
          // Refresh configuration data
          Promise.all([
            api.system.engineStatus(),
            api.config.get('risk_config'),
            api.config.get('x_monitor_config'),
            api.system.getEnv(),
          ]).then(([eR, rR, xR, evR]) => {
            if (eR.ok && eR.data) setIsArmed((eR.data as any).armed);
            if (rR.ok && rR.data) setRiskConfig(rR.data);
            if (xR.ok && xR.data) setXConfig(xR.data);
            if (evR.ok && evR.data) setEnvConfig(evR.data);
          });
        }
      } catch (e) {
        // Continue polling if connection is refused during restart
      }
    }, 1500);
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-lg max-w-4xl">
        <div className="card flex justify-between items-center" style={{ minHeight: '110px' }}>
          <div className="flex-1">
            <div className="skeleton mb-xs" style={{ width: '40%', height: '20px' }}></div>
            <div className="skeleton" style={{ width: '70%', height: '14px' }}></div>
          </div>
          <div className="skeleton rounded-md" style={{ width: '150px', height: '52px' }}></div>
        </div>
        <div className="grid grid-cols-2 gap-lg">
          <FormSkeleton />
          <FormSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg max-w-4xl position-relative">
      
      {/* Restart Overlay overlay */}
      {isRestarting && (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: 'rgba(10, 10, 15, 0.85)', backdropFilter: 'blur(20px)',
          zIndex: 9999, display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', color: '#ffffff'
        }}>
          <div className="flex flex-col items-center gap-md text-center max-w-md px-lg">
            <div className="relative mb-md">
              <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2" style={{ borderColor: 'var(--color-accent)' }}></div>
              <Server className="absolute top-1/2 left-1/2 transform -translate-x-1/2 -translate-y-1/2 text-secondary" size={16} />
            </div>
            <h3 className="text-lg font-bold">后台进程重载中</h3>
            <p className="text-secondary text-sm">{restartMessage}</p>
          </div>
        </div>
      )}

      {/* Engine Control */}
      <div className="card flex justify-between items-center" style={{ background: isArmed ? 'rgba(0, 214, 143, 0.04)' : 'rgba(255, 71, 87, 0.04)', borderColor: isArmed ? 'rgba(0, 214, 143, 0.15)' : 'rgba(255, 71, 87, 0.15)' }}>
        <div className="flex flex-col gap-xs">
          <h2 className="text-xl font-bold flex items-center gap-sm">
            <Shield className={isArmed ? 'text-success' : 'text-danger'} />
            Engine Status: {isArmed ? 'ARMED' : 'LOCKED'}
          </h2>
          <p className="text-secondary text-sm">
            {isArmed ? '实盘发动机已解锁。系统将自动监听KOL推送，匹配白名单后直接执行买入并同步提报TP/SL。' : '实盘发动机已锁定。系统仅记录活动与匹配信号，所有开仓交易将被物理拒绝。'}
          </p>
        </div>
        <button className={`btn ${isArmed ? 'btn-danger' : 'btn-primary'}`}
          style={{ padding: '12px 24px', fontSize: '1.05rem', fontWeight: 700 }} onClick={handleToggle}>
          {isArmed ? 'DISARM' : 'ARM ENGINE'}
        </button>
      </div>

      <div className="grid grid-cols-2 gap-lg">
        {/* Risk Config */}
        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Settings size={18} /> 风险控制</h3>
          <div className="flex flex-col gap-sm">
            <label className="flex items-center justify-between" style={{ padding: '4px 0' }}>
              <span className="text-sm font-medium">启用安全检查</span>
              <input type="checkbox" checked={riskConfig.security_check_enabled} style={{ width: '16px', height: '16px', accentColor: 'var(--color-accent)' }}
                onChange={e => setRiskConfig({ ...riskConfig, security_check_enabled: e.target.checked })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最大买入税 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_buy_tax}
                onChange={e => setRiskConfig({ ...riskConfig, max_buy_tax: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最大卖出税 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_sell_tax}
                onChange={e => setRiskConfig({ ...riskConfig, max_sell_tax: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最小流动性 (USD)</span>
              <input type="number" className="input font-mono" value={riskConfig.min_liquidity_usd}
                onChange={e => setRiskConfig({ ...riskConfig, min_liquidity_usd: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">最大滑点 (%)</span>
              <input type="number" className="input font-mono" value={riskConfig.max_slippage_pct}
                onChange={e => setRiskConfig({ ...riskConfig, max_slippage_pct: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">连续亏损熔断数</span>
              <input type="number" className="input font-mono" value={riskConfig.consecutive_loss_limit}
                onChange={e => setRiskConfig({ ...riskConfig, consecutive_loss_limit: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">CA 冷却时间 (分钟)</span>
              <input type="number" className="input font-mono" value={riskConfig.ca_cooldown_min}
                onChange={e => setRiskConfig({ ...riskConfig, ca_cooldown_min: Number(e.target.value) })} />
            </label>
          </div>
          <button className="btn btn-primary mt-2" onClick={saveRisk}>保存风控设置</button>
        </div>

        {/* X Monitor Config */}
        <div className="card flex flex-col gap-md">
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Server size={18} /> X 监控配置</h3>
          <div className="flex flex-col gap-sm">
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">推文轮询间隔 (秒)</span>
              <input type="number" className="input font-mono" value={xConfig.timeline_poll_interval_sec}
                onChange={e => setXConfig({ ...xConfig, timeline_poll_interval_sec: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">关注轮询间隔 (秒)</span>
              <input type="number" className="input font-mono" value={xConfig.follows_poll_interval_sec}
                onChange={e => setXConfig({ ...xConfig, follows_poll_interval_sec: Number(e.target.value) })} />
            </label>
            <label className="flex flex-col gap-xs">
              <span className="text-xs text-secondary font-medium">每轮最大 KOL 数</span>
              <input type="number" className="input font-mono" value={xConfig.max_kol_per_round}
                onChange={e => setXConfig({ ...xConfig, max_kol_per_round: Number(e.target.value) })} />
            </label>
          </div>
          <button className="btn btn-primary mt-2" onClick={saveXConfig}>保存监控设置</button>
        </div>

        {/* API Credentials and Environment config */}
        <div className="card flex flex-col gap-md" style={{ gridColumn: 'span 2' }}>
          <h3 className="text-lg font-bold flex items-center gap-sm border-b pb-sm" style={{ borderColor: 'var(--color-border)' }}><Key size={18} /> API 密钥与环境变量管理 (.env)</h3>
          
          <div className="grid grid-cols-2 gap-lg">
            {/* Left Block: External Integrations */}
            <div className="flex flex-col gap-sm">
              <h4 className="text-sm font-semibold text-secondary mb-xs">🔌 接口授权与钱包</h4>
              
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">GMGN API Key</span>
                <input className="input font-mono text-sm" value={envConfig.GMGN_API_KEY || ''}
                  onChange={e => setEnvConfig({ ...envConfig, GMGN_API_KEY: e.target.value })} placeholder="输入 GMGN OpenAPI 授权密匙" />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  GMGN Private Key (SOL/EVM 交易签名私钥)
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('GMGN_PRIVATE_KEY')}>
                    {showSecrets['GMGN_PRIVATE_KEY'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['GMGN_PRIVATE_KEY'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['GMGN_PRIVATE_KEY'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.GMGN_PRIVATE_KEY || ''}
                  onChange={e => setEnvConfig({ ...envConfig, GMGN_PRIVATE_KEY: e.target.value })} placeholder="0x... 或 base58 格式私钥" />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">X 数据提供源 (X_DATA_PROVIDER)</span>
                <select className="input text-sm" value={envConfig.X_DATA_PROVIDER || 'mock'}
                  onChange={e => setEnvConfig({ ...envConfig, X_DATA_PROVIDER: e.target.value })}>
                  <option value="mock">Mock (前向模拟测试源)</option>
                  <option value="socialdata">SocialData (第三方 X 推特源)</option>
                </select>
              </label>

              {envConfig.X_DATA_PROVIDER === 'socialdata' && (
                <label className="flex flex-col gap-xs">
                  <span className="text-xs text-secondary font-medium flex items-center justify-between">
                    SocialData API Key
                    <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('SOCIALDATA_API_KEY')}>
                      {showSecrets['SOCIALDATA_API_KEY'] ? <EyeOff size={12} /> : <Eye size={12} />}
                      {showSecrets['SOCIALDATA_API_KEY'] ? '隐藏' : '显示'}
                    </button>
                  </span>
                  <input type={showSecrets['SOCIALDATA_API_KEY'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.SOCIALDATA_API_KEY || ''}
                    onChange={e => setEnvConfig({ ...envConfig, SOCIALDATA_API_KEY: e.target.value })} placeholder="输入 SocialData API Key" />
                </label>
              )}

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  Telegram Bot Token
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('TG_BOT_TOKEN')}>
                    {showSecrets['TG_BOT_TOKEN'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['TG_BOT_TOKEN'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['TG_BOT_TOKEN'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.TG_BOT_TOKEN || ''}
                  onChange={e => setEnvConfig({ ...envConfig, TG_BOT_TOKEN: e.target.value })} placeholder="例如：123456:ABC-def..." />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">Telegram Chat ID</span>
                <input className="input font-mono text-sm" value={envConfig.TG_CHAT_ID || ''}
                  onChange={e => setEnvConfig({ ...envConfig, TG_CHAT_ID: e.target.value })} placeholder="例如：-10012345678" />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">SOL 接收钱包地址 (WALLET_SOL)</span>
                <input className="input font-mono text-sm" value={envConfig.WALLET_SOL || ''}
                  onChange={e => setEnvConfig({ ...envConfig, WALLET_SOL: e.target.value })} placeholder="Solana Base58 格式公钥" />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">EVM 接收钱包地址 (WALLET_EVM)</span>
                <input className="input font-mono text-sm" value={envConfig.WALLET_EVM || ''}
                  onChange={e => setEnvConfig({ ...envConfig, WALLET_EVM: e.target.value })} placeholder="0x 开头以太坊/BSC/Base钱包" />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  看板登录鉴权口令 (ADMIN_TOKEN)
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('ADMIN_TOKEN')}>
                    {showSecrets['ADMIN_TOKEN'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['ADMIN_TOKEN'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['ADMIN_TOKEN'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.ADMIN_TOKEN || ''}
                  onChange={e => setEnvConfig({ ...envConfig, ADMIN_TOKEN: e.target.value })} placeholder="管理员面板 Bearer Token" />
              </label>
            </div>

            {/* Right Block: System Core (Port / Database) */}
            <div className="flex flex-col gap-sm">
              <h4 className="text-sm font-semibold text-secondary mb-xs">🗄️ 系统核心与数据库</h4>
              
              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">后台服务端口 (BACKEND_PORT)</span>
                <input type="number" className="input font-mono text-sm" value={envConfig.BACKEND_PORT || '3011'}
                  onChange={e => setEnvConfig({ ...envConfig, BACKEND_PORT: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库主机 (DB_HOST)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_HOST || 'localhost'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_HOST: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库端口 (DB_PORT)</span>
                <input type="number" className="input font-mono text-sm" value={envConfig.DB_PORT || '5432'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_PORT: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库库名 (DB_NAME)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_NAME || 'xbot'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_NAME: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium">数据库用户名 (DB_USER)</span>
                <input className="input font-mono text-sm" value={envConfig.DB_USER || 'pm_user'}
                  onChange={e => setEnvConfig({ ...envConfig, DB_USER: e.target.value })} />
              </label>

              <label className="flex flex-col gap-xs">
                <span className="text-xs text-secondary font-medium flex items-center justify-between">
                  数据库密码 (DB_PASSWORD)
                  <button type="button" className="text-xs text-accent flex items-center gap-2" onClick={() => toggleSecretVisibility('DB_PASSWORD')}>
                    {showSecrets['DB_PASSWORD'] ? <EyeOff size={12} /> : <Eye size={12} />}
                    {showSecrets['DB_PASSWORD'] ? '隐藏' : '显示'}
                  </button>
                </span>
                <input type={showSecrets['DB_PASSWORD'] ? 'text' : 'password'} className="input font-mono text-sm" value={envConfig.DB_PASSWORD || ''}
                  onChange={e => setEnvConfig({ ...envConfig, DB_PASSWORD: e.target.value })} placeholder="PostgreSQL 用户密码" />
              </label>
            </div>
          </div>

          <div className="flex justify-end gap-sm border-t pt-md mt-sm" style={{ borderColor: 'var(--color-border)' }}>
            <button className="btn btn-primary" style={{ padding: '10px 20px', fontWeight: 600 }} onClick={saveEnv}>
              保存配置并热重启后台
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
