const db = require('../../lib/db');
const { legacyPercentages } = require('../trade/exit-strategy-compiler');
const { isTradeConfigSnapshot } = require('../signal/contract-snapshot');
const { normalizeTemplateSnapshot } = require('./templates');

const MAX_TARGETS = 50;
const EXECUTABLE_SIGNAL_STATUSES = [
  'recorded', 'pending', 'pending_risk', 'approved', 'execution_reserved'
];
const ACTIVE_BUY_ATTEMPT_STATUSES = [
  'reserved', 'preparing', 'submitting', 'submitted', 'confirming',
  'submission_uncertain', 'reconciliation_required'
];

const SKIP = Object.freeze({
  NOT_FOUND: 'TARGET_NOT_FOUND',
  ARCHIVED: 'TARGET_ARCHIVED',
  NON_FIXED: 'TARGET_NOT_FIXED_CA',
  CHAIN_MISMATCH: 'TEMPLATE_CHAIN_MISMATCH',
  ACCEPTANCE_SCOPE: 'ACCEPTANCE_SCOPE_ACTIVE',
  LEGACY_SIGNAL: 'LEGACY_SIGNAL_PENDING',
  BUDGET_BELOW_COMMITTED: 'TEMPLATE_BUDGET_BELOW_COMMITTED',
  REPEAT_BELOW_HISTORY: 'TEMPLATE_REPEAT_LIMIT_BELOW_HISTORY',
  CONFIG_INVALID: 'TARGET_CONFIG_INVALID'
});

function syncError(message, code = 'TEMPLATE_SYNC_INVALID') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeIds(values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw syncError('至少选择一个固定 CA');
  }
  const ids = [...new Set(values.map((value) => Number(value)))];
  if (ids.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw syncError('固定 CA ID 无效');
  }
  if (ids.length > MAX_TARGETS) {
    throw syncError(`单次最多同步 ${MAX_TARGETS} 个固定 CA`);
  }
  return ids.sort((left, right) => left - right);
}

function normalizeRequest(data = {}, { requireExpectedVersion = false } = {}) {
  const templateId = Number(data.template_id);
  if (!Number.isSafeInteger(templateId) || templateId < 1) {
    throw syncError('模板 ID 无效');
  }
  const whitelistIds = normalizeIds(data.whitelist_ids);
  const expectedTemplateVersion = data.expected_template_version == null
    ? null : Number(data.expected_template_version);
  if (requireExpectedVersion
      && (!Number.isSafeInteger(expectedTemplateVersion) || expectedTemplateVersion < 1)) {
    throw syncError('执行同步必须携带模板版本');
  }
  if (expectedTemplateVersion !== null
      && (!Number.isSafeInteger(expectedTemplateVersion) || expectedTemplateVersion < 1)) {
    throw syncError('模板版本无效');
  }
  return { templateId, whitelistIds, expectedTemplateVersion };
}

function templateTradeConfig(snapshot) {
  const legacy = legacyPercentages(snapshot.exit_strategy);
  return {
    budget_per_trade: Number(snapshot.budget_per_trade),
    total_budget: Number(snapshot.total_budget),
    slippage: Number(snapshot.slippage),
    allow_repeat_buy: Boolean(snapshot.allow_repeat_buy),
    max_repeat_buys: Number(snapshot.max_repeat_buys || 1),
    exit_strategy: snapshot.exit_strategy,
    auto_tp_pct: Number(legacy.auto_tp_pct),
    auto_sl_pct: Number(legacy.auto_sl_pct)
  };
}

