import type {
  ExitStrategy,
  WhitelistEntry,
  WhitelistProjectAccount,
  WhitelistTemplateSnapshot,
  XDirectSource,
  XSignalRelation,
} from '../../lib/types';
import { cloneStrategy, sameExitStrategy } from './strategy-presets';

export type RelationTargetPolicy = 'all_selected_project_identities' | 'manual';

export interface WhitelistConfigDraft {
  direct_sources: XDirectSource[];
  relations: XSignalRelation[];
  project_accounts: WhitelistProjectAccount[];
  direct_source_rule_enabled: boolean;
  direct_source_actor_handles: string[];
  relation_rule_enabled: boolean;
  relation_actor_handles: string[];
  relation_target_handles: string[];
  relation_target_policy: RelationTargetPolicy;
  direct_source_event_types: XDirectSource['event_types'];
  relation_event_types: XSignalRelation['event_types'];
  budget_per_trade: string;
  total_budget: string;
  slippage: string;
  allow_repeat_buy: boolean;
  max_repeat_buys: string;
  exit_strategy: ExitStrategy;
}

const X_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;

export function normalizeHandle(value: string) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

export function uniqueHandles(values: string[] = []) {
  return [...new Set(values.map(normalizeHandle).filter((handle) => X_HANDLE_PATTERN.test(handle)))];
}

export function identityHandles(accounts: WhitelistProjectAccount[] = []) {
  return uniqueHandles(accounts
    .filter((item) => item.usage === 'identity')
    .map((item) => item.handle));
}

function relationTargetHandles(relations: XSignalRelation[] = []) {
  return uniqueHandles(relations.map((item) => item.target_x_handle));
}

function ecosystemSourceHandles(sources: XDirectSource[] = []) {
  return uniqueHandles(sources
    .filter((item) => item.source_kind === 'ecosystem')
    .map((item) => item.actor_handle));
}

function relationActorHandles(relations: XSignalRelation[] = []) {
  return uniqueHandles(relations.map((item) => item.actor_handle));
}

function materializeSources<T extends WhitelistConfigDraft>(draft: T) {
  const next = draft.direct_sources.filter((item) => item.source_kind !== 'ecosystem');
  if (!draft.direct_source_rule_enabled) return next;
  const existing = new Map(draft.direct_sources
    .filter((item) => item.source_kind === 'ecosystem')
    .map((item) => [normalizeHandle(item.actor_handle), item]));
  draft.direct_source_actor_handles.forEach((actorHandle) => {
    const handle = normalizeHandle(actorHandle);
    const current = existing.get(handle);
    next.push({
      ...current,
      actor_handle: handle,
      event_types: [...draft.direct_source_event_types],
      match_mode: 'ca_only',
      source_kind: 'ecosystem',
      role: current?.role || 'ecosystem',
    });
  });
  return next;
}

function materializeRelations<T extends WhitelistConfigDraft>(draft: T) {
  if (!draft.relation_rule_enabled) return [];
  const existing = new Map(draft.relations.map((item) => [
    `${normalizeHandle(item.actor_handle)}:${normalizeHandle(item.target_x_handle)}`,
    item,
  ]));
  const next: XSignalRelation[] = [];
  draft.relation_target_handles.forEach((targetHandle) => {
    const target = normalizeHandle(targetHandle);
    draft.relation_actor_handles.forEach((actorHandle) => {
      const actor = normalizeHandle(actorHandle);
      if (actor === target) return;
      const current = existing.get(`${actor}:${target}`);
      next.push({
        ...current,
        actor_handle: actor,
        target_x_handle: target,
        event_types: [...draft.relation_event_types],
        enabled: true,
      });
    });
  });
  return next;
}

function materializeProjectAccounts<T extends WhitelistConfigDraft>(draft: T) {
  const retained = draft.project_accounts.filter((item) => item.usage !== 'interaction_target');
  if (!draft.relation_rule_enabled) return retained;
  const existingTargets = new Map(draft.project_accounts
    .filter((item) => item.usage === 'interaction_target')
    .map((item) => [normalizeHandle(item.handle), item]));
  const identities = new Map(draft.project_accounts
    .filter((item) => item.usage === 'identity')
    .map((item) => [normalizeHandle(item.handle), item]));
  draft.relation_target_handles.forEach((target) => {
    const handle = normalizeHandle(target);
    const existing = existingTargets.get(handle);
    const identity = identities.get(handle);
    retained.push(existing || {
      handle,
      role: identity?.role || 'project',
      usage: 'interaction_target',
      evidence_snapshot: identity?.evidence_snapshot || {},
    });
  });
  return retained;
}

export function materializeConfigDraft<T extends WhitelistConfigDraft>(current: T): T {
  const directSourceActorHandles = uniqueHandles(
    current.direct_source_actor_handles.length
      ? current.direct_source_actor_handles
      : ecosystemSourceHandles(current.direct_sources),
  );
  const relationActors = uniqueHandles(
    current.relation_actor_handles.length
      ? current.relation_actor_handles
      : relationActorHandles(current.relations),
  );
  const targets = current.relation_target_policy === 'all_selected_project_identities'
    ? identityHandles(current.project_accounts)
    : uniqueHandles(
      current.relation_target_handles.length
        ? current.relation_target_handles
        : relationTargetHandles(current.relations),
    );
  const prepared = {
    ...current,
    direct_source_actor_handles: directSourceActorHandles,
    relation_actor_handles: relationActors,
    relation_target_handles: targets,
  };
  return {
    ...prepared,
    direct_sources: materializeSources(prepared),
    relations: materializeRelations(prepared),
    project_accounts: materializeProjectAccounts(prepared),
  };
}

