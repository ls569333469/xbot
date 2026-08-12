import templates from '../../../shared/chain-explorers.json';

export function explorerUrl(chain: string, kind: 'address' | 'transaction', value?: string | null) {
  const registry = templates as Record<string, Partial<Record<'address' | 'transaction', string>>>;
  const template = registry[chain]?.[kind];
  return template && value ? template.replace('{value}', encodeURIComponent(value)) : null;
}
