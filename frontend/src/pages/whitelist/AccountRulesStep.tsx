import { ArrowRight, AtSign, Check, Info, Plus, Search, Trash2, Users, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ActivityType,
  ChainId,
  KolAccount,
  ResearchCandidate,
  XDirectSource,
  XSignalRelation,
  WhitelistProjectAccount,
} from '../../lib/types';
import { eventTypeLabel, researchRoleLabel } from '../../lib/display-labels';
import KolCategoryBar from '../kol/KolCategoryBar';
import {
  KOL_ECOSYSTEM_CATEGORIES,
  accountMatchesCategory,
  customCategoryId,
  customCategoryKey,
  ecosystemCategoryKey,
  type KolCategoryKey,
} from '../kol/kol-category';

const DIRECT_EVENTS: Array<Exclude<ActivityType, 'follow' | 'unfollow'>> = ['tweet', 'retweet', 'quote', 'reply'];
const RELATION_EVENTS: Array<Exclude<ActivityType, 'tweet' | 'unfollow'>> = ['retweet', 'quote', 'reply', 'follow'];
const ECOSYSTEM_LABELS: Record<string, string> = {
  sol: 'SOL',
  bsc: 'BSC',
  base: 'BASE',
  eth: 'ETH',
  robinhood: 'ROBINHOOD',
  cross_chain: '跨链',
};

type PickerKind = 'ecosystem' | 'actor' | 'target';

