// logger.js — 结构化日志（error/trade 级别异步写入 DB）

function logToDb(level, module, message, meta) {
  try {
    const db = require('./db');
    db.query(
      'INSERT INTO system_logs (level, module, message, meta) VALUES ($1, $2, $3, $4)',
      [level, module, message, meta ? JSON.stringify(meta) : null]
    ).catch(e => console.error('Failed to write log to DB:', e));
  } catch (err) {
    console.error('DB Logging error:', err);
  }
}

const format = (level, moduleName, msg, meta) => {
  const ts = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : '';
  return `[${ts}] [${level.toUpperCase()}] [${moduleName}] ${msg}${metaStr}`;
};

const logger = {
  info: (moduleName, msg, meta) => {
    console.log(format('info', moduleName, msg, meta));
  },
  warn: (moduleName, msg, meta) => {
    console.warn(format('warn', moduleName, msg, meta));
  },
  error: (moduleName, msg, meta) => {
    console.error(format('error', moduleName, msg, meta));
    logToDb('error', moduleName, msg, meta);
  },
  trade: (moduleName, msg, meta) => {
    console.log(format('trade', moduleName, msg, meta));
    logToDb('trade', moduleName, msg, meta);
  }
};

module.exports = logger;
