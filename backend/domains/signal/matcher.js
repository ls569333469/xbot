const db = require('../../lib/db');
const signalQueries = require('./queries');
const logger = require('../../lib/logger');

async function matchActivity(activity) {
  // get active whitelists
  const whitelistsRes = await db.query("SELECT * FROM ca_whitelist WHERE status = 'active'");
  const whitelists = whitelistsRes.rows;
  
  let matches = 0;
  
  for (const wl of whitelists) {
    // 1. match CA
    if (activity.extracted_cas && activity.extracted_cas.includes(wl.contract_address)) {
      await signalQueries.createSignal({
        activity_id: activity.id,
        whitelist_id: wl.id,
        kol_id: activity.kol_id,
        kol_handle: activity.kol_handle,
        signal_type: 'ca_mention',
        match_detail: wl.contract_address
      });
      matches++;
    }
    
    // 2. match Ticker
    if (activity.extracted_tickers && wl.symbol && activity.extracted_tickers.includes(wl.symbol)) {
      await signalQueries.createSignal({
        activity_id: activity.id,
        whitelist_id: wl.id,
        kol_id: activity.kol_id,
        kol_handle: activity.kol_handle,
        signal_type: 'ticker_mention',
        match_detail: wl.symbol
      });
      matches++;
    }
    
    // 3. match Handle
    if (wl.project_x_handles && activity.target_x_handle && wl.project_x_handles.includes(activity.target_x_handle)) {
      await signalQueries.createSignal({
        activity_id: activity.id,
        whitelist_id: wl.id,
        kol_id: activity.kol_id,
        kol_handle: activity.kol_handle,
        signal_type: 'handle_match',
        match_detail: activity.target_x_handle
      });
      matches++;
    }
  }
  
  return matches;
}

module.exports = { matchActivity };
