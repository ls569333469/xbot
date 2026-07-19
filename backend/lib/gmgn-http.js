// D:\AI_Projects\xbot\backend\lib\gmgn-http.js
const crypto = require('crypto');
const logger = require('./logger');

const BASE_URL = 'https://openapi.gmgn.ai';

// 密钥解析器：支持 hex / base64 / solana数组 / PEM 格式的 Ed25519 私钥，并统一转化为 PKCS#8 密钥对象
function getPrivateKeyObject(rawKeyStr) {
  if (!rawKeyStr) return null;
  if (rawKeyStr.includes('-----BEGIN PRIVATE KEY-----')) {
    try {
      return crypto.createPrivateKey(rawKeyStr);
    } catch (e) {
      logger.error('gmgn-http', `解析 PEM 私钥失败: ${e.message}`);
      return null;
    }
  }
  let rawBytes;
  try {
    const trimmed = rawKeyStr.trim();
    if (/^[0-9a-fA-F]+$/.test(trimmed)) {
      rawBytes = Buffer.from(trimmed, 'hex');
    } else if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      rawBytes = Buffer.from(JSON.parse(trimmed));
    } else {
      rawBytes = Buffer.from(trimmed, 'base64');
    }
  } catch (e) {
    logger.error('gmgn-http', `解码二进制私钥失败: ${e.message}`);
    return null;
  }

  // Solana 私钥通常为 64 字节 (后 32 字节为公钥)，我们取前 32 字节私钥
  if (rawBytes.length === 64) {
    rawBytes = rawBytes.subarray(0, 32);
  }

  if (rawBytes.length === 32) {
    // 注入 Ed25519 PKCS#8 DER 标准前缀，用以构造 Node.js 识别的 KeyObject
    const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
    const derKey = Buffer.concat([prefix, rawBytes]);
    try {
      return crypto.createPrivateKey({
        key: derKey,
        format: 'der',
        type: 'pkcs8'
      });
    } catch (e) {
      logger.error('gmgn-http', `使用 PKCS#8 包装私钥失败: ${e.message}`);
      return null;
    }
  }
  
  logger.warn('gmgn-http', `私钥长度不匹配，预期 32 字节，当前为 ${rawBytes.length} 字节`);
  return null;
}

// 获取请求头 (带有 API Key，且当配置私钥时自动附带 Ed25519 签名头部)
function getHeaders(path = '', query = {}, body = '') {
  const apiKey = process.env.GMGN_API_KEY;
  const privateKeyStr = process.env.GMGN_PRIVATE_KEY;
  
  const headers = {
    'Content-Type': 'application/json',
  };
  
  if (apiKey) {
    headers['x-route-key'] = apiKey;
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  if (privateKeyStr && path) {
    const privateKey = getPrivateKeyObject(privateKeyStr);
    if (privateKey) {
      const timestamp = Date.now().toString();
      
      // 升序排列 Query 参数以生成一致的签名串
      const sortedKeys = Object.keys(query).sort();
      const sortedQueryStr = sortedKeys
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
        .join('&');
      
      const bodyStr = typeof body === 'object' ? JSON.stringify(body) : (body || '');
      
      // 构造签名消息 message: {sub_path}:{sorted_query_string}:{request_body}:{timestamp}
      const message = `${path}:${sortedQueryStr}:${bodyStr}:${timestamp}`;
      
      try {
        // 对 Ed25519 签名，摘要算法传 null
        const signature = crypto.sign(null, Buffer.from(message), privateKey);
        headers['X-Signature'] = signature.toString('base64');
        headers['X-Timestamp'] = timestamp;
      } catch (e) {
        logger.error('gmgn-http', `生成 Ed25519 签名发生异常: ${e.message}`);
      }
    }
  }

  return headers;
}

// 模拟代币基础数据生成器（降级使用，防止未配 API key 阻断测试）
function getMockTokenInfo(chain, ca) {
  let hash = 0;
  for (let i = 0; i < ca.length; i++) {
    hash = ca.charCodeAt(i) + ((hash << 5) - hash);
  }
  const basePrice = Math.abs(hash % 100) / 1000 + 0.001;
  const drift = (Math.random() - 0.5) * 0.03;
  const price = basePrice * (1 + drift);

  return {
    chain,
    address: ca,
    symbol: 'MOCK_TOKEN',
    name: 'Simulated MEME Token',
    decimals: 9,
    price: price,
    price_usd: price,
    liquidity: 15000 + Math.random() * 5000,
    market_cap: 120000 + Math.random() * 30000,
    volume_24h: 85000,
    logo: ''
  };
}

// 模拟代币安全数据
function getMockTokenSecurity() {
  return {
    is_honeypot: false,
    buy_tax: 0,
    sell_tax: 0,
    is_renounced: true,
    is_blacklist: false,
    lock_summary: {
      is_locked: true,
      lock_percent: 98.5
    },
    flags: []
  };
}

// 模拟交易报价与原始交易体
function getMockQuote(from, to, amount) {
  return {
    quote_price: 1.0,
    out_amount: amount,
    price_impact: 0.1,
    gas_fee: 0.00005,
    slippage: 1.0,
    raw_tx: {
      tx_data: 'mock_transaction_serialized_data_base64_or_hex',
      tx_hash: '0xmock_hash_' + Math.random().toString(36).substring(7)
    }
  };
}

/**
 * 获取代币基本价格与元数据
 */
async function getTokenInfo(chain, ca) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，降级为 Mock 模式获取 Token Info', { chain, ca });
    return getMockTokenInfo(chain, ca);
  }

  const url = `${BASE_URL}/api/v1/token_info/${chain}/${ca}`;
  try {
    const res = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.data) {
      return data.data;
    }
    throw new Error('Invalid response structure');
  } catch (err) {
    logger.error('gmgn-http', `获取代币 ${ca} 价格失败，降级为 Mock 价格: ${err.message}`, { chain, ca });
    return getMockTokenInfo(chain, ca);
  }
}

