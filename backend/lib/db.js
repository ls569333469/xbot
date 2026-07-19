const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  database: process.env.DB_NAME || 'xbot',
  user: process.env.DB_USER || 'pm_user',
  password: process.env.DB_PASSWORD || ''
});

pool.on('error', (err, client) => {
  logger.error('Database pool error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
