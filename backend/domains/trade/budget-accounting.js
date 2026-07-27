function finiteNonNegative(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function reservationUnitUsd(reservation = {}) {
  const principal = finiteNonNegative(reservation.amount_native);
  const feeEnvelope = finiteNonNegative(reservation.fee_native);
  const usd = finiteNonNegative(reservation.amount_usd_snapshot);
  const total = principal === null || feeEnvelope === null ? null : principal + feeEnvelope;
  if (total === null || total <= 0 || usd === null) return null;
  return usd / total;
}

function ledgerUsdAmount(reservation, amountNative = 0, feeNative = 0) {
  const amount = finiteNonNegative(amountNative);
  const fee = finiteNonNegative(feeNative);
  const unitUsd = reservationUnitUsd(reservation);
  if (amount === null || fee === null || unitUsd === null) return null;
  return (amount + fee) * unitUsd;
}

function unusedFeeEnvelope(reservation = {}) {
  const envelope = finiteNonNegative(reservation.fee_native);
  const used = finiteNonNegative(reservation.fee_used_native);
  if (envelope === null || used === null) return 0;
  return Math.max(0, envelope - used);
}

module.exports = { ledgerUsdAmount, reservationUnitUsd, unusedFeeEnvelope };
