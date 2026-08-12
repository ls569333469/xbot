const ENTITY_TYPES = new Set(['signal', 'position', 'order', 'attempt']);
const CHANGE_TYPES = new Set(['created', 'updated', 'settled']);

async function enqueueEntityEvent(executor, entityType, entityId, changeType, transitionKey = changeType) {
  if (!ENTITY_TYPES.has(entityType) || !CHANGE_TYPES.has(changeType)) {
    throw new Error('Invalid P27 entity event');
  }
  const dedupeKey = `${entityType}:${entityId}:${transitionKey}`;
  const result = await executor.query(
    `INSERT INTO notification_outbox
      (channel, topic, aggregate_type, aggregate_id, dedupe_key, payload)
     VALUES ('entity_event','entity.changed',$1,$2,$3,$4)
     ON CONFLICT (channel, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [entityType, String(entityId), dedupeKey, {
      contract_version: 'p27.events.v1',
      entity_type: entityType,
      entity_id: String(entityId),
      change_type: changeType
    }]
  );
  return result.rows[0]?.id || null;
}

function entityEnvelope(row) {
  return {
    type: 'entity:changed',
    event_id: String(row.id),
    contract_version: 'p27.events.v1',
    payload: {
      entity_type: row.payload?.entity_type || row.aggregate_type,
      entity_id: String(row.payload?.entity_id || row.aggregate_id),
      change_type: row.payload?.change_type || 'updated'
    }
  };
}

module.exports = { enqueueEntityEvent, entityEnvelope };
