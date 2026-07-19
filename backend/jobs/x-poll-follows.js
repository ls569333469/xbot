const db = require('../lib/db');
const logger = require('../lib/logger');
const { createXClient } = require('../lib/x-client');
const xMonitorQueries = require('../domains/x-monitor/queries');

async function run(deps) {
  logger.info('jobs', 'Running x-poll-follows job');
  const xClient = createXClient();
  
  // Get 1 KOL with oldest last_follow_check (using last_polled_at for simplicity here if we don't have a separate col, but let's assume we use last_polled_at or just order by updated_at)
  const res = await db.query(
    'SELECT * FROM x_kol_accounts WHERE enabled = true ORDER BY updated_at ASC LIMIT 1'
  );
  
  if (res.rows.length === 0) return;
  const kol = res.rows[0];
  
  try {
    const following = await xClient.getUserFollowing(kol.x_handle);
    const oldFollowing = kol.last_follow_snapshot || [];
    
    // Find new follows
    const newFollows = following.filter(f => !oldFollowing.find(of => of.id === f.id));
    
    for (const f of newFollows) {
      await xMonitorQueries.insertActivity({
        kol_id: kol.id,
        kol_handle: kol.x_handle,
        activity_type: 'follow',
        target_x_handle: f.handle,
        raw_json: f
      });
    }
    
    await db.query(
      'UPDATE x_kol_accounts SET last_follow_snapshot = $1, updated_at = NOW() WHERE id = $2',
      [JSON.stringify(following), kol.id]
    );
  } catch (err) {
    logger.error('jobs', `Failed to poll follows for KOL ${kol.x_handle}: ${err.message}`);
  }
}

module.exports = { run };
