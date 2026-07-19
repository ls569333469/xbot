// D:\AI_Projects\xbot\backend\domains\trade\trade-engine.js
const { VersionedTransaction, Keypair } = require('@solana/web3.js');
const { Wallet } = require('ethers');
const db = require('../../lib/db');
const logger = require('../../lib/logger');
const gmgnHttp = require('../../lib/gmgn-http');

// 解析 Solana 私钥字节数组或字符串
function loadSolanaKeypair(keyStr) {
  if (!keyStr) return null;
  try {
    const trimmed = keyStr.trim();
    let bytes;
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      bytes = Uint8Array.from(JSON.parse(trimmed));
    } else if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      bytes = Buffer.from(trimmed, 'hex');
    } else {
      bytes = Buffer.from(trimmed, 'base64');
    }
    return Keypair.fromSecretKey(bytes);
  } catch (e) {
    logger.error('trade-engine', `加载 Solana 密钥对失败: ${e.message}`);
    return null;
  }
}

// 获取链对应原生代币地址 (实盘 WETH/WBNB 合约地址)
function getNativeTokenAddress(chain) {
  const map = {
    sol: 'So11111111111111111111111111111111111111112',
    bsc: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',   // WBNB
    base: '0x4200000000000000000000000000000000000006',  // WETH
    eth: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'   // WETH
  };
  return map[chain] || map.sol;
}

// EVM 链 ID 映射表
const EVM_CHAIN_IDS = {
  eth: 1,
  bsc: 56,
  base: 8453
};

/**
 * 真实小额开仓逻辑
 */
