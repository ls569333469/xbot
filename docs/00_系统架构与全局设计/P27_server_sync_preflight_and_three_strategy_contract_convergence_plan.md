# P27 服务器同步前全链路收口与三策略契约统一方案

> 版本：v1.2
> 日期：2026-08-12
> 状态：代码、Migration、自动回归和 DOM 验收已完成；三策略真实小额闭环与已披露凭据轮换待完成
> 前置版本：P20-P26
> 目标：纠正 v1.0 的错误归因，收口三策略数据契约、交易元数据、GMGN 调用边界、前端设计系统和发布链路，验收后再同步服务器

## 1. 复核结论

P27 v1.0 的方向基本正确，但有错误归因、兼容性缺口和发布验收遗漏，不应直接按 v1.0 实施。基于当前代码和本地数据库只读证据，确认：

- 信号页实际调用 `/api/system/signals`，该查询已经 JOIN `ca_whitelist`；v1.0 将“未知代币”归因于 `signal/queries.js SELECT *` 不准确。
- `positions` 表已有 `symbol`。真实问题是上游可能写入空值，且 `SELECT p.*, wl.symbol` 存在同名列覆盖风险。
- 前端 `/history` 实际展示 `/api/trade/attempts` 的 Trade Attempt，不是 `/api/trade/history` 的已平仓 Position。v1.1 只收口 Signal/Position/History 仍会漏掉交易记录主页面。
- 之前数据库读取失败来自临时命令未正确加载 `.env` 或引号错误，不是已确认的 `DB_PASSWORD` 异常。本轮已成功完成只读核对。
- 当前数据库已有历史真实交易证据：固定 CA 确认买入 11 笔/平仓 10 笔，动态喊单确认买入 3 笔/平仓 1 笔，关注发现确认买入 3 笔/平仓 2 笔。
- 上述证据说明统一交易内核可完成三策略真实交易，也说明“未知代币”是元数据管道缺陷，不是买入能力缺失。
- 过去 24 小时 GMGN 审计没有 `429`，但保护策略对账调用量较高：`strategy_batch_query` 271 次、`strategy_query` 195 次。这些不是未触发策略的买入；当前代码已有批量查询，仍需核对版本切换前后的调用、due 集合、频率和防 N+1 退化。
- P26 分进程后不能在数据库事务提交后才临时广播 Signal。实体与事件 outbox 必须同事务写入，`NOTIFY` 只负责唤醒 relay；否则进程在 COMMIT 后、广播前退出时会永久丢事件。
- DTO 中的策略规范值必须与现有运行域一致：`fixed_ca | dynamic_policy | follow_discovery`。`dynamic_keyword` 是 Signal 类型，不是策略类型。
- P27 最终代码仍须重做三条真实 6551 入口的小额买入和平仓，历史成功不能代替本次发布验收。

P27 不继续增加业务门禁，而是把链路收敛为：

```text
6551 真实事件
  -> 目标策略命中（未命中则结束）
  -> 策略域确定唯一 chain + CA
  -> 创建带不可变快照的 Signal
  -> Live Queue Claim
  -> Trade Intent / Attempt 幂等
  -> GMGN 必要交易调用
  -> Order / Chain Receipt
  -> Position / Lot / Protection
  -> 独立 Sell Attempt
  -> Sell Order / Receipt / Settlement
```

未命中的策略不创建交易 Signal，也不调用 GMGN 买入端点。已确认成交不得因为页面刷新、启动检查或 Research 再次提交 Swap。

## 2. 审计范围

1. `backend/domains` 的 6551、fixed CA、dynamic、follow discovery、trade、research、system、whitelist 域。
2. `backend/jobs`、`backend/scripts`、`backend/server.js`、Supervisor 和 `deploy` 启动资产。
3. Migration `000-043`、数据库结构、约束、迁移记录和历史数据投影。
4. `frontend/src` 的 API、TypeScript、WebSocket、CSS、公共组件和页面样式。
5. P20-P26 测试、真实验收工具、Paper/Record 工具和历史日志。
6. Git 跟踪文件、Secret、`.env`、PEM、日志、dump、构建输出和服务器发布输入。

审计原则：先证明可达性和数据主人，再决定保留、迁移、归档或删除；不以“页面没有入口”作为删除代码的唯一依据。

## 3. 三策略标准链路

### 3.1 固定 CA

```text
6551 tweet/reply/quote/follow
  -> 已配置 KOL -> 项目关系命中
  -> 读取已保存的 chain + contract_address + asset snapshot
  -> 创建 handle_match/ca_mention/ticker_mention Signal
  -> 统一交易内核
```

固定 CA 不重新搜索 CA，也不因每次事件重新调用 GMGN 验收。固定配置的 `symbol`、`project_name` 和 `token_logo_url` 是首选展示元数据。

### 3.2 P20 动态喊单

```text
6551 tweet/reply/quote
  -> P20 意图判断
  -> 从原文提取完整 CA
  -> Candidate Index 或本地 RPC 唯一确定链
  -> 保留本地 candidate metadata
  -> 创建 dynamic_keyword Signal
  -> 统一交易内核
```

P20 Live 事件路径不得调用 GMGN `token/info`、`security`、`pool_info`、`rank` 或 `trenches` 做 CA 发现。完整 EVM CA 在允许多条 EVM 链时必须使用本地 RPC 唯一确定，不能丢弃或猜链。显式人工 Research 可使用隔离的 GMGN 读接口，但不属于 Live 事件路径。

### 3.3 P21 关注发现

