const crypto = require('crypto');
const db = require('../../lib/db');
const candidateRepository = require('../dynamic-signal/candidate-repository');
const { legacyPercentages } = require('../trade/exit-strategy-compiler');
const { chainBudgetFor } = require('./policy-service');
const { followError } = require('./errors');
const { assetSnapshot, authorizationSnapshot } = require('../signal/contract-snapshot');
const { enqueueEntityEvent } = require('../../lib/entity-outbox');

async function materialize(event, resolution, executor = db) {
  if (!resolution?.selected || !['paper', 'live'].includes(event.mode)) return null;
  const policyResult = await executor.query(
    `SELECT policy.*, kol.enabled AS kol_enabled
     FROM follow_discovery_policies policy
     JOIN x_kol_accounts kol ON kol.id = policy.kol_id
     WHERE policy.id = $1 AND policy.archived_at IS NULL
     FOR SHARE OF policy`, [Number(event.policy_id)]
  );
  const policy = policyResult.rows[0];
  if (!policy || !policy.enabled || !policy.kol_enabled
      || Number(policy.revision) !== Number(event.policy_revision)
      || policy.context_hash !== event.context_hash || policy.mode !== event.mode) {
    throw followError('FOLLOW_POLICY_REVISION_CHANGED', 'Follow discovery policy changed before materialization');
  }
  const selected = resolution.selected;
  const projectName = resolution.profile?.project_name || resolution.research?.project_name
    || selected.name || selected.symbol || null;
  const projectHandle = resolution.profile?.project_handle || resolution.research?.project_handle
    || selected.owner_handle || event.target_handle;
  selected.name = selected.name || projectName;
  selected.xHandles = [...new Set([...(selected.xHandles || []), projectHandle].filter(Boolean))];
  const budget = chainBudgetFor(policy, selected.chainId);
  if (!budget) throw followError('FOLLOW_CHAIN_BUDGET_NOT_CONFIGURED', 'Follow discovery chain budget is missing');
  const variant = await candidateRepository.upsertCandidate(
    selected, 'follow_discovery', executor, { sourceRef: String(event.id) }
  );
  if (!variant) throw followError('FOLLOW_VARIANT_MATERIALIZATION_FAILED', 'Verified candidate could not be materialized');
  const strategy = policy.trade_config_snapshot?.exit_strategy || {};
  const legacy = legacyPercentages(strategy);
  const configHash = crypto.createHash('sha256').update(policy.context_hash).digest('hex');
  const whitelistResult = await executor.query(
    `INSERT INTO ca_whitelist
      (contract_address, chain_id, symbol, project_name, budget_per_trade, total_budget,
       auto_tp_pct, auto_sl_pct, slippage, allow_repeat_buy, max_repeat_buys,
       source, managed_by_system, follow_discovery_policy_id, follow_discovery_event_id,
       exit_strategy, live_activation_state, activation_context_hash,
       provider_verification_snapshot)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'follow_discovery',true,$12,$13,$14,'live_ready',$15,$16)
     ON CONFLICT (follow_discovery_policy_id, contract_address, chain_id)
       WHERE status = 'active' AND source = 'follow_discovery'
     DO UPDATE SET symbol = EXCLUDED.symbol, project_name = EXCLUDED.project_name,
       budget_per_trade = EXCLUDED.budget_per_trade, total_budget = EXCLUDED.total_budget,
       slippage = EXCLUDED.slippage, allow_repeat_buy = EXCLUDED.allow_repeat_buy,
       max_repeat_buys = EXCLUDED.max_repeat_buys,
       follow_discovery_event_id = EXCLUDED.follow_discovery_event_id,
       exit_strategy = EXCLUDED.exit_strategy, live_activation_state = EXCLUDED.live_activation_state,
       activation_context_hash = EXCLUDED.activation_context_hash,
       provider_verification_snapshot = EXCLUDED.provider_verification_snapshot,
       updated_at = NOW()
     RETURNING *`,
    [selected.contractAddress, selected.chainId, selected.symbol || null,
      projectName, budget.budget_per_trade, budget.daily_budget,
      legacy.auto_tp_pct, legacy.auto_sl_pct, Number(policy.trade_config_snapshot.slippage),
      Number(policy.trade_config_snapshot.per_token_buy_limit) > 1,
      Number(policy.trade_config_snapshot.per_token_buy_limit), policy.id, event.id,
      JSON.stringify(strategy), configHash,
       JSON.stringify(selected.providerSnapshot || selected.localEvidence || {})]
  );
  const whitelist = whitelistResult.rows[0];
  const snapshotInput = {
    execution_mode: event.mode,
    whitelist_id: whitelist.id,
    follow_discovery_policy_id: policy.id,
    follow_discovery_policy_revision: policy.revision,
    follow_discovery_context_hash: policy.context_hash,
    chain_id: selected.chainId,
    contract_address: selected.contractAddress,
    symbol: selected.symbol,
    project_name: projectName,
    project_handle: projectHandle
  };
  const signalResult = await executor.query(
    `INSERT INTO trade_signals
      (activity_id, whitelist_id, kol_id, kol_handle, signal_type, match_detail,
       execution_mode, status, canonical_key, matched_whitelist_ids,
       follow_discovery_policy_id, follow_discovery_event_id,
       follow_discovery_policy_revision, follow_discovery_context_hash,
       activation_wait_version, strategy_type, asset_snapshot, authorization_snapshot)
     VALUES ($1,$2,$3,$4,'follow_discovery',$5,$6,$7,$8,ARRAY[$2]::int[],$9,$10,$11,$12,$13,
       'follow_discovery',$14,$15)
     ON CONFLICT (follow_discovery_event_id) WHERE follow_discovery_event_id IS NOT NULL
     DO NOTHING RETURNING *`,
    [event.x_activity_id, whitelist.id, policy.kol_id, event.actor_handle,
      `${selected.chainId}:${selected.contractAddress}`, event.mode,
      event.mode === 'live' ? 'recorded' : 'signal_only', `follow:${event.id}`,
      policy.id, event.id, policy.revision, policy.context_hash, null,
      assetSnapshot(snapshotInput, 'grok_selected'),
      authorizationSnapshot(snapshotInput, 'follow_discovery')]
  );
  const signal = signalResult.rows[0] || null;
  if (signal) await enqueueEntityEvent(executor, 'signal', signal.id, 'created', `created:${signal.status}`);
  return { variant, whitelist,
    signal };
}

module.exports = { materialize };