async function openRealPosition(signal, wsBroadcast) {
  const apiKey = process.env.GMGN_API_KEY;

  // 1. 事务级锁，防止并发重入买入
  const pgClient = await db.pool.connect();
  try {
    await pgClient.query('BEGIN');
    
    // 锁定对应的白名单行并重检预算
    const wlRes = await pgClient.query(
      'SELECT * FROM ca_whitelist WHERE id = $1 FOR UPDATE',
      [signal.whitelist_id]
    );
    const whitelist = wlRes.rows[0];
    if (!whitelist || whitelist.status !== 'active') {
      throw new Error('白名单不存在或已失效');
    }

    const chain = whitelist.chain_id;
    const ca = whitelist.contract_address;

    const budgetPerTrade = Number(whitelist.budget_per_trade || 0.001);
    const spentBudget = Number(whitelist.spent_budget || 0);
    const totalBudget = Number(whitelist.total_budget || 0);

    if (spentBudget + budgetPerTrade > totalBudget) {
      throw new Error(`超出白名单限额: 已用 ${spentBudget}, 单笔 ${budgetPerTrade}, 总限额 ${totalBudget}`);
    }

    const periodKey = new Date().toISOString().split('T')[0];
    // 锁定链级每日预算
    const budgetRes = await pgClient.query(
      "SELECT * FROM budget_tracking WHERE chain_id = $1 AND period_type = 'daily' AND period_key = $2 FOR UPDATE",
      [chain, periodKey]
    );
    if (budgetRes.rows.length > 0) {
      const tracking = budgetRes.rows[0];
      if (Number(tracking.spent) + budgetPerTrade > Number(tracking.budget_limit)) {
        throw new Error(`超出每日链预算限制: ${chain}`);
      }
    }

    logger.info('trade-engine', `进入实盘交易流水线 | 链: ${chain} | CA: ${ca} | 预算: ${budgetPerTrade}`);

    // 获取代币的真实精度 (EVM 可为 18, 6 等; Solana 多为 9)
    let tokenDecimals = 9;
    try {
      const tokenInfo = await gmgnHttp.getTokenInfo(chain, ca);
      if (tokenInfo && tokenInfo.decimals !== undefined) {
        tokenDecimals = Number(tokenInfo.decimals);
      }
    } catch (err) {
      logger.warn('trade-engine', `获取代币 ${ca} 精度失败，使用链默认值: ${err.message}`);
      tokenDecimals = chain === 'sol' ? 9 : 18;
    }

    let buyTxHash = null;
    let amountOut = 0;
    let entryPriceUsd = 0;
    let tpOrderId = null;
    let slOrderId = null;

    if (!apiKey) {
      // ◈ 降级 Mock 交易模式
      logger.warn('trade-engine', 'GMGN_API_KEY 未配置，降级为模拟交易执行');
      buyTxHash = '0xmock_real_buy_' + Math.random().toString(36).substring(7);
      
      const tokenInfo = await gmgnHttp.getTokenInfo(chain, ca);
      entryPriceUsd = Number(tokenInfo.price_usd || 0);
      
      // 模拟滑点与部分成交：成交率 95% ~ 100%
      const fillRate = 0.95 + Math.random() * 0.05;
      amountOut = (budgetPerTrade / entryPriceUsd) * fillRate;
      
      // 模拟创建 TP/SL 挂单
      tpOrderId = 'mock_tp_order_' + Math.random().toString(36).substring(7);
      slOrderId = 'mock_sl_order_' + Math.random().toString(36).substring(7);
    } else {
      // ◈ 真实链上交易模式
      const fromAddress = chain === 'sol' ? process.env.WALLET_SOL : process.env.WALLET_EVM;
      const privateKeyStr = process.env.GMGN_PRIVATE_KEY;
      if (!fromAddress || !privateKeyStr) {
        throw new Error('缺失钱包公钥 WALLET_SOL/WALLET_EVM 或私钥 GMGN_PRIVATE_KEY');
      }

      // A. 获取买入路由 (输入是原生代币 SOL/BNB/ETH)
      const nativeIn = getNativeTokenAddress(chain);
      const nativeDecimals = chain === 'sol' ? 9 : 18;
      const rawInAmount = Math.floor(budgetPerTrade * Math.pow(10, nativeDecimals)).toString();
      
      const routeData = await gmgnHttp.getSwapRoute(chain, nativeIn, ca, rawInAmount, fromAddress, whitelist.slippage || 15);
      const unsignedTx = routeData.raw_tx.tx_data;
      entryPriceUsd = Number(routeData.quote_price || 0);
      
      // B. 本地离线签署交易
      let signedTx = null;
      if (chain === 'sol') {
        const keypair = loadSolanaKeypair(privateKeyStr);
        if (!keypair) throw new Error('解析 Solana 私钥失败');
        
        const txBuffer = Buffer.from(unsignedTx, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);
        transaction.sign([keypair]);
        signedTx = Buffer.from(transaction.serialize()).toString('base64');
      } else {
        // EVM 链离线签名
        const wallet = new Wallet(privateKeyStr);
        
        let txParams;
        if (typeof unsignedTx === 'string') {
          try {
            txParams = JSON.parse(unsignedTx);
          } catch (e) {
            // 如果已经是 hex 编码的 rawTransaction，直接赋值
            txParams = unsignedTx;
          }
        } else {
          txParams = unsignedTx;
        }

        if (typeof txParams === 'object') {
          // 适配 Ethers.js v5/v6 参数并补全 chainId
          const chainId = EVM_CHAIN_IDS[chain] || 1;
          const formattedTx = {
            to: txParams.to || txParams.target,
            data: txParams.data,
            value: txParams.value || '0x00',
            gasLimit: txParams.gasLimit || txParams.gas_limit || 300000,
            gasPrice: txParams.gasPrice || txParams.gas_price,
            chainId: chainId
          };
          signedTx = await wallet.signTransaction(formattedTx);
        } else {
          // 已经签过名或者格式为原生 Hex
          signedTx = txParams;
        }
      }

      // C. 提交交易上链
      const submitRes = await gmgnHttp.submitSwap(chain, signedTx);
      buyTxHash = submitRes.tx_hash;
      logger.info('trade-engine', `买入交易已提交上链 | Hash: ${buyTxHash}`);

      // D. 估算成交数量 (根据代币精度 tokenDecimals 进行处理)
      const expectedOut = Number(routeData.out_amount || 0) / Math.pow(10, tokenDecimals);
      const fillRate = 0.98; // 实盘估算成交率
      amountOut = expectedOut * fillRate;

      // E. 创建止盈止损策略订单 (TP/SL)
      const tpPrice = entryPriceUsd * (1 + Number(whitelist.auto_tp_pct) / 100);
      const slPrice = entryPriceUsd * (1 - Number(whitelist.auto_sl_pct) / 100);

      const strategyParams = {
        chain,
        from_address: fromAddress,
        token_in_address: ca,
        token_out_address: nativeIn,
        amount_in: Math.floor(amountOut * Math.pow(10, tokenDecimals)).toString(), // 使用动态精度全部抛出
        tp_price: tpPrice.toString(),
        sl_price: slPrice.toString(),
        order_type: 'smart_trade',
        sub_order_type: 'mix_trade'
      };

      try {
        const orderRes = await gmgnHttp.submitStrategyOrder(chain, strategyParams);
        tpOrderId = orderRes.order_id;
        slOrderId = orderRes.order_id; // TP/SL 共享同一个订单组 ID
        logger.info('trade-engine', `止盈止损条件单提交成功 | ID: ${tpOrderId}`);
      } catch (err) {
        logger.error('trade-engine', `TP/SL 条件单挂单失败，系统将在后续定时任务中重试挂单: ${err.message}`);
      }
    }

    // 2. 插入 open 状态持仓记录
    const posRes = await pgClient.query(
      `INSERT INTO positions (
        signal_id, whitelist_id, contract_address, chain_id, symbol,
        amount_in, amount_out, entry_price, buy_tx_hash,
        tp_pct, sl_pct, tp_order_id, sl_order_id, tpsl_status, status, opened_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, NOW())
       RETURNING *`,
      [
        signal.id,
        signal.whitelist_id,
        ca,
        chain,
        whitelist.symbol,
        budgetPerTrade,
        amountOut,
        entryPriceUsd,
        buyTxHash,
        whitelist.auto_tp_pct,
        whitelist.auto_sl_pct,
        tpOrderId,
        slOrderId,
        tpOrderId ? 'ok' : 'pending_setup',
        'open'
      ]
    );
    const newPosition = posRes.rows[0];

    // 3. 更新白名单已消耗额度与购买次数
    await pgClient.query(
      `UPDATE ca_whitelist 
       SET spent_budget = spent_budget + $1, 
           current_buy_count = current_buy_count + 1,
           updated_at = NOW() 
       WHERE id = $2`,
      [budgetPerTrade, whitelist.id]
    );

    // 4. 更新每日预算 tracking
    await pgClient.query(
      `INSERT INTO budget_tracking (chain_id, period_type, period_key, spent, budget_limit, updated_at)
       VALUES ($1, 'daily', $2, $3, $4, NOW())
       ON CONFLICT (chain_id, period_type, period_key)
       DO UPDATE SET spent = budget_tracking.spent + $3, updated_at = NOW()`,
      [chain, periodKey, budgetPerTrade, 5.0] // 默认每日限额 5.0 原生代币
    );

    await pgClient.query('COMMIT');
    logger.trade('trade-engine', `开仓成功 | 代币: ${whitelist.symbol} | 数量: ${amountOut.toFixed(4)} | PnL监控启动`);

    // 广播消息给前端
    if (wsBroadcast) {
      wsBroadcast({
        type: 'trade:executed',
        payload: newPosition
      });
    }

    return newPosition;
  } catch (err) {
    await pgClient.query('ROLLBACK');
    logger.error('trade-engine', `交易执行失败，已回滚事务: ${err.message}`, { signal_id: signal.id });
    throw err;
  } finally {
    pgClient.release();
  }
}

