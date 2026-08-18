import { Check, Pencil, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Modal } from '../../components/ui/Modal';
import { useToast } from '../../components/ui/ToastContext';
import { api } from '../../lib/api';
import type { KolLabel } from '../../lib/types';

interface KolLabelManagerProps {
  open: boolean;
  labels: KolLabel[];
  onClose: () => void;
  onChanged: () => Promise<void>;
}

export default function KolLabelManager({ open, labels, onClose, onChanged }: KolLabelManagerProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const { toast } = useToast();

  const startEdit = (label: KolLabel) => {
    setEditingId(label.id);
    setName(label.name);
  };

  const save = async () => {
    if (!editingId || !name.trim()) return;
    setSaving(true);
    try {
      const response = await api.kol.labels.update(editingId, name);
      if (!response.ok) return toast(response.error || '标签改名失败', 'error');
      toast('标签名称已更新', 'success');
      setEditingId(null);
      await onChanged();
    } finally {
      setSaving(false);
    }
  };

  const remove = async (label: KolLabel) => {
    if (label.account_count > 0 || !confirm(`确认删除标签“${label.name}”？`)) return;
    const response = await api.kol.labels.remove(label.id);
    if (!response.ok) return toast(response.error || '标签删除失败', 'error');
    toast('标签已删除', 'success');
    await onChanged();
  };

  return <Modal isOpen={open} onClose={onClose} title="管理自定义标签">
    <div className="kol-label-manager">
      {labels.map((label) => <div key={label.id}>
        {editingId === label.id
          ? <div className="kol-label-manager-edit"><input className="input" value={name} maxLength={24} autoFocus onChange={(event) => setName(event.target.value)} /><button type="button" className="p16-icon-button" title="保存标签名称" aria-label="保存标签名称" disabled={saving} onClick={() => void save()}><Check size={15} /></button><button type="button" className="p16-icon-button" title="取消改名" aria-label="取消改名" onClick={() => setEditingId(null)}><X size={15} /></button></div>
          : <><div><strong>{label.name}</strong><small>{label.account_count} 个账号使用</small></div><div className="p16-table-actions"><button type="button" className="p16-icon-button" title="修改标签名称" aria-label="修改标签名称" onClick={() => startEdit(label)}><Pencil size={15} /></button><button type="button" className="p16-icon-button danger" title={label.account_count ? '使用中的标签不能删除' : '删除标签'} aria-label={`删除标签 ${label.name}`} disabled={label.account_count > 0} onClick={() => void remove(label)}><Trash2 size={15} /></button></div></>}
      </div>)}
      {!labels.length && <div className="p16-empty-line">暂无自定义标签，可在添加或编辑 KOL 时创建。</div>}
    </div>
  </Modal>;
}