export function applyConfigSnapshot<T extends WhitelistConfigDraft>(
  current: T,
  snapshot: WhitelistTemplateSnapshot,
): T {
  const next: T = {
    ...current,
    budget_per_trade: String(snapshot.budget_per_trade),
    total_budget: String(snapshot.total_budget),
    slippage: String(snapshot.slippage),
    allow_repeat_buy: snapshot.allow_repeat_buy,
    max_repeat_buys: String(snapshot.max_repeat_buys),
    exit_strategy: cloneStrategy(snapshot.exit_strategy),
    relation_event_types: [...snapshot.relation_event_types],
    direct_source_event_types: [...snapshot.direct_source_event_types],
    direct_source_rule_enabled: snapshot.direct_source_rule_enabled,
    direct_source_actor_handles: uniqueHandles(snapshot.direct_source_actor_handles),
    relation_rule_enabled: snapshot.relation_rule_enabled,
    relation_actor_handles: uniqueHandles(snapshot.relation_actor_handles),
    relation_target_policy: snapshot.relation_target_policy,
  };
  return materializeConfigDraft(next);
}

export function snapshotFromDraft(draft: WhitelistConfigDraft): WhitelistTemplateSnapshot {
  return {
    schema_version: 2,
    budget_per_trade: Number(draft.budget_per_trade),
    total_budget: Number(draft.total_budget),
    slippage: Number(draft.slippage),
    allow_repeat_buy: draft.allow_repeat_buy,
    max_repeat_buys: Number(draft.max_repeat_buys),
    exit_strategy: cloneStrategy(draft.exit_strategy),
    relation_event_types: [...draft.relation_event_types],
    direct_source_event_types: [...draft.direct_source_event_types],
    direct_source_rule_enabled: draft.direct_source_rule_enabled,
    direct_source_actor_handles: uniqueHandles(draft.direct_source_actor_handles),
    relation_rule_enabled: draft.relation_rule_enabled,
    relation_actor_handles: uniqueHandles(draft.relation_actor_handles),
    relation_target_policy: 'all_selected_project_identities',
  };
}

export function snapshotFromWhitelist(item: WhitelistEntry): WhitelistTemplateSnapshot {
  const ecosystemSources = (item.direct_sources || []).filter((source) => source.source_kind === 'ecosystem');
  const relationActors = relationActorHandles(item.relations || []);
  return {
    schema_version: 2,
    budget_per_trade: Number(item.budget_per_trade),
    total_budget: Number(item.total_budget),
    slippage: Number(item.slippage),
    allow_repeat_buy: Boolean(item.allow_repeat_buy),
    max_repeat_buys: Number(item.max_repeat_buys || 1),
    exit_strategy: cloneStrategy(item.exit_strategy),
    relation_event_types: [...(item.relations?.[0]?.event_types || ['retweet', 'quote', 'reply', 'follow'])],
    direct_source_event_types: [...(ecosystemSources[0]?.event_types || ['tweet'])],
    direct_source_rule_enabled: ecosystemSources.length > 0,
    direct_source_actor_handles: ecosystemSourceHandles(ecosystemSources),
    relation_rule_enabled: relationActors.length > 0,
    relation_actor_handles: relationActors,
    relation_target_policy: 'all_selected_project_identities',
  };
}

function sameList(left: string[] = [], right: string[] = []) {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

export function configDiffLabels(
  draft: WhitelistConfigDraft,
  baseline?: WhitelistTemplateSnapshot | null,
) {
  if (!baseline) return [];
  const labels: string[] = [];
  const xConfigChanged = draft.direct_source_rule_enabled !== baseline.direct_source_rule_enabled
    || draft.relation_rule_enabled !== baseline.relation_rule_enabled
    || !sameList(
      uniqueHandles(draft.direct_source_actor_handles),
      uniqueHandles(baseline.direct_source_actor_handles),
    )
    || !sameList(
      uniqueHandles(draft.relation_actor_handles),
      uniqueHandles(baseline.relation_actor_handles),
    )
    || draft.relation_target_policy !== baseline.relation_target_policy
    || !sameList(draft.direct_source_event_types, baseline.direct_source_event_types)
    || !sameList(draft.relation_event_types, baseline.relation_event_types);
  if (xConfigChanged) labels.push('X 触发');
  if (
    Number(draft.budget_per_trade) !== Number(baseline.budget_per_trade)
    || Number(draft.total_budget) !== Number(baseline.total_budget)
    || Number(draft.slippage) !== Number(baseline.slippage)
    || draft.allow_repeat_buy !== baseline.allow_repeat_buy
    || Number(draft.max_repeat_buys) !== Number(baseline.max_repeat_buys)
  ) labels.push('资金与买入');
  if (!sameExitStrategy(draft.exit_strategy, baseline.exit_strategy)) {
    labels.push('离场策略');
  }
  return labels;
}