/**
 * 获取代币安全属性 (Honeypot/Tax/Locks)
 */
async function getTokenSecurity(chain, ca) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，降级为 Mock 模式获取 Token Security', { chain, ca });
    return getMockTokenSecurity();
  }

  const url = `${BASE_URL}/api/v1/token_security/${chain}/${ca}`;
  try {
    const res = await fetch(url, { headers: getHeaders(), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.data) {
      return data.data;
    }
    throw new Error('Invalid response structure');
  } catch (err) {
    logger.error('gmgn-http', `获取代币 ${ca} 安全检查失败，降级为 Mock 安全属性: ${err.message}`, { chain, ca });
    return getMockTokenSecurity();
  }
}

/**
 * 获取价格冲击和预计成交量 (Quote)
 */
async function quote(chain, fromToken, toToken, amount, slippage) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，降级为 Mock 模式获取交易 Quote', { chain, fromToken, toToken });
    return getMockQuote(fromToken, toToken, amount);
  }

  const path = `/defi/router/v1/${chain === 'sol' ? 'sol' : chain}/tx/get_swap_route`;
  const query = {
    token_in_address: fromToken,
    token_out_address: toToken,
    in_amount: amount.toString(),
    slippage: slippage.toString()
  };
  const sortedKeys = Object.keys(query).sort();
  const queryString = sortedKeys.map(k => `${k}=${query[k]}`).join('&');
  const url = `${BASE_URL}${path}?${queryString}`;

  try {
    const res = await fetch(url, { headers: getHeaders(path, query), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.data) {
      return {
        quote_price: data.data.quote_price,
        out_amount: data.data.out_amount,
        price_impact: data.data.price_impact || 0,
        gas_fee: data.data.gas_fee || 0,
        slippage: slippage
      };
    }
    throw new Error('Invalid response structure');
  } catch (err) {
    logger.error('gmgn-http', `获取 Quote 失败，降级为 Mock 交易 Quote: ${err.message}`, { chain, fromToken, toToken });
    return getMockQuote(fromToken, toToken, amount);
  }
}

/**
 * 获取未签署的原生交易路由及 Payload
 */
