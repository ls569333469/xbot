function assertDecimals(decimals) {
  const value = Number(decimals);
  if (!Number.isInteger(value) || value < 0 || value > 36) {
    const error = new Error(`Invalid decimals: ${decimals}`);
    error.code = 'INVALID_DECIMALS';
    throw error;
  }
  return value;
}

function decimalToRaw(value, decimals) {
  const precision = assertDecimals(decimals);
  const normalized = String(value).trim();
  if (!/^\d+(?:\.\d+)?$/.test(normalized)) {
    const error = new Error(`Invalid decimal amount: ${value}`);
    error.code = 'INVALID_DECIMAL_AMOUNT';
    throw error;
  }
  const [whole, fraction = ''] = normalized.split('.');
  if (fraction.length > precision && /[1-9]/.test(fraction.slice(precision))) {
    const error = new Error(`Amount has more than ${precision} decimal places: ${value}`);
    error.code = 'DECIMAL_PRECISION_EXCEEDED';
    throw error;
  }
  const raw = `${whole}${fraction.slice(0, precision).padEnd(precision, '0')}`;
  return raw.replace(/^0+(?=\d)/, '') || '0';
}

function rawToDecimal(value, decimals, maxFraction = decimals) {
  const precision = assertDecimals(decimals);
  const fractionLimit = Math.min(precision, Math.max(0, Number(maxFraction)));
  const raw = String(value ?? '').trim();
  if (!/^\d+$/.test(raw)) {
    const error = new Error(`Invalid raw amount: ${value}`);
    error.code = 'INVALID_RAW_AMOUNT';
    throw error;
  }
  if (precision === 0) return raw.replace(/^0+(?=\d)/, '') || '0';
  const padded = raw.padStart(precision + 1, '0');
  const whole = padded.slice(0, -precision).replace(/^0+(?=\d)/, '') || '0';
  const fraction = padded.slice(-precision).slice(0, fractionLimit).replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole;
}

function minRaw(...values) {
  const parsed = values.map((value) => BigInt(String(value ?? '0')));
  return parsed.reduce((minimum, value) => value < minimum ? value : minimum).toString();
}

function addRaw(...values) {
  return values.reduce((total, value) => total + BigInt(String(value ?? '0')), 0n).toString();
}

function subtractRaw(left, right) {
  const result = BigInt(String(left ?? '0')) - BigInt(String(right ?? '0'));
  if (result < 0n) {
    const error = new Error('Raw amount subtraction would be negative');
    error.code = 'RAW_AMOUNT_UNDERFLOW';
    throw error;
  }
  return result.toString();
}

module.exports = {
  addRaw,
  decimalToRaw,
  minRaw,
  rawToDecimal,
  subtractRaw
};