```text
6551 follow
  -> 确认 target user id 和关注时间
  -> Grok/x_search 研究账号、项目身份、人员关系和 CA 证据
  -> 保留 project_name/project_handle/evidence IDs
  -> 本地 RPC 唯一确定 EVM 链
  -> 唯一 chain + CA
  -> 创建 follow_discovery Signal
  -> 统一交易内核
```

Grok 只负责 X/公开资料研究和自然语言分析，提示词不包含 GMGN、本地程序或交易指令。GMGN 不参与关注发现、人物关系判断或 CA 提取。关注发现永久去重，每轮验收必须使用全新目标账号。

## 4. 已确认问题及关联风险

### P0：P20/P21 元数据在生产链路中丢失

实际信号查询已 JOIN `ca_whitelist`。真正问题发生在生产者链路：

- P20 只有完整 CA 时，RPC 可确定链，但 candidate 可能没有 `name/symbol`。
- P21 Grok schema 包含 `project_name`，但 `normalizeResearchResult()` 没有稳定保留到 selected candidate。
- `follow-discovery/resolver.js` 构造 `selected` 时未保留 `name/symbol/project_name/project_handle`。
- `materializer.js` 写入 whitelist 的 `symbol/project_name` 因而仍可能为空。
- 数据库最近的 P20/P21 Signal 和 Position 确实大量存在 `symbol/project_name = null`，其中多笔已确认买入或平仓。

必须从 Grok/P20 candidate -> selected -> whitelist -> signal snapshot -> position snapshot 端到端修复。

### P0：展示元数据与精确结算元数据混用

| 类型 | 字段 | 用途 | 缺失处理 |
|---|---|---|---|
| 展示元数据 | `name`、`symbol`、`logo_url`、`project_name` | 页面和通知显示 | 不阻止交易，最后用缩短 CA |
| 路由必需字段 | `chain_id`、`contract_address` | 选择 GMGN 链和交易对 | 缺失或不唯一时不得交易 |
| 精确结算字段 | raw amounts、input/output decimals | Lot、盈亏、平仓 | 由 GMGN Order/Report 和 Receipt 在成交后确认 |

当前买入 Swap 使用 native input raw amount 和目标 CA，不需要预先调用 `token/info` 获取目标 token decimals；GMGN Order/Report 和链上 Receipt 为成交结算提供精确 raw amounts/decimals。若 confirmed 证据仍缺精确值，必须进入对账/人工核查，不得伪造 Lot、重提 Swap，也不得为了补显示名称把 `token/info` 放回买入热路径。

### P0：前后端字段和事件契约漂移

- `SignalType` 和 `SIGNAL_TYPE_LABELS` 缺少 `dynamic_keyword | follow_discovery`，直接造成“未知匹配”。
- `TradeSignal` 混用 `type/signal_type`、`ca/contract_address`、`chain/chain_id`。
- `TradeSignal.type/project_name` 被错误设为必填，`Position` 又缺少后端已返回的 `project_name`。
- 多处 `as any`、`as unknown as` 掩盖了契约漂移。
- REST 和 WebSocket 由不同 Worker 拼装 payload，不保证同一实体字段一致。
- `/history` 页面名与接口语义错位：主页面使用 Trade Attempt list/detail，另有未直接展示的 closed Position history/CSV；二者必须作为不同契约治理。
- 前端 API 仍以强制类型转换吸收响应漂移，关键页面存在 `as any/as unknown as`，使新增字段和枚举遗漏无法在构建期暴露。

### P0：信号页实盘授权显示会误判

`/api/system/signals` 的 `live_authorization` 目前只按固定 CA 全局 policy 计算。Dynamic/Follow 实际可执行时，页面仍可能显示“只记录”。

必须区分：

- `authorization_at_signal_time`：当时的策略、修订、预算快照和最终执行结果；
- `current_authorization`：按当前配置只读评估，仅用于提示；
- 历史已执行 Signal 不得因当前 policy 变化而被显示成“当时未授权”。

当前授权投影必须按 strategy kind 复用相同授权语义，但不能在 50 条分页数据上逐条执行完整 evaluator。应批量加载 fixed/dynamic/follow policy、readiness 和用量快照，再通过纯函数投影；页面查询不得预留或扣减预算。

### P1：Signal 实时刷新不统一

- SignalLog 只监听 `signal:matched`。
- 固定策略只有部分入口广播该事件。
- P20 只广播 `p20:resolution`。
- P21 创建 Signal 后没有统一前端 Signal 事件。

REST 必须是规范数据源。WebSocket 只发 `entity_type + entity_id + contract_version`，前端收到后重拉规范 DTO，不再信任各 Worker 的临时完整 payload。

P26 已拆分 ingestion/execution 进程，ingestion role 没有 API WebSocket；固定策略 Signal 即使在 ingestion 中成功落库，也不能依赖本进程 `wsBroadcast`。统一事件发布器必须把实体和数据库 outbox 放在同一事务中；PostgreSQL `NOTIFY` 仅作为提交后唤醒，execution/API role 通过可恢复 relay 广播。事件采用 at-least-once 语义，前端按 `event_id/entity_id` 去重。

### P1：Position/History 有同名列覆盖风险

`SELECT p.*, wl.symbol, wl.project_name` 可能用空的 `wl.symbol` 覆盖有效的 `p.symbol`。公开 DTO 必须显式投影，例如：

```sql
COALESCE(
  NULLIF(p.asset_snapshot->>'symbol', ''),
  NULLIF(p.symbol, ''),
  NULLIF(wl.symbol, '')
) AS symbol
```

