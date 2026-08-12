const logger = require('./logger');
const { explorerUrl } = require('./chain-config');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

class Notifier {
  constructor() {
    this.botToken = process.env.TG_BOT_TOKEN;
    this.chatId = process.env.TG_CHAT_ID;
  }

  async sendTelegramMessage(htmlText) {
    // Dynamically read token and chatId to handle settings panel hot-reloads!
    const token = process.env.TG_BOT_TOKEN || this.botToken;
    const chatId = process.env.TG_CHAT_ID || this.chatId;

    if (!token || !chatId) {
      logger.warn('notifier', 'Telegram notification skipped: TG_BOT_TOKEN or TG_CHAT_ID is not configured.');
      return;
    }

    try {
      const url = `https://api.telegram.org/bot${token}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          chat_id: chatId,
          text: htmlText,
          parse_mode: 'HTML',
          disable_web_page_preview: true
        })
      });

      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        logger.error('notifier', `Telegram API error (${res.status}): ${errText}`);
      } else {
        logger.info('notifier', 'Telegram notification sent successfully.');
      }
    } catch (err) {
      logger.error('notifier', `Failed to send Telegram notification: ${err.message}`);
    }
  }

  getChainExplorerLink(chain, address) {
    return explorerUrl(chain, 'address', address);
  }

  tradeExecuted(position) {
    logger.info('notifier', `Trade executed: ${position.contract_address} on ${position.chain_id}`);
    
    const assetUrl = this.getChainExplorerLink(position.chain_id, position.contract_address);
    const amountIn = Number(position.amount_in).toFixed(4);
    const entryPrice = position.entry_price ? Number(position.entry_price).toFixed(6) : '-';
    const chain = escapeHtml(String(position.chain_id || '').toUpperCase());
    const explorerLine = assetUrl
      ? `🔗 <b>区块浏览器：</b><a href="${escapeHtml(assetUrl)}">查看代币详情</a>`
      : '🔗 <b>区块浏览器：</b><code>当前链未配置浏览器</code>';
    
    const text = `
🟢 <b>[xbot] 交易开仓成功通知</b>
------------------------------------
🪙 <b>代币：</b><code>${escapeHtml(position.symbol || 'Unknown')}</code> on <b>${chain}</b>
📝 <b>合约：</b><code>${escapeHtml(position.contract_address)}</code>
💰 <b>投入额：</b><code>${amountIn} ${chain === 'SOL' ? 'SOL' : chain === 'BSC' ? 'BNB' : 'ETH'}</code>
📊 <b>开仓价格：</b><code>$${entryPrice}</code>
🎯 <b>止盈止损：</b><code>+${position.tp_pct}% / -${position.sl_pct}%</code>
${explorerLine}
    `.trim();

    this.sendTelegramMessage(text);
  }

  tradeFailed(signal, error) {
    logger.error('notifier', `Trade failed for signal ${signal.id}: ${error.message}`);
    
    const text = `
🔴 <b>[xbot] 交易开仓失败警告</b>
------------------------------------
⚠️ <b>信号 ID：</b><code>${escapeHtml(signal.id)}</code>
🪙 <b>代币：</b><code>${escapeHtml(signal.symbol || 'Unknown')}</code> on <b>${escapeHtml(String(signal.chain_id || '').toUpperCase())}</b>
📝 <b>合约：</b><code>${escapeHtml(signal.contract_address)}</code>
🔍 <b>触发源：</b>@${escapeHtml(signal.kol_handle)} (${escapeHtml(signal.signal_type)})
❌ <b>错误原因：</b><code>${escapeHtml(error.message)}</code>
    `.trim();

    this.sendTelegramMessage(text);
  }

  tpHit(position) {
    logger.info('notifier', `Take Profit hit for position ${position.id}`);
    
    const pnl = Number(position.pnl || 0).toFixed(5);
    const pnlPct = Number(position.pnl_pct || 0).toFixed(2);
    
    const text = `
🎯 <b>[xbot] Take Profit (止盈) 触发通知</b>
------------------------------------
🪙 <b>代币：</b><code>${escapeHtml(position.symbol || 'Unknown')}</code> on <b>${escapeHtml(String(position.chain_id || '').toUpperCase())}</b>
📝 <b>合约：</b><code>${escapeHtml(position.contract_address)}</code>
💰 <b>止盈价格：</b><code>$${Number(position.exit_price || 0).toFixed(6)}</code>
💵 <b>实际盈亏：</b><code>+${pnl} (和入场价比)</code>
📈 <b>实现收益比率：</b><code>+${pnlPct}%</code>
🎉 <b>状态：</b><code>止盈平仓已完成</code>
    `.trim();

    this.sendTelegramMessage(text);
  }

  slHit(position) {
    logger.info('notifier', `Stop Loss hit for position ${position.id}`);
    
    const pnl = Number(position.pnl || 0).toFixed(5);
    const pnlPct = Number(position.pnl_pct || 0).toFixed(2);
    
    const text = `
🛑 <b>[xbot] Stop Loss (止损) 触发通知</b>
------------------------------------
🪙 <b>代币：</b><code>${escapeHtml(position.symbol || 'Unknown')}</code> on <b>${escapeHtml(String(position.chain_id || '').toUpperCase())}</b>
📝 <b>合约：</b><code>${escapeHtml(position.contract_address)}</code>
💰 <b>止损价格：</b><code>$${Number(position.exit_price || 0).toFixed(6)}</code>
💵 <b>实际盈亏：</b><code>${pnl}</code>
📉 <b>亏损比率：</b><code>${pnlPct}%</code>
⚠️ <b>状态：</b><code>止损平仓已执行</code>
    `.trim();

    this.sendTelegramMessage(text);
  }

  budgetWarning(chain, pct) {
    logger.warn('notifier', `Budget warning for ${chain}: ${pct}% used`);
    
    const text = `
⚠️ <b>[xbot] 预算警告通知</b>
------------------------------------
⛓️ <b>链：</b><code>${escapeHtml(String(chain || '').toUpperCase())}</code>
📊 <b>状态：</b>已消耗每日限额额度的 <b>${pct.toFixed(1)}%</b>
💡 <i>建议：请及时核算今日策略命中率或补充每日预算限额配置。</i>
    `.trim();

    this.sendTelegramMessage(text);
  }

  signalMatched(signal) {
    logger.info('notifier', `Signal matched: ${signal.signal_type} from @${signal.kol_handle}`);
    
    const text = `
🔍 <b>[xbot] 信号匹配命记录</b>
------------------------------------
👤 <b>KOL：</b>@${escapeHtml(signal.kol_handle)} (权重: ${escapeHtml(signal.kol_weight)})
⚡ <b>匹配模式：</b><code>${escapeHtml(signal.signal_type)}</code>
📝 <b>合约：</b><code>${escapeHtml(signal.contract_address)}</code>
🏷️ <b>匹配细节：</b><code>${escapeHtml(signal.match_detail || '-')}</code>
    `.trim();

    this.sendTelegramMessage(text);
  }
}

const notifier = new Notifier();
module.exports = notifier;
module.exports.Notifier = Notifier;
module.exports.escapeHtml = escapeHtml;
