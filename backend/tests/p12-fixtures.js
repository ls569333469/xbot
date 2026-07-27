async function createTradeIntent(db, values = {}) {
  const suffix = values.suffix || `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const chain = values.chain || 'sol';
  const walletAddress = values.walletAddress || `P12Wallet${suffix}`;
  const contractAddress = values.contractAddress || `P12Token${suffix}`;
  const side = values.side || 'buy';
  const result = await db.query(
    `INSERT INTO trade_intents(
       source_key, scope_key, side, signal_id, position_id, whitelist_id,
       chain, wallet_address, contract_address, wallet_lane_key, status,
       max_retries, retry_count, expires_at, config_snapshot_json
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'{}')
     RETURNING *`,
    [
      values.sourceKey || `test:${side}:source:${suffix}`,
      values.scopeKey || `test:${side}:scope:${suffix}`,
      side,
      values.signalId || null,
      values.positionId || null,
      values.whitelistId || null,
      chain,
      walletAddress,
      contractAddress,
      `wallet_lane:${chain}:${chain === 'sol' ? walletAddress : walletAddress.toLowerCase()}`,
      values.status || 'created',
      values.maxRetries || 0,
      values.retryCount || 0,
      values.expiresAt || null
    ]
  );
  return result.rows[0];
}

module.exports = { createTradeIntent };
