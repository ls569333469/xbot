const db = require('../../lib/db');

function createAccountResearchRepository(executor = db) {
  return {
    async getRun(runId, revision) {
      const result = await executor.query(
        `SELECT run.*, COALESCE(json_agg(result ORDER BY result.x_handle)
           FILTER (WHERE result.id IS NOT NULL), '[]') AS results
         FROM x_actor_screening_runs run
         LEFT JOIN x_actor_screening_results result ON result.screening_run_id = run.id
         WHERE run.id = $1 AND run.screening_revision = $2 GROUP BY run.id`,
        [runId, revision]
      );
      return result.rows[0] || null;
    },

    async listRuns(limit, revision) {
      const result = await executor.query(
        `SELECT run.*, COUNT(result.id)::int AS result_count,
           COUNT(result.id) FILTER (WHERE result.status = 'completed')::int AS completed_count,
           COUNT(result.id) FILTER (WHERE result.status IN ('completed','partial','failed'))::int AS finished_count,
           COUNT(result.id) FILTER (WHERE result.status = 'failed')::int AS failed_count,
           COUNT(result.id) FILTER (WHERE result.recommendation = 'approve_for_record')::int AS recommended_count,
           COALESCE(SUM(
             jsonb_array_length(COALESCE(result.metrics #> '{grok,result,candidates}', '[]'::jsonb))
           ), 0)::int AS discovered_count
         FROM x_actor_screening_runs run
         LEFT JOIN x_actor_screening_results result ON result.screening_run_id = run.id
         WHERE run.screening_revision = $2
         GROUP BY run.id ORDER BY run.created_at DESC LIMIT $1`,
        [limit, revision]
      );
      return result.rows;
    }
  };
}

module.exports = { createAccountResearchRepository };
