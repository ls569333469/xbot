import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  FilePlus2,
  Layers3,
  Pencil,
  RotateCcw,
  Save,
  Search,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type {
  ChainId,
  KolAccount,
  WhitelistDraftPayload,
  WhitelistEntry,
  WhitelistTemplate,
  WhitelistTemplateSnapshot,
} from '../../lib/types';
import AccountRulesStep from './AccountRulesStep';
import StrategyEditor from './StrategyEditor';
import { cloneStrategy, STRATEGY_PRESETS, strategySummary } from './strategy-presets';
import {
  applyConfigSnapshot,
  configDiffLabels,
  identityHandles,
  materializeConfigDraft,
  normalizeHandle,
  snapshotFromDraft,
  snapshotFromWhitelist,
  uniqueHandles,
  type RelationTargetPolicy,
  type WhitelistConfigDraft,
} from './whitelist-config';

const CHAINS: ChainId[] = ['sol', 'bsc', 'base', 'eth', 'robinhood'];
const NATIVE_SYMBOLS: Record<ChainId, string> = {
  sol: 'SOL', bsc: 'BNB', base: 'ETH', eth: 'ETH', robinhood: 'ETH',
};
const DEFAULT_DIRECT_EVENTS: WhitelistTemplateSnapshot['direct_source_event_types'] = ['tweet'];
const DEFAULT_RELATION_EVENTS: WhitelistTemplateSnapshot['relation_event_types'] = ['retweet', 'quote', 'reply', 'follow'];

type DraftForm = WhitelistConfigDraft & {
  contract_address: string;
  chain_id: ChainId;
  symbol: string;
  project_name: string;
  token_logo_url: string | null;
  token_official_x_handle: string | null;
  token_website_url: string | null;
  token_metadata_source: string | null;
  token_metadata_fetched_at: string | null;
  candidates?: WhitelistDraftPayload['candidates'];
};

type ConfigSource = {
  kind: 'template' | 'copy' | 'blank' | 'current';
  id?: string;
  name: string;
  version?: number;
  baseline?: WhitelistTemplateSnapshot | null;
};

function seedActorHandles(seed?: WhitelistDraftPayload | null) {
  return {
    direct: uniqueHandles(seed?.direct_source_actor_handles?.length
      ? seed.direct_source_actor_handles
      : (seed?.direct_sources || [])
        .filter((source) => source.source_kind === 'ecosystem')
        .map((source) => source.actor_handle)),
    relation: uniqueHandles(seed?.relation_actor_handles?.length
      ? seed.relation_actor_handles
      : (seed?.relations || []).map((relation) => relation.actor_handle)),
    targets: uniqueHandles(seed?.relation_target_handles?.length
      ? seed.relation_target_handles
      : (seed?.relations || []).map((relation) => relation.target_x_handle)),
  };
}

function emptyForm(seed?: WhitelistDraftPayload | null): DraftForm {
  const handles = seedActorHandles(seed);
  const sources = (seed?.direct_sources || [])
    .filter((source) => source.source_kind === 'ecosystem' || source.source_kind === 'launch')
    .map((source) => ({
      ...source,
      event_types: Array.isArray(source.event_types) && source.event_types.length
        ? source.event_types
        : [...DEFAULT_DIRECT_EVENTS],
      match_mode: 'ca_only' as const,
    }));
  const relations = (seed?.relations || []).map((relation) => ({
    ...relation,
    event_types: Array.isArray(relation.event_types) && relation.event_types.length
      ? relation.event_types
      : [...DEFAULT_RELATION_EVENTS],
  }));
  const targetPolicy: RelationTargetPolicy = seed?.relation_target_policy || 'manual';
  const base: DraftForm = {
    contract_address: seed?.contract_address || '',
    chain_id: seed?.chain_id || 'sol',
    symbol: seed?.symbol || '',
    project_name: seed?.project_name || '',
    direct_sources: sources,
    relations,
    project_accounts: seed?.project_accounts || [],
    direct_source_rule_enabled: seed?.direct_source_rule_enabled ?? handles.direct.length > 0,
    direct_source_actor_handles: handles.direct,
    relation_rule_enabled: seed?.relation_rule_enabled ?? handles.relation.length > 0,
    relation_actor_handles: handles.relation,
    relation_target_handles: handles.targets,
    relation_target_policy: targetPolicy,
    relation_event_types: seed?.relation_event_types
      || seed?.relations?.[0]?.event_types
      || [...DEFAULT_RELATION_EVENTS],
    direct_source_event_types: seed?.direct_source_event_types
      || seed?.direct_sources?.[0]?.event_types
      || [...DEFAULT_DIRECT_EVENTS],
    budget_per_trade: seed?.budget_per_trade == null ? '' : String(seed.budget_per_trade),
    total_budget: seed?.total_budget == null ? '' : String(seed.total_budget),
    slippage: seed?.slippage == null ? '10' : String(seed.slippage),
    allow_repeat_buy: Boolean(seed?.allow_repeat_buy),
    max_repeat_buys: seed?.max_repeat_buys == null ? '1' : String(seed.max_repeat_buys),
    exit_strategy: seed?.exit_strategy || cloneStrategy(STRATEGY_PRESETS[0].value),
    token_logo_url: seed?.token_logo_url || null,
    token_official_x_handle: seed?.token_official_x_handle || null,
    token_website_url: seed?.token_website_url || null,
    token_metadata_source: seed?.token_metadata_source || null,
    token_metadata_fetched_at: seed?.token_metadata_fetched_at || null,
    candidates: seed?.candidates || [],
  };
  return materializeConfigDraft(base);
}

