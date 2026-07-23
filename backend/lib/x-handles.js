function normalizeXHandle(value) {
  return String(value || '').trim().replace(/^@+/, '').toLowerCase();
}

function normalizeXHandles(values) {
  const source = Array.isArray(values) ? values : [values];
  const handles = source.flatMap((value) => String(value || '').split(/[,，;；\s]+/));
  return [...new Set(handles.map(normalizeXHandle).filter(Boolean))];
}

module.exports = { normalizeXHandle, normalizeXHandles };
