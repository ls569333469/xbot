-- P16 final audit closure: durable cancellation/concurrency metadata and prompt v3.
-- This migration only extends research tables and does not touch trading state.

ALTER TABLE research_jobs
  DROP CONSTRAINT IF EXISTS research_jobs_status_check;
ALTER TABLE research_jobs
  ADD CONSTRAINT research_jobs_status_check
    CHECK(status IN('pending','running','completed','partial','failed','cancelled'));
ALTER TABLE research_jobs
  ADD COLUMN IF NOT EXISTS cancelled_count int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS concurrency_limit int NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE research_jobs
  DROP CONSTRAINT IF EXISTS research_jobs_concurrency_limit_check;
ALTER TABLE research_jobs
  ADD CONSTRAINT research_jobs_concurrency_limit_check
    CHECK(concurrency_limit BETWEEN 1 AND 3);
ALTER TABLE research_jobs
  ALTER COLUMN prompt_version SET DEFAULT 'p16-project-team-v3';

ALTER TABLE research_job_items
  DROP CONSTRAINT IF EXISTS research_job_items_status_check;
ALTER TABLE research_job_items
  ADD CONSTRAINT research_job_items_status_check
    CHECK(status IN('queued','gmgn','grok','verification','completed','failed','cancelled'));

ALTER TABLE token_research_reports
  ALTER COLUMN prompt_version SET DEFAULT 'p16-project-team-v3';