function templateActorCount(snapshot?: WhitelistTemplateSnapshot | null) {
  if (!snapshot) return 0;
  return new Set([
    ...(snapshot.direct_source_rule_enabled ? uniqueHandles(snapshot.direct_source_actor_handles) : []),
    ...(snapshot.relation_rule_enabled ? uniqueHandles(snapshot.relation_actor_handles) : []),
  ]).size;
}

interface Props {
  seed?: WhitelistDraftPayload | null;
  editing?: WhitelistEntry | null;
  whitelists: WhitelistEntry[];
  templates: WhitelistTemplate[];
  kolAccounts: KolAccount[];
  onCancel: () => void;
  onOpenResearch: (draft: WhitelistDraftPayload) => void;
  onSaved: () => void;
  onTemplatesChanged: () => void | Promise<void>;
}

export default function WhitelistWorkspace({
  seed,
  editing,
  whitelists,
  templates,
  kolAccounts,
  onCancel,
  onOpenResearch,
  onSaved,
  onTemplatesChanged,
}: Props) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState<DraftForm>(() => emptyForm(seed || editing));
  const [configSource, setConfigSource] = useState<ConfigSource>(() => editing
    ? { kind: 'current', name: '当前白名单配置', baseline: null }
    : { kind: 'blank', name: '空白配置', baseline: null });
  const [templateChooserOpen, setTemplateChooserOpen] = useState(false);
  const [templateChoice, setTemplateChoice] = useState('');
  const [copyChoice, setCopyChoice] = useState('');
  const [copyPickerOpen, setCopyPickerOpen] = useState(false);
  const [copySources, setCopySources] = useState<WhitelistEntry[]>(whitelists);
  const [copySourcesLoading, setCopySourcesLoading] = useState(false);
  const [templateDetailsOpen, setTemplateDetailsOpen] = useState(false);
  const [templateConfirmOpen, setTemplateConfirmOpen] = useState(false);
  const [templateEditing, setTemplateEditing] = useState(false);
  const [metadataState, setMetadataState] = useState<'idle' | 'loading' | 'ready' | 'manual'>('idle');
  const [saving, setSaving] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [watchImpact, setWatchImpact] = useState<{ unique_handles: number; reused_watches: number; new_watches: number } | null>(null);
  const metadataSequence = useRef(0);
  const copySourcesSequence = useRef(0);
  const autoAppliedChain = useRef<string>('');
  const { toast } = useToast();

  const nativeSymbol = NATIVE_SYMBOLS[form.chain_id];
  const chainTemplates = templates.filter((item) => item.chain_id === form.chain_id);
  const defaultTemplate = chainTemplates.find((item) => item.is_default);
  const sameChainWhitelists = copySources.filter((item) => (
    item.chain_id === form.chain_id && item.id !== editing?.id
  ));
  const uniqueActors = useMemo(() => new Set([
    ...form.direct_source_actor_handles,
    ...form.relation_actor_handles,
  ].map(normalizeHandle)).size, [form.direct_source_actor_handles, form.relation_actor_handles]);
  const launchSourceCount = form.direct_sources.filter((item) => item.source_kind === 'launch').length;
  const ecosystemSourceCount = form.direct_sources.filter((item) => item.source_kind === 'ecosystem').length;
  const projectIdentityCount = form.project_accounts.filter((item) => item.usage === 'identity').length;
  const configDiffs = useMemo(
    () => configDiffLabels(form, configSource.baseline),
    [configSource.baseline, form],
  );
  const enabledRuleCount = Number(form.direct_source_rule_enabled) + Number(form.relation_rule_enabled);

  const asDraft = (): WhitelistDraftPayload => ({
    ...form,
    template_id: configSource.kind === 'template' ? configSource.id || null : null,
    budget_per_trade: form.budget_per_trade.trim() ? Number(form.budget_per_trade) : undefined,
    total_budget: form.total_budget.trim() ? Number(form.total_budget) : undefined,
    slippage: form.slippage.trim() ? Number(form.slippage) : undefined,
    max_repeat_buys: form.max_repeat_buys.trim() ? Number(form.max_repeat_buys) : undefined,
  });

  const applyTemplate = useCallback((template: WhitelistTemplate) => {
    setForm((current) => applyConfigSnapshot(current, template.template_snapshot));
    setConfigSource({
      kind: 'template',
      id: template.id,
      name: template.name,
      version: template.version,
      baseline: template.template_snapshot,
    });
    setTemplateChoice(template.id);
  }, []);

  const startTemplateEdit = (template: WhitelistTemplate) => {
    applyTemplate(template);
    setTemplateEditing(true);
    setTemplateChooserOpen(false);
    setTemplateDetailsOpen(true);
    setStep(2);
  };

  const cancelTemplateEdit = () => {
    if (configSource.baseline) {
      setForm((current) => applyConfigSnapshot(current, configSource.baseline!));
    }
    setTemplateEditing(false);
    setStep(1);
  };

  useEffect(() => {
    if (editing || autoAppliedChain.current === form.chain_id) return;
    const seededTemplate = seed?.chain_id === form.chain_id && seed.template_id
      ? chainTemplates.find((item) => item.id === seed.template_id)
      : null;
    const template = seededTemplate || defaultTemplate;
    if (!template && templates.length === 0) return;
    autoAppliedChain.current = form.chain_id;
    if (template) applyTemplate(template);
  }, [applyTemplate, chainTemplates, defaultTemplate, editing, form.chain_id, seed, templates.length]);

  const identityKey = identityHandles(form.project_accounts).join(',');
  useEffect(() => {
    if (!form.relation_rule_enabled
      || form.relation_target_policy !== 'all_selected_project_identities') return;
    const targets = identityHandles(form.project_accounts);
    const currentTargets = uniqueHandles(form.relation_target_handles);
    if (JSON.stringify(targets) === JSON.stringify(currentTargets)) return;
    setForm((current) => materializeConfigDraft({
      ...current,
      relation_target_handles: targets,
    }));
  }, [form.project_accounts, form.relation_rule_enabled, form.relation_target_handles, form.relation_target_policy, identityKey]);

  useEffect(() => {
    const address = form.contract_address.trim();
    const sequence = ++metadataSequence.current;
    if (address.length < 20) {
      setMetadataState('idle');
      return;
    }
    const timer = window.setTimeout(async () => {
      setMetadataState('loading');
      const response = await api.research.tokenMetadata(form.chain_id, address);
      if (metadataSequence.current !== sequence) return;
      if (!response.ok || !response.data) {
        setMetadataState('manual');
        return;
      }
      const metadata = response.data;
      setForm((current) => ({
        ...current,
        symbol: metadata.symbol || current.symbol,
        project_name: metadata.name || current.project_name,
        token_logo_url: metadata.logo_url,
        token_official_x_handle: metadata.official_x_handle,
        token_website_url: metadata.website_url,
        token_metadata_source: metadata.source,
        token_metadata_fetched_at: metadata.fetched_at,
      }));
      setMetadataState('ready');
    }, 500);
    return () => window.clearTimeout(timer);
  }, [form.chain_id, form.contract_address]);

  useEffect(() => {
    if (step !== 4) return;
    void api.whitelist.watchImpact({
      relations: form.relations,
      direct_sources: form.direct_sources.filter((source) => source.source_kind === 'ecosystem'),
    }).then((response) => setWatchImpact(response.ok && response.data ? response.data : null));
  }, [step, form.relations, form.direct_sources]);

  const applyCopy = (item: WhitelistEntry) => {
    const snapshot = snapshotFromWhitelist(item);
    const sourceId = String(item.id);
    setForm((current) => applyConfigSnapshot(current, snapshot));
    setConfigSource({
      kind: 'copy',
      id: sourceId,
      name: `复制 ${item.symbol || item.contract_address}`,
      baseline: snapshot,
    });
    setCopyChoice(sourceId);
    autoAppliedChain.current = form.chain_id;
  };

  const applyBlank = () => {
    setForm((current) => materializeConfigDraft({
      ...current,
      direct_sources: current.direct_sources.filter((item) => item.source_kind === 'launch'),
      relations: [],
      project_accounts: current.project_accounts.filter((item) => item.usage === 'identity'),
      direct_source_rule_enabled: false,
      direct_source_actor_handles: [],
      relation_rule_enabled: false,
      relation_actor_handles: [],
      relation_target_handles: [],
      relation_target_policy: 'manual',
      relation_event_types: [...DEFAULT_RELATION_EVENTS],
      direct_source_event_types: [...DEFAULT_DIRECT_EVENTS],
      budget_per_trade: '',
      total_budget: '',
      slippage: '10',
      allow_repeat_buy: false,
      max_repeat_buys: '1',
      exit_strategy: cloneStrategy(STRATEGY_PRESETS[0].value),
    }));
    setConfigSource({ kind: 'blank', name: '空白配置', baseline: null });
    setTemplateChoice('');
    setCopyChoice('');
    autoAppliedChain.current = form.chain_id;
  };

  const openTemplateChooser = () => {
    setTemplateChoice(configSource.kind === 'template'
      ? configSource.id || ''
      : defaultTemplate?.id || '');
    setCopyChoice(configSource.kind === 'copy' ? configSource.id || '' : '');
    setCopyPickerOpen(false);
    setTemplateChooserOpen(true);
  };

  const loadCopySources = async () => {
    const sequence = ++copySourcesSequence.current;
    setCopySourcesLoading(true);
    const loaded: WhitelistEntry[] = [];
    const pageSize = 100;
    let page = 1;
    let total = 1;

    while (loaded.length < total) {
      const response = await api.whitelist.list({
        chain_id: form.chain_id,
        page: String(page),
        pageSize: String(pageSize),
      });
      if (sequence !== copySourcesSequence.current) return;
      if (!response.ok) {
        setCopySourcesLoading(false);
        toast(response.error || '可复制白名单加载失败', 'error');
        return;
      }
      const rows = response.data || [];
      loaded.push(...rows);
      total = response.total ?? loaded.length;
      if (rows.length < pageSize) break;
      page += 1;
    }

    if (sequence !== copySourcesSequence.current) return;
    setCopySources(loaded);
    setCopySourcesLoading(false);
  };

  const toggleCopyPicker = () => {
    const next = !copyPickerOpen;
    setCopyPickerOpen(next);
    if (next) void loadCopySources();
  };

  const validateStep = (targetStep: number) => {
    if (targetStep > 1 && !form.contract_address.trim()) return '请先填写 CA';
    if (targetStep > 2 && form.direct_sources.length === 0 && form.relations.length === 0) {
      return '请至少配置一个 X 触发账号';
    }
    if (targetStep > 3) {
      const perTrade = Number(form.budget_per_trade);
      const total = Number(form.total_budget);
      if (!(perTrade > 0) || !(total > 0) || perTrade > total) return '请检查单笔金额与累计上限';
      if (!form.exit_strategy.legs.length || form.exit_strategy.legs.length > 10) {
        return '离场策略需要 1 至 10 条条件';
      }
    }
    return null;
  };

  const validateTemplate = () => {
    const perTrade = Number(form.budget_per_trade);
    const total = Number(form.total_budget);
    if (!(perTrade > 0) || !(total >= perTrade)) return '请先填写有效的资金配置';
    if (form.direct_source_rule_enabled && form.direct_source_actor_handles.length === 0) {
      return '已启用 CA 动态规则，但尚未选择生态账号';
    }
    if (form.relation_rule_enabled && form.relation_actor_handles.length === 0) {
      return '已启用互动规则，但尚未选择生态账号';
    }
    if (!form.direct_source_rule_enabled && !form.relation_rule_enabled) {
      return '完整链模板至少需要启用一类 X 触发规则';
    }
    return null;
  };

  const goToStep = (target: number) => {
    if (templateEditing) {
      setStep(Math.max(2, Math.min(3, target)));
      return;
    }
    const error = target > step ? validateStep(target) : null;
    if (error) return toast(error, 'error');
    setStep(Math.max(1, Math.min(4, target)));
  };

  const saveTemplate = async () => {
    const error = validateTemplate();
    if (error) return toast(error, 'error');
    const snapshot = snapshotFromDraft(form);
    const payload = {
      name: `${form.chain_id.toUpperCase()} 默认模板`,
      chain_id: form.chain_id,
      is_default: true,
      template_snapshot: snapshot,
    };
    setSavingTemplate(true);
    const response = defaultTemplate
      ? await api.whitelist.templates.update(defaultTemplate.id, payload)
      : await api.whitelist.templates.create(payload);
    setSavingTemplate(false);
    if (!response.ok || !response.data) return toast(response.error || '模板保存失败', 'error');
    setConfigSource({
      kind: 'template',
      id: response.data.id,
      name: response.data.name,
      version: response.data.version,
      baseline: snapshot,
    });
    setTemplateChoice(response.data.id);
    setTemplateConfirmOpen(false);
    if (templateEditing) {
      setTemplateEditing(false);
      setStep(1);
    }
    await onTemplatesChanged();
    toast(`${form.chain_id.toUpperCase()} 默认模板已更新`, 'success');
  };

  const handleSave = async () => {
    const error = validateStep(4);
    if (error) return toast(error, 'error');
    setSaving(true);
    const payload = asDraft();
    const response = editing
      ? await api.whitelist.update(editing.id, payload)
      : await api.whitelist.create(payload);
    setSaving(false);
    if (!response.ok) return toast(response.error || '白名单保存失败', 'error');
    if (response.meta?.merged_into_existing) {
      const count = Number(response.meta.added_relations || 0) + Number(response.meta.added_sources || 0);
      toast(count ? `已向现有白名单新增 ${count} 条触发规则，资金与策略保持不变` : '触发规则已存在，未重复添加', 'success');
    } else {
      toast(editing ? '白名单已更新' : '白名单已保存', 'success');
    }
    onSaved();
  };

  const handleChainChange = (chainId: ChainId) => {
    autoAppliedChain.current = '';
    setConfigSource({ kind: 'blank', name: '空白配置', baseline: null });
    setTemplateChoice('');
    setCopyChoice('');
    setTemplateDetailsOpen(false);
    setForm(emptyForm({ chain_id: chainId }));
  };

  const sourceStatus = configSource.kind === 'template'
    ? '已应用完整配置'
    : configSource.kind === 'copy' ? '已复制同链配置'
      : configSource.kind === 'current' ? '当前白名单草稿'
        : '当前未应用模板';
  const xSummary = enabledRuleCount
    ? `${uniqueActors} 个生态账号 · ${enabledRuleCount} 类规则`
    : 'X 触发待配置';
  const moneySummary = form.budget_per_trade && form.total_budget
    ? `单笔 ${form.budget_per_trade} ${nativeSymbol} · 累计 ${form.total_budget} ${nativeSymbol}`
    : '资金待配置';
  const templateActionLabel = defaultTemplate ? '更新链默认模板' : '设为链默认模板';
  const stepItems = [
    ['代币与模板', '链、CA、配置来源'],
    ['X 触发账号', '项目身份、生态行为'],
    ['资金与离场', '金额、次数、策略'],
    ['确认保存', 'Watch 影响、提交'],
  ];

  const selectedTemplate = chainTemplates.find((item) => item.id === templateChoice);
  const editableTemplate = configSource.kind === 'template'
    ? chainTemplates.find((item) => item.id === configSource.id) || defaultTemplate
    : defaultTemplate;
  const templateLayers = (templateChooserOpen || templateConfirmOpen) && createPortal(<>
    <button
      type="button"
      className="p164-layer-overlay"
      aria-label="关闭模板窗口"
      onClick={() => {
        setTemplateChooserOpen(false);
        setTemplateConfirmOpen(false);
      }}
    />
    {templateChooserOpen && <aside className="p164-template-drawer" role="dialog" aria-modal="true" aria-label={`选择 ${form.chain_id.toUpperCase()} 配置`}>
      <div className="p164-layer-head">
        <div><strong>选择 {form.chain_id.toUpperCase()} 配置</strong><span>只显示当前链可复用配置</span></div>
        <button type="button" className="p16-icon-button" title="关闭" aria-label="关闭模板选择" onClick={() => setTemplateChooserOpen(false)}><X size={16} /></button>
      </div>
      <div className="p164-template-drawer-body">
        <div className="p164-template-options">
          {chainTemplates.map((template) => {
            const selected = templateChoice === template.id;
            const snapshot = template.template_snapshot;
            return <button type="button" className={`p164-template-option ${selected ? 'selected' : ''}`} aria-pressed={selected} key={template.id} onClick={() => { setTemplateChoice(template.id); setCopyChoice(''); }}>
              <i><Check size={12} /></i>
              <div><span><strong>{template.name}</strong>{template.is_default && <em>默认</em>}</span><small>{templateActorCount(snapshot)} 个生态账号 · {snapshot.budget_per_trade}/{snapshot.total_budget} {nativeSymbol} · {strategySummary(snapshot.exit_strategy)}</small></div>
            </button>;
          })}
          {chainTemplates.length === 0 && <div className="p16-empty-line">当前链尚无模板，可使用现有配置创建默认模板</div>}
        </div>

        <section className="p164-alternate-source">
          <span>其他创建方式</span>
          <button type="button" onClick={toggleCopyPicker}><Copy size={16} />复制已有 {form.chain_id.toUpperCase()} 白名单配置</button>
          {copyPickerOpen && <div className="p164-copy-picker">
            <select className="input" value={copyChoice} disabled={copySourcesLoading} onChange={(event) => { setCopyChoice(event.target.value); setTemplateChoice(''); }}>
              <option value="">{copySourcesLoading ? '正在加载当前链白名单' : '选择白名单'}</option>
              {sameChainWhitelists.map((item) => <option value={String(item.id)} key={item.id}>{item.symbol || item.contract_address}</option>)}
            </select>
            <button type="button" className="btn btn-secondary" disabled={!copyChoice} onClick={() => {
              const item = sameChainWhitelists.find((entry) => String(entry.id) === copyChoice);
              if (!item) return;
              applyCopy(item);
              setTemplateChooserOpen(false);
            }}>应用</button>
          </div>}
          <button type="button" onClick={() => { applyBlank(); setTemplateChooserOpen(false); }}><FilePlus2 size={16} />从空白开始</button>
        </section>
      </div>
      <div className="p164-layer-foot">
        <button type="button" className="btn btn-secondary" onClick={() => setTemplateChooserOpen(false)}>取消</button>
        <button type="button" className="btn btn-secondary" disabled={!selectedTemplate} onClick={() => {
          if (selectedTemplate) startTemplateEdit(selectedTemplate);
        }}><Pencil size={16} />编辑所选</button>
        <button type="button" className="btn btn-primary" disabled={!templateChoice} onClick={() => {
          const template = chainTemplates.find((item) => item.id === templateChoice);
          if (!template) return;
          applyTemplate(template);
          autoAppliedChain.current = form.chain_id;
          setTemplateChooserOpen(false);
        }}><Check size={16} />应用所选</button>
      </div>
    </aside>}

    {templateConfirmOpen && <section className="p164-template-modal" role="dialog" aria-modal="true" aria-label={`${templateActionLabel}确认`}>
      <div className="p164-layer-head">
        <div><strong>{templateActionLabel}</strong><span>覆盖该链后续白名单的默认配置</span></div>
        <button type="button" className="p16-icon-button" title="关闭" aria-label="关闭模板确认" onClick={() => setTemplateConfirmOpen(false)}><X size={16} /></button>
      </div>
      <div className="p164-template-modal-body">
        <div><span>X 触发</span><strong>{xSummary}</strong></div>
        <div><span>资金与买入</span><strong>{form.budget_per_trade}/{form.total_budget} {nativeSymbol} · {form.max_repeat_buys} 次</strong></div>
        <div><span>离场策略</span><strong>{strategySummary(form.exit_strategy)}</strong></div>
        <p>不会保存当前 CA、项目名称、项目账号、关系 ID、Watch 状态、持仓或交易历史。</p>
      </div>
      <div className="p164-layer-foot">
        <button type="button" className="btn btn-secondary" onClick={() => setTemplateConfirmOpen(false)}>取消</button>
        <button type="button" className="btn btn-primary" disabled={savingTemplate} onClick={() => void saveTemplate()}><Save size={16} />{savingTemplate ? '更新中' : '确认更新'}</button>
      </div>
    </section>}
  </>, document.body);

  return (
    <div className="p16-workspace p162-known-workspace">
      <div className="p16-workspace-head">
        <div><button type="button" className="p16-back-link" onClick={templateEditing ? cancelTemplateEdit : onCancel}><ArrowLeft size={16} />{templateEditing ? '退出模板编辑' : '返回白名单'}</button><h2>{templateEditing ? `编辑 ${form.chain_id.toUpperCase()} 默认模板` : editing ? '编辑白名单' : '新增白名单'}</h2></div>
        {!templateEditing && <button type="button" className="btn btn-secondary" onClick={() => onOpenResearch(asDraft())}><Search size={16} />快速投研</button>}
      </div>

      <section className="p162-workspace-shell">
        <nav className={`p162-stepper ${templateEditing ? 'template-editing' : ''}`} aria-label={templateEditing ? '模板编辑步骤' : '创建步骤'}>
          {stepItems.map(([title, detail], index) => {
            const number = index + 1;
            if (templateEditing && number !== 2 && number !== 3) return null;
            const displayNumber = templateEditing ? number - 1 : number;
            const displayDetail = templateEditing && number === 2 ? '生态账号、事件类型' : detail;
            return <button type="button" key={title} className={`p162-step-button ${step === number ? 'active' : ''} ${step > number ? 'complete' : ''}`} onClick={() => goToStep(number)}><span>{step > number ? <Check size={14} /> : displayNumber}</span><div data-short={index === 0 ? '代币' : index === 1 ? 'X 账号' : index === 2 ? '资金' : '确认'}><strong>{title}</strong><small>{displayDetail}</small></div></button>;
          })}
        </nav>

        {templateEditing ? <div className="p164-template-edit-context">
          <div><Pencil size={17} /><span><strong>正在编辑 {configSource.name}</strong><small>仅保存 X 触发、资金、买入次数和离场策略</small></span></div>
          <button type="button" className="btn btn-primary" onClick={() => setTemplateConfirmOpen(true)}><Save size={16} />保存模板</button>
        </div> : <div className="p162-token-context">
          <div className="p162-token-summary">
            {form.token_logo_url ? <img src={form.token_logo_url} alt="" /> : <span>{(form.symbol || form.chain_id).slice(0, 1).toUpperCase()}</span>}
            <div><strong>{form.symbol || '待补全'}</strong><small>{form.chain_id.toUpperCase()} · {form.contract_address || '尚未填写 CA'}</small></div>
          </div>
          <div className="p164-context-controls">
            <div className="p164-context-template"><span>当前配置</span><strong>{configSource.name}</strong></div>
            <button type="button" className="btn btn-secondary" onClick={openTemplateChooser}><Layers3 size={15} />更换</button>
            <button type="button" className="btn btn-secondary" title="将当前 X、资金和离场配置保存为链默认模板" onClick={() => setTemplateConfirmOpen(true)}><Save size={15} />保存模板</button>
            <div className="p162-context-stats"><span><strong>{projectIdentityCount}</strong>项目身份</span><span><strong>{uniqueActors}</strong>唯一 Watch</span></div>
          </div>
        </div>}

        <main className="p16-step-main p162-step-main">
          <div className="p16-step-content">
            {step === 1 && <>
              <div className="p16-step-title"><div><span>步骤 1 / 4</span><h3>选择代币</h3></div><em className={metadataState}>{metadataState === 'loading' ? 'GMGN 查询中' : metadataState === 'ready' ? 'GMGN 已补全' : metadataState === 'manual' ? '可手动填写' : '等待 CA'}</em></div>
              <div className="p16-form-grid token">
                <label><span>链</span><select className="input" value={form.chain_id} disabled={Boolean(editing)} onChange={(event) => handleChainChange(event.target.value as ChainId)}>{CHAINS.map((chain) => <option key={chain} value={chain}>{chain.toUpperCase()}</option>)}</select></label>
                <label className="wide"><span>合约地址 (CA)</span><input className="input font-mono" value={form.contract_address} disabled={Boolean(editing)} onChange={(event) => setForm((current) => ({ ...current, contract_address: event.target.value, symbol: '', project_name: '', token_logo_url: null, token_official_x_handle: null, token_website_url: null, token_metadata_source: null, token_metadata_fetched_at: null, candidates: [], project_accounts: [], relation_target_handles: [], relations: [] }))} placeholder="0x... 或 Base58" /></label>
                <label><span>代币符号</span><input className="input" value={form.symbol} onChange={(event) => setForm((current) => ({ ...current, symbol: event.target.value.toUpperCase() }))} placeholder="自动补全或手动填写" /></label>
                <label><span>项目名称</span><input className="input" value={form.project_name} onChange={(event) => setForm((current) => ({ ...current, project_name: event.target.value }))} placeholder="自动补全或手动填写" /></label>
              </div>
              {(form.symbol || form.token_logo_url) && <div className="p16-token-strip">{form.token_logo_url ? <img src={form.token_logo_url} alt="" /> : <span>{form.symbol.slice(0, 1)}</span>}<div><strong>{form.symbol || '未命名'}</strong><small>{form.project_name || '项目名称待确认'}{form.token_official_x_handle ? ` · @${form.token_official_x_handle}` : ''}</small></div></div>}

              <section className={`p164-template-strip ${configSource.kind === 'blank' ? 'empty' : ''}`}>
                <div className="p164-template-strip-main">
                  <i><Layers3 size={17} /></i>
                  <div className="p164-template-name"><strong>{configSource.name}</strong><span>{sourceStatus}</span></div>
                  <div className="p164-template-summary"><span>{xSummary}</span><span>{moneySummary}</span><span>{strategySummary(form.exit_strategy)}</span></div>
                  <div className="p164-template-actions"><button type="button" onClick={() => setTemplateDetailsOpen((value) => !value)}>{templateDetailsOpen ? '收起' : '查看'}</button>{editableTemplate && <button type="button" title="编辑当前链默认模板" onClick={() => startTemplateEdit(editableTemplate)}><Pencil size={12} />编辑</button>}<button type="button" onClick={openTemplateChooser}>更换</button></div>
                </div>
                {templateDetailsOpen && <div className="p164-template-details">
                  <div><span>X 触发配置</span><strong>{xSummary}</strong></div>
                  <div><span>资金与买入</span><strong>{moneySummary} · 最多 {form.max_repeat_buys} 次</strong></div>
                  <div><span>离场策略</span><strong>{strategySummary(form.exit_strategy)}</strong></div>
                </div>}
              </section>
            </>}

            {step === 2 && <>
              <div className="p16-step-title"><div><span>{templateEditing ? '模板 1 / 2' : '步骤 2 / 4'}</span><h3>配置 X 账号</h3></div><em>{uniqueActors} 个唯一 Watch 账号</em></div>
              {configSource.kind === 'template' && <div className="p164-template-origin"><Layers3 size={15} /><span>X 触发已从 {configSource.name} 预填</span></div>}
              <AccountRulesStep
                templateMode={templateEditing}
                chainId={form.chain_id}
                directSources={form.direct_sources}
                relations={form.relations}
                projectAccounts={form.project_accounts}
                candidates={form.candidates}
                kolAccounts={kolAccounts}
                directRuleEnabled={form.direct_source_rule_enabled}
                directActorHandles={form.direct_source_actor_handles}
                relationRuleEnabled={form.relation_rule_enabled}
                relationActorHandles={form.relation_actor_handles}
                relationTargetHandles={form.relation_target_handles}
                directEventTypes={form.direct_source_event_types}
                relationEventTypes={form.relation_event_types}
                onDirectRuleEnabledChange={(direct_source_rule_enabled) => setForm((current) => ({ ...current, direct_source_rule_enabled }))}
                onDirectActorHandlesChange={(direct_source_actor_handles) => setForm((current) => ({ ...current, direct_source_actor_handles }))}
                onRelationRuleEnabledChange={(relation_rule_enabled) => setForm((current) => ({ ...current, relation_rule_enabled }))}
                onRelationActorHandlesChange={(relation_actor_handles) => setForm((current) => ({ ...current, relation_actor_handles }))}
                onRelationTargetHandlesChange={(relation_target_handles) => setForm((current) => ({ ...current, relation_target_handles }))}
                onRelationTargetPolicyChange={(relation_target_policy) => setForm((current) => ({ ...current, relation_target_policy }))}
                onDirectSourcesChange={(direct_sources) => setForm((current) => ({ ...current, direct_sources }))}
                onRelationsChange={(relations) => setForm((current) => ({ ...current, relations }))}
                onProjectAccountsChange={(project_accounts) => setForm((current) => ({ ...current, project_accounts }))}
                onCandidatesChange={(candidates) => setForm((current) => ({ ...current, candidates }))}
                onDirectEventTypesChange={(direct_source_event_types) => setForm((current) => ({ ...current, direct_source_event_types }))}
                onRelationEventTypesChange={(relation_event_types) => setForm((current) => ({ ...current, relation_event_types }))}
                onOpenResearch={() => onOpenResearch(asDraft())}
                onError={(message) => toast(message, 'error')}
              />
            </>}

            {step === 3 && <>
              <div className="p16-step-title">
                <div><span>{templateEditing ? '模板 2 / 2' : '步骤 3 / 4'}</span><h3>设置资金与离场策略</h3></div>
                {configSource.baseline && configDiffs.length === 0
                  ? <em className="ready"><Check size={14} />与配置来源一致</em>
                  : !configSource.baseline && <em>当前配置尚未保存为模板</em>}
              </div>
              {configDiffs.length > 0 && <div className="p164-template-change-bar">
                <div><AlertCircle size={17} /><span><strong>当前白名单已修改：{configDiffs.join('、')}</strong><small>本次修改默认只影响当前 CA，不会自动改动链模板</small></span></div>
                <div><button type="button" className="btn btn-secondary" onClick={() => configSource.baseline && setForm((current) => applyConfigSnapshot(current, configSource.baseline!))}><RotateCcw size={15} />恢复来源配置</button></div>
              </div>}
              <div className="p16-form-grid money">
                <label><span>单笔金额 ({nativeSymbol})</span><input className="input" type="number" min="0.000001" step="0.000001" value={form.budget_per_trade} onChange={(event) => setForm((current) => ({ ...current, budget_per_trade: event.target.value }))} /></label>
                <label><span>{templateEditing ? '每个 CA 累计上限' : '该 CA 累计上限'} ({nativeSymbol})</span><input className="input" type="number" min="0.000001" step="0.000001" value={form.total_budget} onChange={(event) => setForm((current) => ({ ...current, total_budget: event.target.value }))} /></label>
                <label><span>滑点 %</span><input className="input" type="number" min="0.01" max="100" value={form.slippage} onChange={(event) => setForm((current) => ({ ...current, slippage: event.target.value }))} /></label>
                <label className="p16-repeat-field"><span>买入次数</span><div><label><input type="checkbox" checked={form.allow_repeat_buy} onChange={(event) => setForm((current) => ({ ...current, allow_repeat_buy: event.target.checked, max_repeat_buys: event.target.checked ? current.max_repeat_buys : '1' }))} />允许重复买入</label><input className="input" type="number" min="1" disabled={!form.allow_repeat_buy} value={form.max_repeat_buys} onChange={(event) => setForm((current) => ({ ...current, max_repeat_buys: event.target.value }))} /></div></label>
              </div>
              <section className="p16-inline-section"><div className="p16-section-heading"><div><h3>离场策略</h3><p>条件单由后端统一编译，最多 10 条。</p></div></div><StrategyEditor value={form.exit_strategy} saveHint={templateEditing ? '修改仅保留在当前模板草稿，点击“保存模板”后生效' : undefined} onChange={(exit_strategy) => setForm((current) => ({ ...current, exit_strategy }))} /></section>
            </>}

            {step === 4 && <>
              <div className="p16-step-title"><div><span>步骤 4 / 4</span><h3>确认并保存</h3></div><em className="ready">可以保存</em></div>
              <div className="p16-review-list">
                <div><span>代币</span><strong>{form.chain_id.toUpperCase()} · {form.symbol || form.contract_address}</strong></div>
                <div><span>配置来源</span><strong>{configSource.name}{configSource.version ? ` · v${configSource.version}` : ''}{configDiffs.length ? ' · 当前 CA 已修改' : ''}</strong></div>
                <div><span>资金</span><strong>{form.budget_per_trade} {nativeSymbol} / 累计 {form.total_budget} {nativeSymbol}</strong></div>
                <div><span>离场</span><strong>{strategySummary(form.exit_strategy)}</strong></div>
                <div><span>项目账号身份</span><strong>{projectIdentityCount} 个</strong></div>
                <div><span>生态账号 CA 动态</span><strong>{ecosystemSourceCount} 个</strong></div>
                <div><span>生态互动关系</span><strong>{form.relations.length} 条</strong></div>
                {launchSourceCount > 0 && <div><span>首发来源</span><strong>{launchSourceCount} 个，只读审计</strong></div>}
                <div><span>6551 Watch</span><strong>{watchImpact ? `${watchImpact.unique_handles} 个唯一账号；复用 ${watchImpact.reused_watches}，新增 ${watchImpact.new_watches}` : '正在计算影响'}</strong></div>
              </div>
              <div className="p16-save-note">保存成功后才会通过 Outbox 同步 6551 Watch；模板保存、模板应用和研究草稿不会修改远端 Watch。</div>
            </>}
          </div>

          {templateEditing
            ? <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={step === 2 ? cancelTemplateEdit : () => goToStep(2)}>{step === 2 ? '取消编辑' : '上一步'}</button>{step === 2 ? <button type="button" className="btn btn-primary" onClick={() => goToStep(3)}>下一步<ArrowRight size={16} /></button> : <button type="button" className="btn btn-primary" onClick={() => setTemplateConfirmOpen(true)}><Save size={16} />保存模板</button>}</div>
            : <div className="p16-step-actions"><button type="button" className="btn btn-secondary" onClick={() => step === 1 ? onCancel() : goToStep(step - 1)}>{step === 1 ? '取消' : '上一步'}</button>{step < 4 ? <button type="button" className="btn btn-primary" onClick={() => goToStep(step + 1)}>下一步<ArrowRight size={16} /></button> : <button type="button" className="btn btn-primary" disabled={saving} onClick={handleSave}><Save size={16} />{saving ? '保存中' : '保存白名单'}</button>}</div>}
        </main>
      </section>
      {templateLayers}
    </div>
  );
}