不得继续用 `SELECT *` 加同名列组装公开 DTO。

`/api/system/signals` 还重复构造两次 SELECT，且 COUNT 查询携带只为列表数据服务的 LATERAL latest-trade-flow JOIN。P27 应拆成共享筛选条件、轻量 COUNT 和显式列表投影，避免每次刷新做不必要的逐行交易流查询。

### P1：前端设计系统不完整

已确认使用但未定义的 CSS token：

```text
--bg-elevated
--bg-subtle
--bg-subtle-hover
--border-color
--color-bg
--color-bg-secondary
--color-info
--color-surface
--color-surface-hover
--color-text-tertiary
--font-mono
--space-xs
```

页面还使用 `text-white`、`p-3`、`mt-2`、`rounded` 等 Tailwind 风格类，但项目没有 Tailwind，部分类实际无样式。设计收口必须覆盖 token 完整性、utility class 可达性、控件高度、表格密度、焦点状态、响应式和可访问性，不只是字号。

`index.css` 还远程导入 Google Fonts，网络不可用时可能发生字体跳动。P27 需改为本地托管或稳定的系统字体栈。

### P1：GMGN “无事件窗口为 0”口径错误

未完成 Order、保护策略、平仓和对账任务可在没有新 Signal 时合法调用 GMGN。正确标准：

- 未触发策略的“新买入”调用为 0；
- readiness、启动恢复、Research 页面刷新和 DOM 刷新不产生隐式交易调用；
- `trade_reconciliation`、`trade_close`、`protection_strategy_sync` 独立分类并关联 due 实体；
- 对账按 chain + wallet 批量查询，只查 due 对象，使用自适应间隔和退避，批量成功时不逐项 fallback；
- 建立每分钟/每小时调用预算和 backlog 指标，告警不能阻断已有持仓安全收尾。

当前设置页正常启动和“重新检查”均使用 `arm/prepare` 的默认 `probe=false`，不会执行 Contract Quote；但 `readiness?probe=true` 和 `/api/trade/chains/:chain/diagnose` 会显式执行 Contract Quote、RPC probe 和 Strategy Query。它们不是隐藏买入调用，但会消耗 GMGN 权重，必须作为操作员诊断单独分类，不能混入普通 readiness 或启动恢复。

### P1：风险审计字段与实际执行门禁语义混用

当前 `risk_passed/risk_reasons/risk_warnings` 会写入 Signal 风险快照，但执行代码并不直接以 `risk.passed` 作为统一阻断条件。实际 blocker 来自运行状态、策略授权、链路可用性、预算、钱包写入幂等和明确的 provider schema/security 异常。P27 必须分别输出：

- `execution.blockers`：实际导致本次未执行或失败的稳定 code；
- `risk.warnings`：仅供操作员理解、不改变执行结果的观察项；
- `risk.hard_failures`：代码中确实抛错并阻断的安全事实。

前端不得根据 `risk_passed=false` 自行宣称“交易被门禁拦截”，必须以 Attempt/Signal 的实际执行结果为准。

### P1：Research 隔离须使用共享持久状态

当前 Research Queue 在 execution role 内运行，能读取同进程 armed 状态。但 `engine-state` 同时有进程内变量和数据库状态；以后拆进程后仅读 `getArmed()` 会失效。P27 固化规则：Research 是否可运行以 `trade_runtime_state.live_engine_control`、共享 scheduler 状态和预留权重为准，不依赖进程拓扑。

### P1：迁移和发布链路不完整

- `deploy/README.md` 仍写 Migration `000-040`，当前已到 `043`。
- P21 部署文档仍写“GMGN 精确验证”，与当前 Grok + 本地 RPC 链路冲突。
- `schema_migrations` 只记录文件名，没有 checksum，无法发现同名迁移被修改。
- 缺少 release SHA、migration manifest、frontend build 的完整一致性确认。
- 缺少数据库备份/恢复演练、应用回滚、发布后观察和版本确认。

### P1：Telegram 通知安全和链链接错误

`notifier.js` 使用 `parse_mode=HTML`，但外部 `symbol`、`error.message`、`match_detail`、handle 等未统一 escape，可能导致格式破坏或发送失败。Robinhood Chain 未配置 explorer，当前会错误回退到 Solscan；前端 Trade Attempt 的交易哈希链接也缺少 Robinhood 映射。

已平仓 CSV 目前使用字符串拼接，只移除 symbol 中的逗号，未统一处理引号、换行和电子表格公式前缀。外部元数据可能破坏 CSV 结构或形成公式注入，且空 symbol 仍导出 `Unknown`。

### P2：旧入口、验收脚本和 Secret 风险

- `server.js --role=all`、`start:all`、P20 smoke、P25 Live runner 仍存在，需按生产入口、自动回归、历史验收工具分类。
- 生产环境已拒绝 `role=all`，该保护应保留并加启动契约测试。
- 本轮 tracked 文件名扫描未发现 `.env/.pem/.key/.log/.dump`；内容命中主要是 example、测试假值和官方 GMGN 文档，尚未发现可确认的真实 Secret 泄漏。
- 正式发布前仍须做 Git 历史、工作区、日志脱敏和发布 allowlist 扫描，不能只依赖 `.gitignore`。
- Git 扫描无法覆盖曾粘贴到对话、截图、终端或外部日志的凭据。任何经过这些渠道展示的 GMGN/API Key 均按已暴露处理，服务器同步前轮换；测试 profile 与生产 profile 使用不同 Key，并由启动检查拒绝角色/profile 混用。
- `run-p25-live-acceptance.js` 具有真实交易能力，P27 验收完成后不得进入服务器发布包；先提取仍需的只读证据检查，再删除或移出生产仓库入口。

