const db = require('../../lib/db');

async function getActivities(filters) {
  let query = 'SELECT * FROM x_activities WHERE 1=1';
  let countQuery = 'SELECT COUNT(*) FROM x_activities WHERE 1=1';
  let params = [];
  let countParams = [];
  let paramIndex = 1;

  if (filters.kol_id) {
    const clause = ` AND kol_id = $${paramIndex++}`;
    query += clause;
    countQuery += clause;
    params.push(filters.kol_id);
    countParams.push(filters.kol_id);
  }
  if (filters.activity_type) {
    const clause = ` AND activity_type = $${paramIndex++}`;
    query += clause;
    countQuery += clause;
    params.push(filters.activity_type);
    countParams.push(filters.activity_type);
  }

  const countRes = await db.query(countQuery, countParams);
  const total = parseInt(countRes.rows[0].count, 10);

  const page = filters.page || 1;
  const pageSize = filters.pageSize || 20;
  const offset = (page - 1) * pageSize;

  query += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
  params.push(pageSize, offset);

  const res = await db.query(query, params);
  return { rows: res.rows, total };
}

async function getStatus() {
  const res = await db.query('SELECT COUNT(*) as total_activities, COUNT(CASE WHEN processed = false THEN 1 END) as pending_activities FROM x_activities');
  return res.rows[0];
}

async function insertActivity(data, executor = db) {
  const res = await executor.query(
    `INSERT INTO x_activities
      (kol_id, kol_handle, activity_type, tweet_id, tweet_text, target_x_handle,
       target_x_handles, extracted_cas, extracted_tickers, provider_event_id,
       source_created_at, provider, semantic_key, observation_started_at, observation_ended_at,
       raw_json, trace_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [
      data.kol_id, data.kol_handle, data.activity_type, data.tweet_id,
      data.tweet_text, data.target_x_handle, data.target_x_handles || [],
      data.extracted_cas || [], data.extracted_tickers || [],
      data.provider_event_id, data.source_created_at, data.provider,
      data.semantic_key || null,
      data.observation_started_at, data.observation_ended_at, data.raw_json,
      data.trace_id || null
    ]
  );
  return res.rows[0];
}

module.exports = { getActivities, getStatus, insertActivity };
