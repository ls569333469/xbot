import type { ExitStrategy } from '../../lib/types';

export const STRATEGY_PRESETS: Array<{ id: string; name: string; detail: string; value: ExitStrategy }> = [
  {
    id: 'principal_no_stop',
    name: '翻倍出本，无止损',
    detail: '+100% 卖 50% / 保留 50%',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
      ],
    },
  },
  {
    id: 'principal_protected',
    name: '翻倍出本，带保护',
    detail: '+100% 卖 50% / -20% 保护',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
        { type: 'stop_loss', drop_pct: 20, sell_pct: 100 },
      ],
    },
  },
  {
    id: 'conservative_staged',
    name: '保守分批',
    detail: '+50% / +100% / +200% / -15%',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 50, sell_pct: 25 },
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
        { type: 'take_profit', trigger_pct: 200, sell_pct: 25 },
        { type: 'stop_loss', drop_pct: 15, sell_pct: 100 },
      ],
    },
  },
  {
    id: 'standard_staged',
    name: '标准分段',
    detail: '+100% / +200% / +500% / -20%',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
        { type: 'take_profit', trigger_pct: 200, sell_pct: 25 },
        { type: 'take_profit', trigger_pct: 500, sell_pct: 25 },
        { type: 'stop_loss', drop_pct: 20, sell_pct: 100 },
      ],
    },
  },
  {
    id: 'moonbag_trailing',
    name: '保留月亮包',
    detail: '10 倍激活 / 回撤 40% 卖尾仓',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
        { type: 'take_profit', trigger_pct: 300, sell_pct: 25 },
        { type: 'trailing_take_profit', activation_pct: 900, drawdown_pct: 40, sell_pct: 25 },
      ],
    },
  },
  {
    id: 'full_trailing_protection',
    name: '全仓移动保护',
    detail: '+100% 激活 / 回撤 25% 全出',
    value: {
      version: 1,
      sell_ratio_type: 'buy_amount',
      legs: [
        { type: 'trailing_take_profit', activation_pct: 100, drawdown_pct: 25, sell_pct: 100 },
        { type: 'stop_loss', drop_pct: 20, sell_pct: 100 },
      ],
    },
  },
];

export function cloneStrategy(strategy: ExitStrategy): ExitStrategy {
  return JSON.parse(JSON.stringify(strategy));
}

function legSignature(leg: ExitStrategy['legs'][number]) {
  if (leg.type === 'take_profit') return `take_profit:${Number(leg.trigger_pct)}:${Number(leg.sell_pct)}`;
  if (leg.type === 'stop_loss') return `stop_loss:${Number(leg.drop_pct)}:${Number(leg.sell_pct)}`;
  if (leg.type === 'trailing_take_profit') {
    return `trailing_take_profit:${Number(leg.activation_pct)}:${Number(leg.drawdown_pct)}:${Number(leg.sell_pct)}`;
  }
  return `trailing_stop_loss:${Number(leg.drop_pct)}:${Number(leg.drawdown_pct)}:${Number(leg.sell_pct)}`;
}

export function sameExitStrategy(left: ExitStrategy, right: ExitStrategy) {
  return Number(left.version) === Number(right.version)
    && left.sell_ratio_type === right.sell_ratio_type
    && left.legs.length === right.legs.length
    && left.legs.every((leg, index) => legSignature(leg) === legSignature(right.legs[index]));
}

export function strategySummary(strategy?: ExitStrategy | null) {
  if (!strategy?.legs?.length) return '未配置';
  return strategy.legs.map((leg) => {
    if (leg.type === 'take_profit') return `+${leg.trigger_pct}% 卖 ${leg.sell_pct}%`;
    if (leg.type === 'stop_loss') return `-${leg.drop_pct}% 止损`;
    if (leg.type === 'trailing_take_profit') {
      return `+${leg.activation_pct}% 激活，回撤 ${leg.drawdown_pct}% 卖 ${leg.sell_pct}%`;
    }
    return `下跌 ${leg.drop_pct}% 激活，回撤 ${leg.drawdown_pct}% 卖 ${leg.sell_pct}%`;
  }).join('；');
}
