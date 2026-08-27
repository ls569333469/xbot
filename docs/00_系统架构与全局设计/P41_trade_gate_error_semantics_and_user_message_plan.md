# P41 交易门禁与错误主文案收口方案

> 日期：2026-08-27
> 状态：代码已实现，待本次发布验收
> 适用范围：固定 CA、动态喊单、关注发现共用的交易记录、信号日志、交易日志、持仓页面和交易 API 错误响应

## 1. 背景与结论

此前系统把几种不同性质的状态混在同一个 `blockers` 和错误码展示中：

1. 本地交易门禁确实拒绝了本次交易；
2. GMGN 明确拒绝了请求；
3. 请求已经发出，但订单或链上结果尚未确认；
4. RPC、余额缓存、GMGN 调度器和 6551 是健康观察，不应改变 Engine；
5. 启动检查没有通过，属于 Engine/实盘授权状态，而不是单笔 provider 失败。

结果是前端显示原始英文、原始错误码或“未识别的阻断项”，用户无法判断“为什么没有买入”“是否已经提交”“是否可以重试”。P41 的结论是：

```text
交易行为继续由现有门禁和状态机决定；P41 只统一错误解释、证据传递和页面展示。
健康观察不进入交易 blockers；提交后不确定状态不显示为确定失败。
```

P41 不改变三个策略的匹配规则、交易金额、预算、CA 买入次数、GMGN 限流、重试、对账、平仓、RPC 非阻断原则或 Engine 启停权。

## 2. 目标错误契约

在 `execution` 中增加可选的统一错误描述，保持 `contract_version=p27.v1` 和所有旧字段：

```json
{
  "error": {
    "code": "CA_BUY_LIMIT_REACHED",
    "user_message": "该 CA 已达到允许的买入次数上限，本次不会重复买入",
    "category": "trade_gate",
    "source": "local_trade_gate",
    "stage": "交易门禁",
    "provider_code": null,
    "provider_message": null,
    "http_status": null,
    "result": "未提交交易",
    "order_created": false,
    "tx_hash": null,
    "retry_allowed": false,
    "next_action": "确认是否已有买入记录；不要重复提交"
  }
}
```

字段规则：

| 字段 | 规则 |
|---|---|
| `code` | 保留机器可检索的原始内部码；未知码不猜测含义 |
| `user_message` | 面向用户的中文主文案，页面优先显示它 |
| `category` | `startup_blocker`、`trade_gate`、`local_execution`、`provider_rejection`、`provider_rate_limited`、`provider_uncertain`、`health_advisory` 或 `unknown` |
| `source` | 区分本地门禁、Engine、GMGN、RPC 观察器和运行健康检查 |
| `stage` | 启动检查、交易门禁、GMGN 请求、GMGN 交易提交、健康观察等 |
| `provider_code/message` | 仅在 GMGN 返回了对应字段时保留；不伪造 |
| `result` | 明确是未提交、仅记录观察、已产生证据或提交结果待核验 |
| `order_created/tx_hash` | 只按数据库订单和 Tx 事实计算，不按错误文案推断 |
| `retry_allowed` | 当前状态机允许时才为 true；P41 不放宽重试 |
| `next_action` | 给出下一步，不建议重复点击或重复提交 |

## 3. 分类边界

### 3.1 真正的交易门禁

`CA_BUY_LIMIT_REACHED`、白名单/链/全局预算超限、单笔限额、持仓上限和无效硬限额归入 `trade_gate`。这类错误表示本次没有进入 GMGN Swap，页面明确写“本次未执行”。

### 3.2 启动和实盘授权

`LIVE_ENGINE_NOT_ARMED`、配置指纹变化、作用域不匹配、链生产权限未批准、白名单停用和准备凭证失效归入 `startup_blocker`。这类错误只说明当前信号不能在当前实盘授权下提交，不改变 Engine 的现有操作员控制语义。

### 3.3 GMGN 明确拒绝

GMGN HTTP 4xx、业务错误码和明确的 `GEvmInsufficientFunds`/`40002301` 归入 `provider_rejection`。其中余额不足的主文案固定为：

```text
钱包余额不足，无法支付本次买入金额和交易手续费
```

原始 GMGN code、message、HTTP 状态进入详情，不覆盖中文主文案。

### 3.4 GMGN 限流

HTTP 429、共享限流冷却和请求额度等待超时归入 `provider_rate_limited`。页面告诉用户等待冷却，不重复点击，不重复提交 Swap。既有全局调度器和每个 CA 的调用间隔不变。

`GMGN_RATE_LIMIT_COOLDOWN` 也必须直接归入该分类，不能因为它是本地调度器抛出的错误就显示为普通本地执行错误。

### 3.5 提交结果不确定

超时、网络断开、非 JSON、订单号缺失和提交后 Schema 异常归入 `provider_uncertain`。若写入已经开始，系统必须显示：

```text
交易提交结果暂时无法确认，不能判断为失败或重复提交
```