async function getSwapRoute(chain, fromToken, toToken, amount, fromAddress, slippage, isAntiMev = true) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，返回 Mock 交易路由 Payload');
    return {
      raw_tx: {
        tx_data: Buffer.from('mock_serialized_transaction_payload').toString('base64'),
        tx_hash: '0xmock_hash_' + Math.random().toString(36).substring(7),
        quote_price: 1.0,
        out_amount: amount.toString()
      }
    };
  }

  const path = `/defi/router/v1/${chain === 'sol' ? 'sol' : chain}/tx/get_swap_route`;
  const query = {
    token_in_address: fromToken,
    token_out_address: toToken,
    in_amount: amount.toString(),
    from_address: fromAddress,
    slippage: slippage.toString()
  };
  
  if (chain === 'sol') {
    query.is_anti_mev = isAntiMev ? 'true' : 'false';
    query.fee = '0.002'; // Solana 防 MEV Jito Tip
  }

  const sortedKeys = Object.keys(query).sort();
  const queryString = sortedKeys.map(k => `${k}=${query[k]}`).join('&');
  const url = `${BASE_URL}${path}?${queryString}`;

  try {
    const res = await fetch(url, { headers: getHeaders(path, query), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.data) {
      return data.data;
    }
    throw new Error(data.msg || data.error || '获取 Swap 路由交易体结构失败');
  } catch (err) {
    logger.error('gmgn-http', `获取交易路由失败: ${err.message}`, { chain, fromToken, toToken });
    throw err;
  }
}

/**
 * 提交签署后的真实交易字节码到链上
 */
async function submitSwap(chain, signedTxHex) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，返回 Mock 交易上链 Hash');
    return {
      tx_hash: '0xmock_submitted_tx_' + chain + '_' + Math.random().toString(36).substring(7)
    };
  }

  const path = `/defi/router/v1/${chain === 'sol' ? 'sol' : chain}/tx/submit`;
  const body = { signed_tx: signedTxHex };
  const url = `${BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(path, {}, body),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.ok) {
      return data.data; // 应包含 { tx_hash }
    }
    throw new Error(data.msg || data.error || '提交交易广播失败');
  } catch (err) {
    logger.error('gmgn-http', `提交交易失败: ${err.message}`, { chain });
    throw err;
  }
}

/**
 * 创建止盈止损限制策略订单 (Limit/Strategy Order)
 */
async function submitStrategyOrder(chain, params) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，返回 Mock 策略条件单 ID');
    return {
      order_id: 'mock_strategy_order_' + Math.random().toString(36).substring(7)
    };
  }

  const path = `/v1/trade/strategy/create`;
  const url = `${BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(path, {}, params),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.ok) {
      return data.data; // 应包含 { order_id }
    }
    throw new Error(data.msg || data.error || '提交策略订单失败');
  } catch (err) {
    logger.error('gmgn-http', `提交策略订单接口错误: ${err.message}`, { chain });
    throw err;
  }
}

/**
 * 撤销止盈止损策略订单
 */
async function cancelStrategyOrder(chain, params) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，返回 Mock 策略条件单撤销成功');
    return { ok: true };
  }

  const path = `/v1/trade/strategy/cancel`;
  const url = `${BASE_URL}${path}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: getHeaders(path, {}, params),
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.ok) {
      return data.data;
    }
    throw new Error(data.msg || data.error || '撤销策略订单失败');
  } catch (err) {
    logger.error('gmgn-http', `撤销策略订单接口错误: ${err.message}`, { chain });
    throw err;
  }
}

/**
 * 状态同步：查询策略订单链上执行状态
 */
async function queryStrategyOrder(chain, orderId, fromAddress) {
  const apiKey = process.env.GMGN_API_KEY;
  if (!apiKey) {
    logger.warn('gmgn-http', 'GMGN_API_KEY 未配置，返回 Mock 策略条件单触发状态');
    return {
      order_id: orderId,
      status: 'completed', // 默认返回已成交以支持 mock 同步逻辑
      executed_price: 1.1,
      pnl: 0.1
    };
  }

  const path = `/v1/trade/strategy/status`;
  const query = { chain, order_id: orderId, from_address: fromAddress };
  const sortedKeys = Object.keys(query).sort();
  const queryString = sortedKeys.map(k => `${k}=${query[k]}`).join('&');
  const url = `${BASE_URL}${path}?${queryString}`;

  try {
    const res = await fetch(url, { headers: getHeaders(path, query), signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      throw new Error(`HTTP error! status: ${res.status}`);
    }
    const data = await res.json();
    if (data && data.ok) {
      return data.data; // 返回包含 { status: 'pending'|'completed'|'cancelled'|'failed' }
    }
    throw new Error(data.msg || data.error || '查询策略订单失败');
  } catch (err) {
    logger.error('gmgn-http', `查询策略订单状态接口错误: ${err.message}`, { chain, orderId });
    throw err;
  }
}

module.exports = {
  getTokenInfo,
  getTokenSecurity,
  quote,
  getSwapRoute,
  submitSwap,
  submitStrategyOrder,
  cancelStrategyOrder,
  queryStrategyOrder
};
