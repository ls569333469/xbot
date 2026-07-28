const db = require('../../lib/db');
const { normalizeXHandles } = require('../../lib/x-handles');
const { validateTokenAddress } = require('../trade/chain-adapters');
const launchQueries = require('../launch-monitor/queries');
const whitelistQueries = require('../whitelist/queries');
const { enqueueWhitelistActivation } = require('../whitelist/activation-outbox');
const {
  normalizeProjectAccounts,
  normalizeRelationInputs,
  normalizeSourceInputs,
  syncWhitelistProjectAccounts,
  syncWhitelistRelations,
  syncWhitelistSourceRules
} = require('../whitelist/relations');
const signalQueries = require('./queries');

const EVM_CHAINS = new Set(['bsc', 'base', 'eth', 'robinhood']);

function targetHandles(activity) {
  return new Set(normalizeXHandles([
    ...(activity.target_x_handles || []),
    activity.target_x_handle
  ]));
}

function validCandidates(activity, chainId) {
  const candidates = new Set();
  for (const value of activity.extracted_cas || []) {
    try {
      candidates.add(validateTokenAddress(chainId, value));
    } catch {}
  }
  return [...candidates];
}

async function loadTriggers(activity, executor) {
  const eventType = String(activity.activity_type || '').trim().toLowerCase();
  const result = await executor.query(
    `SELECT rule.*, 'project_source'::text AS trigger_kind,
            source.id AS trigger_id, actor.x_handle AS actor_handle,
            NULL::text AS target_x_handle
     FROM project_launch_rules AS rule
     JOIN project_launch_sources AS source
       ON source.launch_rule_id = rule.id AND source.enabled = true
     JOIN x_kol_accounts AS actor
       ON actor.id = source.actor_id AND actor.enabled = true
     WHERE source.actor_id = $1 AND $2 = ANY(source.event_types)
       AND rule.status = 'active' AND rule.discovery_count = 0
       AND (rule.expires_at IS NULL OR rule.expires_at > NOW())
     UNION ALL
     SELECT rule.*, 'ecosystem_relation'::text AS trigger_kind,
            relation.id AS trigger_id, actor.x_handle AS actor_handle,
            relation.target_x_handle
     FROM project_launch_rules AS rule
     JOIN project_launch_relations AS relation
       ON relation.launch_rule_id = rule.id AND relation.enabled = true
     JOIN x_kol_accounts AS actor
       ON actor.id = relation.actor_id AND actor.enabled = true
     WHERE relation.actor_id = $1 AND $2 = ANY(relation.event_types)
       AND rule.status = 'active' AND rule.discovery_count = 0
       AND (rule.expires_at IS NULL OR rule.expires_at > NOW())
     ORDER BY id, trigger_kind DESC`,
    [Number(activity.kol_id), eventType]
  );
  const targets = targetHandles(activity);
  const selected = new Map();
  for (const row of result.rows) {
    if (row.trigger_kind === 'ecosystem_relation'
        && !targets.has(normalizeXHandles([row.target_x_handle])[0])) continue;
    const current = selected.get(Number(row.id));
    if (!current || row.trigger_kind === 'project_source') {
      selected.set(Number(row.id), row);
    }
  }
  return [...selected.values()];
}

async function logSkipped(executor, message, meta) {
  await executor.query(
    `INSERT INTO system_logs(level, module, message, meta)
     VALUES ('warn','launch-monitor',$1,$2)`,
    [message, meta]
  );
}

async function loadRuleRelations(ruleId, executor) {
  const result = await executor.query(
    `SELECT actor.x_handle AS actor_handle, relation.target_x_handle,
            relation.event_types
     FROM project_launch_relations AS relation
     JOIN x_kol_accounts AS actor ON actor.id = relation.actor_id
     WHERE relation.launch_rule_id = $1
       AND relation.enabled = true AND actor.enabled = true
     ORDER BY relation.id`,
    [ruleId]
  );
  return result.rows;
}

async function loadRuleSources(ruleId, executor) {
  const result = await executor.query(
    `SELECT actor.x_handle AS actor_handle, source.role, source.event_types
     FROM project_launch_sources AS source
     JOIN x_kol_accounts AS actor ON actor.id = source.actor_id
     WHERE source.launch_rule_id = $1
       AND source.enabled = true AND actor.enabled = true
     ORDER BY source.id`,
    [ruleId]
  );
  return result.rows;
}

function fixedSignalFor(existingSignals, chainId, contractAddress) {
  return (existingSignals || []).find((signal) => (
    String(signal.chain_id).toLowerCase() === chainId
    && String(signal.contract_address).toLowerCase() === String(contractAddress).toLowerCase()
  ));
}

