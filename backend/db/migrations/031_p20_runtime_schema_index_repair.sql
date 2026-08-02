-- P20 runtime repair: migration 030 may already be recorded on a database
-- before its index repair statements are applied.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dynamic_paper_session_running
  ON dynamic_paper_sessions(actor_policy_id, policy_revision)
  WHERE status = 'running';

CREATE UNIQUE INDEX IF NOT EXISTS uq_whitelist_dynamic_actor_ca_chain_active
  ON ca_whitelist(actor_policy_id, contract_address, chain_id)
  WHERE status = 'active' AND source = 'dynamic_keyword';

CREATE UNIQUE INDEX IF NOT EXISTS uq_trade_signal_dynamic_resolution
  ON trade_signals(matched_dynamic_resolution_id)
  WHERE matched_dynamic_resolution_id IS NOT NULL;
