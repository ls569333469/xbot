import {
  Archive, ArrowRight, Check, Layers3, RotateCcw, Save,
  ShieldAlert, Trash2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type {
  ChainId, DynamicPolicy,
  DynamicPolicyTemplate, DynamicPolicyTemplateConfig, DynamicPresetAssetRouteInput,
  DynamicResolution,
  DynamicSignalStatus, ExitStrategy, KolAccount,
} from '../../lib/types';
import DynamicTradeConfigMatrix from '../strategy/DynamicTradeConfigMatrix';
import StrategyEditor from '../whitelist/StrategyEditor';
import { cloneStrategy, STRATEGY_PRESETS, strategySummary } from '../whitelist/strategy-presets';
import { DynamicAssetRouteWorkspace } from './DynamicAssetRouteWorkspace';

const CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const CHAIN_META: Record<ChainId, { label: string; unit: string }> = {
  sol: { label: 'Solana', unit: 'SOL' },
  bsc: { label: 'BNB Chain', unit: 'BNB' },
  base: { label: 'Base', unit: 'ETH' },
  eth: { label: 'Ethereum', unit: 'ETH' },
  robinhood: { label: 'Robinhood', unit: 'ETH' },
};
const TERM_TYPES = [
  ['ca', '完整 CA'], ['cashtag', '$ 代币符号'], ['hashtag', '# 话题标签'], ['approved_name', '项目名称'],
] as const;
const EVENT_TYPES = [
  ['tweet', '原创帖'], ['quote', '引用帖'], ['reply', '回复'],
] as const;
const STEP_ITEMS = [
  ['账号与模板', 'KOL、运行阶段、内容类型'],
  ['词条与解析', '关键词、CA、候选规则'],
  ['资金与离场', '多链金额、限额、策略'],
  ['确认并保存', '版本影响、运行条件、提交'],
] as const;

type Draft = Pick<DynamicPolicy, 'mode' | 'enabled' | 'allowed_chain_ids' |
  'allowed_event_types' | 'allowed_term_types' | 'approved_aliases' | 'chain_budgets' |
  'daily_new_token_limit' | 'per_token_buy_limit' | 'slippage' | 'exit_strategy' | 'resolver_options'> & {
  preset_asset_routes: DynamicPresetAssetRouteInput[];
};

type ConfigSource = {
  kind: 'template' | 'current' | 'blank';
  id?: string;
  name: string;
  version?: number;
  baseline?: DynamicPolicyTemplateConfig | null;
};

function emptyChainBudgets(): DynamicPolicy['chain_budgets'] {
  return Object.fromEntries(CHAINS.map((chain) => [chain, {
    budget_per_trade: 0,
    daily_budget: 0,
  }])) as DynamicPolicy['chain_budgets'];
}

function normalizeChainBudgets(value?: Partial<DynamicPolicy['chain_budgets']>) {
  return Object.fromEntries(CHAINS.map((chain) => [chain, {
    budget_per_trade: Number(value?.[chain]?.budget_per_trade || 0),
    daily_budget: Number(value?.[chain]?.daily_budget || 0),
  }])) as DynamicPolicy['chain_budgets'];
}

function normalizeExitStrategy(value: unknown): ExitStrategy {
  const candidate = value as Partial<ExitStrategy> | null | undefined;
  if (candidate?.version === 1 && candidate.sell_ratio_type === 'buy_amount'
      && Array.isArray(candidate.legs) && candidate.legs.length > 0) {
    return candidate as ExitStrategy;
  }
  return cloneStrategy(STRATEGY_PRESETS[0].value);
}

function freshDraft(): Draft {
  return {
    mode: 'record',
    enabled: true,
    allowed_chain_ids: ['bsc'],
    allowed_event_types: ['tweet'],
    allowed_term_types: ['ca', 'cashtag', 'hashtag'],
    approved_aliases: [],
    preset_asset_routes: [],
    chain_budgets: emptyChainBudgets(),
    daily_new_token_limit: 0,
    per_token_buy_limit: 1,
    slippage: 10,
    exit_strategy: cloneStrategy(STRATEGY_PRESETS[0].value),
    resolver_options: {},
  };
}

function draftFromPolicy(policy: DynamicPolicy): Draft {
  return {
    mode: policy.mode,
    enabled: policy.enabled,
    allowed_chain_ids: [...policy.allowed_chain_ids],
    allowed_event_types: [...policy.allowed_event_types],
    allowed_term_types: [...policy.allowed_term_types],
    approved_aliases: structuredClone(policy.approved_aliases || []),
    preset_asset_routes: structuredClone(policy.preset_asset_routes || []),
    chain_budgets: normalizeChainBudgets(policy.chain_budgets),
    daily_new_token_limit: Number(policy.daily_new_token_limit),
    per_token_buy_limit: Number(policy.per_token_buy_limit),
    slippage: Number(policy.slippage),
    exit_strategy: normalizeExitStrategy(structuredClone(policy.exit_strategy)),
    resolver_options: structuredClone(policy.resolver_options || {}),
  };
}

function editableRoutes(
  routes: DynamicPresetAssetRouteInput[] = [],
  includeRouteId = false,
): DynamicPresetAssetRouteInput[] {
  return routes.map((route) => ({
    ...(includeRouteId && route.route_id ? { route_id: route.route_id } : {}),
    label: route.label,
    aliases: [...route.aliases],
    chain_id: route.chain_id,
    contract_address: route.contract_address,
    enabled: route.enabled !== false,
  }));
}

function configFromDraft(draft: Draft): DynamicPolicyTemplateConfig {
  return {
    allowed_chain_ids: [...draft.allowed_chain_ids],
    allowed_event_types: [...draft.allowed_event_types],
    allowed_term_types: [...draft.allowed_term_types],
    approved_aliases: structuredClone(draft.approved_aliases),
    preset_asset_routes: editableRoutes(draft.preset_asset_routes),
    chain_budgets: normalizeChainBudgets(draft.chain_budgets),
    daily_new_token_limit: draft.daily_new_token_limit,
    per_token_buy_limit: draft.per_token_buy_limit,
    slippage: draft.slippage,
    exit_strategy: normalizeExitStrategy(structuredClone(draft.exit_strategy)),
    resolver_options: structuredClone(draft.resolver_options || {}),
  };
}

function cloneConfig(config: DynamicPolicyTemplateConfig): DynamicPolicyTemplateConfig {
  return configFromDraft({ ...freshDraft(), ...structuredClone(config) });
}

function applyConfig(draft: Draft, config: DynamicPolicyTemplateConfig): Draft {
  const normalized = cloneConfig(config);
  return {
    ...draft,
    ...normalized,
    allowed_chain_ids: [...normalized.allowed_chain_ids],
    allowed_event_types: [...normalized.allowed_event_types],
    allowed_term_types: [...normalized.allowed_term_types],
  };
}

function sameValue(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function configDiffLabels(draft: Draft, baseline?: DynamicPolicyTemplateConfig | null) {
  if (!baseline) return [];
  const current = configFromDraft(draft);
  const labels: string[] = [];
  if (!sameValue(current.allowed_event_types, baseline.allowed_event_types)) labels.push('内容类型');
  if (!sameValue(current.allowed_term_types, baseline.allowed_term_types)
      || !sameValue(current.approved_aliases, baseline.approved_aliases)
      || !sameValue(current.preset_asset_routes, baseline.preset_asset_routes)
      || !sameValue(current.resolver_options, baseline.resolver_options)) labels.push('词条与解析');
  if (!sameValue(current.allowed_chain_ids, baseline.allowed_chain_ids)
      || !sameValue(current.chain_budgets, normalizeChainBudgets(baseline.chain_budgets))) labels.push('链上资金');
  if (current.daily_new_token_limit !== baseline.daily_new_token_limit
      || current.per_token_buy_limit !== baseline.per_token_buy_limit
      || current.slippage !== baseline.slippage) labels.push('限额与滑点');
  if (!sameValue(current.exit_strategy, baseline.exit_strategy)) labels.push('离场策略');
  return labels;
}

function modeLabel(mode: DynamicPolicy['mode']) {
  return mode === 'record' ? '记录' : mode === 'paper' ? '模拟' : mode === 'live' ? '实盘' : '暂停';
}

function aliasesText(values: DynamicPolicy['approved_aliases']) {
  return (values || []).map((item) => typeof item === 'string' ? item : item.name).join('\n');
}

function aliasMatchKey(value: string) {
  return value.normalize('NFKC').toLocaleLowerCase('en-US').replace(/[\p{P}\p{Z}\s]+/gu, '');
}

function aliasCount(values: DynamicPolicy['approved_aliases']) {
  return values?.length || 0;
}

function resolutionLabel(status: DynamicResolution['status']) {
  return status === 'resolved' ? '已解析' : status === 'ambiguous' ? '存在歧义'
    : status === 'not_found' ? '未找到' : status === 'provider_failed' ? '数据源失败'
      : status === 'rejected' ? '已拒绝' : '处理中';
}

function eventSummary(config: DynamicPolicyTemplateConfig) {
  return EVENT_TYPES.filter(([value]) => config.allowed_event_types.includes(value))
    .map(([, label]) => label).join('、') || '未配置内容';
}

function termSummary(config: DynamicPolicyTemplateConfig) {
  const terms = TERM_TYPES.filter(([value]) => config.allowed_term_types.includes(value))
    .map(([, label]) => label);
  const count = aliasCount(config.approved_aliases);
  const routes = config.preset_asset_routes?.length || 0;
  return `${terms.join('、') || '未配置词条'}${routes ? ` · ${routes} 条资产路由` : ''}${count ? ` · ${count} 个待绑定词` : ''}`;
}

function routeValidation(routes: DynamicPresetAssetRouteInput[]) {
  const seen = new Set<string>();
  const assetKeys = new Set<string>();
  let totalAliases = 0;
  for (const [routeIndex, route] of routes.entries()) {
    if (!route.label.trim() || !route.contract_address.trim()) return `请补全第 ${routeIndex + 1} 条资产路由`;
    if (route.aliases.length < 1 || route.aliases.length > 10 || route.aliases.some((alias) => !alias.trim())) {
      return `第 ${routeIndex + 1} 条资产路由需要 1 至 10 个有效关键词`;
    }
    totalAliases += route.aliases.length;
    const contract = route.chain_id === 'sol'
      ? route.contract_address.trim() : route.contract_address.trim().toLowerCase();
    const assetKey = `${route.chain_id}:${contract}`;
    if (assetKeys.has(assetKey)) return `第 ${routeIndex + 1} 条资产路由与另一条路由绑定了相同 CA`;
    assetKeys.add(assetKey);
    for (const alias of route.aliases) {
      const key = aliasMatchKey(alias);
      if (seen.has(key)) return `关键词“${alias}”归一化后与另一条路由重复`;
      seen.add(key);
    }
  }
  if (totalAliases > 50) return '每个账号最多配置 50 个路由关键词';
  return null;
}

function moneySummary(config: DynamicPolicyTemplateConfig) {
  if (!config.allowed_chain_ids.length) return '尚未启用链';
  return config.allowed_chain_ids.map((chain) => {
    const budget = config.chain_budgets[chain];
    return `${CHAIN_META[chain].unit} ${budget?.budget_per_trade || 0}/${budget?.daily_budget || 0}`;
  }).join(' · ');
}

export function P20Operations({ kols, initialKolId }: { kols: KolAccount[]; initialKolId?: string }) {
  const [policies, setPolicies] = useState<DynamicPolicy[]>([]);
  const [templates, setTemplates] = useState<DynamicPolicyTemplate[]>([]);
  const [kolId, setKolId] = useState('');
  const [draft, setDraft] = useState<Draft>(() => freshDraft());
  const [step, setStep] = useState(1);
  const [configSource, setConfigSource] = useState<ConfigSource>({ kind: 'blank', name: '空白配置', baseline: null });
  const [templateChooserOpen, setTemplateChooserOpen] = useState(false);
  const [chooserTemplateId, setChooserTemplateId] = useState('');
  const [templateDetailsOpen, setTemplateDetailsOpen] = useState(true);
  const [accountTemplateId, setAccountTemplateId] = useState('');
  const [accountTemplateName, setAccountTemplateName] = useState('');
  const [saving, setSaving] = useState(false);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [resolutions, setResolutions] = useState<DynamicResolution[]>([]);
  const [runtime, setRuntime] = useState<DynamicSignalStatus | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const { toast } = useToast();

  const refresh = useCallback(async () => {
    const [policyResponse, templateResponse, resolutionResponse, statusResponse] = await Promise.all([
      api.dynamicSignal.policies(), api.dynamicSignal.templates.list(),
      api.dynamicSignal.resolutions({ limit: '50' }), api.dynamicSignal.status(),
    ]);
    if (policyResponse.ok) setPolicies(policyResponse.data || []);
    if (templateResponse.ok) setTemplates(templateResponse.data || []);
    if (resolutionResponse.ok) setResolutions(resolutionResponse.data || []);
    if (statusResponse.ok) setRuntime(statusResponse.data || null);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const selected = useMemo(
    () => policies.find((item) => String(item.kol_id) === kolId),
    [kolId, policies],
  );
  const selectedKey = selected ? `${selected.id}:${selected.revision}:${selected.updated_at || ''}` : '';
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  useEffect(() => {
    if (kolId) return;
    const requestedKolId = initialKolId && kols.some((item) => String(item.id) === initialKolId)
      ? initialKolId : '';
    setKolId(requestedKolId || String(policies[0]?.kol_id || kols[0]?.id || ''));
  }, [initialKolId, kolId, kols, policies]);

  useEffect(() => {
    if (!kolId) return;
    const currentPolicy = selectedRef.current;
    const next = currentPolicy ? draftFromPolicy(currentPolicy) : freshDraft();
    setDraft(next);
    setConfigSource(currentPolicy
      ? { kind: 'current', name: '当前账号策略', baseline: configFromDraft(next) }
      : { kind: 'blank', name: '空白配置', baseline: null });
    setAccountTemplateId('');
    setAccountTemplateName('');
    setStep(1);
  // Only an account or persisted revision change may replace an in-progress draft.
  }, [kolId, selectedKey]);

  const selectedTemplate = templates.find((item) => item.id === accountTemplateId);
  const chooserTemplate = templates.find((item) => item.id === chooserTemplateId);
  const currentConfig = useMemo(() => configFromDraft(draft), [draft]);
  const policyChanged = useMemo(() => {
    if (!selected) return true;
    return draft.mode !== selected.mode || draft.enabled !== selected.enabled
      || !sameValue(currentConfig, configFromDraft(draftFromPolicy(selected)));
  }, [currentConfig, draft.enabled, draft.mode, selected]);
  const sourceConfig = configSource.baseline || currentConfig;
  const configDiffs = useMemo(
    () => configDiffLabels(draft, configSource.baseline),
    [configSource.baseline, draft],
  );

  const toggle = <T extends string>(field: 'allowed_event_types' | 'allowed_term_types', value: T) => {
    setDraft((current) => {
      const values = current[field] as string[];
      return { ...current, [field]: values.includes(value) ? values.filter((item) => item !== value) : [...values, value] };
    });
  };

  const resetDraft = () => {
    const next = selected ? draftFromPolicy(selected) : freshDraft();
    setDraft(next);
    setConfigSource(selected
      ? { kind: 'current', name: '当前账号策略', baseline: configFromDraft(next) }
      : { kind: 'blank', name: '空白配置', baseline: null });
    setAccountTemplateId('');
    setAccountTemplateName('');
    setStep(1);
  };

  const openTemplateChooser = () => {
    setChooserTemplateId(accountTemplateId);
    setTemplateChooserOpen(true);
  };

  const applySelectedTemplate = () => {
    if (!chooserTemplate) return toast('请先选择动态策略模板', 'error');
    const baseline = cloneConfig(chooserTemplate.config);
    setDraft((current) => applyConfig(current, baseline));
    setConfigSource({
      kind: 'template', id: chooserTemplate.id, name: chooserTemplate.name,
      version: chooserTemplate.version, baseline,
    });
    setAccountTemplateId(chooserTemplate.id);
    setAccountTemplateName(chooserTemplate.name);
    setTemplateChooserOpen(false);
    toast(`已应用完整模板“${chooserTemplate.name}”；账号、运行阶段和启用状态未改变`, 'success');
  };

  const applyBlank = () => {
    setDraft((current) => ({ ...freshDraft(), mode: current.mode, enabled: current.enabled }));
    setConfigSource({ kind: 'blank', name: '空白配置', baseline: null });
    setAccountTemplateId('');
    setChooserTemplateId('');
    setAccountTemplateName('');
    setTemplateChooserOpen(false);
  };

  const restoreSource = () => {
    if (!configSource.baseline) return;
    setDraft((current) => applyConfig(current, configSource.baseline!));
    toast(`已恢复“${configSource.name}”完整配置`, 'success');
  };

  const saveAccountTemplate = async () => {
    const name = accountTemplateName.trim();
    if (!name) return toast('请输入动态策略模板名称', 'error');
    setTemplateBusy(true);
    try {
      const response = await api.dynamicSignal.templates.create({ name, config: currentConfig });
      if (!response.ok || !response.data) return toast(response.error || '动态策略模板保存失败', 'error');
      setTemplates((current) => [response.data!, ...current.filter((item) => item.id !== response.data!.id)]);
      setAccountTemplateId(response.data.id);
      setAccountTemplateName(response.data.name);
      setConfigSource({
        kind: 'template', id: response.data.id, name: response.data.name,
        version: response.data.version, baseline: cloneConfig(response.data.config),
      });
      toast(`动态策略模板“${response.data.name}”已保存`, 'success');
    } finally { setTemplateBusy(false); }
  };

  const updateAccountTemplate = async () => {
    if (!selectedTemplate) return toast('请先选择要更新的动态策略模板', 'error');
    if (!window.confirm(`确认用当前草稿覆盖模板“${selectedTemplate.name}”？这不会修改其他账号已保存的策略。`)) return;
    const name = accountTemplateName.trim() || selectedTemplate.name;
    setTemplateBusy(true);
    try {
      const response = await api.dynamicSignal.templates.update(selectedTemplate.id, { name, config: currentConfig });
      if (!response.ok || !response.data) return toast(response.error || '动态策略模板更新失败', 'error');
      setTemplates((current) => current.map((item) => item.id === response.data!.id ? response.data! : item));
      setAccountTemplateName(response.data.name);
      setConfigSource({
        kind: 'template', id: response.data.id, name: response.data.name,
        version: response.data.version, baseline: cloneConfig(response.data.config),
      });
      toast(`动态策略模板“${response.data.name}”已更新`, 'success');
    } finally { setTemplateBusy(false); }
  };

  const deleteAccountTemplate = async () => {
    if (!selectedTemplate || !window.confirm(`确认删除动态策略模板“${selectedTemplate.name}”？已保存的账号策略不会变化。`)) return;
    setTemplateBusy(true);
    try {
      const response = await api.dynamicSignal.templates.remove(selectedTemplate.id);
      if (!response.ok) return toast(response.error || '动态策略模板删除失败', 'error');
      setTemplates((current) => current.filter((item) => item.id !== selectedTemplate.id));
      setAccountTemplateId('');
      setAccountTemplateName('');
      if (configSource.id === selectedTemplate.id) {
        setConfigSource({ kind: 'current', name: '当前草稿', baseline: configFromDraft(draft) });
      }
      toast('动态策略模板已删除，当前草稿未改变', 'success');
    } finally { setTemplateBusy(false); }
  };

  const validateStep = (target: number) => {
    if (target > 1 && !kolId) return '请先选择 X 账号';
    if (target > 2) {
      if (!draft.allowed_event_types.length) return '请至少选择一种内容类型';
      if (!draft.allowed_term_types.length) return '请至少选择一种词条类型';
      if (!draft.allowed_term_types.includes('approved_name')
          && draft.preset_asset_routes.some((route) => route.enabled !== false)) {
        return '资产路由需要启用“项目名称”词条类型';
      }
      if (draft.allowed_term_types.includes('approved_name')
          && !draft.approved_aliases.length && !draft.preset_asset_routes.length) {
        return '启用项目名称时必须配置至少一条资产路由';
      }
      const invalidRoute = routeValidation(draft.preset_asset_routes);
      if (invalidRoute) return invalidRoute;
      if (['paper', 'live'].includes(draft.mode) && draft.approved_aliases.length) {
        return '模拟或实盘前必须将所有旧关键词绑定到资产路由，或删除旧关键词';
      }
      if (draft.preset_asset_routes.some((route) => !draft.allowed_chain_ids.includes(route.chain_id))) {
        return '资产路由使用的链必须同时在资金步骤中启用';
      }
    }
    if (target > 3) {
      if (!draft.allowed_chain_ids.length) return '请至少启用一条链';
      const invalidBudget = draft.allowed_chain_ids.some((chain) => {
        const budget = draft.chain_budgets[chain];
        return !budget || budget.budget_per_trade <= 0 || budget.daily_budget < budget.budget_per_trade;
      });
      if (['paper', 'live'].includes(draft.mode) && invalidBudget) return '请检查每条启用链的单笔金额和每日上限';
      if (['paper', 'live'].includes(draft.mode) && draft.slippage <= 0) return '模拟或实盘必须设置有效滑点';
      if (draft.mode === 'live' && draft.daily_new_token_limit <= 0) return '实盘必须设置每日新币上限';
      if (!draft.exit_strategy.legs.length || draft.exit_strategy.legs.length > 10) return '离场策略需要 1 至 10 条条件';
    }
    return null;
  };

  const goToStep = (target: number) => {
    const next = Math.max(1, Math.min(4, target));
    const error = next > step ? validateStep(next) : null;
    if (error) return toast(error, 'error');
    setStep(next);
  };

  const save = async () => {
    const error = validateStep(4);
    if (error) return toast(error, 'error');
    setSaving(true);
    try {
      const previousRevision = selected?.revision;
      const response = await api.dynamicSignal.savePolicy(kolId, {
        ...draft,
        preset_asset_routes: editableRoutes(draft.preset_asset_routes, true),
      });
      if (!response.ok || !response.data) return toast(response.error || '策略保存失败', 'error');
      const nextRevision = Number(response.data.revision);
      if (previousRevision === undefined) {
        toast(`动态策略已创建：Revision ${nextRevision}；新事件立即使用该配置`, 'success');
      } else if (nextRevision > Number(previousRevision)) {
        toast(`动态策略已热更新：Revision ${previousRevision} → ${nextRevision}；新事件立即使用新配置`, 'success');
      } else {
        toast(`配置与服务器 Revision ${nextRevision} 一致，无需更新`, 'info');
      }
      await refresh();
    } finally { setSaving(false); }
  };

  const archivePolicy = async () => {
    if (!selected || !window.confirm(`确认停用并归档 @${selected.x_handle.replace(/^@+/, '')} 的动态策略？已有仓位仍会保留离场能力。`)) return;
    setActionBusy(true);
    try {
      const response = await api.dynamicSignal.removePolicy(selected.id);
      if (!response.ok) return toast(response.error || '策略归档失败', 'error');
      toast('动态策略已停用并归档', 'success');
      await refresh();
    } finally { setActionBusy(false); }
  };

  const policyResolutions = selected
    ? resolutions.filter((item) => item.actor_policy_id === selected.id).slice(0, 8) : [];
  const watchReady = selected?.watch_sync_status === 'succeeded';
  const liveReady = Boolean(selected?.mode === 'live' && selected.enabled
    && runtime?.features.P20_LIVE_ENABLED && watchReady);
  const watchStatusLabel = selected?.watch_sync_status === 'succeeded' ? '已同步'
    : selected?.watch_sync_status === 'failed' ? '同步失败'
      : selected?.watch_sync_status === 'processing' ? '同步中'
        : selected?.watch_sync_status === 'pending' ? '等待同步' : '未创建';
  const selectedKol = kols.find((item) => String(item.id) === kolId);
  const sourceStatus = configSource.kind === 'template' ? `已应用完整模板 · v${configSource.version}`
    : configSource.kind === 'current' ? '已加载保存配置' : '当前未应用模板';

  const templateLayers = templateChooserOpen && createPortal(<>
    <button type="button" className="p164-layer-overlay" aria-label="关闭模板选择" onClick={() => setTemplateChooserOpen(false)} />
    <aside className="p164-template-drawer" role="dialog" aria-modal="true" aria-label="选择动态策略模板">
      <div className="p164-layer-head"><div><strong>选择动态策略模板</strong><span>一套完整配置贯穿词条、资金与离场步骤</span></div><button type="button" className="p16-icon-button" title="关闭" aria-label="关闭模板选择" onClick={() => setTemplateChooserOpen(false)}><X size={16} /></button></div>
      <div className="p164-template-drawer-body">
        <div className="p164-template-options">
          {templates.map((template) => {
            const selectedOption = chooserTemplateId === template.id;
            return <button type="button" className={`p164-template-option ${selectedOption ? 'selected' : ''}`} aria-pressed={selectedOption} key={template.id} onClick={() => setChooserTemplateId(template.id)}>
              <i><Check size={12} /></i><div><span><strong>{template.name}</strong><em>v{template.version}</em></span><small>{eventSummary(template.config)} · {termSummary(template.config)}<br />{moneySummary(template.config)} · {strategySummary(template.config.exit_strategy)}</small></div>
            </button>;
          })}
          {!templates.length && <div className="p16-empty-line">还没有动态策略模板，可从当前草稿保存第一份模板。</div>}
        </div>
        <section className="p164-alternate-source"><span>其他创建方式</span><button type="button" onClick={applyBlank}>从空白配置开始</button></section>
      </div>
      <div className="p164-layer-foot"><button type="button" className="btn btn-secondary" onClick={() => setTemplateChooserOpen(false)}>取消</button><button type="button" className="btn btn-primary" disabled={!chooserTemplate} onClick={applySelectedTemplate}><Check size={16} />应用所选</button></div>
    </aside>
  </>, document.body);

  return (
    <section className="p20-operations">
      <section className="p20-policy-wizard">
        <nav className="p162-stepper" aria-label="动态策略创建步骤">
          {STEP_ITEMS.map(([title, detail], index) => {
            const number = index + 1;
            return <button type="button" key={title} className={`p162-step-button ${step === number ? 'active' : ''} ${step > number ? 'complete' : ''}`} onClick={() => goToStep(number)}><span>{step > number ? <Check size={14} /> : number}</span><div data-short={title.slice(0, 2)}><strong>{title}</strong><small>{detail}</small></div></button>;
          })}
        </nav>

        <div className="p20-wizard-context">
          <div className="p20-wizard-actor"><span>{(selectedKol?.x_handle || 'X').replace(/^@+/, '').slice(0, 1).toUpperCase()}</span><div><strong>{selectedKol ? `@${selectedKol.x_handle.replace(/^@+/, '')}` : '待选择账号'}</strong><small>{selected ? `${modeLabel(selected.mode)} · Revision ${selected.revision}` : '动态策略草稿'}</small></div></div>
          <div className="p20-wizard-context-actions"><div><span>当前配置</span><strong>{configSource.name}</strong></div><button type="button" className="btn btn-secondary" onClick={openTemplateChooser}><Layers3 size={15} />更换</button><div className="p162-context-stats"><span><strong>{draft.allowed_chain_ids.length}</strong>允许链</span><span><strong>{draft.allowed_term_types.length}</strong>词条类型</span></div></div>
        </div>

        <main className="p20-wizard-main">
          <div className="p16-step-content">
            {step === 1 && <>
              <div className="p16-step-title"><div><span>步骤 1 / 4</span><h3>选择账号并应用配置模板</h3></div><em className={kolId ? 'ready' : ''}>{kolId ? '账号已选择' : '等待账号'}</em></div>
              <div className="p20-form-row"><label><span>X 账号</span><select value={kolId} onChange={(event) => setKolId(event.target.value)}><option value="">选择账号</option>{kols.map((kol) => <option key={kol.id} value={String(kol.id)}>@{kol.x_handle.replace(/^@+/, '')}</option>)}</select></label><label><span>运行阶段</span><select value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as Draft['mode'] })}><option value="record">记录：仅记录</option><option value="paper">模拟：模拟交易</option><option value="live">实盘：直接交易</option><option value="paused">暂停</option></select></label></div>

              <section className={`p164-template-strip ${configSource.kind === 'blank' ? 'empty' : ''}`}>
                <div className="p164-template-strip-main"><i><Layers3 size={17} /></i><div className="p164-template-name"><strong>{configSource.name}{configSource.version ? ` · v${configSource.version}` : ''}</strong><span>{sourceStatus}</span></div><div className="p164-template-summary"><span>{eventSummary(sourceConfig)}</span><span>{termSummary(sourceConfig)}</span><span>{moneySummary(sourceConfig)}</span><span>{strategySummary(sourceConfig.exit_strategy)}</span></div><div className="p164-template-actions"><button type="button" onClick={() => setTemplateDetailsOpen((value) => !value)}>{templateDetailsOpen ? '收起' : '查看'}</button><button type="button" onClick={openTemplateChooser}>更换</button></div></div>
                {templateDetailsOpen && <div className="p20-template-details"><div><span>内容与词条</span><strong>{eventSummary(sourceConfig)}<br />{termSummary(sourceConfig)}</strong></div><div><span>资产路由</span><strong>{sourceConfig.preset_asset_routes?.map((route) => `${route.label} · ${route.aliases.length} 词`).join('；') || aliasesText(sourceConfig.approved_aliases) || '未配置'}</strong></div><div><span>多链资金</span><strong>{moneySummary(sourceConfig)}</strong></div><div><span>限额与滑点</span><strong>每日 {sourceConfig.daily_new_token_limit || '不限制'} 个新币 · 单币累计 {sourceConfig.per_token_buy_limit} 次 · 滑点 {sourceConfig.slippage}%</strong></div><div><span>离场策略</span><strong>{strategySummary(sourceConfig.exit_strategy)}</strong></div><div><span>模板不保存</span><strong>X 账号、运行阶段、启用状态、路由验证证据、Revision 和 Watch</strong></div></div>}
              </section>

              <div className="p20-template-save-row"><input value={accountTemplateName} onChange={(event) => setAccountTemplateName(event.target.value)} placeholder="模板名称，例如：多链喊单标准" aria-label="动态策略模板名称" /><button type="button" className="btn btn-secondary" disabled={templateBusy} onClick={() => void saveAccountTemplate()}><Save size={15} />保存为新模板</button>{selectedTemplate && <button type="button" className="btn btn-secondary" disabled={templateBusy} onClick={() => void updateAccountTemplate()}><Save size={15} />更新所选模板</button>}{selectedTemplate && <button type="button" className="p16-icon-button" title="删除所选模板" aria-label="删除所选模板" disabled={templateBusy} onClick={() => void deleteAccountTemplate()}><Trash2 size={15} /></button>}</div>

              <div className="p20-choice-row"><span>状态</span><label><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />启用该账号策略</label></div>
              <div className="p20-choice-row"><span>监听内容</span>{EVENT_TYPES.map(([value, label]) => <label key={value}><input type="checkbox" checked={draft.allowed_event_types.includes(value)} onChange={() => toggle('allowed_event_types', value)} />{label}</label>)}</div>
              {draft.mode === 'live' && <div className="p20-live-notice"><ShieldAlert size={15} /><span>策略保存并启用后，在全局真实交易运行期间直接参与实盘；无需账号短时授权。</span></div>}
            </>}

            {step === 2 && <>
              <div className="p16-step-title"><div><span>步骤 2 / 4</span><h3>配置词条与 CA 解析规则</h3></div><em>{draft.allowed_term_types.length} 类词条</em></div>
              {configSource.kind === 'template' && <div className="p164-template-origin"><Layers3 size={15} /><span>词条与解析已从 {configSource.name} 预填，当前步骤可以继续修改。</span></div>}
              <div className="p20-choice-row"><span>允许词条</span>{TERM_TYPES.map(([value, label]) => <label key={value}><input type="checkbox" checked={draft.allowed_term_types.includes(value)} onChange={() => toggle('allowed_term_types', value)} />{label}</label>)}</div>
              {draft.allowed_term_types.includes('approved_name') && <DynamicAssetRouteWorkspace
                routes={draft.preset_asset_routes}
                legacyAliases={draft.approved_aliases}
                allowedChains={draft.allowed_chain_ids}
                onChange={(preset_asset_routes) => setDraft((current) => ({ ...current, preset_asset_routes }))}
                onLegacyAliasesChange={(approved_aliases) => setDraft((current) => ({ ...current, approved_aliases }))}
              />}
              <div className="p20-resolver-note"><strong>解析顺序</strong><span>完整 CA 与资产路由均为确定映射；同一路由多个关键词只触发一次，不同路由或冲突 CA 会拒绝交易。</span></div>
            </>}

            {step === 3 && <>
              <div className="p16-step-title"><div><span>步骤 3 / 4</span><h3>设置多链资金与离场策略</h3></div>{configSource.baseline && configDiffs.length === 0 ? <em className="ready"><Check size={14} />与配置来源一致</em> : !configSource.baseline ? <em>当前配置尚未保存为模板</em> : null}</div>
              {configSource.baseline && <div className="p164-template-origin"><Layers3 size={15} /><span>配置来源：{configSource.name}{configSource.version ? ` · v${configSource.version}` : ''}</span></div>}
              {configDiffs.length > 0 && <div className="p164-template-change-bar"><div><ShieldAlert size={17} /><span><strong>当前账号策略已修改：{configDiffs.join('、')}</strong><small>本次修改只影响当前账号，不会自动改写模板。</small></span></div><button type="button" className="btn btn-secondary" onClick={restoreSource}><RotateCcw size={15} />恢复来源配置</button></div>}
              <DynamicTradeConfigMatrix allowedChainIds={draft.allowed_chain_ids} chainBudgets={draft.chain_budgets} mode={draft.mode} onChange={(value) => setDraft((current) => ({ ...current, ...value }))} />
              <div className="p20-number-grid"><label><span>每日新币上限</span><input type="number" min="0" value={draft.daily_new_token_limit} onChange={(event) => setDraft({ ...draft, daily_new_token_limit: Number(event.target.value) })} /></label><label><span>单币累计买入上限</span><input type="number" min="1" value={draft.per_token_buy_limit} onChange={(event) => setDraft({ ...draft, per_token_buy_limit: Number(event.target.value) })} /></label><label><span>滑点 %</span><input type="number" min="0.01" max="100" step="0.01" value={draft.slippage} onChange={(event) => setDraft({ ...draft, slippage: Number(event.target.value) })} /></label></div>
              <div className="p20-exit-section"><div className="p20-section-title"><strong>共用离场策略</strong><span>{strategySummary(draft.exit_strategy)}</span></div><StrategyEditor value={draft.exit_strategy} onChange={(exit_strategy) => setDraft((current) => ({ ...current, exit_strategy }))} saveHint="修改只生成新 Revision，不需要重新授权" /></div>
            </>}

            {step === 4 && <>
              <div className="p16-step-title"><div><span>步骤 4 / 4</span><h3>确认并保存策略</h3></div><em className="ready">可以保存</em></div>
              <div className="p16-review-list"><div><span>账号与阶段</span><strong>{selectedKol ? `@${selectedKol.x_handle.replace(/^@+/, '')}` : '--'} · {modeLabel(draft.mode)}</strong></div><div><span>配置来源</span><strong>{configSource.name}{configSource.version ? ` · v${configSource.version}` : ''}{configDiffs.length ? ' · 当前账号已修改' : ''}</strong></div><div><span>监听内容</span><strong>{eventSummary(currentConfig)}</strong></div><div><span>词条与解析</span><strong>{termSummary(currentConfig)}</strong></div><div><span>多链资金</span><strong>{moneySummary(currentConfig)}</strong></div><div><span>限额</span><strong>每日 {draft.daily_new_token_limit || '不限制'} 个新币 · 单币累计 {draft.per_token_buy_limit} 次 · 滑点 {draft.slippage}%</strong></div><div><span>离场策略</span><strong>{strategySummary(draft.exit_strategy)}</strong></div><div><span>版本影响</span><strong>{selected ? policyChanged ? `热更新 Revision ${selected.revision} → ${selected.revision + 1}` : `配置无变化，保持 Revision ${selected.revision}` : '保存后创建 Revision 1'}</strong></div></div>
              <div className="p16-save-note">策略保存采用热更新，无需停止或重启 Engine。实盘策略启用后，只要全局真实交易正在运行，后续新事件就会按当前 Revision 和逐链预算直接执行。</div>
            </>}
          </div>

          <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? resetDraft() : goToStep(step - 1)}>{step === 1 ? '重置草稿' : '上一步'}</button>{step < 4 ? <button type="button" className="btn btn-primary" onClick={() => goToStep(step + 1)}>下一步<ArrowRight size={16} /></button> : <div className="p20-policy-actions">{selected && <button type="button" className="btn btn-secondary" disabled={actionBusy} onClick={archivePolicy}><Archive size={15} />停用归档</button>}<button type="button" className="btn btn-primary" disabled={saving || actionBusy || !kolId} onClick={save}><Save size={15} />{saving ? '保存中' : '保存策略'}</button></div>}</div>
        </main>
      </section>

      <section className="p20-configured-policies p20-configured-policies-wide"><div className="p20-section-title"><strong>已配置账号</strong><span>{policies.length} 个</span></div><div className="p20-policy-list">{policies.map((policy) => <button type="button" key={policy.id} className={String(policy.kol_id) === kolId ? 'selected' : ''} onClick={() => setKolId(String(policy.kol_id))}><strong>@{policy.x_handle.replace(/^@+/, '')}</strong><span>{modeLabel(policy.mode)} · Revision {policy.revision}</span></button>)}{!policies.length && <div className="p16-empty-line">还没有动态策略。</div>}</div></section>

      <div className="p20-runtime-grid">
        <section><div className="p20-section-title"><strong>解析记录</strong><span>{policyResolutions.length ? `最近 ${policyResolutions.length} 条` : '暂无记录'}</span></div><div className="p20-audit-list">{policyResolutions.map((item) => <div key={item.id}><span><strong>{item.symbol || item.contract_address || '未解析词条'}</strong><small>{item.chain_id?.toUpperCase() || '--'} · {item.failure_code || item.intent_class}</small></span><i className={item.status === 'resolved' ? 'active' : ''}>{resolutionLabel(item.status)}</i></div>)}{!policyResolutions.length && <div className="p16-empty-line">该策略还没有解析记录</div>}</div></section>
        <section>
          <div className="p20-section-title"><strong>实盘运行条件</strong><span>{liveReady ? '当前策略可进入实盘' : '当前策略未进入实盘'}</span></div>
          <div className="p20-acceptance-status">
            <div><span>当前 Revision</span><strong>{selected?.revision || '--'}</strong></div>
            <div><span>策略状态</span><strong>{selected?.enabled ? modeLabel(selected.mode) : '已停用'}</strong></div>
            <div><span>6551 Watch</span><strong>{watchStatusLabel}</strong></div>
            <div><span>P20 实盘能力</span><strong>{runtime?.features.P20_LIVE_ENABLED ? '已开启' : '未开启'}</strong></div>
          </div>
          <div className="p20-authorization-note"><ShieldAlert size={15} /><span>{liveReady ? '全局 Engine 启动后，该账号按当前配置直接参与真实交易，无需额外授权。' : '要进入实盘，请确认策略为“实盘”并启用、6551 Watch 已同步、P20 实盘能力已开启且全局 Engine 正在运行。'}</span></div>
        </section>
      </div>
      {templateLayers}
    </section>
  );
}