## 5. 实施方案

### 5.1 建立版本化、兼容优先的 HTTP 契约

Signal、Position、Trade Attempt list/detail 和 Closed Position History/CSV 分别只有一个后端投影入口。REST 是实体规范数据源，WebSocket 只使用独立的最小事件 envelope：

1. 在仓库内建立版本化 JSON Schema 作为唯一契约源；后端 projector 做契约测试，前端类型由 schema 生成或经同一 fixture 校验，禁止手写两套不受约束的字段表。
2. JSON DTO 增加 `contract_version: "p27.v1"`。
3. 第一阶段 additive：保留旧扁平字段，同时新增规范字段。
4. 前端切换并通过回归后，下一版本再删旧字段；P27 不做同步破坏性删除。
5. 公开查询不使用 `SELECT *` 产生 DTO，显式命名重要列；事务内部的锁定查询不在本次机械改写范围。
6. 清除 Signal、Position、Trade Attempt 及其 API 路径中的 `as any/as unknown as`。
7. `/api/trade/history` 与 `/api/trade/history/export-csv` 复用同一个 Closed Position projector；CSV 在 projector 之后做 RFC 4180 编码和公式注入防护。

Signal 规范字段至少包括：

```json
{
  "contract_version": "p27.v1",
  "id": "...",
  "strategy_type": "fixed_ca | dynamic_policy | follow_discovery",
  "signal_type": "...",
  "activity_type": "...",
  "chain_id": "...",
  "contract_address": "...",
  "asset": {
    "symbol": null,
    "name": null,
    "logo_url": null,
    "display_label": "SYMBOL | Project | 0x1234...abcd",
    "metadata_source": "signal_snapshot | whitelist | candidate | address_fallback"
  },
  "settlement": {
    "token_decimals": null,
    "source": "order_report | position_lot | unavailable"
  },
  "project": { "name": null, "handles": [] },
  "authorization": {
    "signal_policy_snapshot": {
      "mode": "live | record | unknown",
      "policy_id": null,
      "revision": null,
      "context_hash": null
    },
    "execution_decision": {
      "status": "not_attempted | allowed | denied | unknown",
      "blockers": []
    },
    "current_projection": {
      "status": "auto_allowed | manual_allowed | record_only | unknown",
      "blockers": []
    }
  },
  "execution": {
    "mode": "...",
    "status": "...",
    "intent_id": null,
    "attempt_id": null,
    "order_id": null,
    "tx_hash": null
  },
  "source": { "provider": "6551", "activity_id": "...", "trace_id": "..." }
}
```

Trade Attempt list/detail 至少增加同源的：

```json
{
  "contract_version": "p27.v1",
  "id": "...",
  "intent_id": "...",
  "strategy_type": "fixed_ca | dynamic_policy | follow_discovery | unknown",
  "signal_id": "...",
  "position_id": null,
  "chain_id": "...",
  "contract_address": "...",
  "asset": { "symbol": null, "name": null, "display_label": "0x1234...abcd" },
  "side": "buy | sell | strategy_create | strategy_cancel",
  "status": "...",
  "order": { "id": null, "provider_order_id": null, "tx_hash": null, "status": null }
}
```

旧字段 `chain`、顶层 order 字段和已有详情数组在 P27 仅做兼容保留，但必须与规范字段来自同一个 projector，不允许列表和详情各自拼装不同语义。Signal 的 `strategy_type` 必须是三种已知值；历史 Trade Attempt/Position 缺少可证明的 Signal 归属时返回 `unknown`，不得默认成 `fixed_ca`。

### 5.2 使用 Migration `044` 建立可信迁移清单

新增 `044_p27_migration_manifest.sql`，只扩展迁移基础设施，不修改业务表：

- 为 `schema_migrations` 增加 nullable `checksum_sha256` 和 manifest 关联字段；
- 新增 release migration manifest 表，保存 release SHA、manifest digest、签署/确认信息和创建时间；
- 新 runner 首次发现旧表无 checksum 时，只允许先应用 `044`，然后暂停；
- 使用已冻结并提交的 P26 release SHA 生成 `000-043` 基线 manifest，人工核对后显式导入，不能从 P27 当前文件静默推断历史真值；
- `000-043` 基线和 `044` 自身验证通过后，runner 才允许继续应用 `045+`；以后所有新 migration 在同一事务记录文件 SHA-256，已应用文件 checksum 不一致时拒绝启动。

这一 bootstrap 必须在专用数据库演练“旧 schema -> 044 -> 导入签署基线 -> 045/046 -> 二次启动零变更”，并覆盖失败后重跑。

### 5.3 使用 additive Migration `045` 保存不可变 Signal 契约快照

新增 `045_p27_signal_contract_snapshots.sql` 保存不可变快照，不修改已应用的 `000-044`：

- `trade_signals.asset_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`；
- `trade_signals.authorization_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`；
- `trade_signals.strategy_type text`，无默认值，约束为 `fixed_ca | dynamic_policy | follow_discovery`；
- `positions.asset_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb`；
- 仅增加必要索引，不同步破坏性重写大表。

新 Signal 创建时一次性写入 `strategy_type`、asset/source provenance 和当时的 policy id/revision/context hash。`authorization_snapshot` 的创建阶段只记录策略配置身份、模式和可证明的只读判定；尚未经过最终提交检查时写 `execution_decision: "not_attempted"`，不得提前写成 `allowed`。最终提交前的授权结果属于 Attempt 的 config/pre-submit 证据，不回写覆盖 Signal 创建快照。

