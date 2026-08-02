const db = require('../../lib/db');
const { normalizeXHandle } = require('../../lib/x-handles');

async function createRun(input = {}, executor = db) {
  const handles = [...new Set((input.handles || input.x_handles || [])
    .map(normalizeXHandle).filter(Boolean))];
  if (handles.length === 0 || handles.length > 50) {
    const error = new Error('Screening requires 1 to 50 X handles');
    error.code = 'ACTOR_SCREENING_INPUT_INVALID';
    throw error;
  }
  const result = await executor.query(
    `INSERT INTO x_actor_screening_runs
      (input_handles, sample_started_at, sample_ended_at, screening_revision)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [handles, input.sample_started_at || null, input.sample_ended_at || null, 'p20-screen-v1']
  );
  const run = result.rows[0];
  for (const handle of handles) {
    await executor.query(
      `INSERT INTO x_actor_screening_results(screening_run_id, x_handle, status)
       VALUES ($1,$2,'pending') ON CONFLICT DO NOTHING`, [run.id, handle]
    );
  }
  return run;
}

async function getRun(id, executor = db) {
  const result = await executor.query(
    `SELECT run.*, COALESCE(json_agg(result ORDER BY result.x_handle)
       FILTER (WHERE result.id IS NOT NULL), '[]') AS results
     FROM x_actor_screening_runs run
     LEFT JOIN x_actor_screening_results result ON result.screening_run_id = run.id
     WHERE run.id = $1 GROUP BY run.id`, [Number(id)]
  );
  return result.rows[0] || null;
}

async function listRuns(limit = 50, executor = db) {
  const result = await executor.query(
    `SELECT run.*, COUNT(result.id)::int AS result_count,
       COUNT(result.id) FILTER (WHERE result.status = 'completed')::int AS completed_count
     FROM x_actor_screening_runs run
     LEFT JOIN x_actor_screening_results result ON result.screening_run_id = run.id
     GROUP BY run.id ORDER BY run.created_at DESC LIMIT $1`,
    [Math.min(100, Math.max(1, Number(limit)))]
  );
  return result.rows;
}

async function retryFailedRun(id, executor = db) {
  const result = await executor.query(
    `UPDATE x_actor_screening_results
     SET status = 'pending', error_code = NULL, last_error = NULL,
         started_at = NULL, completed_at = NULL, updated_at = NOW()
     FROM x_actor_screening_runs AS run
     WHERE x_actor_screening_results.screening_run_id = run.id
       AND x_actor_screening_results.status = 'failed'
       AND run.status <> 'cancelled'
     RETURNING id`, [Number(id)]
  );
  if (result.rows.length === 0) return false;
  await executor.query(
    `UPDATE x_actor_screening_runs
     SET status = CASE WHEN status IN ('failed','partial') THEN 'pending' ELSE status END,
         last_error = NULL, completed_at = NULL, updated_at = NOW()
     WHERE id = $1 AND status <> 'cancelled'`, [Number(id)]
  );
  return true;
}

module.exports = { createRun, getRun, listRuns, retryFailedRun };
