// D:\AI_Projects\xbot\backend\lib\engine-state.js
// Armed 状态持久化到 DB config 表，服务重启后自动恢复

const db = require('./db');
const logger = require('./logger');

let isArmed = false;
let initialized = false;

// 启动时从 DB 恢复 Armed 状态
async function init() {
  if (initialized) return;
  try {
    const res = await db.query("SELECT value_json FROM config WHERE key = 'engine_armed'");
    if (res.rows.length > 0 && res.rows[0].value_json) {
      const val = res.rows[0].value_json;
      isArmed = val === true || val.armed === true;
    }
    initialized = true;
    logger.info('engine-state', `Armed 状态已从 DB 恢复: ${isArmed}`);
  } catch (err) {
    // DB 尚未就绪时降级为内存模式
    logger.warn('engine-state', `无法从 DB 恢复 Armed 状态，降级为内存模式: ${err.message}`);
    initialized = true;
  }
}

module.exports = {
  init,
  getArmed: () => isArmed,
  setArmed: async (val) => {
    isArmed = !!val;
    try {
      await db.query(
        "INSERT INTO config (key, value_json) VALUES ('engine_armed', $1) ON CONFLICT (key) DO UPDATE SET value_json = EXCLUDED.value_json, updated_at = NOW()",
        [JSON.stringify({ armed: isArmed })]
      );
    } catch (err) {
      logger.error('engine-state', `持久化 Armed 状态到 DB 失败: ${err.message}`);
    }
  }
};