快照采用 write-once 语义：新增记录必须在创建事务中写入；普通 repository update 不暴露修改入口；历史 backfill 只更新空对象并记录 `snapshot_version/source/hash`。迁移先回填和核对冲突，再验证 CHECK 并设置 `strategy_type NOT NULL`，不得使用默认 `fixed_ca` 掩盖归属缺失。

历史 backfill 规则：

1. 只使用历史 Signal、Whitelist、Candidate、Order 中已有元数据。
2. 不调用 GMGN 或 Grok 补历史名称。
3. 无本地名称时保留 `null`，DTO 显示缩短 CA。
4. 输出修改行数、来源和未命中行数，不修改金额、状态或交易凭证。
5. `strategy_type` 只按已有外键确定性回填：有 `follow_discovery_policy_id` 为 `follow_discovery`，否则有 `actor_policy_id` 为 `dynamic_policy`，其余为 `fixed_ca`；冲突行停止迁移并输出审计清单。
6. 历史无法证明的授权决策写 `unknown`，不得根据当前 policy 伪造当时状态。

### 5.4 修复三策略元数据生产者

- Fixed：创建 Signal 时写入 whitelist asset snapshot。
- P20：保留 candidate index/原文本地 `name/symbol/source`；只有 CA 时允许空展示元数据继续交易。
- P21：保留 `project_name/project_handle` 到 normalized result、selected、whitelist 和 Signal snapshot。
- Position：从 Signal snapshot 复制展示元数据；从 confirmed GMGN Order/Report 写精确 raw amounts/decimals 到 Order 和 Lot。
- 通知：从规范 DTO 读取显示标签，不自行推断链或代币。

### 5.5 使用 Migration `046` 扩展现有 outbox，统一可靠实时事件

新增 `046_p27_reliable_notification_outbox.sql`，扩展现有 `notification_outbox`，不再创建第二张功能重复的事件表：

- 增加 `channel`（`alert | entity_event`）、可空 `dedupe_key`、`locked_at/locked_by` 和必要索引；
- 保留已有 alert 数据和 topic 语义，默认历史记录为 `alert`；
- entity event 使用 outbox 行 id 作为稳定 `event_id`，生产者可用 `dedupe_key` 防止同一状态转换重复入队；
- 修复现有 Worker 只认领 `pending/failed`、崩溃后 `sending` 永久滞留的问题：超过 lease 的 `sending` 必须可回收；
- 为 sent/failed 记录建立可审计的保留和分批清理策略，不在交易事务中删除。

实体写入和 outbox INSERT 必须使用同一个数据库事务；事务提交后共用 relay 按 channel 分发，`entity_event` 发送：

```json
{
  "type": "entity:changed",
  "event_id": "...",
  "contract_version": "p27.events.v1",
  "payload": {
    "entity_type": "signal | position | order | attempt",
    "entity_id": "...",
    "change_type": "created | updated | settled"
  }
}
```

- 三策略创建 Signal 都调用同一发布器。
- WebSocket 不携带可能过时的完整实体。
- 前端收到事件后 debounce/dedupe 并重拉 REST DTO。
- `NOTIFY` 只唤醒 relay，不作为持久消息本体；通知丢失时由轮询兜底。
- execution/API role 使用 `FOR UPDATE SKIP LOCKED` 认领共用 outbox，alert 保持现有通知语义，entity_event 广播最小 envelope；广播成功后标记发送。广播后、标记前崩溃允许重复，前端按 `event_id` 去重。
- 进程重启后恢复 pending/超时 sending 事件；设置 attempt、next_attempt_at、last_error、sent_at 和保留/清理策略。
- 任何实体生产者若无法与 outbox 共用事务，必须先重构事务边界，禁止 COMMIT 后 best-effort 补事件。

### 5.6 修正按策略类型的授权投影

- 建立按 strategy kind 分组的批量只读授权投影，一次加载 fixed/dynamic/follow policy、readiness 和用量快照。
- 投影语义必须分别与 fixed live policy、`dynamic-authorization`、`follow-discovery/authorization` 一致，但不逐条触发数据库 evaluator。
- 页面查询不调用 `reserveUsage/commitUsage`。
- 前端分开显示 Signal 创建时策略快照、Attempt 最终执行决定和当前授权提示；三者缺失时显示 `unknown/not_attempted`，不得互相推断。

### 5.7 收口前端设计系统

| 用途 | 字号 | 行高 |
|---|---:|---:|
| 页面标题 | 20px | 28px |
| 区块标题 | 16px | 24px |
| 正文和表格 | 14px | 20px |
| 辅助信息 | 12px | 18px |
| 紧凑标签 | 11px | 16px |
| 地址/订单哈希 | 12px Mono | 18px |

实施要求：

1. 定义或替换所有未定义 CSS token，并增加完整性测试。
2. 扫描静态 `className`，清理无定义 utility class，不为兼容旧类名引入 Tailwind。
3. 统一 StatusBadge、DataTable、页面标题、筛选栏、空/加载/错误状态。
4. 统一控件高度、焦点、表格密度、颜色、圆角和状态徽章。
5. 检查桌面/移动换行、横向滚动、遮挡、布局跳动和键盘焦点。
6. 处理 Google Fonts 远程依赖。
7. 工作台卡片圆角收敛到不超过 8px；Modal 和既有特殊控件如需例外必须在 token 中显式命名。

### 5.8 GMGN、对账和 Research 治理