function normalizeHandle(value: string) {
  return value.trim()
    .replace(/^https?:\/\/(?:www\.)?(?:x\.com|twitter\.com)\//i, '')
    .split(/[/?#]/)[0]
    .replace(/^@+/, '')
    .toLowerCase();
}

function validHandle(value: string) {
  return /^[a-z0-9_]{1,15}$/.test(value);
}

function sortAccounts(accounts: KolAccount[], chainId: ChainId) {
  const priority = (account: KolAccount) => {
    if (account.chain_ids?.includes(chainId)) return 0;
    if (account.chain_ids?.includes('cross_chain')) return 1;
    if (!account.chain_ids?.length) return 3;
    return 2;
  };
  return [...accounts].sort((left, right) => (
    priority(left) - priority(right)
    || Number(right.weight || 0) - Number(left.weight || 0)
    || normalizeHandle(left.x_handle).localeCompare(normalizeHandle(right.x_handle))
  ));
}

function accountTagText(account: KolAccount) {
  return account.chain_ids?.length
    ? account.chain_ids.map((tag) => ECOSYSTEM_LABELS[tag] || tag).join(' / ')
    : '未分类';
}

function usePopoverPosition(
  open: boolean,
  anchorRef: React.RefObject<HTMLDivElement | null>,
  maxWidth = 480,
) {
  const [position, setPosition] = useState<React.CSSProperties>({});
  useLayoutEffect(() => {
    if (!open) return undefined;
    const updatePosition = () => {
      const rect = anchorRef.current?.getBoundingClientRect();
      if (!rect) return;
      const viewportMargin = 12;
      const width = Math.min(maxWidth, window.innerWidth - viewportMargin * 2);
      const left = Math.max(
        viewportMargin,
        Math.min(rect.left, window.innerWidth - width - viewportMargin),
      );
      const spaceBelow = window.innerHeight - rect.bottom - 6;
      const spaceAbove = rect.top - 6;
      const placeBelow = spaceBelow >= 300 || spaceBelow >= spaceAbove;
      const available = Math.max(180, Math.min(380, placeBelow ? spaceBelow : spaceAbove));
      setPosition({
        left,
        width,
        maxHeight: available,
        ...(placeBelow ? { top: rect.bottom + 4 } : { bottom: window.innerHeight - rect.top + 4 }),
      });
    };
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [anchorRef, maxWidth, open]);
  return position;
}

interface AccountPickerProps {
  accounts: KolAccount[];
  chainId: ChainId;
  value: string;
  selectedHandles: string[];
  disabled?: boolean;
  placeholder?: string;
  open: boolean;
  onChange: (value: string) => void;
  onSelectedHandlesChange: (handles: string[]) => void;
  onOpen: () => void;
  onClose: () => void;
}

function AccountPicker({
  accounts,
  chainId,
  value,
  selectedHandles,
  disabled = false,
  placeholder = '搜索账号或输入 @handle',
  open,
  onChange,
  onSelectedHandlesChange,
  onOpen,
  onClose,
}: AccountPickerProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const [activeCategoryKey, setActiveCategoryKey] = useState<KolCategoryKey>('all');
  const position = usePopoverPosition(open, anchorRef);
  const enabledAccounts = useMemo(
    () => sortAccounts(accounts.filter((item) => item.enabled !== false), chainId),
    [accounts, chainId],
  );
  const categoryLabels = useMemo(() => {
    const labels = new Map<string, { id: string; name: string; account_count: number }>();
    enabledAccounts.forEach((account) => (account.custom_labels || []).forEach((label) => {
      const current = labels.get(label.id);
      labels.set(label.id, { id: label.id, name: label.name, account_count: (current?.account_count || 0) + 1 });
    }));
    return [...labels.values()].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  }, [enabledAccounts]);
  const categoryCounts = useMemo(() => {
    const counts: Partial<Record<KolCategoryKey, number>> = { all: enabledAccounts.length };
    KOL_ECOSYSTEM_CATEGORIES.forEach((category) => {
      const key = ecosystemCategoryKey(category.value);
      counts[key] = enabledAccounts.filter((account) => accountMatchesCategory(account, key)).length;
    });
    categoryLabels.forEach((label) => { counts[customCategoryKey(label.id)] = label.account_count; });
    return counts;
  }, [categoryLabels, enabledAccounts]);
  const needle = normalizeHandle(value);
  const matches = enabledAccounts.filter((item) => {
    const matchesSearch = !needle || [
      normalizeHandle(item.x_handle),
      String(item.display_name || '').toLowerCase(),
      ...(item.chain_ids || []),
      ...(item.custom_labels || []).map((label) => label.name.toLowerCase()),
    ].some((part) => part.includes(needle));
    return matchesSearch && accountMatchesCategory(item, activeCategoryKey);
  });
  const selectedSet = new Set(selectedHandles.map(normalizeHandle));
  const selectableMatches = matches.map((item) => normalizeHandle(item.x_handle));
  const allVisibleSelected = selectableMatches.length > 0
    && selectableMatches.every((handle) => selectedSet.has(handle));

  const toggleHandle = (handle: string) => {
    const normalized = normalizeHandle(handle);
    onSelectedHandlesChange(
      selectedSet.has(normalized)
        ? selectedHandles.filter((item) => normalizeHandle(item) !== normalized)
        : [...selectedHandles, normalized],
    );
  };

  const toggleVisible = () => {
    const visibleSet = new Set(selectableMatches);
    if (allVisibleSelected) {
      onSelectedHandlesChange(selectedHandles.filter((item) => !visibleSet.has(normalizeHandle(item))));
      return;
    }
    onSelectedHandlesChange([...new Set([
      ...selectedHandles.map(normalizeHandle),
      ...selectableMatches,
    ])]);
  };

  useEffect(() => {
    const labelId = customCategoryId(activeCategoryKey);
    if (labelId && !categoryLabels.some((label) => label.id === labelId)) setActiveCategoryKey('all');
  }, [activeCategoryKey, categoryLabels]);

  useEffect(() => {
    if (!open) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, open]);

  return (
    <div className="p16-account-picker" ref={anchorRef}>
      <input
        className="input"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onOpen}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          onClose();
          event.currentTarget.blur();
        }}
        placeholder={placeholder}
        aria-expanded={open && !disabled}
      />
      {open && createPortal(
        <div className="p16-account-suggestions" style={position}>
          <div className="p16-account-suggestions-head">
            <span><strong>KOL 账号库</strong> · {matches.length} 个结果 · 已选 {selectedHandles.length}</span>
            <button
              type="button"
              className="p16-icon-button"
              aria-label="关闭账号建议"
              title="关闭账号建议"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClose}
            ><X size={14} /></button>
          </div>
          <KolCategoryBar value={activeCategoryKey} labels={categoryLabels} counts={categoryCounts} onChange={setActiveCategoryKey} variant="picker" preserveFocus />
          <div className="p162-account-selection-bar">
            <button
              type="button"
              className={allVisibleSelected ? 'active' : ''}
              disabled={selectableMatches.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleVisible}
            >
              <span><Check size={12} /></span>
              {allVisibleSelected ? '取消当前全选' : `全选当前结果 (${selectableMatches.length})`}
            </button>
          </div>
          <div className="p162-account-list">
            {matches.map((item) => {
              const handle = normalizeHandle(item.x_handle);
              const selected = selectedSet.has(handle);
              return (
                <button
                  type="button"
                  className={`p16-account-suggestion-option ${selected ? 'selected' : ''}`}
                  key={item.id}
                  aria-pressed={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggleHandle(handle)}
                >
                  <span className={`p162-account-check ${selected ? 'selected' : ''}`}><Check size={12} /></span>
                  <strong>@{handle}</strong>
                  <span className="p162-account-meta"><span>{item.display_name || '未命名'}</span><i className={!item.chain_ids?.length ? 'unclassified' : ''}>{accountTagText(item)}</i></span>
                  <em>权重 {item.weight}</em>
                </button>
              );
            })}
            {matches.length === 0 && <span className="p162-account-empty">当前分类没有匹配账号</span>}
          </div>
          <div className="p162-account-foot">
            <span>{selectedHandles.length > 0 ? `已选择 ${selectedHandles.length} 个账号` : '尚未选择账号'}</span>
            <div>
              <button type="button" disabled={selectedHandles.length === 0} onClick={() => onSelectedHandlesChange([])}>清空</button>
              <button type="button" className="primary" onClick={onClose}>完成</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface ProjectTargetOption {
  handle: string;
  role: string;
  summary: string;
}

interface ProjectTargetPickerProps {
  accounts: ProjectTargetOption[];
  value: string;
  selectedHandles: string[];
  open: boolean;
  onChange: (value: string) => void;
  onSelectedHandlesChange: (handles: string[]) => void;
  onOpen: () => void;
  onClose: () => void;
}

function ProjectTargetPicker({
  accounts,
  value,
  selectedHandles,
  open,
  onChange,
  onSelectedHandlesChange,
  onOpen,
  onClose,
}: ProjectTargetPickerProps) {
  const anchorRef = useRef<HTMLDivElement>(null);
  const position = usePopoverPosition(open, anchorRef);
  const needle = normalizeHandle(value);
  const matches = accounts.filter((item) => !needle || [
    item.handle,
    item.role,
    item.summary,
  ].some((part) => part.toLowerCase().includes(needle)));
  const selectedSet = new Set(selectedHandles.map(normalizeHandle));
  const visibleHandles = matches.map((item) => item.handle);
  const allVisibleSelected = visibleHandles.length > 0
    && visibleHandles.every((handle) => selectedSet.has(handle));

  const toggleHandle = (handle: string) => {
    onSelectedHandlesChange(
      selectedSet.has(handle)
        ? selectedHandles.filter((item) => normalizeHandle(item) !== handle)
        : [...selectedHandles, handle],
    );
  };

  const toggleVisible = () => {
    const visibleSet = new Set(visibleHandles);
    if (allVisibleSelected) {
      onSelectedHandlesChange(selectedHandles.filter(
        (item) => !visibleSet.has(normalizeHandle(item)),
      ));
      return;
    }
    onSelectedHandlesChange([...new Set([
      ...selectedHandles.map(normalizeHandle),
      ...visibleHandles,
    ])]);
  };

  return (
    <div className="p16-account-picker" ref={anchorRef}>
      <input
        className="input"
        value={value}
        disabled={accounts.length === 0}
        onChange={(event) => onChange(event.target.value)}
        onFocus={onOpen}
        onClick={onOpen}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          onClose();
          event.currentTarget.blur();
        }}
        placeholder={accounts.length ? '搜索项目账号' : '请先保留项目身份'}
        aria-expanded={open && accounts.length > 0}
      />
      {open && accounts.length > 0 && createPortal(
        <div className="p16-account-suggestions" style={position}>
          <div className="p16-account-suggestions-head">
            <span><strong>项目账号</strong> · {matches.length} 个结果 · 已选 {selectedHandles.length}</span>
            <button
              type="button"
              className="p16-icon-button"
              aria-label="关闭项目账号选择"
              title="关闭项目账号选择"
              onMouseDown={(event) => event.preventDefault()}
              onClick={onClose}
            ><X size={14} /></button>
          </div>
          <div className="p162-account-selection-bar">
            <button
              type="button"
              className={allVisibleSelected ? 'active' : ''}
              disabled={visibleHandles.length === 0}
              onMouseDown={(event) => event.preventDefault()}
              onClick={toggleVisible}
            >
              <span><Check size={12} /></span>
              {allVisibleSelected ? '取消当前全选' : `全选当前结果 (${visibleHandles.length})`}
            </button>
          </div>
          <div className="p162-account-list">
            {matches.map((item) => {
              const selected = selectedSet.has(item.handle);
              return (
                <button
                  type="button"
                  className={`p16-account-suggestion-option p163-target-option ${selected ? 'selected' : ''}`}
                  key={item.handle}
                  aria-pressed={selected}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => toggleHandle(item.handle)}
                >
                  <span className={`p162-account-check ${selected ? 'selected' : ''}`}><Check size={12} /></span>
                  <strong>@{item.handle}</strong>
                  <span className="p163-target-meta"><i>{item.role}</i><small>{item.summary || '已保留项目身份'}</small></span>
                </button>
              );
            })}
            {matches.length === 0 && <span className="p162-account-empty">没有匹配项目账号</span>}
          </div>
          <div className="p162-account-foot">
            <span>{selectedHandles.length > 0 ? `已选择 ${selectedHandles.length} 个项目账号` : '尚未选择项目账号'}</span>
            <div>
              <button type="button" disabled={selectedHandles.length === 0} onClick={() => onSelectedHandlesChange([])}>清空</button>
              <button type="button" className="primary" onClick={onClose}>完成</button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

interface Props {
  templateMode?: boolean;
  chainId: ChainId;
  directSources: XDirectSource[];
  relations: XSignalRelation[];
  projectAccounts: WhitelistProjectAccount[];
  candidates?: ResearchCandidate[];
  kolAccounts: KolAccount[];
  directRuleEnabled: boolean;
  directActorHandles: string[];
  relationRuleEnabled: boolean;
  relationActorHandles: string[];
  relationTargetHandles: string[];
  directEventTypes: XDirectSource['event_types'];
  relationEventTypes: XSignalRelation['event_types'];
  onDirectRuleEnabledChange: (enabled: boolean) => void;
  onDirectActorHandlesChange: (handles: string[]) => void;
  onRelationRuleEnabledChange: (enabled: boolean) => void;
  onRelationActorHandlesChange: (handles: string[]) => void;
  onRelationTargetHandlesChange: (handles: string[]) => void;
  onRelationTargetPolicyChange: (policy: 'all_selected_project_identities' | 'manual') => void;
  onDirectSourcesChange: (items: XDirectSource[]) => void;
  onRelationsChange: (items: XSignalRelation[]) => void;
  onProjectAccountsChange: (items: WhitelistProjectAccount[]) => void;
  onCandidatesChange: (items: ResearchCandidate[]) => void;
  onDirectEventTypesChange: (items: XDirectSource['event_types']) => void;
  onRelationEventTypesChange: (items: XSignalRelation['event_types']) => void;
  onOpenResearch: () => void;
  onError: (message: string) => void;
}

export default function AccountRulesStep({
  templateMode = false,
  chainId,
  directSources,
  relations,
  projectAccounts,
  candidates = [],
  kolAccounts,
  directRuleEnabled,
  directActorHandles,
  relationRuleEnabled,
  relationActorHandles,
  relationTargetHandles,
  directEventTypes,
  relationEventTypes,
  onDirectRuleEnabledChange,
  onDirectActorHandlesChange,
  onRelationRuleEnabledChange,
  onRelationActorHandlesChange,
  onRelationTargetHandlesChange,
  onRelationTargetPolicyChange,
  onDirectSourcesChange,
  onRelationsChange,
  onProjectAccountsChange,
  onCandidatesChange,
  onDirectEventTypesChange,
  onRelationEventTypesChange,
  onOpenResearch,
  onError,
}: Props) {
  const [identityInput, setIdentityInput] = useState('');
  const [ecosystemInput, setEcosystemInput] = useState('');
  const [actorInput, setActorInput] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [activeSuggestions, setActiveSuggestions] = useState<PickerKind | null>(null);
  const [activeIdentityHandle, setActiveIdentityHandle] = useState<string | null>(null);

  useEffect(() => {
    if (!activeSuggestions) return undefined;
    const closeOnOutsideClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest('.p16-account-picker, .p16-account-suggestions')) {
        setActiveSuggestions(null);
      }
    };
    document.addEventListener('mousedown', closeOnOutsideClick);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick);
  }, [activeSuggestions]);

  useEffect(() => {
    if (!activeIdentityHandle) return undefined;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setActiveIdentityHandle(null);
    };
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [activeIdentityHandle]);

  const ecosystemSources = directSources.filter((item) => item.source_kind === 'ecosystem');
  const projectHandles = useMemo(() => [...new Set([
    ...projectAccounts
      .filter((item) => item.usage === 'identity' || item.usage === 'interaction_target')
      .map((item) => normalizeHandle(item.handle)),
    ...relations.map((item) => normalizeHandle(item.target_x_handle)),
  ].filter(validHandle))], [projectAccounts, relations]);
  const ecosystemHandles = [...new Set(directActorHandles.map(normalizeHandle).filter(validHandle))];
  const relationActorSelection = [...new Set(relationActorHandles.map(normalizeHandle).filter(validHandle))];
  const relationTargetSelection = [...new Set(relationTargetHandles.map(normalizeHandle).filter(validHandle))];

  useEffect(() => {
    setEcosystemInput('');
    setActorInput('');
    setTargetSearch('');
    setActiveSuggestions(null);
  }, [chainId]);

  const toggleEvent = <T extends string>(current: T[], event: T, allowed: T[]) => (
    (Array.isArray(current) ? current : []).includes(event)
      ? current.length === 1 ? current : current.filter((item) => item !== event)
      : allowed.filter((item) => [...(Array.isArray(current) ? current : []), event].includes(item))
  );

  const candidateEvidenceSnapshot = (candidate: ResearchCandidate) => ({
    source: candidate.source,
    display_name: candidate.display_name,
    role: candidate.role,
    organization: candidate.organization,
    association: candidate.association || '',
    confidence: candidate.confidence,
    verified: candidate.verified,
    evidence: candidate.evidence,
  });

  const candidateSummary = (candidate: ResearchCandidate) => [...new Set([
    candidate.display_name,
    candidate.association,
  ].map((item) => String(item || '').trim()).filter(Boolean))].join(' · ');

  const accountSummary = (account: WhitelistProjectAccount) => {
    const snapshot = account.evidence_snapshot || {};
    const candidate = candidates.find((item) => normalizeHandle(item.handle) === normalizeHandle(account.handle));
    return [...new Set([
      typeof snapshot.display_name === 'string' ? snapshot.display_name : candidate?.display_name || '',
      typeof snapshot.association === 'string' ? snapshot.association : candidate?.association || '',
    ].map((item) => item.trim()).filter(Boolean))].join(' · ');
  };

  const projectTargetOptions: ProjectTargetOption[] = projectHandles.map((handle) => {
    const candidate = candidates.find((item) => normalizeHandle(item.handle) === handle);
    const account = projectAccounts.find((item) => (
      normalizeHandle(item.handle) === handle && item.usage === 'identity'
    )) || projectAccounts.find((item) => normalizeHandle(item.handle) === handle);
    return {
      handle,
      role: researchRoleLabel(candidate?.role || account?.role || 'project'),
      summary: candidate ? candidateSummary(candidate) : account ? accountSummary(account) : '',
    };
  });

  const expectedRelationCount = relationTargetSelection.reduce((count, target) => (
    count + relationActorSelection.filter((actor) => actor !== target).length
  ), 0);
  const relationPairSet = new Set(relations.map((item) => (
    `${normalizeHandle(item.actor_handle)}:${normalizeHandle(item.target_x_handle)}`
  )));
  const matrixComplete = expectedRelationCount === relations.length
    && relationActorSelection.every((actor) => relationTargetSelection.every(
      (target) => actor === target || relationPairSet.has(`${actor}:${target}`),
    ));
  const relationGroups = relationTargetSelection.map((target) => {
    const option = projectTargetOptions.find((item) => item.handle === target);
    const actors = relations
      .filter((item) => normalizeHandle(item.target_x_handle) === target)
      .map((item) => normalizeHandle(item.actor_handle));
    return { target, actors, option };
  });

  const upsertProjectAccount = (
    handle: string,
    usage: WhitelistProjectAccount['usage'],
    candidate?: ResearchCandidate,
  ) => {
    const accounts = new Map(projectAccounts.map((item) => [`${normalizeHandle(item.handle)}:${item.usage}`, item]));
    accounts.set(`${handle}:${usage}`, {
      handle,
      role: candidate?.role || 'project',
      usage,
      evidence_snapshot: candidate ? candidateEvidenceSnapshot(candidate) : {},
    });
    onProjectAccountsChange([...accounts.values()]);
  };

  const replaceEcosystemSources = (handles: string[]) => {
    const selected = [...new Set(handles.map(normalizeHandle).filter(validHandle))];
    const existing = new Map(ecosystemSources.map((item) => [normalizeHandle(item.actor_handle), item]));
    const next = directSources.filter((item) => item.source_kind !== 'ecosystem');
    selected.forEach((handle) => {
      const normalized = normalizeHandle(handle);
      next.push(existing.get(normalized) || {
        actor_handle: normalized,
        event_types: [...directEventTypes],
        match_mode: 'ca_only',
        source_kind: 'ecosystem',
        role: 'ecosystem',
      });
    });
    onDirectActorHandlesChange(selected);
    onDirectSourcesChange(next);
  };

  const addSource = () => {
    const handle = normalizeHandle(ecosystemInput);
    if (!validHandle(handle)) return onError('请填写有效的 X 账号');
    replaceEcosystemSources([...ecosystemHandles, handle]);
    setEcosystemInput('');
    setActiveSuggestions(null);
  };

  const removeSource = (handle: string) => {
    replaceEcosystemSources(ecosystemHandles.filter(
      (item) => item !== normalizeHandle(handle),
    ));
  };

  const addIdentityInput = () => {
    const handle = normalizeHandle(identityInput);
    if (!validHandle(handle)) return onError('请填写有效的项目 X 账号');
    upsertProjectAccount(handle, 'identity');
    setIdentityInput('');
  };

  const removeIdentity = (handle: string) => {
    onProjectAccountsChange(projectAccounts.filter((item) => !(
      item.usage === 'identity' && normalizeHandle(item.handle) === handle
    )));
  };

  const toggleCandidateIdentity = (candidate: ResearchCandidate) => {
    const handle = normalizeHandle(candidate.handle);
    if (!validHandle(handle)) return;
    const selected = projectAccounts.some((item) => (
      item.usage === 'identity' && normalizeHandle(item.handle) === handle
    ));
    if (selected) return removeIdentity(handle);
    upsertProjectAccount(handle, 'identity', candidate);
  };

  const removeCandidate = (candidate: ResearchCandidate) => {
    const handle = normalizeHandle(candidate.handle);
    onCandidatesChange(candidates.filter((item) => normalizeHandle(item.handle) !== handle));
    onProjectAccountsChange(projectAccounts.filter((item) => !(
      item.usage === 'identity' && normalizeHandle(item.handle) === handle
    )));
  };

  const updateSourceEvent = (source: XDirectSource, eventType: XDirectSource['event_types'][number]) => {
    onDirectSourcesChange(directSources.map((item) => (
      item.source_kind === source.source_kind
        && normalizeHandle(item.actor_handle) === normalizeHandle(source.actor_handle)
        ? { ...item, event_types: toggleEvent(item.event_types, eventType, DIRECT_EVENTS) }
        : item
    )));
  };

  const replaceRelationMatrix = (actorHandles: string[], targetHandles: string[]) => {
    const selectedActors = [...new Set(actorHandles.map(normalizeHandle).filter(validHandle))];
    const selectedTargets = [...new Set(targetHandles.map(normalizeHandle).filter(validHandle))];
    const existing = new Map(relations.map((item) => [
      `${normalizeHandle(item.actor_handle)}:${normalizeHandle(item.target_x_handle)}`,
      item,
    ]));
    const next: XSignalRelation[] = [];
    selectedTargets.forEach((target) => {
      selectedActors.forEach((actor) => {
        if (actor === target) return;
        next.push(existing.get(`${actor}:${target}`) || {
          actor_handle: actor,
          target_x_handle: target,
          event_types: [...relationEventTypes],
          enabled: true,
        });
      });
    });

    const accountMap = new Map(projectAccounts.map((item) => [
      `${normalizeHandle(item.handle)}:${item.usage}`,
      item,
    ]));
    const nextProjectAccounts = projectAccounts.filter((item) => item.usage !== 'interaction_target');
    selectedTargets.forEach((target) => {
      const existingTarget = accountMap.get(`${target}:interaction_target`);
      const identity = accountMap.get(`${target}:identity`);
      const candidate = candidates.find((item) => normalizeHandle(item.handle) === target);
      nextProjectAccounts.push(existingTarget || {
        handle: target,
        role: candidate?.role || identity?.role || 'project',
        usage: 'interaction_target',
        evidence_snapshot: candidate
          ? candidateEvidenceSnapshot(candidate)
          : identity?.evidence_snapshot || {},
      });
    });

    onRelationActorHandlesChange(selectedActors);
    onRelationTargetHandlesChange(selectedTargets);
    onRelationsChange(next);
    onProjectAccountsChange(nextProjectAccounts);
    return true;
  };

  const replaceRelationActors = (handles: string[]) => {
    replaceRelationMatrix(handles, relationTargetSelection);
  };

  const replaceRelationTargets = (handles: string[]) => {
    onRelationTargetPolicyChange('manual');
    replaceRelationMatrix(relationActorSelection, handles);
  };

  const addRelation = () => {
    const actor = normalizeHandle(actorInput);
    if (!validHandle(actor)) return onError('请填写有效的生态账号');
    if (!replaceRelationMatrix([...relationActorSelection, actor], relationTargetSelection)) return;
    setActorInput('');
    setActiveSuggestions(null);
  };

  const updateMatrixEvent = (eventType: XSignalRelation['event_types'][number]) => {
    const nextEvents = toggleEvent(relationEventTypes, eventType, RELATION_EVENTS);
    onRelationEventTypesChange(nextEvents);
    onRelationsChange(relations.map((item) => ({
      ...item,
      event_types: [...nextEvents],
    })));
  };

  const toggleDirectRule = () => {
    if (directRuleEnabled && ecosystemSources.length) {
      if (!window.confirm('关闭后将移除当前草稿中的生态账号 CA 动态规则，是否继续？')) return;
      onDirectSourcesChange(directSources.filter((item) => item.source_kind !== 'ecosystem'));
      onDirectActorHandlesChange([]);
    }
    onDirectRuleEnabledChange(!directRuleEnabled);
    setEcosystemInput('');
    setActiveSuggestions(null);
  };

  const toggleRelationRule = () => {
    const turningOff = relationRuleEnabled;
    if (turningOff && (relations.length || relationActorSelection.length || relationTargetSelection.length)) {
      if (!window.confirm('关闭后将移除当前草稿中的全部生态互动关系，是否继续？')) return;
      onRelationsChange([]);
      onProjectAccountsChange(projectAccounts.filter((item) => item.usage !== 'interaction_target'));
    }
    onRelationRuleEnabledChange(!relationRuleEnabled);
    if (turningOff) {
      onRelationActorHandlesChange([]);
      onRelationTargetHandlesChange([]);
      onRelationTargetPolicyChange('manual');
    }
    setActorInput('');
    setTargetSearch('');
    setActiveSuggestions(null);
  };

  const identityMap = new Map<string, { candidate?: ResearchCandidate; account?: WhitelistProjectAccount }>();
  candidates.forEach((candidate) => identityMap.set(normalizeHandle(candidate.handle), { candidate }));
  projectAccounts.filter((item) => item.usage === 'identity').forEach((account) => {
    const handle = normalizeHandle(account.handle);
    identityMap.set(handle, { ...identityMap.get(handle), account });
  });
  const identityRows = [...identityMap.entries()].map(([handle, row]) => ({
    handle,
    ...row,
    selected: Boolean(row.account),
    summary: row.candidate ? candidateSummary(row.candidate) : row.account ? accountSummary(row.account) : '',
    role: researchRoleLabel(row.candidate?.role || row.account?.role || 'project'),
    confidence: row.candidate?.confidence || 'manual',
  }));
  const activeIdentity = identityRows.find((item) => item.handle === activeIdentityHandle) || null;
  const activeSnapshot = activeIdentity?.account?.evidence_snapshot || {};
  const activeEvidence = activeIdentity?.candidate?.evidence
    || (Array.isArray(activeSnapshot.evidence) ? activeSnapshot.evidence as ResearchCandidate['evidence'] : []);
  const activeAssociation = activeIdentity?.candidate?.association
    || (typeof activeSnapshot.association === 'string' ? activeSnapshot.association : '')
    || '暂无补充说明';

  return (
    <div className="p162-account-rules">
      {!templateMode && <section className="p162-task-section">
        <div className="p162-task-heading">
          <span>1</span>
          <div><h3>项目身份</h3><p>用于生态互动目标，不会因项目账号自己的动态买入当前 CA</p></div>
          <button type="button" className="btn btn-secondary" onClick={onOpenResearch}><Search size={16} />重新投研</button>
        </div>

        <div className="p162-identity-list">
          {identityRows.map((row) => (
            <div className={`p162-identity-row ${row.selected ? 'selected' : ''}`} key={row.handle}>
              <button
                type="button"
                className={`p162-identity-check ${row.selected ? 'selected' : ''}`}
                aria-label={`${row.selected ? '取消' : '保留'} @${row.handle} 项目身份`}
                aria-pressed={row.selected}
                onClick={() => row.candidate ? toggleCandidateIdentity(row.candidate) : removeIdentity(row.handle)}
              ><Check size={14} /></button>
              <div className="p162-identity-main"><strong>@{row.handle}</strong><span>{row.summary || '手工添加的项目身份'}</span></div>
              <span className="p162-identity-role">{row.role}</span>
              <span className={`p16-confidence ${row.confidence}`}>{row.confidence === 'verified' ? '已核验' : row.confidence === 'high' ? '高置信' : row.confidence === 'manual' ? '手工' : '待确认'}</span>
              <div className="p162-identity-actions">
                {(row.candidate || Object.keys(row.account?.evidence_snapshot || {}).length > 0) && <button type="button" className="p16-icon-button" title="查看证据" aria-label={`查看 @${row.handle} 证据`} onClick={() => setActiveIdentityHandle(row.handle)}><Info size={15} /></button>}
                <button type="button" className="p16-icon-button danger" title="移除账号" aria-label={`移除 @${row.handle}`} onClick={() => row.candidate ? removeCandidate(row.candidate) : removeIdentity(row.handle)}><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
          {identityRows.length === 0 && <div className="p16-empty-line">尚无项目身份，可手工添加或先运行快速投研</div>}
        </div>

        <div className="p162-manual-identity">
          <label><span>手工添加项目账号</span><input className="input" value={identityInput} onChange={(event) => setIdentityInput(event.target.value)} placeholder="@project" /></label>
          <button type="button" className="btn btn-secondary" onClick={addIdentityInput}><Plus size={16} />添加</button>
        </div>
      </section>}

      <section className="p162-task-section">
        <div className="p162-task-heading">
          <span>{templateMode ? '1' : '2'}</span>
          <div><h3>交易触发</h3><p>两条规则可单独启用、同时启用或全部关闭</p></div>
        </div>

        <div className="p162-trigger-list">
          <article className={`p162-trigger-rule ${directRuleEnabled ? 'enabled' : ''}`}>
            <div className="p162-trigger-head">
              <div className="p162-trigger-name"><i><AtSign size={17} /></i><div><strong>生态账号发布完整 CA</strong><span>账号动态包含当前合约地址</span></div></div>
              <div className="p162-trigger-controls"><span>{ecosystemSources.length} 个账号</span><button type="button" className="p162-rule-switch" role="switch" aria-checked={directRuleEnabled} aria-label="启用生态账号发布完整 CA" onClick={toggleDirectRule}><i /></button></div>
            </div>
            {directRuleEnabled && <div className="p162-trigger-body">
              <div className="p16-rule-builder source-only">
                <label><span>生态账号</span><AccountPicker accounts={kolAccounts} chainId={chainId} value={ecosystemInput} selectedHandles={ecosystemHandles} open={activeSuggestions === 'ecosystem'} onChange={setEcosystemInput} onSelectedHandlesChange={replaceEcosystemSources} onOpen={() => setActiveSuggestions('ecosystem')} onClose={() => setActiveSuggestions(null)} /></label>
                <button type="button" className="btn btn-secondary" onClick={addSource} disabled={!validHandle(normalizeHandle(ecosystemInput))}><Plus size={16} />手动添加</button>
              </div>
              <div className="p16-event-options" aria-label="新生态账号默认事件">
                {DIRECT_EVENTS.map((eventType) => <label key={eventType}><input type="checkbox" checked={directEventTypes.includes(eventType)} onChange={() => onDirectEventTypesChange(toggleEvent(directEventTypes, eventType, DIRECT_EVENTS))} />{eventTypeLabel(eventType)}</label>)}
              </div>
              <div className="p16-rule-list">
                {ecosystemSources.map((source) => (
                  <div className="p16-rule-row" key={source.actor_handle}>
                    <strong>@{normalizeHandle(source.actor_handle)}</strong><span>完整 CA</span><div className="p16-rule-event-editor">{DIRECT_EVENTS.map((eventType) => <label key={eventType}><input type="checkbox" checked={source.event_types?.includes(eventType) || false} onChange={() => updateSourceEvent(source, eventType)} />{eventTypeLabel(eventType)}</label>)}</div>
                    <button type="button" className="p16-icon-button" title="移除生态账号" aria-label="移除生态账号" onClick={() => removeSource(source.actor_handle)}><Trash2 size={16} /></button>
                  </div>
                ))}
                {ecosystemSources.length === 0 && <div className="p16-empty-line">勾选账号后立即加入当前草稿</div>}
              </div>
            </div>}
          </article>

          <article className={`p162-trigger-rule ${relationRuleEnabled ? 'enabled' : ''}`}>
            <div className="p162-trigger-head">
              <div className="p162-trigger-name"><i><Users size={17} /></i><div><strong>生态账号与项目账号互动</strong><span>转发、引用、回复或关注项目账号</span></div></div>
              <div className="p162-trigger-controls"><span>{templateMode ? `${relationActorSelection.length} 个账号` : `${relations.length} 条关系`}</span><button type="button" className="p162-rule-switch" role="switch" aria-checked={relationRuleEnabled} aria-label="启用生态账号与项目账号互动" onClick={toggleRelationRule}><i /></button></div>
            </div>
            {relationRuleEnabled && <div className="p162-trigger-body">
              {templateMode ? <>
                <div className="p16-rule-builder source-only">
                  <label><span>生态账号</span><AccountPicker accounts={kolAccounts} chainId={chainId} value={actorInput} selectedHandles={relationActorSelection} open={activeSuggestions === 'actor'} onChange={setActorInput} onSelectedHandlesChange={replaceRelationActors} onOpen={() => setActiveSuggestions('actor')} onClose={() => setActiveSuggestions(null)} /></label>
                  <button type="button" className="btn btn-secondary" onClick={addRelation} disabled={!validHandle(normalizeHandle(actorInput))}><Plus size={16} />手动添加</button>
                </div>
                <div className="p164-template-target-note"><Info size={15} /><span>模板只保存生态账号与互动类型；项目账号将在每个 CA 投研后自动作为互动目标。</span></div>
              </> : <div className="p16-rule-builder interaction">
                <label><span>生态账号</span><AccountPicker accounts={kolAccounts} chainId={chainId} value={actorInput} selectedHandles={relationActorSelection} open={activeSuggestions === 'actor'} onChange={setActorInput} onSelectedHandlesChange={replaceRelationActors} onOpen={() => setActiveSuggestions('actor')} onClose={() => setActiveSuggestions(null)} /></label>
                <ArrowRight size={17} aria-hidden="true" />
                <label><span>项目账号</span><ProjectTargetPicker accounts={projectTargetOptions} value={targetSearch} selectedHandles={relationTargetSelection} open={activeSuggestions === 'target'} onChange={setTargetSearch} onSelectedHandlesChange={replaceRelationTargets} onOpen={() => setActiveSuggestions('target')} onClose={() => setActiveSuggestions(null)} /></label>
                <button type="button" className="btn btn-secondary" onClick={addRelation} disabled={!validHandle(normalizeHandle(actorInput))}><Plus size={16} />手动添加</button>
              </div>}
              <div className="p16-event-options" aria-label="全部生态互动关系事件">
                {RELATION_EVENTS.map((eventType) => <label key={eventType}><input type="checkbox" checked={relationEventTypes.includes(eventType)} onChange={() => updateMatrixEvent(eventType)} />{eventTypeLabel(eventType)}</label>)}
              </div>
              {templateMode ? <div className="p164-template-actor-summary"><strong>{relationActorSelection.length}</strong><span>个生态账号将用于每个新 CA 的项目身份互动</span></div> : <div className="p163-matrix-summary" aria-label="生态互动关系矩阵统计">
                <div><strong>{relationActorSelection.length}</strong><span>生态账号</span></div>
                <i>×</i>
                <div><strong>{relationTargetSelection.length}</strong><span>项目账号</span></div>
                <i>=</i>
                <div><strong>{relations.length}</strong><span>互动关系</span></div>
                <em>{relationActorSelection.length} 个唯一 Watch</em>
              </div>}
              {!templateMode && expectedRelationCount > 0 && !matrixComplete && <div className="p163-matrix-notice">当前为历史关系覆盖 {relations.length}/{expectedRelationCount}；调整任一侧选择后将生成完整矩阵</div>}
              {!templateMode && <div className="p163-relation-groups">
                {relationGroups.map((group) => (
                  <div className="p163-relation-group" key={group.target}>
                    <div className="p163-relation-target">
                      <strong>@{group.target}</strong>
                      <span>{group.option?.role || '项目账号'}{group.option?.summary ? ` · ${group.option.summary}` : ''}</span>
                    </div>
                    <strong>{group.actors.length} 个生态账号</strong>
                    <div className="p163-actor-preview">
                      {group.actors.slice(0, 3).map((actor) => <span key={actor}>@{actor}</span>)}
                      {group.actors.length > 3 && <em>+{group.actors.length - 3}</em>}
                      {group.actors.length === 0 && <small>等待选择生态账号</small>}
                    </div>
                  </div>
                ))}
                {relationTargetSelection.length === 0 && <div className="p16-empty-line">尚未选择项目账号</div>}
              </div>}
            </div>}
          </article>
        </div>
      </section>

      {activeIdentity && createPortal(<>
        <button type="button" className="p162-drawer-overlay" aria-label="关闭账号证据" onClick={() => setActiveIdentityHandle(null)} />
        <aside className="p162-evidence-drawer" role="dialog" aria-modal="true" aria-label={`@${activeIdentity.handle} 账号证据`}>
          <div className="p162-drawer-head"><strong>账号证据</strong><button type="button" className="p16-icon-button" title="关闭" aria-label="关闭账号证据" onClick={() => setActiveIdentityHandle(null)}><X size={17} /></button></div>
          <div className="p162-drawer-body">
            <div className="p162-drawer-account"><strong>@{activeIdentity.handle}</strong><span>{activeIdentity.role}</span><em className={`p16-confidence ${activeIdentity.confidence}`}>{activeIdentity.confidence === 'verified' ? '已核验' : activeIdentity.confidence === 'high' ? '高置信' : '待确认'}</em></div>
            <section><h3>关联说明</h3><p>{activeAssociation}</p></section>
            <section><h3>机构与来源</h3><p>{activeIdentity.candidate?.organization || '未标注机构'} · {activeIdentity.candidate?.source || (typeof activeSnapshot.source === 'string' ? activeSnapshot.source : '手工记录')}</p></section>
            <section><h3>核验证据</h3><div className="p162-evidence-list">{activeEvidence.length ? activeEvidence.map((evidence, index) => <div key={`${evidence.label}:${index}`}><span>{evidence.label}</span>{evidence.url && <a href={evidence.url} target="_blank" rel="noreferrer">查看来源</a>}</div>) : <p>暂无结构化证据</p>}</div></section>
          </div>
        </aside>
      </>, document.body)}
    </div>
  );
}
