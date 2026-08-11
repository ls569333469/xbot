const crypto = require('crypto');
const db = require('../../lib/db');
const { chainBudgetFor } = require('./policy-service');
const { legacyPercentages } = require('../trade/exit-strategy-compiler');

async function materialize(job, attempt, selected, executor = db) {
  if (!selected || !['paper', 'live'].includes(job.mode)) return null;
  const policyResult = await executor.query(
    'SELECT * FROM x_actor_dynamic_policies WHERE id = $1 FOR SHARE', [job.actor_policy_id]
  );
  const policy = policyResult.rows[0];
  if (!policy || !policy.enabled || Number(policy.revision) !== Number(job.policy_revision)
      || policy.context_hash !== job.context_hash) {
    const error = new Error('Dynamic policy changed before target materialization');
    error.code = 'DYNAMIC_POLICY_CHANGED';
    throw error;
  }
  const chainBudget = chainBudgetFor(policy, selected.chainId);
  if (!chainBudget) {
    const error = new Error(`Dynamic chain budget is not configured: ${selected.chainId}`);
    error.code = 'DYNAMIC_CHAIN_BUDGET_NOT_CONFIGURED';
    throw error;
  }
  const config = {
    chain_id: selected.chainId,
    budget_per_trade: chainBudget.budget_per_trade,
    daily_budget: chainBudget.daily_budget,
    slippage: Number(policy.slippage), exit_strategy: policy.exit_strategy,
    policy_revision: Number(policy.revision), policy_context_hash: policy.context_hash
  };
  const legacy = legacyPercentages(policy.exit_strategy);
  const targetResult = await executor.query(
    `INSERT INTO dynamic_targets
      (actor_policy_id, actor_policy_revision, resolution_attempt_id, variant_id,
       chain_id, contract_address, mode, config_snapshot, context_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (actor_policy_id, chain_id, contract_address) DO UPDATE SET
       actor_policy_revision = EXCLUDED.actor_policy_revision,
       resolution_attempt_id = EXCLUDED.resolution_attempt_id,
       variant_id = EXCLUDED.variant_id, mode = EXCLUDED.mode, status = 'active',
       config_snapshot = EXCLUDED.config_snapshot, context_hash = EXCLUDED.context_hash,
       updated_at = NOW() RETURNING *`,
    [policy.id, policy.revision, attempt.id, selected.variantId || selected.id,
      selected.chainId, selected.contractAddress, job.mode, config, policy.context_hash]
  );
  const target = targetResult.rows[0];
  const whitelistResult = await executor.query(
    `INSERT INTO ca_whitelist
      (contract_address, chain_id, symbol, project_name, budget_per_trade, total_budget,
       auto_tp_pct, auto_sl_pct, slippage, allow_repeat_buy, max_repeat_buys,
       source, managed_by_system, dynamic_target_id, actor_policy_id, actor_policy_revision,
       exit_strategy, live_activation_state, activation_context_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'dynamic_keyword',true,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (actor_policy_id, contract_address, chain_id)
       WHERE status = 'active' AND source = 'dynamic_keyword'
     DO UPDATE SET symbol = EXCLUDED.symbol, project_name = EXCLUDED.project_name,
       budget_per_trade = EXCLUDED.budget_per_trade, total_budget = EXCLUDED.total_budget,
       slippage = EXCLUDED.slippage, allow_repeat_buy = EXCLUDED.allow_repeat_buy,
       max_repeat_buys = EXCLUDED.max_repeat_buys, dynamic_target_id = EXCLUDED.dynamic_target_id,
       actor_policy_revision = EXCLUDED.actor_policy_revision,
       exit_strategy = EXCLUDED.exit_strategy,
       live_activation_state = EXCLUDED.live_activation_state,
       activation_context_hash = EXCLUDED.activation_context_hash, updated_at = NOW()
     RETURNING *`,
    [selected.contractAddress, selected.chainId, selected.symbol || null, selected.name || selected.symbol || null,
       chainBudget.budget_per_trade, chainBudget.daily_budget, legacy.auto_tp_pct, legacy.auto_sl_pct,
      policy.slippage, policy.per_token_buy_limit > 1, policy.per_token_buy_limit, target.id, policy.id,
      policy.revision, policy.exit_strategy, 'live_ready',
      crypto.createHash('sha256').update(policy.context_hash).digest('hex')]
  );
  const whitelist = whitelistResult.rows[0];
  await executor.query(
    'UPDATE dynamic_targets SET whitelist_id = $2, updated_at = NOW() WHERE id = $1',
    [target.id, whitelist.id]
  );
  return {
    ...target,
    whitelist_id: whitelist.id,
    activation_version: whitelist.activation_version,
    whitelist
  };
}

async function createSignal(job, attempt, target, result, executor = db) {
  if (!target) return null;
  const status = job.mode === 'live' ? 'recorded' : job.mode === 'paper' ? 'recorded' : 'signal_only';
  const signalResult = await executor.query(
    `INSERT INTO trade_signals
      (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail,
       execution_mode, status, canonical_key, matched_whitelist_ids,
       matched_dynamic_resolution_id, dynamic_target_id, actor_policy_id,
       actor_policy_revision, dynamic_policy_context_hash, dynamic_intent_class,
       dynamic_intent_reason_codes, dynamic_intent_rule_revision, dynamic_authorization,
       activation_wait_version)
     VALUES ($1,$2,$3,$4,'dynamic_keyword',$5,$6,$7,$8,ARRAY[$2]::int[],$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (matched_dynamic_resolution_id) WHERE matched_dynamic_resolution_id IS NOT NULL
     DO NOTHING RETURNING *`,
    [job.x_activity_id, target.whitelist_id, job.kol_id, job.kol_handle,
      `${target.chain_id}:${target.contract_address}`, job.mode, status,
      `dynamic:${attempt.id}`, attempt.id, target.id, job.actor_policy_id,
      job.policy_revision, job.context_hash, result.intent?.intentClass || 'unknown',
      result.intent?.reasonCodes || [], result.intent?.ruleRevision || 'unknown',
      { resolver_revision: result.resolverRevision, resolution_confidence: result.confidence },
      null]
  );
  return signalResult.rows[0] || null;
}

module.exports = { createSignal, materialize };