此时继续使用现有钱包隔离、订单对账和链上核验，不允许用户通过再次点击制造重复交易。

同一组错误在只读查询或交易准备阶段不表示存在待核验的 Swap，必须显示“GMGN 数据格式异常，无法继续”或对应的只读请求失败文案，并标记为未提交交易。GMGN 非 JSON 响应在 HTTP 层保留专用 `GMGN_NON_JSON_RESPONSE`，避免后续被误归类为通用 `GMGN_API_ERROR`。

### 3.6 健康观察

`WALLET_BALANCE_CACHE_STALE`、RPC 不可用/超时/返回异常、调度器健康、6551 心跳和未解决记录归入 `health_advisory`。余额缓存和 RPC 仍遵守 P39：过期、未知、估算 Gas 不足只记录观察，不能成为 GMGN 请求前的交易阻断，也不能改变 Engine 状态。

`CHAIN_NATIVE_BALANCE_INSUFFICIENT` 在健康读取语境下同样是观察；GMGN 真正返回的余额不足仍按上一节的 provider 拒绝处理。代码不会把健康观察项放进 `execution.blockers`。

## 4. 证据传递

数据库已经具备所需存储，不新增 Migration：

1. GMGN 订单响应从 `trade_orders.last_response_json` 读取；不能从不存在的 `trade_attempts.last_response_json` 读取。
2. 拒绝、提交不确定和平仓失败事件在 `trade_attempt_events.summary` 追加 `error_code`、provider code/message、HTTP 状态和 provider status。
3. Signals、Positions 和交易列表查询只取最近 Attempt、最近 Order 和最近 Attempt Event，再由同一个目录生成 `execution.error`。
4. 详情接口保留完整追加式事件、失败证据、重试决策、订单和链上回执；P41 不把 Secret、API Key 或完整请求鉴权信息写入页面。
5. API 写操作失败返回中文 `error` 主字段，同时返回 `code` 和 `error_detail` 供前端和日志检索。
6. 三份 P27 DTO Schema 对 `execution.error` 提供可选的正式定义，旧字段和 `contract_version` 保持不变。

## 5. 前端行为

| 页面 | 展示规则 |
|---|---|
| Signals | 显示中文主文案、分类、阶段、结果和下一步；健康观察不伪装成交易阻断 |
| Trade Log | 列表显示中文主文案；详情显示 provider code/message、HTTP 状态、订单证据和下一步 |
| Positions | 只在交易确实有执行错误时显示中文主文案；健康观察不占用平仓错误位置 |
| API Toast | 直接使用后端中文 `error`；前端仅作为兼容 fallback，不重复翻译内部英文异常 |

“交易结果待核验”使用黄色/警示样式，“健康观察”使用观察样式，真正阻断才使用红色阻断样式。任何未知错误保留原始 code，但文案明确表示暂不能判定，不显示为虚假的已失败或已成交。

## 6. 不变项与风险边界

本次明确不修改：

- 固定 CA、动态喊单、关注发现的匹配、解析和授权规则；
- Engine 的人工 Start/Stop、armed 状态、三策略共享运行模型；
- GMGN 请求权重、冷却、共享限流和每 CA 调用间隔；
- 预算、CA 重复买入、钱包写租约、链级熔断、重试和失败证据状态机；
- RPC 非阻断原则、持仓保护、平仓和外部钱包同步；
- 数据库表结构和现有 P27 REST 合同版本。

唯一行为上的收口是：健康分类错误不再被投影为交易 `blockers`，API 错误主字段改为统一中文主文案。数据库历史错误不批量改写；刷新详情后按当前目录解释历史 code。

## 7. 验收矩阵

本地至少验证：

1. CA 买入次数达到上限显示“该 CA 已达到允许的买入次数上限”，并保留 `trade_gate`。
2. RPC 超时、余额缓存过期和健康观察不进入 Position/Attempt `execution.blockers`。
3. GMGN `40002301` 或 `GEvmInsufficientFunds` 显示“钱包余额不足”，并保留 provider code/message。
4. GMGN 429 显示限流和等待动作，不建议重复提交。
5. 提交后超时/格式异常显示“交易结果待核验”，不得显示确定失败。
6. Signals、Positions、Trade Log 三个接口不会查询不存在的数据库字段。
7. 后端全量测试、前端 lint/build、发布资产审计和 `git diff --check` 通过。

## 8. 发布与回滚

P41 不新增 Migration，按 P29 A 类后端/前端应用发布流程执行：先保持 Engine 原状态，读取未完成 Attempt/Order 和钱包隔离，完成本地测试与发布审计后再做服务器原子切换。发布后只读验收 health SHA、双角色进程、API、数据库查询、Engine 和 GMGN 请求/429 增量。

如果发布后出现查询错误、错误目录加载失败或前端构建资源不匹配，保持 Engine 停止新买入，按 P29 原子回滚到上一 release；不直接改生产表，不重放信号，不补发交易。
