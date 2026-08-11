-- P25: align the cross-process GMGN bucket with the largest initial buy session.

UPDATE gmgn_rate_limit_state
SET capacity = GREATEST(capacity, 6),
    available_tokens = LEAST(available_tokens, GREATEST(capacity, 6)),
    updated_at = NOW()
WHERE capacity < 6
   OR available_tokens > GREATEST(capacity, 6);
