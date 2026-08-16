-- P34: make read-only KOL research terminal states explicit.
-- This migration does not touch live signal, execution, order, or position tables.

ALTER TABLE kol_performance_runs
  DROP CONSTRAINT IF EXISTS kol_performance_runs_status_check;

ALTER TABLE kol_performance_runs
  ADD CONSTRAINT kol_performance_runs_status_check
  CHECK (status IN (
    'pending', 'extracting', 'pricing', 'completed', 'no_samples',
    'partial', 'price_retry', 'price_unavailable', 'failed'
  ));
