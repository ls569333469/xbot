import { ChevronDown, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KolLabel } from '../../lib/types';
import {
  KOL_ECOSYSTEM_CATEGORIES,
  customCategoryId,
  customCategoryKey,
  ecosystemCategoryKey,
  type KolCategoryKey,
} from './kol-category';

const DIRECT_CUSTOM_LABEL_LIMIT = 8;

type CategoryLabel = Pick<KolLabel, 'id' | 'name'> & Partial<Pick<KolLabel, 'account_count'>>;

interface KolCategoryBarProps {
  value: KolCategoryKey;
  labels: CategoryLabel[];
  onChange: (value: KolCategoryKey) => void;
  counts?: Partial<Record<KolCategoryKey, number>>;
  variant?: 'page' | 'picker';
  preserveFocus?: boolean;
}

export default function KolCategoryBar({
  value,
  labels,
  onChange,
  counts = {},
  variant = 'page',
  preserveFocus = false,
}: KolCategoryBarProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreSearch, setMoreSearch] = useState('');
  const sortedLabels = useMemo(
    () => [...labels].sort((left, right) => left.name.localeCompare(right.name, 'zh-CN')),
    [labels],
  );
  const activeCustomId = customCategoryId(value);
  const visibleLabels = useMemo(() => {
    const first = sortedLabels.slice(0, DIRECT_CUSTOM_LABEL_LIMIT);
    if (!activeCustomId || first.some((label) => label.id === activeCustomId)) return first;
    const active = sortedLabels.find((label) => label.id === activeCustomId);
    return active ? [...first.slice(0, DIRECT_CUSTOM_LABEL_LIMIT - 1), active] : first;
  }, [activeCustomId, sortedLabels]);
  const visibleIds = useMemo(() => new Set(visibleLabels.map((label) => label.id)), [visibleLabels]);
  const hiddenLabels = sortedLabels.filter((label) => !visibleIds.has(label.id));
  const searchedHiddenLabels = hiddenLabels.filter((label) => (
    !moreSearch.trim() || label.name.toLowerCase().includes(moreSearch.trim().toLowerCase())
  ));

  useEffect(() => {
    if (!moreOpen) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setMoreOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [moreOpen]);

  const mouseDown = preserveFocus
    ? (event: React.MouseEvent<HTMLButtonElement>) => event.preventDefault()
    : undefined;
  const countText = (key: KolCategoryKey, fallback?: number) => {
    const count = counts[key] ?? fallback;
    return Number.isFinite(count) ? ` ${count}` : '';
  };
  const choose = (key: KolCategoryKey) => {
    onChange(key);
    setMoreOpen(false);
    setMoreSearch('');
  };

  return <div className={`kol-category-bar kol-category-bar--${variant}`} ref={rootRef}>
    <span className="kol-category-bar__label">KOL 分类</span>
    <div className="kol-category-bar__items" role="tablist" aria-label="KOL 分类">
      <button type="button" role="tab" aria-selected={value === 'all'} className={value === 'all' ? 'active' : ''} onMouseDown={mouseDown} onClick={() => choose('all')}>全部{countText('all')}</button>
      {KOL_ECOSYSTEM_CATEGORIES.map((category) => {
        const key = ecosystemCategoryKey(category.value);
        return <button type="button" role="tab" aria-selected={value === key} className={value === key ? 'active' : ''} key={key} onMouseDown={mouseDown} onClick={() => choose(key)}>{category.label}{countText(key)}</button>;
      })}
      {visibleLabels.map((label) => {
        const key = customCategoryKey(label.id);
        return <button type="button" role="tab" aria-selected={value === key} className={`custom ${value === key ? 'active' : ''}`} key={key} onMouseDown={mouseDown} onClick={() => choose(key)}>{label.name}{countText(key, label.account_count)}</button>;
      })}
      {hiddenLabels.length > 0 && <button type="button" className={`more ${moreOpen ? 'active' : ''}`} aria-expanded={moreOpen} onMouseDown={mouseDown} onClick={() => setMoreOpen((current) => !current)}>更多 <ChevronDown size={12} /></button>}
    </div>
    {moreOpen && <div className="kol-category-bar__more">
      <label><Search size={13} /><input value={moreSearch} autoFocus onChange={(event) => setMoreSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') setMoreOpen(false); }} placeholder="搜索自定义标签" /></label>
      <div>{searchedHiddenLabels.map((label) => {
        const key = customCategoryKey(label.id);
        return <button type="button" className={value === key ? 'active' : ''} key={key} onClick={() => choose(key)}>{label.name}{countText(key, label.account_count)}</button>;
      })}</div>
      {!searchedHiddenLabels.length && <span>没有匹配标签</span>}
    </div>}
  </div>;
}
