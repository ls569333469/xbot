import type { EcosystemTag, KolAccount } from '../../lib/types';

export type KolEcosystemCategory = EcosystemTag | 'unclassified';
export type KolCategoryKey = 'all' | `ecosystem:${KolEcosystemCategory}` | `custom:${string}`;

export const KOL_ECOSYSTEM_CATEGORIES: Array<{
  value: KolEcosystemCategory;
  label: string;
}> = [
  { value: 'sol', label: 'SOL' },
  { value: 'bsc', label: 'BSC' },
  { value: 'base', label: 'BASE' },
  { value: 'eth', label: 'ETH' },
  { value: 'robinhood', label: 'ROBINHOOD' },
  { value: 'cross_chain', label: '跨链' },
  { value: 'unclassified', label: '未分类' },
];

export function ecosystemCategoryKey(value: KolEcosystemCategory): KolCategoryKey {
  return `ecosystem:${value}`;
}

export function customCategoryKey(id: string): KolCategoryKey {
  return `custom:${id}`;
}

export function customCategoryId(value: KolCategoryKey) {
  return value.startsWith('custom:') ? value.slice('custom:'.length) : null;
}

export function categoryQuery(value: KolCategoryKey): Record<string, string> {
  if (value.startsWith('ecosystem:')) return { tag: value.slice('ecosystem:'.length) };
  if (value.startsWith('custom:')) return { label_id: value.slice('custom:'.length) };
  return {};
}

export function accountMatchesCategory(account: KolAccount, value: KolCategoryKey) {
  if (value === 'all') return true;
  if (value === 'ecosystem:unclassified') return !account.chain_ids?.length;
  if (value.startsWith('ecosystem:')) {
    return account.chain_ids?.includes(value.slice('ecosystem:'.length) as EcosystemTag) ?? false;
  }
  const labelId = customCategoryId(value);
  return Boolean(labelId && account.custom_labels?.some((label) => label.id === labelId));
}
