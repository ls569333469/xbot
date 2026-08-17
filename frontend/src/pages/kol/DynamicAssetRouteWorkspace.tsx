import {
  AlertTriangle, CheckCircle2, Plus, Search, ShieldCheck, Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../lib/api';
import type {
  ChainId, DynamicPolicy, DynamicPresetAssetRouteInput, DynamicPresetRouteMatchPreview,
} from '../../lib/types';

const CHAINS: Array<{ id: ChainId; label: string }> = [
  { id: 'sol', label: 'Solana' },
  { id: 'bsc', label: 'BNB Chain' },
  { id: 'base', label: 'Base' },
  { id: 'eth', label: 'Ethereum' },
  { id: 'robinhood', label: 'Robinhood' },
];

type RouteDraft = DynamicPresetAssetRouteInput & {
  variant_id?: string | number;
  verification?: { status: 'verified'; source: 'local_rpc'; verified_at: string };
};

function aliasKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function emptyRoute(chain: ChainId): RouteDraft {
  return {
    label: '', aliases: [''], chain_id: chain, contract_address: '', enabled: true,
  };
}

function routeKey(route: RouteDraft, index: number) {
  return String(route.route_id || `draft-${index}`);
}

function routeInput(route: RouteDraft): DynamicPresetAssetRouteInput {
  return {
    ...(route.route_id ? { route_id: route.route_id } : {}),
    label: route.label,
    aliases: [...route.aliases],
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    enabled: route.enabled !== false,
  };
}

export function DynamicAssetRouteWorkspace({
  routes,
  legacyAliases,
  allowedChains,
  onChange,
  onLegacyAliasesChange,
}: {
  routes: RouteDraft[];
  legacyAliases: DynamicPolicy['approved_aliases'];
  allowedChains: ChainId[];
  onChange: (routes: RouteDraft[]) => void;
  onLegacyAliasesChange: (aliases: DynamicPolicy['approved_aliases']) => void;
}) {
  const [selectedKey, setSelectedKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [previewText, setPreviewText] = useState('');
  const [preview, setPreview] = useState<DynamicPresetRouteMatchPreview | null>(null);
  const [error, setError] = useState('');

  const keys = useMemo(() => routes.map(routeKey), [routes]);
  const selectedIndex = Math.max(0, keys.indexOf(selectedKey));
  const selected = routes[selectedIndex];
  useEffect(() => {
    if (!routes.length) setSelectedKey('');
    else if (!keys.includes(selectedKey)) setSelectedKey(keys[0]);
  }, [keys, routes.length, selectedKey]);

  const duplicateKeys = useMemo(() => {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    routes.flatMap((route) => route.aliases).forEach((alias) => {
      const key = aliasKey(alias);
      if (!key) return;
      if (seen.has(key)) duplicates.add(key);
      seen.add(key);
    });
    return duplicates;
  }, [routes]);
  const totalAliasCount = useMemo(() => (
    routes.reduce((total, route) => total + route.aliases.length, 0)
  ), [routes]);

  const updateSelected = (patch: Partial<RouteDraft>, resetVerification = false) => {
    onChange(routes.map((route, index) => index === selectedIndex ? {
      ...route,
      ...patch,
      ...(resetVerification ? { verification: undefined, variant_id: undefined } : {}),
    } : route));
    setPreview(null);
    setError('');
  };

  const addRoute = () => {
    if (routes.length >= 20) return setError('每个账号最多配置 20 条资产路由');
    const next = emptyRoute(allowedChains[0] || 'bsc');
    onChange([...routes, next]);
    setSelectedKey(`draft-${routes.length}`);
    setPreview(null);
  };

  const removeRoute = () => {
    if (!selected) return;
    const next = routes.filter((_, index) => index !== selectedIndex);
    onChange(next);
    setSelectedKey(next.length ? routeKey(next[Math.max(0, selectedIndex - 1)], Math.max(0, selectedIndex - 1)) : '');
    setPreview(null);
  };

  const updateAlias = (index: number, value: string) => {
    if (!selected) return;
    updateSelected({ aliases: selected.aliases.map((alias, aliasIndex) => aliasIndex === index ? value : alias) });
  };

  const addAlias = () => {
    if (!selected || selected.aliases.length >= 10) return;
    if (totalAliasCount >= 50) return setError('每个账号最多配置 50 个路由关键词');
    updateSelected({ aliases: [...selected.aliases, ''] });
  };

  const bindLegacyAlias = (legacyIndex: number) => {
    if (!selected) return setError('请先新建或选择一条资产路由');
    const item = legacyAliases[legacyIndex];
    const value = typeof item === 'string' ? item : item.name;
    const alreadyBound = selected.aliases.some((alias) => aliasKey(alias) === aliasKey(value));
    if (!alreadyBound && selected.aliases.filter(Boolean).length >= 10) {
      return setError('当前资产路由已有 10 个关键词，请选择其他路由');
    }
    if (!alreadyBound && totalAliasCount >= 50) {
      return setError('每个账号最多配置 50 个路由关键词');
    }
    if (!alreadyBound) {
      updateSelected({ aliases: [...selected.aliases.filter(Boolean), value] });
    }
    onLegacyAliasesChange(legacyAliases.filter((_, index) => index !== legacyIndex));
  };

  const verify = async () => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.dynamicSignal.verifyPresetRoute(routeInput(selected));
      if (!response.ok || !response.data) return setError(response.error || '链上验证失败');
      updateSelected({ verification: response.data.verification });
    } finally { setBusy(false); }
  };

  const runPreview = async () => {
    if (!previewText.trim()) return;
    setBusy(true);
    setError('');
    try {
      const response = await api.dynamicSignal.previewPresetRouteMatch({
        text: previewText,
        approved_aliases: legacyAliases,
        preset_asset_routes: routes.map(routeInput),
      });
      if (!response.ok || !response.data) return setError(response.error || '匹配测试失败');
      setPreview(response.data);
    } finally { setBusy(false); }
  };

  return <section className="p35-route-workspace">
    {legacyAliases.length > 0 && <div className="p35-legacy-strip">
      <AlertTriangle size={16} />
      <div><strong>{legacyAliases.length} 个旧关键词尚未绑定 CA</strong><span>记录模式可保留；模拟和实盘必须绑定或删除。</span></div>
      <div>{legacyAliases.map((item, index) => <button type="button" key={`${typeof item === 'string' ? item : item.name}-${index}`} onClick={() => bindLegacyAlias(index)}>{typeof item === 'string' ? item : item.name}</button>)}</div>
    </div>}

    <div className="p35-route-shell">
      <aside className="p35-route-list">
        <header><div><strong>资产路由</strong><span>{routes.length}/20 · {totalAliasCount}/50 词</span></div><button type="button" title="新增资产路由" aria-label="新增资产路由" onClick={addRoute}><Plus size={16} /></button></header>
        <div>{routes.map((route, index) => {
          const key = routeKey(route, index);
          return <button type="button" key={key} className={key === selectedKey || index === selectedIndex && !selectedKey ? 'selected' : ''} onClick={() => setSelectedKey(key)}>
            <span><strong>{route.label || `未命名路由 ${index + 1}`}</strong><small>{route.chain_id.toUpperCase()} · {route.aliases.filter(Boolean).length} 个关键词</small></span>
            {route.verification?.status === 'verified' ? <CheckCircle2 size={15} /> : <i />}
          </button>;
        })}{!routes.length && <div className="p35-route-empty">尚未配置资产路由</div>}</div>
      </aside>

      <div className="p35-route-editor">
        {selected ? <>
          <header><div><span>当前路由</span><strong>{selected.label || '未命名资产'}</strong></div><label><input type="checkbox" checked={selected.enabled} onChange={(event) => updateSelected({ enabled: event.target.checked })} />启用</label><button type="button" title="删除当前路由" aria-label="删除当前路由" onClick={removeRoute}><Trash2 size={15} /></button></header>
          <div className="p35-route-fields">
            <label><span>资产名称</span><input value={selected.label} maxLength={40} onChange={(event) => updateSelected({ label: event.target.value })} placeholder="用于识别，例如 Binance Utility" /></label>
            <label><span>链</span><select value={selected.chain_id} onChange={(event) => updateSelected({ chain_id: event.target.value as ChainId }, true)}>{CHAINS.filter((chain) => allowedChains.includes(chain.id)).map((chain) => <option key={chain.id} value={chain.id}>{chain.label}</option>)}</select></label>
            <label className="wide"><span>合约地址 CA</span><input value={selected.contract_address} onChange={(event) => updateSelected({ contract_address: event.target.value.trim() }, true)} placeholder={selected.chain_id === 'sol' ? 'Solana Mint Address' : '0x...'} /></label>
          </div>

          <div className="p35-alias-editor">
            <div><span>触发关键词</span><button type="button" onClick={addAlias} disabled={selected.aliases.length >= 10 || totalAliasCount >= 50}><Plus size={14} />添加关键词</button></div>
            {selected.aliases.map((alias, index) => <label key={index} className={duplicateKeys.has(aliasKey(alias)) ? 'invalid' : ''}><b>{index + 1}</b><input value={alias} maxLength={80} onChange={(event) => updateAlias(index, event.target.value)} placeholder="完整关键词或短语" /><button type="button" title="删除关键词" aria-label="删除关键词" disabled={selected.aliases.length <= 1} onClick={() => updateSelected({ aliases: selected.aliases.filter((_, aliasIndex) => aliasIndex !== index) })}><Trash2 size={14} /></button></label>)}
          </div>

          <div className="p35-verification-row">
            <div>{selected.verification?.status === 'verified' ? <><ShieldCheck size={16} /><span><strong>链上验证通过</strong><small>{new Date(selected.verification.verified_at).toLocaleString()}</small></span></> : <><AlertTriangle size={16} /><span><strong>保存前需要链上验证</strong><small>只调用所选公链 RPC，不调用 GMGN</small></span></>}</div>
            <button type="button" className="btn btn-secondary" disabled={busy || !selected.contract_address || !selected.label || selected.aliases.some((alias) => !alias.trim())} onClick={verify}><ShieldCheck size={15} />{busy ? '验证中' : '验证资产'}</button>
          </div>
        </> : <div className="p35-route-editor-empty"><Plus size={20} /><strong>新建第一条资产路由</strong></div>}
      </div>
    </div>

    <div className="p35-match-preview">
      <div><Search size={15} /><span><strong>文本匹配测试</strong><small>只验证关键词路由，不生成信号或交易</small></span></div>
      <div><textarea rows={2} value={previewText} onChange={(event) => setPreviewText(event.target.value)} placeholder="输入一段帖子、回复或引用评论" /><button type="button" className="btn btn-secondary" disabled={busy || !previewText.trim() || !routes.length} onClick={runPreview}>测试匹配</button></div>
      {preview && <output className={preview.status === 'matched' ? 'matched' : preview.status === 'none' ? '' : 'failed'}>{preview.status === 'matched' ? `命中：${preview.candidate?.routeLabel} · ${preview.candidate?.chainId?.toUpperCase()} · ${preview.candidate?.contractAddress}` : preview.failure_code || '未命中任何资产路由'}</output>}
      {error && <output className="failed">{error}</output>}
    </div>
  </section>;
}
