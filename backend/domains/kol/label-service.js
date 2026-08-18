const db = require('../../lib/db');

const MAX_LABELS_PER_KOL = 12;
const MAX_LABEL_LENGTH = 24;

function kolLabelError(code, message, status = 400) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function normalizeLabelName(value) {
  const name = String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (!name || /[\u0000-\u001f\u007f-\u009f]/u.test(name)) {
    throw kolLabelError('KOL_LABEL_INVALID', '标签名称不能为空或包含控制字符');
  }
  if (Array.from(name).length > MAX_LABEL_LENGTH) {
    throw kolLabelError('KOL_LABEL_INVALID', `标签名称不能超过 ${MAX_LABEL_LENGTH} 个字符`);
  }
  return { name, normalizedName: name.toLocaleLowerCase('und') };
}

function normalizeLabelIds(values) {
  if (!Array.isArray(values)) {
    throw kolLabelError('KOL_LABEL_INVALID', 'custom_label_ids must be an array');
  }
  const ids = [...new Set(values.map((value) => String(value).trim()))];
  if (ids.length > MAX_LABELS_PER_KOL) {
    throw kolLabelError(
      'KOL_LABEL_LIMIT_EXCEEDED',
      `每个 KOL 最多关联 ${MAX_LABELS_PER_KOL} 个自定义标签`
    );
  }
  if (ids.some((id) => !/^[1-9]\d*$/.test(id))) {
    throw kolLabelError('KOL_LABEL_INVALID', '自定义标签 ID 无效');
  }
  return ids;
}

async function listLabels(filters = {}, executor = db) {
  const search = String(filters.search || '').normalize('NFKC').trim();
  const result = await executor.query(
    `SELECT label.id::text,
            label.name,
            COUNT(account_label.kol_id)::int AS account_count,
            label.created_at,
            label.updated_at
       FROM x_kol_labels AS label
       LEFT JOIN x_kol_account_labels AS account_label ON account_label.label_id = label.id
      WHERE ($1 = '' OR label.name ILIKE '%' || $1 || '%')
      GROUP BY label.id
      ORDER BY lower(label.name), label.id`,
    [search]
  );
  return result.rows;
}

async function createLabel(value, options = {}) {
  const executor = options.executor || db;
  const operator = String(options.operator || 'admin').slice(0, 128);
  const { name, normalizedName } = normalizeLabelName(value);
  const result = await executor.query(
    `WITH inserted AS (
       INSERT INTO x_kol_labels (name, normalized_name, created_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (normalized_name) DO NOTHING
       RETURNING *
     ), selected AS (
       SELECT * FROM inserted
       UNION ALL
       SELECT * FROM x_kol_labels WHERE normalized_name = $2
       LIMIT 1
     )
     SELECT selected.id::text, selected.name,
            (SELECT COUNT(*)::int FROM x_kol_account_labels WHERE label_id = selected.id) AS account_count,
            selected.created_at, selected.updated_at
       FROM selected`,
    [name, normalizedName, operator]
  );
  return result.rows[0];
}

async function renameLabel(id, value, options = {}) {
  const executor = options.executor || db;
  const { name, normalizedName } = normalizeLabelName(value);
  try {
    const result = await executor.query(
      `UPDATE x_kol_labels
          SET name = $1, normalized_name = $2, updated_at = NOW()
        WHERE id::text = $3
        RETURNING id::text, name,
          (SELECT COUNT(*)::int FROM x_kol_account_labels WHERE label_id = x_kol_labels.id) AS account_count,
          created_at, updated_at`,
      [name, normalizedName, String(id)]
    );
    if (!result.rows[0]) throw kolLabelError('KOL_LABEL_NOT_FOUND', '自定义标签不存在', 404);
    return result.rows[0];
  } catch (error) {
    if (error.code === '23505') {
      throw kolLabelError('KOL_LABEL_INVALID', '已存在同名自定义标签');
    }
    throw error;
  }
}

async function deleteLabel(id, options = {}) {
  const executor = options.executor || db;
  const labelId = String(id);
  const result = await executor.query(
    `DELETE FROM x_kol_labels AS label
      WHERE label.id::text = $1
        AND NOT EXISTS (
          SELECT 1 FROM x_kol_account_labels WHERE label_id = label.id
        )
      RETURNING label.id::text`,
    [labelId]
  );
  if (result.rows[0]) return { deleted: true, id: result.rows[0].id };

  const existing = await executor.query(
    `SELECT EXISTS(SELECT 1 FROM x_kol_labels WHERE id::text = $1) AS exists,
            EXISTS(SELECT 1 FROM x_kol_account_labels WHERE label_id::text = $1) AS in_use`,
    [labelId]
  );
  if (existing.rows[0]?.in_use) {
    throw kolLabelError('KOL_LABEL_IN_USE', '该标签仍被 KOL 使用，不能删除', 409);
  }
  throw kolLabelError('KOL_LABEL_NOT_FOUND', '自定义标签不存在', 404);
}

async function replaceAccountLabels(kolId, values, executor = db) {
  const ids = normalizeLabelIds(values);
  if (ids.length) {
    const found = await executor.query(
      'SELECT id::text FROM x_kol_labels WHERE id::text = ANY($1::text[]) FOR SHARE',
      [ids]
    );
    const known = new Set(found.rows.map((row) => row.id));
    if (ids.some((id) => !known.has(id))) {
      throw kolLabelError('KOL_LABEL_NOT_FOUND', '包含不存在的自定义标签', 400);
    }
  }

  await executor.query('DELETE FROM x_kol_account_labels WHERE kol_id = $1', [Number(kolId)]);
  if (ids.length) {
    await executor.query(
      `INSERT INTO x_kol_account_labels (kol_id, label_id)
       SELECT $1, value::bigint FROM unnest($2::text[]) AS value`,
      [Number(kolId), ids]
    );
  }
  return ids;
}

module.exports = {
  MAX_LABELS_PER_KOL,
  createLabel,
  deleteLabel,
  kolLabelError,
  listLabels,
  normalizeLabelIds,
  normalizeLabelName,
  renameLabel,
  replaceAccountLabels
};
