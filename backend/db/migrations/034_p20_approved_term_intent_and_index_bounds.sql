-- P20 approved phrases are actionable resolution terms. Provider-owned index
-- values remain bounded so one malformed market row cannot abort a warmup batch.

ALTER TABLE dynamic_ca_resolution_attempts
  DROP CONSTRAINT IF EXISTS dynamic_ca_resolution_attempts_intent_class_check;
ALTER TABLE dynamic_ca_resolution_attempts
  ADD CONSTRAINT dynamic_ca_resolution_attempts_intent_class_check
  CHECK(intent_class IN(
    'buy_direct','launch_direct','full_ca_solo','approved_term_direct','neutral_reference',
    'comparison_or_list','historical_review','sell_or_exit',
    'negative_or_warning','security_incident','quoted_only',
    'multi_asset_ambiguous','unknown'
  ));

ALTER TABLE dynamic_asset_families
  DROP CONSTRAINT IF EXISTS dynamic_asset_families_identity_key_size_check;
ALTER TABLE dynamic_asset_families
  ADD CONSTRAINT dynamic_asset_families_identity_key_size_check
  CHECK(octet_length(identity_key) <= 1024);

ALTER TABLE dynamic_candidate_index
  DROP CONSTRAINT IF EXISTS dynamic_candidate_index_key_size_check;
ALTER TABLE dynamic_candidate_index
  ADD CONSTRAINT dynamic_candidate_index_key_size_check
  CHECK(octet_length(normalized_key) <= 1024);

ALTER TABLE dynamic_candidate_index
  DROP CONSTRAINT IF EXISTS dynamic_candidate_index_source_ref_size_check;
ALTER TABLE dynamic_candidate_index
  ADD CONSTRAINT dynamic_candidate_index_source_ref_size_check
  CHECK(source_ref IS NULL OR octet_length(source_ref) <= 1024);
