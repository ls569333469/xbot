-- Deterministic multi-chain EVM resolution can identify the target chain via
-- local RPC before the terminal GMGN swap. Preserve that provenance alongside
-- exact addresses extracted directly from the source event.

ALTER TABLE dynamic_asset_variants
  DROP CONSTRAINT IF EXISTS dynamic_asset_variants_provider_status_check;

ALTER TABLE dynamic_asset_variants
  ADD CONSTRAINT dynamic_asset_variants_provider_status_check
  CHECK (provider_status IN ('unknown', 'verified', 'error', 'local_event', 'local_rpc'));

ALTER TABLE dynamic_ca_resolution_candidates
  DROP CONSTRAINT IF EXISTS dynamic_ca_resolution_candidates_provider_status_check;

ALTER TABLE dynamic_ca_resolution_candidates
  ADD CONSTRAINT dynamic_ca_resolution_candidates_provider_status_check
  CHECK (provider_status IN ('unknown', 'verified', 'error', 'local_event', 'local_rpc'));
