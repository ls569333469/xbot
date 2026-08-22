# P39 持久余额缓存新鲜度与非阻断钱包提示方案

> 日期：2026-08-22
>
> 状态：本地实现与测试中，未提交、未推送、未部署
>
> 适用生产版本：`p36.3.1-production-20260821` / `187060ab83ad84552ab4017982ad0df9c8184bf4`

## 1. 背景与目标

生产 `chain_live_readiness` 的余额记录停留在 2026-08-01。BASE 的旧余额被快速交易路径读取，在当前余额未知或 RPC 失败时，最终被 `MINIMUM_GAS_RESERVE_BREACH` 当成交易硬门禁，导致 GMGN Swap 尚未调用就被拒绝。

本次目标：

1. 识别并标记 `chain_live_readiness` 余额缓存的新鲜度、来源、缓存年龄和检查时间。
2. 过期余额不得作为“当前余额”或最低 Gas 保留门禁的事实依据。
3. RPC 成功、失败、超时、余额未知和缓存过期都只能形成 warning/audit，不得阻断 GMGN 请求。
4. 交易是否成功由 GMGN 的真实返回、订单状态和链上回执决定；GMGN 返回余额不足或 Swap 失败时，按 provider 真实失败记录。
5. Readiness 页面把“当前有效证据”和“历史/过期证据”分开表达，但不因余额/RPC 观察失败自动暂停 Engine。
6. 不改变固定 CA、动态喊单、关注发现的匹配规则、预算模型、信号快照、持仓快照、平仓和重试语义之外的功能。

## 2. 已确认根因

### 2.1 旧缓存没有新鲜度语义

`fast-path-context.js` 从 `chain_live_readiness` 读取 `native_balance` 和 `last_checked_at`，但没有计算缓存年龄；非空余额会被当作当前余额。

### 2.2 RPC 异常会中断准备阶段

`execution-service.js` 在 GMGN 未提供余额时调用 RPC。RPC 抛异常时原异常直接从 `Promise.all` 传播，交易无法进入 GMGN terminal 路径。

### 2.3 创建买入时重复硬拒绝

`trade-repository.js` 又用缓存余额计算：

```text
walletNativeBalance - planned < requiredGasReserve
    -> MINIMUM_GAS_RESERVE_BREACH
```

该判断无法证明当前链上余额，也不能替代 GMGN 的真实 Swap 结果。

### 2.4 Readiness 将 RPC 观察问题混入 blocker

探测模式下 `CHAIN_NATIVE_BALANCE_UNKNOWN`、`CHAIN_NATIVE_BALANCE_INSUFFICIENT` 和 `CHAIN_RPC_UNAVAILABLE` 当前进入 `blockers`。这些属于观测结果，不应改变 Engine 状态或成为其他策略的全局阻断理由。

## 3. 目标运行语义

| 情况 | 交易路径 | 页面/审计 | Engine |
|---|---|---|---|
| 新鲜余额缓存 | 继续 GMGN | 显示来源与年龄 | 不变 |
| 余额缓存过期 | 尝试 RPC；即使 RPC 失败也继续 GMGN | `WALLET_BALANCE_CACHE_STALE` | 不变 |
| RPC 成功 | 继续 GMGN，记录 RPC block/identity | 显示 `rpc` 来源 | 不变 |
| RPC 失败/超时/未知 | 继续 GMGN | `WALLET_BALANCE_UNKNOWN`、RPC error | 不变 |
| 估算交易后余额低于配置保留额 | 继续 GMGN | `INSUFFICIENT_NATIVE_BALANCE` / `MINIMUM_GAS_RESERVE_BREACH` warning | 不变 |
| GMGN 返回余额不足或 Swap 失败 | 按 provider 结果结束当前尝试 | 记录 provider failure 与错误码 | 不变 |
| Honeypot、严重 Rug、授权/预算/重复交易等真正业务门禁 | 维持原有局部拒绝 | 显示明确原因 | 不变 |

这里的“继续 GMGN”仅表示不因本地缓存或 RPC 观察结果提前拒绝；不绕过 GMGN 自身返回、交易授权、信号时效、预算、重复交易、钱包写租约、未确定订单和人工 Engine 状态。

## 4. 实施内容

### 4.1 快速交易上下文

文件：`backend/domains/trade/fast-path-context.js`

- 增加可配置的余额缓存 TTL：`CHAIN_READINESS_BALANCE_TTL_MS`，默认 5 分钟。
- 计算 `last_checked_at` 的 `age_ms`、`fresh`、`checked_at` 和 `usable_for_balance`。
- 过期数据仍保留在 audit context 中，便于排查和计算展示价格，但不再宣称它是当前余额。
- 不引入新的数据库表，不修改 Signal/Position 的不可变快照。

### 4.2 执行服务

文件：`backend/domains/trade/execution-service.js`

- 钱包缓存过期时优先尝试同钱包 RPC。
- RPC 调用用有界错误和短超时包住；异常、超时、无余额统一为结构化 advisory，不能拖住 GMGN terminal 路径。
- `evaluateRisk()` 将余额未知、缓存过期和估算余额不足从 `reasons` 移到 `warnings`，保留安全事实和来源。
- 风险快照记录 `wallet_native_balance_source`、缓存年龄、RPC 错误、检查时间和 advisory。
- GMGN security schema、honeypot、rug、链授权、预算、重复交易等非余额门禁保持原行为。

### 4.3 买入创建与 Gas 记录

文件：`backend/domains/trade/trade-repository.js`

