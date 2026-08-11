-- P24 accepts an exact CA from the current Grok/6551 event without a GMGN
-- candidate-verification round trip. Preserve that source state explicitly.

ALTER TABLE dynamic_asset_variants
  DROP CONSTRAINT IF EXISTS dynamic_asset_variants_provider_status_check;

ALTER TABLE dynamic_asset_variants
  ADD CONSTRAINT dynamic_asset_variants_provider_status_check
  CHECK (provider_status IN ('unknown', 'verified', 'error', 'local_event'));

ALTER TABLE dynamic_ca_resolution_candidates
  DROP CONSTRAINT IF EXISTS dynamic_ca_resolution_candidates_provider_status_check;

ALTER TABLE dynamic_ca_resolution_candidates
  ADD CONSTRAINT dynamic_ca_resolution_candidates_provider_status_check
  CHECK (provider_status IN ('unknown', 'verified', 'error', 'local_event'));
