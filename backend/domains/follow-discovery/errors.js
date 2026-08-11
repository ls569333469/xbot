function followError(code, message, options = {}) {
  const error = new Error(message);
  error.code = code;
  if (options.retryable !== undefined) error.retryable = options.retryable;
  if (options.retryAt) error.retryAt = options.retryAt;
  return error;
}

module.exports = { followError };