| 分类 | 允许内容 | 处理方式 |
|---|---|---|
| 新买入 | 命中 Signal 的必要 Gas/Quote/Swap | 每 Attempt 最多一次 Swap，统一 scheduler/audit |
| 平仓 | 余额、必要 Quote、Strategy Cancel/Verify、Sell Swap | 绑定 Sell Attempt |
| Order 对账 | 未完成/不确定 Order Query 和 Receipt | 只查 due 对象，自适应退避 |
| 保护策略对账 | chain + wallet 批量 Strategy Query | 去除 N+1，限制每周期 group，监控 backlog |
| 独立 Research | 人工提交的 Token/Security/Pool/Market | 隔离权重，实盘 desired_running 时暂停 |
| 显式诊断 | 操作员确认的单链单次检查 | 不得由启动/页面隐式调用 |
| Paper/Record | Mock/本地快照/数据库 | 禁止真实 GMGN write |

买入热路径不调用 `token/info`；本地已有 decimals 可随 Signal snapshot 保存，但不作为展示名称门禁。成交精度以 GMGN Order/Report 和 Receipt 为准，缺失时进入对账/人工核查，不伪造 Lot。Gas/Quote/Security 只按链适配器和本次 Attempt 的实际必需项调用，不恢复全局预热；`token/info` 仅允许操作员显式只读诊断，并使用独立审计来源。

`readiness` 默认和 `arm/prepare` 必须固定 `probe=false`；显式诊断入口在请求前返回待探测 whitelist/chain 数量、预计 GMGN endpoint/weight 和冷却状态，用户二次确认后才执行。实盘 Engine armed 时继续拒绝诊断，且诊断不得自动递归到全部策略。

业务模块统一通过 `gmgn-access-service`；`gmgn-http` 只负责签名、HTTP、scheduler 和审计。`provider-rate-recorder` 是底层审计例外，不是业务调用者。

幂等标准：

- 同一时刻只有一个 active Attempt；
- 允许有明确 lineage 的合法 retry Attempt；
- 每个 Attempt 最多一次 Swap；
- Query Order 不确定时不重提 Swap；
- 同一经济交易不得产生重复 confirmed fill/Position Lot。

### 5.9 通知、导出安全和链浏览器

- 对所有外部字段做 Telegram HTML escape，URL 参数安全编码。
- 后端通知和前端交易记录共用链注册表中的 explorer 模板；Robinhood Chain 映射到已验证的 Blockscout explorer，未知链不回退 Solscan。
- Closed Position CSV 对每个单元格做 RFC 4180 escape，并中和 `= + - @` 等公式前缀；显示名称与 Position DTO 使用同一 asset fallback。
- 通知失败不影响交易状态，但记录可审计原因。

### 5.10 发布和回滚

1. P26 未提交修改先形成独立可回归基线，P27 不与其混成一个提交。
2. 提交按逻辑单元划分，不机械要求后端/前端/迁移/文档各一个；每个中间提交须可启动。
3. 最终发布使用单一 release SHA，所有代码、构建、Migration manifest 和文档都来自该 SHA。
4. 使用 5.2 的兼容 migration runner 和签署基线；服务器迁移必须按“044 -> 停止并导入/验证 P26 基线 -> 045 -> 046 -> 047”执行，禁止跳过 bootstrap 或自动接受 checksum 漂移。
5. 更新 `deploy/README.md` 的 Migration 范围和 P21 链路。
6. 发布前做数据库备份和恢复演练；Migration 只做 additive，保证应用回滚兼容。
7. 健康/版本接口输出 release SHA、process role、contract version 和 migration manifest 版本。
8. 发布后确认只有一个 ingestion 和一个 execution；先禁止新买入并保留对账/平仓，观察健康后再由操作员启动。
9. 在专用环境演练应用回滚：P27 schema 保持不变，切回已签署 P26 binary，确认可启动、读取历史、继续 Order/保护对账和平仓；回滚期间暂停新买入，P26 无需理解 P27 新列/outbox。

## 6. 验收方案

### 6.1 自动回归

1. 后端全量 `npm test`。
2. 前端 `npm run lint` 和 `npm run build`。
3. `git diff --check`、JS/TS 语法和类型检查。
4. Migration checksum/manifest、schema audit 和生产只读 audit。
5. 三策略事件 -> Signal -> attribution -> chain/CA -> asset/authorization snapshot -> Attempt final decision -> GMGN audit 契约测试。
6. 空 `name/symbol` 不阻止合法买入；confirmed report 缺 raw amount/decimals 时不得伪造 Lot。
7. Signal、Position、Trade Attempt list/detail、Closed Position history/CSV 的旧字段与 `p27.v1` 同源；REST 与 WebSocket ID 回拉一致；ingestion 的实体和现有 `notification_outbox` 同事务落库，事件可跨进程送达 API role，超时 `sending` 可回收，重启恢复不丢事件且重复事件可去重。
8. 三策略授权查询使用批量只读投影，不改变预算账本，不产生逐 Signal N+1。
9. 未命中策略的新买入调用为 0；单 Attempt 最多一次 Swap；429 不重试 Swap；合法 retry 有 lineage；对账关联 due 实体。
10. 批量对账不退化为 N+1，不活跃策略使用退避，backlog 可观测。
11. 风险 warning、hard failure 和实际 execution blocker 语义分离，页面不根据风险快照伪造拒绝原因。
12. 普通 readiness/arm 为 GMGN 0 调用；显式诊断有 weight preview、二次确认、独立审计，armed 时拒绝且不扩散到全部策略。
13. CSS token、utility class 和可访问性检查。
14. Telegram escape、CSV 注入防护和 Robinhood explorer 测试。
15. P27 schema 上的 P26 应用回滚启动、只读查询、对账和平仓回归。
16. Secret 扫描、已披露凭据轮换、测试/生产 Key 隔离和错误 profile 启动拒绝测试。