/**
 * 真实平仓逻辑 (支持止盈、止损、手动)
 */
async function closeRealPosition(positionId, closePriceUsd, status, wsBroadcast) {
  const apiKey = process.env.GMGN_API_KEY;

  const res = await db.query('SELECT * FROM positions WHERE id = $1', [positionId]);
  const pos = res.rows[0];
  if (!pos || pos.status !== 'open') {
    throw new Error('未找到该活跃持仓');
  }

  const chain = pos.chain_id;
  const ca = pos.contract_address;
  const wlId = pos.whitelist_id;

  logger.info('trade-engine', `进入平仓流水线 | 持仓ID: ${positionId} | 平仓类型: ${status} | 代币: ${pos.symbol}`);

  let sellTxHash = null;
  let exitPrice = closePriceUsd;

  // 获取该代币精度
  let tokenDecimals = 9;
  try {
    const tokenInfo = await gmgnHttp.getTokenInfo(chain, ca);
    if (tokenInfo && tokenInfo.decimals !== undefined) {
      tokenDecimals = Number(tokenInfo.decimals);
    }
  } catch (err) {
    tokenDecimals = chain === 'sol' ? 9 : 18;
  }

  if (!apiKey) {
    // ◈ Mock 平仓模式
    sellTxHash = '0xmock_real_sell_' + Math.random().toString(36).substring(7);
  } else {
    // ◈ 真实平仓模式
    const fromAddress = chain === 'sol' ? process.env.WALLET_SOL : process.env.WALLET_EVM;
    const privateKeyStr = process.env.GMGN_PRIVATE_KEY;

    // A. 撤销在途的 TP/SL 挂单
    if (pos.tp_order_id) {
      try {
        await gmgnHttp.cancelStrategyOrder(chain, {
          chain,
          order_id: pos.tp_order_id,
          from_address: fromAddress
        });
        logger.info('trade-engine', `成功撤销在途条件单 | ID: ${pos.tp_order_id}`);
      } catch (err) {
        logger.error('trade-engine', `撤销条件单失败 (可能已成交或过期): ${err.message}`);
      }
    }

    // B. 获取卖出 Swap 路由 (输入是持有的代币，输出是原生包装代币)
    const nativeOut = getNativeTokenAddress(chain);
    const rawSellAmount = Math.floor(Number(pos.amount_out) * Math.pow(10, tokenDecimals)).toString();
    
    try {
      const routeData = await gmgnHttp.getSwapRoute(chain, ca, nativeOut, rawSellAmount, fromAddress, 15);
      const unsignedTx = routeData.raw_tx.tx_data;
      exitPrice = Number(routeData.quote_price || closePriceUsd);

      // C. 签署交易并提交
      let signedTx = null;
      if (chain === 'sol') {
        const keypair = loadSolanaKeypair(privateKeyStr);
        const txBuffer = Buffer.from(unsignedTx, 'base64');
        const transaction = VersionedTransaction.deserialize(txBuffer);
        transaction.sign([keypair]);
        signedTx = Buffer.from(transaction.serialize()).toString('base64');
      } else {
        const wallet = new Wallet(privateKeyStr);
        
        let txParams;
        if (typeof unsignedTx === 'string') {
          try {
            txParams = JSON.parse(unsignedTx);
          } catch (e) {
            txParams = unsignedTx;
          }
        } else {
          txParams = unsignedTx;
        }

        if (typeof txParams === 'object') {
          const chainId = EVM_CHAIN_IDS[chain] || 1;
          const formattedTx = {
            to: txParams.to || txParams.target,
            data: txParams.data,
            value: txParams.value || '0x00',
            gasLimit: txParams.gasLimit || txParams.gas_limit || 300000,
            gasPrice: txParams.gasPrice || txParams.gas_price,
            chainId: chainId
          };
          signedTx = await wallet.signTransaction(formattedTx);
        } else {
          signedTx = txParams;
        }
      }

      const submitRes = await gmgnHttp.submitSwap(chain, signedTx);
      sellTxHash = submitRes.tx_hash;
      logger.info('trade-engine', `卖出平仓交易已提交 | Hash: ${sellTxHash}`);
    } catch (err) {
      logger.error('trade-engine', `卖出 Swap 执行失败，降级为强制平仓记录: ${err.message}`);
    }
  }

  // 计算最终 PnL
  const entryPrice = Number(pos.entry_price);
  const amountIn = Number(pos.amount_in);
  let pnlPct = 0;
  if (entryPrice > 0) {
    pnlPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  }
  pnlPct = Math.round(pnlPct * 100) / 100;
  const pnlNative = amountIn * (pnlPct / 100);

  // 更新 positions 为已结转状态
  const updatedRes = await db.query(
    `UPDATE positions 
     SET status = $1, 
         exit_price = $2, 
         pnl = $3, 
         pnl_pct = $4, 
         sell_tx_hash = $5,
         closed_at = NOW(), 
         updated_at = NOW() 
     WHERE id = $6 
     RETURNING *`,
    [status, exitPrice, pnlNative, pnlPct, sellTxHash, positionId]
  );
  const closedPosition = updatedRes.rows[0];

  logger.trade('trade-engine', `平仓成功 | 代币: ${pos.symbol} | 类型: ${status} | 结算 PnL: ${pnlPct}%`);

  // 广播平仓事件给前端
  if (wsBroadcast) {
    wsBroadcast({
      type: `position:${status}`,
      payload: closedPosition
    });
  }

  return closedPosition;
}

module.exports = {
  openRealPosition,
  closeRealPosition
};
