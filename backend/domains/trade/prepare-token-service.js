const crypto = require('crypto');
const db = require('../../lib/db');

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function create(input) {
  const token = crypto.randomBytes(32).toString('base64url');
  const ttlSeconds = Math.min(300, Math.max(15, Number(input.ttlSeconds || 60)));
  await db.query(
    `INSERT INTO prepare_tokens
      (token_hash, purpose, signal_id, position_id, operator_id, snapshot_hash,
       snapshot_json, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + ($8 * INTERVAL '1 second'))`,
    [
      tokenHash(token),
      input.purpose,
      input.signalId || null,
      input.positionId || null,
      input.operatorId,
      input.snapshotHash,
      input.snapshot,
      ttlSeconds
    ]
  );
  return { token, expiresInSeconds: ttlSeconds };
}

async function consume(token, input) {
  const result = await db.query(
    `UPDATE prepare_tokens
     SET consumed_at = NOW()
     WHERE token_hash = $1
       AND purpose = $2
       AND operator_id = $3
       AND consumed_at IS NULL
       AND expires_at > NOW()
     RETURNING *`,
    [tokenHash(token), input.purpose, input.operatorId]
  );
  if (result.rows.length === 0) {
    const error = new Error('Prepare token is invalid, expired, already used, or belongs to another operator');
    error.code = 'PREPARE_TOKEN_INVALID';
    throw error;
  }
  return result.rows[0];
}

module.exports = { consume, create, tokenHash };