### 6.2 DOM 回归

测试从 `App.tsx` 自动枚举全部可达路由，至少覆盖 Dashboard、Strategies、Fixed、Dynamic、Follow Discovery、`/whitelist` 兼容入口、KOL、Signals、Positions、History/Trade Attempt、Settings，并单独测试 closed Position history API/CSV。每个路由覆盖默认态、加载态、空态、错误态及可达的 drawer/modal；桌面和移动视口都执行：

- 字号、行高、颜色、间距、圆角、控件高度和密度符合标准；
- P20/P21 显示已有名称，无名称时显示缩短 CA；
- `dynamic_keyword/follow_discovery` 标签正确；
- 三类 Trade Attempt 均显示正确策略、链、CA 和 asset fallback，Robinhood 交易哈希打开正确浏览器；
- 三策略创建 Signal 后都自动重拉，刷新前后数据一致；
- 历史执行、当前授权、active blocker、advisory 和历史错误语义正确；
- 风险告警与实际执行 blocker 分栏显示，未执行、执行失败和仅有 warning 不混淆；
- 无溢出、遮挡、布局跳动，键盘焦点可见；
- 控制台无错误，页面刷新不触发 GMGN。

### 6.3 GMGN 运行观察

不要求所有 GMGN 调用为 0，而是按 `source + stage + signal_id + execution_session_id` 分类：

| 类别 | 预期 |
|---|---|
| 未触发策略的新买入 | 0 |
| readiness/startup/page refresh | 0 个隐式交易调用 |
| explicit research | 仅关联操作员创建的 Research Job |
| order reconciliation | 每次关联 due Order |
| protection sync | 每次关联 due Strategy Group，无 N+1 |
| close | 每次关联 Sell Attempt |

记录每分钟调用量、权重、最大排队等待、backlog、429/reset_at 和冷却恢复。

### 6.4 三策略真实小额闭环

P27 完成后使用真实 6551 行为，观察工具只读证据，不伪造 Signal，不使用 Paper/Mock：

| 策略 | 真实触发 | 必须证据 |
|---|---|---|
| 固定 CA | 对已配置项目关系的允许互动 | Activity、Signal snapshot、Intent/Attempt、GMGN Order、Tx/Receipt、Position/Lot、Sell Attempt/Settlement |
| 动态喊单 | 允许 KOL 真实发布/回复完整 CA | 原文、RPC 链解析、P20 Signal、上述买入和平仓证据 |
| 关注发现 | 真实 Follow 全新目标账号 | Follow Event、Grok evidence IDs、project metadata、RPC provenance、P21 Signal、上述买入和平仓证据 |

每轮一条事件和一个小额预算。失败时保留原始错误和审计证据，不手工改库。

### 6.5 通过标准

- 三策略各有一条 P27 最终代码下的真实事件 -> 买入 -> 平仓完整证据。
- 同一源事件无重复 Signal，同一经济交易无重复 confirmed fill。
- 合法 retry 有 lineage，同时只有一个 active Attempt，每 Attempt 最多一次 Swap。
- 交易窗口无 `429`，或处理符合共享冷却、reset_at 和不重复提交。
- 对账/保护调用无 N+1，每次关联 due 实体。
- P20/P21 正确显示已有名称，缺少名称时显示缩短 CA。
- DTO/WebSocket、授权只读和历史投影测试通过。
- 前端 lint/build、CSS/utility、DOM 和可访问性通过。
- 通知安全、Secret、发布 allowlist、Migration checksum、备份恢复和双角色启动检查通过。
- CSV 结构、公式注入防护、Trade Attempt list/detail 与 closed Position history 契约通过。
- P27 schema 上的 P26 应用回滚演练通过，且演练期间没有新买入。
- 已披露凭据已轮换，测试/生产 profile 隔离检查通过，发布包不包含 `.env`、真实 Key、日志或 live runner。
- 所有发布资产来自同一 release SHA，Git 工作区无未解释业务改动。

## 7. 实施顺序

1. 冻结当前 P26 工作区，形成独立可回归 baseline，记录数据库、GMGN 审计和 Git SHA。
2. 建立 DTO、WebSocket、GMGN reachability 和设计 token 基线测试。
3. 实施 migration manifest `044` 并导入/验证签署的 P26 基线，再实施 additive Signal snapshot `045`、可靠 notification outbox 扩展 `046` 和可重跑的本地历史 backfill。
4. 修复三策略元数据生产者、规范投影和按策略授权。
5. 统一实时事件，前端切换 `p27.v1`，保留旧字段兼容。
6. 收口前端设计系统、CSS token、utility、组件和可访问性。
7. 收口 GMGN 对账频率、Research 共享状态、通知安全、Migration checksum 和发布文档。
8. 运行全量回归、数据库审计、Secret audit、前端构建和 DOM 回归。
9. 启动双角色进程，先做分类 GMGN 观察，再做三策略真实小额买入和平仓。
10. 生成验收报告、release SHA、migration manifest、发布 allowlist 和回滚手册，最后同步服务器。

## 8. 不在 P27 中做的事

