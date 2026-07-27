import { Check, Plus, Trash2 } from 'lucide-react';
import type { ExitStrategy, ExitStrategyLeg } from '../../lib/types';
import { cloneStrategy, sameExitStrategy, STRATEGY_PRESETS } from './strategy-presets';

interface Props {
  value: ExitStrategy;
  onChange: (value: ExitStrategy) => void;
  saveHint?: string;
}

function numberValue(value: string, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export default function StrategyEditor({ value, onChange, saveHint = '已应用到当前草稿，尚待第 4 步保存' }: Props) {
  const profitLegs = value.legs.filter((leg) => (
    leg.type === 'take_profit' || leg.type === 'trailing_take_profit'
  ));
  const stopLegs = value.legs.filter((leg) => (
    leg.type === 'stop_loss' || leg.type === 'trailing_stop_loss'
  ));
  const plannedSellPct = profitLegs.reduce((total, leg) => total + leg.sell_pct, 0);
  const updateLeg = (index: number, patch: Partial<ExitStrategyLeg>) => {
    const legs = value.legs.map((leg, legIndex) => legIndex === index
      ? { ...leg, ...patch } as ExitStrategyLeg
      : leg);
    onChange({ ...value, legs });
  };

  const changeType = (index: number, type: ExitStrategyLeg['type']) => {
    const defaults: Record<ExitStrategyLeg['type'], ExitStrategyLeg> = {
      take_profit: { type: 'take_profit', trigger_pct: 100, sell_pct: 25 },
      stop_loss: { type: 'stop_loss', drop_pct: 20, sell_pct: 100 },
      trailing_take_profit: {
        type: 'trailing_take_profit', activation_pct: 300, drawdown_pct: 25, sell_pct: 25,
      },
      trailing_stop_loss: {
        type: 'trailing_stop_loss', drop_pct: 10, drawdown_pct: 10, sell_pct: 100,
      },
    };
    const legs = value.legs.map((leg, legIndex) => legIndex === index ? defaults[type] : leg);
    onChange({ ...value, legs });
  };

  return (
    <div className="p16-strategy-editor">
      <div className="p16-preset-grid" role="list" aria-label="离场策略模板">
        {STRATEGY_PRESETS.map((preset) => {
          const selected = sameExitStrategy(value, preset.value);
          return <button
            type="button"
            key={preset.id}
            className={`p16-preset-option ${selected ? 'active' : ''}`}
            aria-pressed={selected}
            onClick={() => onChange(cloneStrategy(preset.value))}
          >
            <strong>{preset.name}</strong>
            <span>{preset.detail}</span>
            {selected && <i className="p16-preset-check" aria-label="已选择"><Check size={13} /></i>}
          </button>;
        })}
      </div>

      <div className={`p16-strategy-draft-summary ${stopLegs.length ? 'protected' : 'unprotected'}`}>
        <div><span>当前草稿</span><strong>{value.legs.length} 条条件</strong></div>
        <div><span>止盈</span><strong>{profitLegs.length} 条 · 预计保留 {Math.max(0, 100 - plannedSellPct)}%</strong></div>
        <div><span>止损</span><strong>{stopLegs.length ? `已设置 ${stopLegs.length} 条` : '未设置'}</strong></div>
        <p>{saveHint}</p>
      </div>

      <details className="p16-advanced" open={!STRATEGY_PRESETS.some((item) => sameExitStrategy(value, item.value))}>
        <summary>自定义条件</summary>
        <div className="p16-leg-list">
          {value.legs.map((leg, index) => (
            <div className="p16-leg-row" key={`${leg.type}-${index}`}>
              <select className="input" value={leg.type} onChange={(event) => changeType(index, event.target.value as ExitStrategyLeg['type'])}>
                <option value="take_profit">固定止盈</option>
                <option value="stop_loss">固定止损</option>
                <option value="trailing_take_profit">移动止盈</option>
                <option value="trailing_stop_loss">移动止损</option>
              </select>

              {'trigger_pct' in leg && (
                <label><span>上涨 %</span><input className="input" type="number" min="0.01" value={leg.trigger_pct} onChange={(event) => updateLeg(index, { trigger_pct: numberValue(event.target.value, 0) })} /></label>
              )}
              {'activation_pct' in leg && (
                <label><span>激活涨幅 %</span><input className="input" type="number" min="0.01" value={leg.activation_pct} onChange={(event) => updateLeg(index, { activation_pct: numberValue(event.target.value, 0) })} /></label>
              )}
              {'drop_pct' in leg && (
                <label><span>下跌 %</span><input className="input" type="number" min="0.01" max="99.99" value={leg.drop_pct} onChange={(event) => updateLeg(index, { drop_pct: numberValue(event.target.value, 0) })} /></label>
              )}
              {'drawdown_pct' in leg && (
                <label><span>回撤 %</span><input className="input" type="number" min="0.01" max="99.99" value={leg.drawdown_pct} onChange={(event) => updateLeg(index, { drawdown_pct: numberValue(event.target.value, 0) })} /></label>
              )}
              <label><span>卖出 %</span><input className="input" type="number" min="1" max="100" value={leg.sell_pct} onChange={(event) => updateLeg(index, { sell_pct: numberValue(event.target.value, 1) })} /></label>
              <button type="button" className="p16-icon-button" title="删除条件" aria-label="删除条件" onClick={() => onChange({ ...value, legs: value.legs.filter((_, legIndex) => legIndex !== index) })}>
                <Trash2 size={16} />
              </button>
            </div>
          ))}
        </div>
        <button type="button" className="btn btn-secondary" disabled={value.legs.length >= 10} onClick={() => onChange({
          ...value,
          legs: [...value.legs, { type: 'take_profit', trigger_pct: 300, sell_pct: 25 }],
        })}>
          <Plus size={16} /> 添加条件
        </button>
      </details>

    </div>
  );
}
