# P22 GMGN 预热与限流治理方案

> 版本：v1.0
>
> 状态：代码更新完成，待数据库迁移和 P21 关注人物实测验收
>
> 范围：GMGN 请求压力、429 冷却、P20 预热遗留和 P21 重复 Context 请求

## 1. 目标

P22 不改变固定 CA、P20 动态喊单或 P21 新关注发现的业务语义，只治理 GMGN 调用压力：

- 没有事件、订单或人工检查时，不产生周期性 GMGN 请求。
- 429 或 `RATE_LIMIT_BANNED` 冷却期间，后台低优先级请求直接拒绝，不进入队列。
- 同一个 CA 的并发强制刷新只允许一个底层请求。
- 固定 CA、动态策略和 P21 继续复用原有交易门禁、预算、Quote、Swap、订单和对账链路。

## 2. 兼容性边界

| 功能 | P22 影响 | 说明 |
|---|---|---|
| 固定 CA | 无业务语义影响 | CA、链、金额、滑点和止盈止损不变；只取消无事件的后台预热 |
| P20 动态策略 | 无匹配语义影响 | 关键词、项目名、CA、账号策略和交易执行不变；Candidate Index 预热关闭 |
| P21 新关注发现 | 无识别语义影响 | 6551 -> Grok/x_search -> CA -> GMGN 验证继续保留 |
| 交易执行 | 无订单语义影响 | Quote、Swap、query_order 和对账继续使用原流程 |

唯一可见变化是：首次真正交易时按需加载实时数据，替代提前全量加载，可能增加少量首请求延迟。

## 3. 已执行修复

1. `GMGN_CACHE_WARMER_ENABLED` 缺省值改为 `false`。
2. P20 Candidate Warmup 改用独立的 `P20_CANDIDATE_WARMUP_ENABLED`，默认关闭；P20 候选索引本身不关闭。
3. 示例配置移除硬编码的测试 API Key。
4. GMGN 冷却期间拒绝稳定对账和缓存/研究类低优先级请求。
5. `fresh` Context 请求增加进行中请求合并，避免 readiness、激活和交易同时刷新同一 key。
6. 新增 PostgreSQL `gmgn_rate_limit_state`，在配置开启时由本地进程、execution 角色和同库服务器共享令牌桶与 cooldown。
7. `provider_rate_events` 增加请求来源审计字段，P21 验证请求记录事件所属策略和进程角色。
8. P21 将 GMGN 验证快照写入 `ca_whitelist.provider_verification_snapshot`；激活仅检查钱包/RPC，不再提前调用 Quote。

## 4. P21 目标调用链

```text
6551 follow event
  -> event dedupe
  -> Grok 4.5 + x_search
  -> local candidate normalization
  -> GMGN token/info
  -> GMGN security/pool when required
  -> whitelist/signal
  -> one real-time quote
  -> swap
  -> order query and low-frequency reconciliation
```

Grok 阶段不调用 GMGN；没有关注事件时 P21 不调用 GMGN。

## 5. P22 实现边界

- PostgreSQL 共享桶按 `P22_GMGN_RATE_SCOPE` 隔离。使用同一 GMGN 出口/API 配额的进程必须配置同一个 scope。
- DB 暂时不可用时回退到本进程 scheduler，并记录可观测错误；不会因为限流状态表故障伪造交易成功。
- P21 激活复用 `provider_verification_snapshot`，交易执行仍然按需刷新必要数据，并在真实买入前只 Quote 一次。
- 固定 CA 和 P20 动态策略不改变原有交易参数或授权；只有 GMGN 请求增加共享限流和审计。
- 429 冷却由响应中的 `reset_at`/`X-RateLimit-Reset` 驱动，冷却期内后台请求拒绝，必要交易请求排到冷却结束后。

## 6. 验收标准

- 无事件、无订单、无人工检查时连续 15 分钟 GMGN 请求为 0。
- 单个去重 CA 候选最多 3 个验证只读请求；同一事件的候选数量仍受 P21 唯一 CA 规则限制，再加 1 次交易 Quote 和 1 次 Swap。
- 冷却期间后台队列不增长。
- 本地与服务器不使用同一出口 IP 并发运行 GMGN execution。
- 限流测试使用 mock/fixture，实盘验收期间主动 429 为 0。
- 部署前必须先应用迁移 `038_p22_gmgn_shared_rate_state_and_audit.sql` 和 `039_p22_follow_verification_snapshot.sql`，并在所有 execution 实例设置相同的 `P22_GMGN_RATE_SCOPE`。
