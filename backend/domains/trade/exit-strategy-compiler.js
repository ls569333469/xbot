const STRATEGY_VERSION = 1;
const SELL_RATIO_TYPE = 'buy_amount';
const MAX_CONDITION_ORDERS = 10;

const LEG_TYPES = Object.freeze([
  'take_profit',
  'stop_loss',
  'trailing_take_profit',
  'trailing_stop_loss'
]);

const STRATEGY_PRESETS = Object.freeze({
  principal_no_stop: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 }
    ]
  },
  principal_protected: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
      { type: 'stop_loss', drop_pct: 20, sell_pct: 100 }
    ]
  },
  conservative_staged: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: 50, sell_pct: 25 },
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
      { type: 'take_profit', trigger_pct: 200, sell_pct: 25 },
      { type: 'stop_loss', drop_pct: 15, sell_pct: 100 }
    ]
  },
  standard_staged: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
      { type: 'take_profit', trigger_pct: 200, sell_pct: 25 },
      { type: 'take_profit', trigger_pct: 500, sell_pct: 25 },
      { type: 'stop_loss', drop_pct: 20, sell_pct: 100 }
    ]
  },
  moonbag_trailing: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: 100, sell_pct: 50 },
      { type: 'take_profit', trigger_pct: 300, sell_pct: 25 },
      {
        type: 'trailing_take_profit',
        activation_pct: 900,
        drawdown_pct: 40,
        sell_pct: 25
      }
    ]
  },
  full_trailing_protection: {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      {
        type: 'trailing_take_profit',
        activation_pct: 100,
        drawdown_pct: 25,
        sell_pct: 100
      },
      { type: 'stop_loss', drop_pct: 20, sell_pct: 100 }
    ]
  }
});

function strategyError(message, code = 'EXIT_STRATEGY_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function finiteNumber(value, field, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw strategyError(`${field} must be a finite number`);
  if (options.min !== undefined && number < options.min) {
    throw strategyError(`${field} must be at least ${options.min}`);
  }
  if (options.max !== undefined && number > options.max) {
    throw strategyError(`${field} must be at most ${options.max}`);
  }
  return number;
}

function parseStrategy(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw strategyError('exit_strategy must be valid JSON');
  }
}

function legacyStrategy(source = {}) {
  const takeProfit = finiteNumber(source.auto_tp_pct ?? 100, 'auto_tp_pct', { min: 0.01 });
  const stopLoss = finiteNumber(source.auto_sl_pct ?? 20, 'auto_sl_pct', { min: 0.01, max: 99.99 });
  return {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs: [
      { type: 'take_profit', trigger_pct: takeProfit, sell_pct: 100 },
      { type: 'stop_loss', drop_pct: stopLoss, sell_pct: 100 }
    ]
  };
}

function normalizeLeg(raw, index) {
  const type = String(raw?.type || '').trim().toLowerCase();
  if (!LEG_TYPES.includes(type)) {
    throw strategyError(`Unsupported exit strategy leg type at index ${index}: ${type || '(empty)'}`);
  }
  const sellPct = finiteNumber(raw.sell_pct, `legs[${index}].sell_pct`, { min: 1, max: 100 });

  if (type === 'take_profit') {
    return {
      type,
      trigger_pct: finiteNumber(raw.trigger_pct, `legs[${index}].trigger_pct`, { min: 0.01 }),
      sell_pct: sellPct
    };
  }
  if (type === 'stop_loss') {
    return {
      type,
      drop_pct: finiteNumber(raw.drop_pct, `legs[${index}].drop_pct`, { min: 0.01, max: 99.99 }),
      sell_pct: sellPct
    };
  }

  const activationField = type === 'trailing_take_profit' ? 'activation_pct' : 'drop_pct';
  const activation = finiteNumber(
    raw[activationField],
    `legs[${index}].${activationField}`,
    { min: 0.01, ...(activationField === 'drop_pct' ? { max: 99.99 } : {}) }
  );
  return {
    type,
    [activationField]: activation,
    drawdown_pct: finiteNumber(raw.drawdown_pct, `legs[${index}].drawdown_pct`, {
      min: 0.01,
      max: 99.99
    }),
    sell_pct: sellPct
  };
}

function normalizeExitStrategy(value, fallback = {}) {
  const parsed = parseStrategy(value) || legacyStrategy(fallback);
  const legs = Array.isArray(parsed.legs) ? parsed.legs.map(normalizeLeg) : [];
  if (legs.length === 0) throw strategyError('At least one exit strategy leg is required');
  if (legs.length > MAX_CONDITION_ORDERS) {
    throw strategyError(`At most ${MAX_CONDITION_ORDERS} exit strategy legs are allowed`);
  }

  const fixedTakeProfits = legs.filter((leg) => leg.type === 'take_profit');
  for (let index = 1; index < fixedTakeProfits.length; index += 1) {
    if (fixedTakeProfits[index].trigger_pct <= fixedTakeProfits[index - 1].trigger_pct) {
      throw strategyError('Fixed take-profit trigger percentages must be strictly increasing');
    }
  }

  const profitSellPct = legs
    .filter((leg) => leg.type === 'take_profit' || leg.type === 'trailing_take_profit')
    .reduce((total, leg) => total + leg.sell_pct, 0);
  if (profitSellPct > 100) {
    throw strategyError('Take-profit legs cannot sell more than 100% of the buy amount');
  }

  return {
    version: STRATEGY_VERSION,
    sell_ratio_type: SELL_RATIO_TYPE,
    legs
  };
}

function compileExitStrategy(value, fallback = {}) {
  const strategy = normalizeExitStrategy(value, fallback);
  const conditionOrders = strategy.legs.map((leg) => {
    const base = { side: 'sell', sell_ratio: String(leg.sell_pct) };
    if (leg.type === 'take_profit') {
      return { ...base, order_type: 'profit_stop', price_scale: String(leg.trigger_pct) };
    }
    if (leg.type === 'stop_loss') {
      return { ...base, order_type: 'loss_stop', price_scale: String(leg.drop_pct) };
    }
    if (leg.type === 'trailing_take_profit') {
      return {
        ...base,
        order_type: 'profit_stop_trace',
        price_scale: String(leg.activation_pct),
        drawdown_rate: String(leg.drawdown_pct)
      };
    }
    return {
      ...base,
      order_type: 'loss_stop_trace',
      price_scale: String(leg.drop_pct),
      drawdown_rate: String(leg.drawdown_pct)
    };
  });
  return { strategy, conditionOrders };
}

function legacyPercentages(strategy) {
  const normalized = normalizeExitStrategy(strategy);
  const takeProfit = normalized.legs.find((leg) => leg.type === 'take_profit');
  const stopLoss = normalized.legs.find((leg) => leg.type === 'stop_loss');
  return {
    auto_tp_pct: takeProfit?.trigger_pct ?? 100,
    auto_sl_pct: stopLoss?.drop_pct ?? null
  };
}

function clonePreset(name) {
  const preset = STRATEGY_PRESETS[name];
  if (!preset) throw strategyError(`Unknown exit strategy preset: ${name}`);
  return JSON.parse(JSON.stringify(preset));
}

module.exports = {
  LEG_TYPES,
  MAX_CONDITION_ORDERS,
  STRATEGY_PRESETS,
  STRATEGY_VERSION,
  clonePreset,
  compileExitStrategy,
  legacyPercentages,
  legacyStrategy,
  normalizeExitStrategy,
  strategyError
};