- 删除基于本地余额的 `MINIMUM_GAS_RESERVE_BREACH` 硬拒绝。
- 将估算余额短缺、未知余额和配置保留额写入风险快照/Attempt metadata，供前端和审计查询。
- 保留预算预留、交易幂等、钱包写租约、订单不确定性与重试边界。
- GMGN provider 返回的余额不足或 Swap 失败仍按真实 provider 失败落库，不转成成功。

### 4.4 Readiness 与历史证据展示

文件：`backend/domains/trade/readiness-service.js`

- `chain_live_readiness` 的余额字段返回 `native_balance_checked_at`、`native_balance_age_ms`、`native_balance_fresh`、`native_balance_source`。
- 余额未知、余额不足、RPC 失败从探测 blocker 改为 chain advisory。
- 合约证据保留最新历史记录，但返回 `stale`/`valid_now` 语义；只有有效、版本匹配、配置 context 匹配的证据才作为当前证据。
- 历史过期证据不能伪装成当前有效证据，也不能仅因过期展示就自动暂停 Engine。

### 4.5 环境说明

文件：`backend/.env.example`

增加：

```text
CHAIN_READINESS_BALANCE_TTL_MS=300000
CHAIN_RPC_ADVISORY_TIMEOUT_MS=500
```

生产未配置时使用代码默认值，不要求本次先改生产配置。

## 5. 其他缓存审计与后续边界

本次不把所有缓存改成实时请求，避免增加 GMGN 调用和 429 风险。已确认：

| 数据 | 当前结论 | 后续处理 |
|---|---|---|
| `chain_live_readiness` 余额 | 已发现 8 月 1 日旧数据，直接关联本次误拒绝 | P39 增加 TTL、来源和非阻断语义 |
| `chain_readiness_evidence` | 合约 probe 有过期记录 | P39 明确历史/当前字段，当前有效判断继续要求 `valid_until`、版本和 context |
| `asset_metadata` | 主要用于名称/Symbol/Logo，当前无 8 月 1 日记录 | 后续增加元数据 TTL 和刷新策略，不改交易链路 |
| `ca_whitelist.token_metadata_fetched_at` | 存在较旧手动 CA 元数据 | 后续做展示/配置刷新，不作为交易余额事实 |
| `dynamic_asset_variants` / `dynamic_candidate_index` | 索引允许 `expires_at IS NULL` 长期有效 | 后续增加来源版本/失效策略，不夹带 P39 交易修复 |
| `kol_price_replay_cache` | 当前为空 | 保持 CA 间隔和全局节流，避免批量回放触发 429 |
| `token_research_reports` | 查询有 `expires_at > NOW()` 过滤 | 保持现状，另行优化报告刷新 |
| Signal/Position/provider snapshot | 历史事实或不可变快照 | 不按实时数据覆盖，避免改变交易审计 |

## 6. 安全边界

P39 不做以下事情：

- 不调用真实 GMGN Swap 作为代码测试的一部分；
- 不修改生产 Engine、生产数据库余额或环境开关；
- 不自动重试确定性交易失败；
- 不解除 Honeypot、Rug、授权、预算、重复买入、写租约、订单不确定性和人工停机控制；
- 不修改 KOL 投研、6551 事件解析、动态关键词匹配、三策略核心配置；
- 不把历史 Signal 重新入队，不因为修复旧缓存而补买。

## 7. 测试矩阵

### 单元测试

1. 新鲜缓存包含正确的年龄和 `fresh=true`。
2. 2026-08-01 旧缓存标记为 stale，不作为当前余额。
3. 缓存过期且 RPC 成功，使用 RPC 结果并记录来源。
4. 缓存过期且 RPC 返回失败、抛异常或超时，返回 advisory，不抛出阻断执行的异常。
5. RPC 长时间不返回时，在 advisory 超时内结束观察并继续 GMGN。
6. 新鲜/过期/未知余额在 `evaluateRisk()` 中都不产生余额硬拒绝 reason。
7. `MINIMUM_GAS_RESERVE_BREACH` 只作为审计 warning，不阻止 `createBuyAttempt()` 进入 GMGN 前置提交。
8. GMGN 自身返回失败仍保留 provider failure 语义。
9. Readiness 的余额/RPC问题进入 advisories，不进入 blockers。
10. 过期合约证据显示 stale，当前有效证据判断仍严格。

### 回归

- Backend 定向交易/readiness 测试；
- Backend 全量测试；
- `git diff --check`；
- 不调用真实 GMGN Swap，不部署生产。

## 8. 发布顺序

1. 本地完成代码与测试。
2. 复核 diff 只包含 P39 文档、余额执行链路、readiness、环境示例和对应测试。
3. 形成单独 commit 后再由用户批准推送 GitHub。
4. 服务器先保持 Engine 当前状态，备份数据库并执行只读 readiness 验收。
5. 部署后先验证余额缓存年龄、RPC advisory、GMGN provider failure 落库和三策略非回归，再由用户决定是否进行小额实盘。

## 9. 验收标准

- 8 月 1 日旧 BASE 缓存不会再产生 `MINIMUM_GAS_RESERVE_BREACH` 硬拒绝。
- RPC 失败/超时不会让准备阶段抛出未处理异常。
- 余额未知、过期和估算不足在前端/审计中可见，但不会阻止 GMGN 请求。
- GMGN 真实返回仍是交易最终结果。
- `readiness` 能清楚显示余额缓存时间、年龄、来源和过期状态。
- 固定 CA、动态喊单、关注发现、持仓、平仓和现有核心门禁测试通过。

## 10. 结论

P39 的原则是：

```text
旧缓存只做历史证据，RPC 只做观察，GMGN 返回决定交易；健康提示不改变 Engine。
```