function currentTradeConfig(row) {
  return {
    budget_per_trade: Number(row.budget_per_trade),
    total_budget: Number(row.total_budget),
    slippage: Number(row.slippage),
    allow_repeat_buy: Boolean(row.allow_repeat_buy),
    max_repeat_buys: Number(row.max_repeat_buys || 1),
    exit_strategy: row.exit_strategy || null,
    exit_strategy_version: Number(row.exit_strategy_version || 1),
    auto_tp_pct: Number(row.auto_tp_pct),
    auto_sl_pct: Number(row.auto_sl_pct)
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function changedConfigFields(current, desired) {
  const fields = [
    'budget_per_trade', 'total_budget', 'slippage', 'allow_repeat_buy',
    'max_repeat_buys', 'auto_tp_pct', 'auto_sl_pct'
  ];
  return [
    ...fields.filter((field) => current[field] !== desired[field]),
    ...(sameJson(current.exit_strategy, desired.exit_strategy) ? [] : ['exit_strategy'])
  ];
}

function summarizeConfig(config) {
  return {
    budget_per_trade: config.budget_per_trade,
    total_budget: config.total_budget,
    slippage: config.slippage,
    allow_repeat_buy: config.allow_repeat_buy,
    max_repeat_buys: config.max_repeat_buys,
    exit_strategy: config.exit_strategy,
    exit_strategy_version: config.exit_strategy_version || 1,
    auto_tp_pct: config.auto_tp_pct,
    auto_sl_pct: config.auto_sl_pct
  };
}

function reason(code, detail) {
  return { outcome: 'skipped', reason_code: code, reason_detail: detail };
}

function evaluateTarget(row, context, desired) {
  if (!row) return reason(SKIP.NOT_FOUND, '目标固定 CA 不存在');
  if (row.status === 'archived') return reason(SKIP.ARCHIVED, '目标固定 CA 已归档');
  if (row.source !== 'manual') return reason(SKIP.NON_FIXED, '只允许同步已知 CA 固定策略');
  if (String(row.chain_id).toLowerCase() !== String(context.template.chain_id).toLowerCase()) {
    return reason(SKIP.CHAIN_MISMATCH, '模板与目标 CA 不属于同一条链');
  }
  if (context.acceptanceIds.has(Number(row.id))) {
    return reason(SKIP.ACCEPTANCE_SCOPE, '目标 CA 正处于实盘验收作用域，未修改');
  }
  if (Number(context.legacySignalCounts.get(Number(row.id)) || 0) > 0) {
    return reason(SKIP.LEGACY_SIGNAL, '存在没有 P42 配置快照的待执行旧信号，未修改');
  }

  const committed = Number(row.spent_budget || 0)
    + Number(context.reservedBudgets.get(Number(row.id)) || 0);
  if (!Number.isFinite(committed) || desired.total_budget < committed) {
    return reason(SKIP.BUDGET_BELOW_COMMITTED, '模板累计预算低于已花预算和当前预留金额');
  }

  const completedBuys = Number(row.current_buy_count || 0);
  const pendingBuys = Number(context.pendingBuyCounts.get(Number(row.id)) || 0);
  const maximumBuys = desired.allow_repeat_buy ? desired.max_repeat_buys : 1;
  if (!Number.isSafeInteger(completedBuys) || !Number.isSafeInteger(pendingBuys)
      || maximumBuys < completedBuys + pendingBuys) {
    return reason(SKIP.REPEAT_BELOW_HISTORY, '模板买入上限低于历史买入次数和未完成买入次数');
  }

  const current = currentTradeConfig(row);
  const fields = changedConfigFields(current, desired);
  if (fields.length === 0) return { outcome: 'unchanged', reason_code: null, reason_detail: null };
  return { outcome: 'updated', reason_code: null, reason_detail: null, changed_fields: fields };
}

async function loadPlan(request, executor = db, options = {}) {
  const templateResult = await executor.query(
    'SELECT * FROM whitelist_templates WHERE id = $1 FOR SHARE',
    [request.templateId]
  );
  const template = templateResult.rows[0];
  if (!template) throw syncError('模板不存在', 'TEMPLATE_NOT_FOUND');
  if (request.expectedTemplateVersion !== null
      && Number(template.version) !== request.expectedTemplateVersion) {
    throw syncError('模板已被修改，请重新预览后再同步', 'TEMPLATE_VERSION_CONFLICT');
  }

  let snapshot;
  try {
    snapshot = normalizeTemplateSnapshot(template.template_snapshot);
  } catch (error) {
    throw syncError(`模板配置无效：${error.message}`, 'TEMPLATE_CONFIG_INVALID');
  }
  const desired = {
    ...templateTradeConfig(snapshot),
    exit_strategy_version: 1
  };
  const targetsResult = await executor.query(
    `SELECT * FROM ca_whitelist
     WHERE id = ANY($1::int[])
     ${options.forUpdate ? 'FOR UPDATE' : ''}`,
    [request.whitelistIds]
  );
  const targets = new Map(targetsResult.rows.map((row) => [Number(row.id), row]));
  const [reservationResult, pendingAttemptResult, legacySignalResult, scopeResult] = await Promise.all([
    executor.query(
      `SELECT whitelist_id, COALESCE(SUM(amount_native), 0) AS reserved_total
       FROM budget_reservations
       WHERE status = 'reserved' AND whitelist_id = ANY($1::int[])
       GROUP BY whitelist_id`,
      [request.whitelistIds]
    ),
    executor.query(
      `SELECT whitelist_id, COUNT(*)::int AS pending_count
       FROM trade_attempts
       WHERE side = 'buy' AND status = ANY($1::text[])
         AND whitelist_id = ANY($2::int[])
       GROUP BY whitelist_id`,
      [ACTIVE_BUY_ATTEMPT_STATUSES, request.whitelistIds]
    ),
    executor.query(
      `SELECT whitelist_id, trade_config_snapshot
       FROM trade_signals
       WHERE status = ANY($1::text[]) AND whitelist_id = ANY($2::int[])
       ORDER BY whitelist_id, id`,
      [EXECUTABLE_SIGNAL_STATUSES, request.whitelistIds]
    ),
    executor.query(
      `SELECT whitelist_id
       FROM live_acceptance_scopes
       WHERE status = 'active' AND whitelist_id = ANY($1::int[])`,
      [request.whitelistIds]
    )
  ]);
  const mapBy = (rows, field) => new Map(rows.map((row) => [Number(row.whitelist_id), Number(row[field]) || 0]));
  const legacySignalCounts = new Map();
  for (const row of legacySignalResult.rows) {
    if (!isTradeConfigSnapshot(row.trade_config_snapshot)) {
      const whitelistId = Number(row.whitelist_id);
      legacySignalCounts.set(whitelistId, Number(legacySignalCounts.get(whitelistId) || 0) + 1);
    }
  }
  const context = {
    template,
    acceptanceIds: new Set(scopeResult.rows.map((row) => Number(row.whitelist_id))),
    reservedBudgets: mapBy(reservationResult.rows, 'reserved_total'),
    pendingBuyCounts: mapBy(pendingAttemptResult.rows, 'pending_count'),
    legacySignalCounts
  };
  const items = request.whitelistIds.map((id) => {
    const row = targets.get(id);
    const before = row ? summarizeConfig(currentTradeConfig(row)) : {};
    const decision = evaluateTarget(row, context, desired);
    const after = decision.outcome === 'updated'
      ? summarizeConfig({ ...desired, exit_strategy_version: row.exit_strategy_version + (decision.changed_fields.includes('exit_strategy') ? 1 : 0) })
      : before;
    return {
      whitelist_id: id,
      symbol: row?.symbol || null,
      contract_address: row?.contract_address || null,
      chain_id: row?.chain_id || null,
      outcome: decision.outcome,
      reason_code: decision.reason_code,
      reason_detail: decision.reason_detail,
      changed_fields: decision.changed_fields || [],
      before_config: before,
      after_config: after,
      row
    };
  });
  return {
    template: {
      id: String(template.id),
      name: template.name,
      chain_id: template.chain_id,
      version: Number(template.version),
      template_snapshot: snapshot
    },
    desired,
    items
  };
}

function resultSummary(items) {
  return {
    requested: items.length,
    updated: items.filter((item) => item.outcome === 'updated').length,
    unchanged: items.filter((item) => item.outcome === 'unchanged').length,
    skipped: items.filter((item) => item.outcome === 'skipped').length
  };
}

function publicPlan(plan) {
  return {
    template: plan.template,
    summary: resultSummary(plan.items),
    items: plan.items.map(({ row, ...item }) => item)
  };
}

async function preview(data, executor = db) {
  const request = normalizeRequest(data);
  return publicPlan(await loadPlan(request, executor));
}

async function execute(data, executor = db, options = {}) {
  const request = normalizeRequest(data, { requireExpectedVersion: true });
  const ownsTransaction = executor === db;
  const client = ownsTransaction ? await db.pool.connect() : executor;
  try {
    if (ownsTransaction) await client.query('BEGIN');
    const plan = await loadPlan(request, client, { forUpdate: true });
    const runResult = await client.query(
      `INSERT INTO whitelist_template_sync_runs
        (template_id, template_version, requested_whitelist_ids, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [request.templateId, plan.template.version, request.whitelistIds, options.createdBy || null]
    );
    const runId = Number(runResult.rows[0].id);
    const results = [];
    for (let index = 0; index < plan.items.length; index += 1) {
      const item = plan.items[index];
      let result = item;
      if (item.outcome === 'updated') {
        const savepoint = `p42_template_sync_${index}`;
        await client.query(`SAVEPOINT ${savepoint}`);
        try {
          const current = item.row;
          const after = item.after_config;
          const updated = await client.query(
            `UPDATE ca_whitelist
             SET budget_per_trade = $1, total_budget = $2, slippage = $3,
                 allow_repeat_buy = $4, max_repeat_buys = $5,
                 exit_strategy = $6, exit_strategy_version = $7,
                 auto_tp_pct = $8, auto_sl_pct = $9, updated_at = NOW()
             WHERE id = $10 RETURNING id`,
            [after.budget_per_trade, after.total_budget, after.slippage,
              after.allow_repeat_buy, after.max_repeat_buys, after.exit_strategy,
              after.exit_strategy_version, after.auto_tp_pct, after.auto_sl_pct,
              item.whitelist_id]
          );
          if (updated.rows.length === 0) {
            result = reason(SKIP.NOT_FOUND, '目标固定 CA 在同步过程中已不存在');
          }
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch (error) {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          result = reason('SYNC_ITEM_WRITE_FAILED', `本条未修改：${error.message}`);
        }
      }
      await client.query(
        `INSERT INTO whitelist_template_sync_items
          (run_id, whitelist_id, outcome, reason_code, reason_detail, before_config, after_config)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [runId, item.whitelist_id, result.outcome, result.reason_code,
          result.reason_detail, item.before_config, result.outcome === 'updated' ? item.after_config : item.before_config]
      );
      results.push({ ...item, ...result, row: undefined });
    }
    if (ownsTransaction) await client.query('COMMIT');
    return {
      ...publicPlan({ ...plan, items: results }),
      run_id: runId
    };
  } catch (error) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (ownsTransaction) client.release();
  }
}

module.exports = {
  ACTIVE_BUY_ATTEMPT_STATUSES,
  EXECUTABLE_SIGNAL_STATUSES,
  MAX_TARGETS,
  SKIP,
  execute,
  normalizeRequest,
  preview,
  templateTradeConfig
};