async function consumeRule(rule, activity, contractAddress, executor, options = {}) {
  const chainId = String(rule.chain_id).toLowerCase();
  await executor.query(
    'SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))',
    [chainId, contractAddress]
  );
  const lockedRule = await launchQueries.getById(rule.id, executor, { forUpdate: true });
  if (!lockedRule || lockedRule.status !== 'active' || Number(lockedRule.discovery_count) !== 0) {
    return null;
  }
  if (lockedRule.expires_at && new Date(lockedRule.expires_at).getTime() <= Date.now()) {
    await launchQueries.updateStatus(lockedRule.id, 'expired', executor);
    return null;
  }

  const prior = await executor.query(
    `SELECT * FROM project_launch_discoveries
     WHERE chain_id = $1 AND contract_address = $2
     ORDER BY created_at, id LIMIT 1`,
    [chainId, contractAddress]
  );
  if (prior.rows[0]) {
    await executor.query(
      `INSERT INTO project_launch_discoveries(
         launch_rule_id, activity_id, chain_id, contract_address, whitelist_id,
         signal_id, trigger_kind, actor_handle, target_x_handle
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT DO NOTHING`,
      [
        lockedRule.id, activity.id, chainId, contractAddress,
        prior.rows[0].whitelist_id, prior.rows[0].signal_id,
        rule.trigger_kind, normalizeXHandles([rule.actor_handle])[0],
        rule.target_x_handle || null
      ]
    );
    await executor.query(
      `UPDATE project_launch_rules
       SET status = 'triggered', discovery_count = 1,
           triggered_at = NOW(), updated_at = NOW()
       WHERE id = $1`,
      [lockedRule.id]
    );
    return null;
  }

  const launchSources = await loadRuleSources(lockedRule.id, executor);
  const launchRelations = await loadRuleRelations(lockedRule.id, executor);
  let whitelist = await whitelistQueries.getActiveByContract(
    contractAddress,
    chainId,
    executor,
    { forUpdate: true }
  );
  let createdWhitelist = false;
  if (!whitelist) {
    whitelist = await whitelistQueries.create({
      contract_address: contractAddress,
      chain_id: chainId,
      symbol: null,
      project_name: lockedRule.project_name || null,
      project_x_handles: launchSources.map((source) => normalizeXHandles([source.actor_handle])[0]),
      budget_per_trade: lockedRule.budget_per_trade,
      total_budget: lockedRule.total_budget,
      exit_strategy: lockedRule.exit_strategy,
      exit_strategy_version: lockedRule.exit_strategy_version,
      slippage: lockedRule.slippage,
      allow_repeat_buy: lockedRule.allow_repeat_buy,
      max_repeat_buys: lockedRule.max_repeat_buys,
      status: 'active',
      source: 'semi-auto',
      launch_rule_id: lockedRule.id
    }, executor);
    createdWhitelist = true;
  }
  const hydrated = await whitelistQueries.getById(whitelist.id, executor);
  const relations = normalizeRelationInputs([
    ...(hydrated.relations || []).filter((item) => item.enabled !== false),
    ...launchRelations
  ]);
  const sources = normalizeSourceInputs([
    ...(hydrated.direct_sources || []).filter((item) => (
      item.enabled !== false && item.source_kind !== 'project'
    )),
    {
      actor_handle: rule.actor_handle,
      event_types: [String(activity.activity_type).toLowerCase()],
      match_mode: 'ca_only',
      source_kind: 'launch',
      role: 'launch_origin'
    }
  ]);
  await syncWhitelistRelations(whitelist.id, relations, executor);
  await syncWhitelistSourceRules(whitelist.id, sources, executor);
  await syncWhitelistProjectAccounts(
    whitelist.id,
    normalizeProjectAccounts([
      ...(hydrated.project_accounts || []),
      ...launchSources.map((source) => ({
        handle: source.actor_handle,
        role: source.role,
        usage: 'identity'
      })),
      ...launchRelations.map((relation) => ({
        handle: relation.target_x_handle,
        role: 'project',
        usage: 'interaction_target'
      }))
    ], relations, sources),
    executor
  );
  const activation = await enqueueWhitelistActivation(
    whitelist.id,
    executor,
    { increment: !createdWhitelist }
  );
  whitelist = await whitelistQueries.getById(whitelist.id, executor);

  const fixedSignal = fixedSignalFor(options.existingSignals, chainId, contractAddress);
  let signal = fixedSignal || null;
  let signalCreated = false;
  if (!signal) {
    const actorHandle = normalizeXHandles([rule.actor_handle])[0];
    const matchedRelations = rule.trigger_kind === 'ecosystem_relation'
      ? whitelist.relations.filter((relation) => (
        normalizeXHandles([relation.actor_handle])[0] === actorHandle
        && normalizeXHandles([relation.target_x_handle])[0]
          === normalizeXHandles([rule.target_x_handle])[0]
        && relation.event_types.includes(String(activity.activity_type).toLowerCase())
      ))
      : [];
    const matchedSources = rule.trigger_kind === 'project_source'
      ? whitelist.direct_sources.filter((source) => (
        source.source_kind === 'launch'
        && normalizeXHandles([source.actor_handle])[0] === actorHandle
      ))
      : [];
    const canonicalKey = `launch:${activity.semantic_key || activity.id}|chain:${chainId}|ca:${contractAddress}`;
    signal = await signalQueries.createSignal({
      activity_id: activity.id,
      trace_id: activity.trace_id,
      whitelist_id: whitelist.id,
      kol_id: activity.kol_id,
      kol_handle: activity.kol_handle,
      signal_type: 'ca_mention',
      match_detail: contractAddress,
      canonical_key: canonicalKey,
      contract_address: contractAddress,
      chain_id: chainId,
      matched_project_handles: [rule.target_x_handle || actorHandle].filter(Boolean),
      matched_whitelist_ids: [Number(whitelist.id)],
      matched_relation_ids: matchedRelations.map((item) => Number(item.id)),
      matched_source_rule_ids: matchedSources.map((item) => Number(item.id)),
      activation_wait_version: activation?.activation_version
    }, executor, { notify: false });
    signalCreated = Boolean(signal);
    if (!signal) {
      const existingSignal = await executor.query(
        `SELECT * FROM trade_signals
         WHERE canonical_key = $1
            OR (activity_id = $2 AND whitelist_id = $3 AND signal_type = 'ca_mention')
         ORDER BY (canonical_key = $1) DESC, id
         LIMIT 1`,
        [canonicalKey, activity.id, whitelist.id]
      );
      signal = existingSignal.rows[0] || null;
    }
  }

  await executor.query(
    `INSERT INTO project_launch_discoveries(
       launch_rule_id, activity_id, chain_id, contract_address, whitelist_id,
       signal_id, trigger_kind, actor_handle, target_x_handle
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      lockedRule.id, activity.id, chainId, contractAddress, whitelist.id,
      signal?.id || null, rule.trigger_kind,
      normalizeXHandles([rule.actor_handle])[0], rule.target_x_handle || null
    ]
  );
  await executor.query(
    `UPDATE project_launch_rules
     SET status = 'triggered', discovery_count = 1,
         triggered_at = NOW(), updated_at = NOW()
     WHERE id = $1`,
    [lockedRule.id]
  );
  return signalCreated ? signal : null;
}

async function matchLaunchActivity(activity, executor, options = {}) {
  if (!(activity.extracted_cas || []).length) return [];
  if (executor === db) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await matchLaunchActivity(activity, client, options);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  const triggers = await loadTriggers(activity, executor);
  const prepared = [];
  for (const trigger of triggers) {
    const candidates = validCandidates(activity, trigger.chain_id);
    if (candidates.length !== 1) {
      if (candidates.length > 1) {
        await logSkipped(executor, 'LAUNCH_EVENT_MULTIPLE_CA', {
          activity_id: activity.id,
          launch_rule_id: Number(trigger.id),
          candidate_count: candidates.length
        });
      }
      continue;
    }
    prepared.push({ trigger, contractAddress: candidates[0] });
  }

  const evmGroups = new Map();
  for (const item of prepared.filter((entry) => EVM_CHAINS.has(entry.trigger.chain_id))) {
    const group = evmGroups.get(item.contractAddress) || new Set();
    group.add(item.trigger.chain_id);
    evmGroups.set(item.contractAddress, group);
  }
  const ambiguousEvm = new Set([...evmGroups.entries()]
    .filter(([, chains]) => chains.size > 1)
    .map(([address]) => address));
  if (ambiguousEvm.size > 0) {
    await logSkipped(executor, 'LAUNCH_EVENT_EVM_CHAIN_AMBIGUOUS', {
      activity_id: activity.id,
      contract_addresses: [...ambiguousEvm]
    });
  }

  const signals = [];
  for (const item of prepared) {
    if (ambiguousEvm.has(item.contractAddress)) continue;
    const signal = await consumeRule(
      item.trigger,
      activity,
      item.contractAddress,
      executor,
      options
    );
    if (signal) signals.push(signal);
  }
  return signals;
}

module.exports = {
  matchLaunchActivity,
  validCandidates
};
