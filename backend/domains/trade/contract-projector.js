const CONTRACT_VERSION = 'p27.v1';
const STRATEGY_TYPES = new Set(['fixed_ca', 'dynamic_policy', 'follow_discovery']);

function text(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function strategyType(row = {}, allowUnknown = true) {
  if (STRATEGY_TYPES.has(row.strategy_type)) return row.strategy_type;
  if (row.follow_discovery_policy_id) return 'follow_discovery';
  if (row.actor_policy_id) return 'dynamic_policy';
  if (row.signal_id || row.whitelist_id) return 'fixed_ca';
  return allowUnknown ? 'unknown' : 'fixed_ca';
}

function shortenedAddress(value) {
  const address = text(value);
  if (!address || address.length <= 14) return address || 'Unknown asset';
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function asset(row = {}) {
  const snapshot = row.asset_snapshot && typeof row.asset_snapshot === 'object'
    ? row.asset_snapshot : {};
  const gmgnSymbol = text(row.gmgn_asset_symbol);
  const gmgnName = text(row.gmgn_asset_name);
  const symbol = gmgnSymbol || text(snapshot.symbol ?? row.symbol);
  const name = gmgnName || text(snapshot.name ?? row.project_name);
  const contractAddress = text(snapshot.contract_address ?? row.contract_address
    ?? row.output_token ?? row.input_token);
  const metadataSource = gmgnSymbol || gmgnName || text(row.gmgn_asset_logo_url)
    ? 'gmgn_shared'
    : snapshot.snapshot_version
    ? 'signal_snapshot'
    : symbol || name ? 'whitelist' : 'address_fallback';
  return {
    symbol,
    name,
    logo_url: text(row.gmgn_asset_logo_url) || text(snapshot.logo_url ?? row.logo_url),
    display_label: symbol || name || shortenedAddress(contractAddress),
    metadata_source: metadataSource
  };
}

function executionDecision(row = {}) {
  const finalStatus = row.trade_attempt_status || row.attempt_status;
  if (!row.trade_attempt_id && !row.attempt_id) {
    const snapshot = row.authorization_snapshot?.execution_decision;
    return snapshot && snapshot.status === 'unknown'
      ? { status: 'unknown', blockers: snapshot.blockers || [] }
      : { status: 'not_attempted', blockers: [] };
  }
  if (['rejected', 'failed'].includes(finalStatus)) {
    return { status: 'denied', blockers: [row.trade_error_code || row.error_code].filter(Boolean) };
  }
  return { status: 'allowed', blockers: [] };
}

function executionBlockers(row = {}, decision = executionDecision(row)) {
  return [...new Set([
    ...(decision.blockers || []),
    ...(['rejected', 'failed'].includes(row.status) ? [row.reject_reason] : [])
  ].filter(Boolean))];
}

function riskProjection(row = {}, blockers = []) {
  const snapshot = row.risk_check && typeof row.risk_check === 'object' ? row.risk_check : {};
  const reasons = Array.isArray(snapshot.reasons) ? snapshot.reasons.filter(Boolean) : [];
  const warnings = Array.isArray(snapshot.warnings) ? snapshot.warnings.filter(Boolean) : [];
  const blockerSet = new Set(blockers);
  const hardFailures = reasons.filter((reason) => blockerSet.has(reason));
  return {
    warnings: [...new Set([...warnings, ...reasons.filter((reason) => !blockerSet.has(reason))])],
    hard_failures: [...new Set(hardFailures)]
  };
}

function projectSignal(row, currentProjection = { status: 'unknown', blockers: [] }) {
  const projectedAsset = asset(row);
  const policySnapshot = row.authorization_snapshot?.signal_policy_snapshot || {};
  const decision = executionDecision(row);
  const blockers = executionBlockers(row, decision);
  const execution = {
    mode: row.execution_mode ?? null,
    status: row.status ?? null,
    intent_id: row.trade_intent_id ?? null,
    attempt_id: row.trade_attempt_id ?? null,
    order_id: row.order_id ?? null,
    tx_hash: row.tx_hash ?? null,
    blockers
  };
  return {
    ...row,
    contract_version: CONTRACT_VERSION,
    strategy_type: strategyType(row, false),
    chain_id: row.chain_id,
    contract_address: row.contract_address,
    symbol: projectedAsset.symbol,
    project_name: projectedAsset.name,
    asset: projectedAsset,
    settlement: {
      token_decimals: row.output_decimals ?? row.gmgn_asset_decimals ?? null,
      source: row.output_decimals != null ? 'order_report'
        : row.gmgn_asset_decimals != null ? 'gmgn_shared' : 'unavailable'
    },
    project: {
      name: projectedAsset.name,
      handles: row.asset_snapshot?.project_handles || row.matched_project_handles || []
    },
    authorization: {
      signal_policy_snapshot: {
        mode: policySnapshot.mode || 'unknown',
        policy_id: policySnapshot.policy_id ?? null,
        revision: policySnapshot.revision ?? null,
        context_hash: policySnapshot.context_hash ?? null
      },
      execution_decision: decision,
      current_projection: {
        status: currentProjection.status || 'unknown',
        blockers: currentProjection.blockers || []
      }
    },
    live_authorization: currentProjection.status,
    execution,
    risk: riskProjection(row, blockers),
    source: {
      provider: row.provider || '6551',
      activity_id: row.activity_id ?? null,
      trace_id: row.trace_id ?? null
    }
  };
}

function projectPosition(row) {
  const projectedAsset = asset(row);
  const blockers = [row.trade_error_code].filter(Boolean);
  return {
    ...row,
    contract_version: CONTRACT_VERSION,
    strategy_type: strategyType(row),
    symbol: projectedAsset.symbol,
    project_name: projectedAsset.name,
    asset: projectedAsset,
    execution: {
      mode: row.execution_mode ?? null,
      status: row.status ?? null,
      intent_id: row.trade_intent_id ?? null,
      attempt_id: row.trade_attempt_id ?? null,
      order_id: row.order_id ?? null,
      tx_hash: row.sell_tx_hash || row.buy_tx_hash || row.tx_hash || null,
      blockers
    },
    risk: riskProjection(row, blockers)
  };
}

function projectAttempt(row) {
  const latestOrder = Array.isArray(row.orders) ? row.orders.at(-1) : null;
  const order = latestOrder || {
    id: row.order_id ?? null,
    provider_order_id: row.provider_order_id ?? null,
    tx_hash: row.tx_hash ?? null,
    normalized_status: row.order_status ?? null
  };
  const contractAddress = row.contract_address
    || (row.side === 'sell' ? row.input_token : row.output_token);
  const blockers = ['rejected', 'failed'].includes(row.status)
    ? [row.error_code].filter(Boolean) : [];
  return {
    ...row,
    contract_version: CONTRACT_VERSION,
    strategy_type: strategyType(row),
    chain_id: row.chain,
    contract_address: contractAddress,
    asset: asset({ ...row, contract_address: contractAddress }),
    execution: {
      mode: row.execution_mode ?? null,
      status: row.status ?? null,
      intent_id: row.intent_id ?? null,
      attempt_id: row.id ?? null,
      order_id: order?.id ?? null,
      tx_hash: order?.tx_hash ?? null,
      blockers
    },
    risk: riskProjection(row, blockers),
    order: {
      id: order?.id ?? null,
      provider_order_id: order?.provider_order_id ?? null,
      tx_hash: order?.tx_hash ?? null,
      status: order?.normalized_status ?? order?.status ?? null
    }
  };
}

function csvCell(value) {
  let textValue = value == null ? '' : String(value);
  if (/^[=+\-@]/.test(textValue)) textValue = `'${textValue}`;
  return `"${textValue.replaceAll('"', '""')}"`;
}

function closedPositionCsv(rows) {
  const headers = ['ID', '策略', '链', '代币', '合约地址', '投入额', '入场价格', '出场价格',
    '实际盈亏', '盈亏比例(%)', '状态', '开仓时间', '平仓时间'];
  const lines = rows.map((item) => {
    const row = projectPosition(item);
    return [row.id, row.strategy_type, String(row.chain_id || '').toUpperCase(),
      row.asset.display_label, row.contract_address, row.amount_in, row.entry_price,
      row.exit_price, row.pnl, row.pnl_pct, row.status, row.opened_at, row.closed_at]
      .map(csvCell).join(',');
  });
  return `\uFEFF${[headers.map(csvCell).join(','), ...lines].join('\r\n')}\r\n`;
}

module.exports = {
  CONTRACT_VERSION,
  asset,
  closedPositionCsv,
  csvCell,
  projectAttempt,
  projectPosition,
  riskProjection,
  projectSignal,
  shortenedAddress,
  strategyType
};
