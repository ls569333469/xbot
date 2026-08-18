import { Plus, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { KolLabel } from '../../lib/types';

interface KolLabelPickerProps {
  labels: KolLabel[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  onCreate: (name: string) => Promise<KolLabel | null>;
  max?: number;
}

function normalized(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase();
}

export default function KolLabelPicker({
  labels,
  selectedIds,
  onChange,
  onCreate,
  max = 12,
}: KolLabelPickerProps) {
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const selected = useMemo(
    () => selectedIds.map((id) => labels.find((label) => label.id === id)).filter(Boolean) as KolLabel[],
    [labels, selectedIds],
  );
  const available = useMemo(() => {
    const term = normalized(query);
    return labels.filter((label) => !selectedIds.includes(label.id)
      && (!term || normalized(label.name).includes(term))).slice(0, 8);
  }, [labels, query, selectedIds]);
  const exactMatch = labels.some((label) => normalized(label.name) === normalized(query));
  const canAdd = selectedIds.length < max;

  const add = (label: KolLabel) => {
    if (!canAdd || selectedIds.includes(label.id)) return;
    onChange([...selectedIds, label.id]);
    setQuery('');
  };

  const create = async () => {
    if (!canAdd || !query.trim()) return;
    setCreating(true);
    try {
      const label = await onCreate(query);
      if (label) add(label);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="kol-label-picker">
      <div className="kol-label-selection" aria-label="已选自定义标签">
        {selected.map((label) => <span key={label.id}>{label.name}<button type="button" title={`移除 ${label.name}`} aria-label={`移除 ${label.name}`} onClick={() => onChange(selectedIds.filter((id) => id !== label.id))}><X size={12} /></button></span>)}
        {!selected.length && <small>未选择自定义标签</small>}
      </div>
      <div className="kol-label-search"><Search size={15} /><input value={query} disabled={!canAdd} onChange={(event) => setQuery(event.target.value)} placeholder={canAdd ? '搜索或新增标签' : `最多 ${max} 个标签`} /></div>
      {canAdd && (query.trim() || available.length > 0) && <div className="kol-label-options">
        {available.map((label) => <button type="button" key={label.id} onClick={() => add(label)}><span>{label.name}</span><small>{label.account_count} 个账号</small></button>)}
        {query.trim() && !exactMatch && <button type="button" className="create" disabled={creating} onClick={() => void create()}><Plus size={14} /><span>{creating ? '新增中' : `新增“${query.trim()}”`}</span></button>}
        {!available.length && (!query.trim() || exactMatch) && <small className="kol-label-empty">没有可选标签</small>}
      </div>}
      <small className="kol-label-limit">{selectedIds.length}/{max}</small>
    </div>
  );
}
