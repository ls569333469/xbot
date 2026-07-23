# GMGN 官方资料归档

> 归档日期：2026-07-20  
> 用途：xbot 的 GMGN Agent API / OpenAPI 接入、实现校验与后续升级参考  
> 原则：`official/` 下的内容保持官方原文，不在原始快照中混入项目修改

## 来源

| 来源 | 在线地址 | 本地归档 |
|---|---|---|
| GMGN Agent API | <https://docs.gmgn.ai/index/gmgn-agent-api> | `official/gmgn-agent-api.md` |
| Generate Public Key | <https://docs.gmgn.ai/index/generate-public-key> | `official/generate-public-key.md` |
| GitBook 文档索引 | <https://docs.gmgn.ai/index/llms.txt> | `official/llms.txt` |
| GMGN OpenAPI Wiki | <https://github.com/GMGNAI/gmgn-skills/wiki> | `official/gmgn-skills-wiki/` |
| GMGN Skills / CLI | <https://github.com/GMGNAI/gmgn-skills> | `official/gmgn-skills/` |
| GMGN Skills Market | <https://gmgn.ai/ai?chain=bsc&tab=skills_market> | 在线查看，详见下方说明 |

固定快照版本：

- `gmgn-skills` commit：`f77da2a95eb0558c60e1fe9ca797ae8104dc47e0`
- `gmgn-skills.wiki` commit：`3d11e171d444dc344e8b168c099e55bcbea551c9`

Skills Market 页面声明的清单地址为 `https://gmgn.ai/static/opstatic/skills_zh-CN.json`。该地址在浏览器页面中可被站点使用，但独立下载请求返回 HTTP 403，因此本次未保存不完整或重建版本。API 接入所需的详细参数、响应字段和官方参考实现已经包含在 `gmgn-skills` 快照中。

## 推荐阅读顺序

1. `official/gmgn-agent-api.md`：产品能力、凭证申请和支持链概览。
2. `official/generate-public-key.md`：Ed25519/RSA API 认证密钥对生成方式。
3. `official/gmgn-skills-wiki/Home-Chinese.md`：OpenAPI 文档导航。
4. `official/gmgn-skills/skills/gmgn-token/SKILL.md`：Token 信息、安全与池子接口。
5. `official/gmgn-skills/skills/gmgn-market/SKILL.md`：行情、K 线与排行榜接口。
6. `official/gmgn-skills/skills/gmgn-swap/SKILL.md`：报价、Swap、订单状态和策略单接口。
7. `official/gmgn-skills/src/client/OpenApiClient.ts`：官方请求路径和认证实现。
8. `official/gmgn-skills/src/client/signer.ts`：签名字符串、时间戳和 Ed25519/RSA 签名实现。

## 对 xbot 的关键结论

### 1. `GMGN_PRIVATE_KEY` 不是链钱包私钥

官方 `.env.example` 明确说明：

- `GMGN_PRIVATE_KEY` 是 GMGN OpenAPI 请求签名私钥。
- 推荐使用 Ed25519，也支持 RSA-SHA256。
- 私钥必须与创建 API Key 时上传的公钥属于同一密钥对。
- 私钥只在本地生成 `X-Signature`，不会作为 Solana/EVM 交易私钥使用。

xbot 当前把它同时传给 Solana `Keypair` 和 EVM `Wallet` 的做法需要移除。

### 2. 当前查询 API 路径和认证方式不匹配官方实现

官方查询认证：

```text
X-APIKEY: <GMGN_API_KEY>

query:
  timestamp=<Unix seconds>
  client_id=<UUID>
```

主要路径：

```text
GET /v1/token/info
GET /v1/token/security
GET /v1/token/pool_info
GET /v1/trade/quote
GET /v1/trade/gas_price
```

xbot 当前使用 `/api/v1/token_info/{chain}/{address}`、`x-route-key` 和 `Authorization`，并缺少 `timestamp`、`client_id`，这与当前官方客户端不一致，也是 HTTP 403 的直接排查方向。

### 3. Signed Auth 规则

Swap 和订单接口需要：

```text
X-APIKEY: <GMGN_API_KEY>
X-Signature: <base64 signature>
```

签名消息格式：

```text
{sub_path}:{sorted_query_string}:{request_body}:{timestamp}
```

其中：

- `timestamp` 是 Unix 秒，不是毫秒，服务端允许误差约正负 5 秒。
- `client_id` 是每次请求生成的 UUID，并参与排序后的 Query 和签名。
- Query 按 Key 字母升序排列并进行 URL 编码。
- Ed25519 直接签名原始 UTF-8 消息。
- RSA 使用 RSA-PSS + SHA256，salt length 为 32。

### 4. 官方交易模型不是“返回原始交易后由钱包私钥签链上交易”

官方当前交易路径：

```text
POST /v1/trade/swap
GET  /v1/trade/query_order
POST /v1/trade/strategy/create
GET  /v1/trade/strategy/orders
POST /v1/trade/strategy/cancel
```

`POST /v1/trade/swap` 使用 GMGN API 签名授权并返回 `order_id`。调用方必须继续轮询订单状态：

```text
pending -> processed -> confirmed
                         failed
                         expired
```

只有状态为 `confirmed` 才能向业务层报告成功。xbot 当前的 `get_swap_route -> 本地链钱包签名 -> submit` 流程应根据官方 Agent API 重构，而不是继续修补旧接口。

### 5. 支持范围和限制

- 官方 Agent API 当前列出的交易链为 SOL、BSC、Base；ETH 仍标记为集成中。
- 请求只支持 IPv4。凭证正确但返回 401/403 时，应检查出口是否走 IPv6。
- `swap` 和大部分订单接口需要 API Key + API 签名私钥。
- Quote、Token 和 Market 等只读接口通常只需要 API Key。
- Swap 成功后附加的 TP/SL 策略单属于 best-effort：Swap 成功不代表策略单一定创建成功，业务层必须分别记录和告警。
- 官方 Swap 路由限流采用权重模型，交易请求不能在 429 后自动循环重试。

## 更新方式

后续刷新资料时，应重新下载 GitBook Markdown，并分别拉取以下仓库：

```text
https://github.com/GMGNAI/gmgn-skills.git
https://github.com/GMGNAI/gmgn-skills.wiki.git
```

更新后记录新的 commit hash，并重新核对 `OpenApiClient.ts`、`signer.ts` 和 `gmgn-swap/SKILL.md`，避免接口升级后项目继续使用旧契约。