- 不重新引入 GMGN 预热、Trenches 或买入前批量 Security/Pool。
- 不为显示名称调用 GMGN。
- 不以增加新门禁替代字段修复、幂等和证据核对。
- 不删除交易历史、失败 Attempt、Order、Receipt、Lot 或审计日志。
- 不把真实验收改成 Paper/Mock。
- 不在完成 P27 三策略验收前同步服务器。
- 不在方案阶段修改或显示生产 Secret。

## 9. 当前风险与实施前置

- 当前分支是 `codex/p26-production-hardening`，工作区仍有 P26 未提交修改和 Migration `043`；P27 实施前须先确定 P26 提交边界。
- 本地数据库只读核对已成功，不存在已确认的 `DB_PASSWORD` 异常。服务器发布前须重跑相同审计。
- 当前仍有未平仓持仓和活跃保护策略，不能停止全部 GMGN 对账来追求“空窗为 0”。
- 对账已有批量查询，但 24 小时调用量较高；须先量化 due 对象再调整退避，不得影响持仓保护和平仓。
- `backend/.env` 含本地运行配置和凭据，只核对 profile/进程隔离，不把实际值写入文档、输出或 Git。

## 10. 批准边界

P27 v1.0 和 v1.1 不应按原文实施。本 v1.2 已纠正事实错误、迁移顺序和关联问题，可作为正式实施基线。

批准本方案只表示可开始按第 7 节更新代码，不表示 P27 已完成，也不表示服务器可同步。服务器同步必须等第 6.5 节全部通过。

## 11. 2026-08-12 实施与自动验收结果

已完成并有自动化证据：

- Migration `044-047`、P26 签署 manifest、专用测试库 bootstrap/重跑脚本和 Schema audit。`047` 只通过原始 P20/P21 精确 Candidate 外键补齐历史名称，不按 CA 模糊关联，也不调用 GMGN/Grok。
- Fixed/P20/P21 `strategy_type + asset_snapshot + authorization_snapshot` 生产者与 Position 复制。
- Signal、Position、Attempt、Closed History/CSV 规范 projector，REST 为实体源，WebSocket 使用可靠 outbox 最小 envelope。
- P20/P21 名称链路和缩短 CA fallback；不为显示名称调用 GMGN/Grok。
- 按策略批量授权投影、风险 warning/hard failure/execution blocker 分离。
- 显式诊断 weight preview、二次确认、持久 Engine 状态拒绝和 Research 持久隔离。
- Telegram escape、共享链浏览器、Robinhood Blockscout、CSV 注入防护。
- 前端字体/token/class/圆角静态契约，链筛选长文本、Signal 长 CA 和 Trade Attempt 弹窗响应式问题已修复。
- 生产 `GMGN_CREDENTIAL_PROFILE=primary` 强制检查、发布 allowlist、当前树和 Git 历史 Secret 审计；历史 P25 Live runner 已移除。
- 业务库应用 `047` 前已完成只读预览：精确命中 Signal `816/817/819/821/829/832/833`，共 7 条 Signal 和 2 条 Position。迁移只补齐本地已有的 `name/symbol`，状态、CA、金额和交易凭证未改变；第二次运行 Migration 为零变更。
- 已创建 Git 忽略目录中的 PostgreSQL custom-format 备份并验证 `pg_restore --list` 可读；备份 SHA-256 为 `D80B411707F220DF3A49B64614E4F4E3D955850A0157BFB7C7C9D85B5D7EE109`。隔离恢复库通过 `047` 和 Schema Audit，`schema_migrations`、KOL、白名单、Signal、Attempt、Order、Position、Lot 八张关键表行数与业务库一致。
- 后端全量测试 `538/538`、前端 lint/build、生产只读 Schema Audit、Release Audit 和 `git diff --check` 均通过；Release Audit 扫描 469 个工作区文件、生成 262 个发布候选，失败 0。
- 11 个路由已在 `1440x900` 和 `390x844` 完成 DOM 回归：无根级横向溢出、异常文本或控制台错误；Signal 正确显示 `CASHCAT/STONKBROKER/MUMU/GTR`，无“未知代币”；交易详情具备 dialog 语义、初始焦点、Esc 关闭和完整 Tx Hash 换行。
- 页面刷新 GMGN 审计以事件 ID 为边界，刷新 11 个路由后新增调用为 0。最近一小时 28 条调用全部为已有持仓的 `strategy_sync`，`429=0`、未知请求 0、未授权买入 0、重复 Swap 0。
- 双角色 Supervisor 已用最终工作区代码重启，健康接口返回 `contract_version=p27.v1`、`event_contract_version=p27.events.v1`；启动和页面刷新未触发显式 GMGN 诊断。
- 健康接口已将当前运行 `release_sha` 与 P26 `migration_manifest.release_sha` 分离；本地未显式设置发布 SHA 时返回 `release_sha=null`，服务器必须注入本次发布 commit，不能把 P26 迁移基线误报成 P27 运行版本。

尚未完成，不能据此同步服务器：

- P26 binary 已证明能在 P27 Schema 上启动、只读和处理空队列恢复，但未用旧 binary 对真实活跃仓位执行平仓写操作。该动作可能触碰生产钱包，不作为本地自动回归冒险执行；事故回滚时必须先暂停新买入并按受控清单逐项验收。
- P27 最终代码下 Fixed/P20/P21 各一条真实 6551 事件的买入与平仓闭环。
- 对话中曾展示过的 GMGN Key 在服务器同步前轮换，并验证生产/测试 profile 隔离。

因此，P27 代码更新、数据库迁移和自动回归已经完成；P27 发布验收尚未完成。下一阶段只能进行三策略真实小额闭环和凭据轮换，未完成前不得生成服务器最终发布结论或同步服务器。
