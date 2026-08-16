const ONE_MINUTE_SECONDS = 60;
const ONE_DAY_SECONDS = 24 * 60 * 60;

function timestampSeconds(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed > 10_000_000_000 ? Math.floor(parsed / 1000) : Math.floor(parsed);
}

function usableRows(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((row, index) => ({
      ...row,
      _index: index,
      _timestamp: timestampSeconds(row?.timestamp),
      open: Number(row?.open),
      high: Number(row?.high),
      close: Number(row?.close)
    }))
    .filter((row) => Number.isFinite(row.close))
    .sort((left, right) => {
      if (left._timestamp === null && right._timestamp === null) return left._index - right._index;
      if (left._timestamp === null) return 1;
      if (right._timestamp === null) return -1;
      return left._timestamp - right._timestamp;
    });
}

module.exports = {
  ONE_DAY_SECONDS,
  ONE_MINUTE_SECONDS,
  timestampSeconds,
  usableRows
};
