const { normalizeXHandle } = require('../../lib/x-handles');

const X_HANDLE_PATTERN = /^[a-z0-9_]{1,15}$/;

function normalizeRelationInputs(values) {
  if (!Array.isArray(values)) return [];

  const deduplicated = new Map();
  for (const value of values) {
    const actorHandle = normalizeXHandle(value?.actor_handle ?? value?.actorHandle);
    const targetHandle = normalizeXHandle(value?.target_x_handle ?? value?.targetHandle);
    if (!X_HANDLE_PATTERN.test(actorHandle)) {
      throw new Error(`Invalid actor X handle: ${actorHandle || '(empty)'}`);
    }
    if (!X_HANDLE_PATTERN.test(targetHandle)) {
      throw new Error(`Invalid target X handle: ${targetHandle || '(empty)'}`);
    }
    if (actorHandle === targetHandle) {
      throw new Error(`Actor and target must be different: @${actorHandle}`);
    }
    deduplicated.set(`${actorHandle}:${targetHandle}`, {
      actor_handle: actorHandle,
      target_x_handle: targetHandle
    });
  }
  return [...deduplicated.values()];
}

async function findOrCreateActor(actorHandle, executor) {
  const existing = await executor.query(
    `SELECT * FROM x_kol_accounts
     WHERE lower(regexp_replace(x_handle, '^@+', '')) = $1
     ORDER BY enabled DESC, id
     LIMIT 1
     FOR UPDATE`,
    [actorHandle]
  );
  if (existing.rows[0]) {
    if (!existing.rows[0].enabled) {
      const enabled = await executor.query(
        `UPDATE x_kol_accounts
         SET enabled = true, updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [existing.rows[0].id]
      );
      return enabled.rows[0];
    }
    return existing.rows[0];
  }

  const created = await executor.query(
    `INSERT INTO x_kol_accounts
      (x_user_id, x_handle, display_name, chain_ids, weight, enabled)
     VALUES ($1, $1, $1, '{}', 5, true)
     ON CONFLICT (x_user_id) DO UPDATE
       SET x_handle = EXCLUDED.x_handle, enabled = true, updated_at = NOW()
     RETURNING *`,
    [actorHandle]
  );
  return created.rows[0];
}

async function syncWhitelistRelations(whitelistId, relations, executor) {
  const relationIds = [];
  for (const relation of relations) {
    const actor = await findOrCreateActor(relation.actor_handle, executor);
    const result = await executor.query(
      `INSERT INTO x_signal_relations
        (whitelist_id, kol_id, target_x_handle, enabled)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (whitelist_id, kol_id, target_x_handle) DO UPDATE
         SET enabled = true, updated_at = NOW()
       RETURNING id`,
      [whitelistId, actor.id, relation.target_x_handle]
    );
    relationIds.push(result.rows[0].id);
  }

  await executor.query(
    `DELETE FROM x_signal_relations
     WHERE whitelist_id = $1
       AND NOT (id = ANY($2::bigint[]))`,
    [whitelistId, relationIds]
  );
  await executor.query(
    `UPDATE ca_whitelist
     SET project_x_handles = COALESCE((
       SELECT array_agg(DISTINCT target_x_handle ORDER BY target_x_handle)
       FROM x_signal_relations
       WHERE whitelist_id = $1 AND enabled = true
     ), '{}'::text[]), updated_at = NOW()
     WHERE id = $1`,
    [whitelistId]
  );
}

async function hydrateWhitelistRelations(rows, executor) {
  if (rows.length === 0) return rows;
  const ids = rows.map((row) => Number(row.id));
  const result = await executor.query(
    `SELECT relation.id, relation.whitelist_id, relation.kol_id,
            actor.x_handle AS actor_handle,
            actor.display_name AS actor_display_name,
            relation.target_x_handle, relation.enabled
     FROM x_signal_relations AS relation
     JOIN x_kol_accounts AS actor ON actor.id = relation.kol_id
     WHERE relation.whitelist_id = ANY($1::int[])
     ORDER BY lower(actor.x_handle), relation.target_x_handle`,
    [ids]
  );
  const grouped = new Map();
  for (const relation of result.rows) {
    const group = grouped.get(Number(relation.whitelist_id)) || [];
    group.push(relation);
    grouped.set(Number(relation.whitelist_id), group);
  }
  return rows.map((row) => ({
    ...row,
    relations: grouped.get(Number(row.id)) || []
  }));
}

module.exports = {
  X_HANDLE_PATTERN,
  hydrateWhitelistRelations,
  normalizeRelationInputs,
  syncWhitelistRelations
};
