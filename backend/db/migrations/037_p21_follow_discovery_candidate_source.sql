-- P21: allow verified follow-discovery candidates in the shared P20 index.

ALTER TABLE dynamic_candidate_index
  DROP CONSTRAINT IF EXISTS dynamic_candidate_index_source_type_check;

ALTER TABLE dynamic_candidate_index
  ADD CONSTRAINT dynamic_candidate_index_source_type_check
  CHECK (source_type IN (
    'tweet_ca', 'tweet_url', 'project_account', 'research', 'whitelist',
    'gmgn_rank', 'gmgn_hot', 'gmgn_trenches', 'gmgn_info', 'follow_discovery'
  ));
