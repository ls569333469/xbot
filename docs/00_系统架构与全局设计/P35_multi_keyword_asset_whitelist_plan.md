# P35 动态喊单多关键词资产路由方案

> 文档状态：`IMPLEMENTED LOCALLY / REAL BUY AND SELL VERIFIED / NOT DEPLOYED`
>
> 设计日期：2026-08-16
>
> 实施日期：2026-08-16 至 2026-08-17
>
> 已确认前端：**方案 B，主从资产路由工作区**
>
> 实施边界：正式 React、Migration、动态 Worker 与授权快照已按本方案更新；既有 GMGN Swap、Order Query、Position、平仓以及固定 CA、关注策略执行逻辑未增加 P35 分支。本地已完成长文本关键词触发、GMGN 真实买入、保护持仓和手动平仓闭环；尚未部署 xiexiu，尚未执行生产 Migration 或服务器真实交易验收。

## 1. 最终结论

P35 不新增第四种策略，也不改变现有动态喊单策略的预算、授权和交易链路。它把目前不完整的：

```text
关键词 -> Candidate Index 猜测资产 -> 可能找不到 CA
```

替换为账号策略内显式配置的：

```text
一个监听账号
  -> 多条资产路由
  -> 每条路由配置多个关键词
  -> 每条路由唯一绑定 chain_id + contract_address
  -> 保存时完成链上 RPC 验证并登记 variant_id
  -> 运行时唯一命中后进入现有 Dynamic Target / Signal / GMGN 链路
```

正式前端采用 `p35-multi-keyword-master-detail-preview.html`。表格原型只保留为设计比较材料，不作为正式实现入口。

P35 的核心边界：

- 关键词匹配规则保持不变。
- 路由资产由用户明确配置，系统不猜 CA。
- 运行时不调用 Grok，不调用 GMGN Token、Market 或 K-line。
- 预设路由不读写 `dynamic_candidate_index`。
- 唯一命中后继续复用 P25/P26 的 GMGN Swap、Order Query、持仓和平仓链路。
- 不提供 Candidate Index、Grok 或 GMGN 查询降级。

## 2. 后端代码调查结论

### 2.1 当前真实链路

代码中的动态策略链路是：

```text
event-queue.loadContext
  -> event-worker
  -> ca-resolver
  -> resolution-store
  -> dynamic-target-service.materialize
  -> trade_signals
  -> dynamic-authorization / final gate
  -> GMGN execution
```

关键词失败发生在 `ca-resolver` 之前到候选解析这一段，不是 GMGN Swap 本身。

### 2.2 不能只在策略表增加一个 JSONB 字段

当前数据库有以下硬约束：

- `dynamic_targets.variant_id` 是 `NOT NULL` 外键。
- `dynamic_ca_resolution_attempts.selected_variant_id` 关联 `dynamic_asset_variants`。
- `dynamic_ca_resolution_candidates.variant_id` 也用于候选审计。
- `dynamic-target-service.materialize()` 要求选中候选已经具有持久化 `variant_id`。

因此，不能只把 `chain_id + contract_address` 放进 `x_actor_dynamic_policies` 的 JSON 后直接创建交易。那样会绕开现有资产注册表和审计外键，最终仍会在物化阶段失败。

### 2.3 Candidate Repository 不能直接用于预设路由

当前 `candidate-repository.upsertCandidate()` 同时完成两件事：

1. 写入 `dynamic_asset_families` / `dynamic_asset_variants`。
2. 写入 `dynamic_candidate_index`。

预设路由只需要第 1 项，不应该污染全局候选索引。因此 P35 应抽出独立的 `asset-registry.js`：

- `asset-registry` 只登记或复用 family / variant。
- `candidate-repository` 改为先调用 `asset-registry`，再写 Candidate Index。
- 预设路由保存只调用 `asset-registry`。

这个拆分必须保持现有 Candidate Repository 的对外行为和测试不变。

### 2.4 保存事务中不能执行网络 RPC

当前 `PUT /api/dynamic-signal/policies/:kolId` 在进入 `policyService.upsert()` 前已经执行 `BEGIN`。如果直接在 `policy-service` 中增加 RPC 验证，数据库行锁、advisory lock 和 Watch Outbox 事务会被网络延迟占住。

P35 必须改为：

```text
事务外：结构校验 + 仅验证新增/变更的 chain + CA
事务内：并发版本复核 + variant 登记 + policy/routes/aliases 保存 + Watch Outbox
```

### 2.5 Intent Gate 存在资产身份冲突点

当前 Intent Gate 把：

- 完整 CA 识别为 `ca:<address>`。
- 批准关键词识别为 `name:<assetFamilyId 或 matchKey>`。

所以同一资产同时出现“关键词 + 完整 CA”时，现有代码可能把它们算成两个资产。P35 不能只增加候选，还必须在 Intent Gate 前给关键词和 CA 标注统一 `assetKey`。

### 2.6 Solana 现有验证不足

`contract-chain-resolver.resolveContractChain()` 对 Solana 目前只检查 Base58 地址格式，没有确认：

- RPC 是否为 Solana Mainnet。
- Mint Account 是否存在。
- Account Owner 是否为 Token Program 或 Token-2022 Program。
- Account Data 是否满足 Mint 基础结构并已初始化。

P35 保存 Solana 路由前必须补充真正的 Mint RPC 验证，不能把“格式正确”标记为“链上已验证”。

## 3. 保持不变的匹配和事件标准

P35 必须复用 `content-extractor.js` 的现有规则，不建立第二套匹配器：

1. Unicode 使用 `NFKC`。
2. 英文忽略大小写。
3. 匹配键忽略 Unicode 标点、空格和全半角差异。
4. 英文关键词保留单词边界，`GME` 不得命中 `GAME`。
5. 同一策略内，归一化后重复的关键词禁止保存。
6. 完整 CA、Cashtag、Hashtag、Intent Gate、账号范围、预算、滑点、离场策略和最终交易门禁保持原有语义。
7. 第一版只解析监听账号自己写下的原创正文、回复文字和引用评论。
8. 不解析被回复原文、被引用原文或纯转发原文中的关键词。

第 7、8 条保持现有作者归属边界，避免 P35 同时扩大 6551 事件语义。

## 4. 正式前端：方案 B

正式组件建议命名为 `DynamicAssetRouteWorkspace.tsx`，放在动态策略向导“词条与解析”步骤，替换当前 `P20Operations.tsx` 中的 `approved_aliases` 多行文本框。

### 4.1 页面结构

- 左侧：当前账号的资产路由列表。
- 右侧：选中路由的资产名称、链、CA、多个关键词、启用状态和验证结果。
- 路由列表始终显示验证状态和关键词数量。
- 右侧提供文本匹配测试，不产生 Signal，不调用研究或交易接口；正式结果由后端复用同一个 `content-extractor` 返回。
- 移动端按“路由列表在上、当前路由详情在下”排列。

### 4.2 交互规则

- 新建路由先存在前端草稿，字段完整后才能保存。
- 资产名称只用于页面识别，不决定交易资产。
- `chain_id + contract_address` 才是资产授权身份。
- 修改名称或关键词不重新调用 RPC。
- 新增路由或修改链 / CA 时才调用 RPC。
- 一个路由至少 1 个、最多 10 个关键词。
- 每个策略最多 20 条路由，关键词总数最多 50。
- 所有关键词冲突必须定位到具体路由和具体词条。
- 后端验证结果不可由前端伪造；前端不提交 `variant_id`、`verified_at` 或验证快照。
- 保存策略仍是热更新，不停止全局 Engine，也不暂停其他策略。

### 4.3 原型文件

- 正式基线：`p35-multi-keyword-master-detail-preview.html`
- 已否决比较方案：`p35-multi-keyword-table-preview.html`

## 5. API 与 DTO 契约

保存入口保持不变：

```text
PUT /api/dynamic-signal/policies/:kolId
```

前端提交的路由只包含用户可编辑字段：

```ts
type DynamicPresetAssetRouteInput = {
  route_id?: string;          // 已存在路由回传；新建草稿不传
  label: string;
  aliases: string[];
  chain_id: ChainId;
  contract_address: string;
  enabled: boolean;
};
```

后端读取接口返回聚合后的执行 DTO：

```ts
type DynamicPresetAssetRoute = DynamicPresetAssetRouteInput & {
  route_id: string;
  variant_id: string;
  verification: {
    status: 'verified';
    source: 'local_rpc';
    verified_at: string;
    error_code: null;
  };
};

type DynamicPolicy = {
  // existing fields...
  approved_aliases: Array<string | { name: string }>;
  preset_asset_routes: DynamicPresetAssetRoute[];
};
```

约束：

- `variant_id` 和 `verification` 只读。
- EVM 地址由后端转为小写；Solana 地址保持原样。
- `route_id` 必须属于当前 `actor_policy_id`，禁止跨账号引用。
- 模板配置只保存 `label/aliases/chain_id/contract_address/enabled`，不复制账号级 `route_id`、`variant_id` 或验证时间。
- 应用模板后，由账号策略保存流程生成新的账号级路由并完成 RPC 验证。

可增加辅助接口供“重新验证”按钮使用：

```text
POST /api/dynamic-signal/preset-routes/verify
```

该接口只提供即时 UI 反馈。最终 `PUT` 保存仍必须由服务端验证或复用同一进程内短时缓存，客户端返回值不构成授权证据。

匹配测试使用独立的只读入口：

```text
POST /api/dynamic-signal/preset-routes/match-preview
```

该入口调用正式 `content-extractor + preset-route-resolver`，只返回 normalized terms、命中路由和歧义结果。前端可以即时显示归一化字符串，但不得在浏览器再实现一套授权判定。

## 6. 数据库设计

Migration 固定为：

```text
052_p35_dynamic_preset_asset_routes.sql
```

不在 `x_actor_dynamic_policies` 增加路由 JSONB。正式模型使用两张正规化表。

### 6.1 资产路由表

```sql
CREATE TABLE dynamic_policy_asset_routes (
  id bigserial PRIMARY KEY,
  actor_policy_id bigint NOT NULL
    REFERENCES x_actor_dynamic_policies(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 40),
  variant_id bigint NOT NULL
    REFERENCES dynamic_asset_variants(id) ON DELETE RESTRICT,
  enabled boolean NOT NULL DEFAULT true,
  verification_source text NOT NULL
    CHECK (verification_source = 'local_rpc'),
  verification_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  verified_at timestamptz NOT NULL,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (id, actor_policy_id)
);

CREATE UNIQUE INDEX uq_dynamic_policy_asset_routes_active_asset
  ON dynamic_policy_asset_routes(actor_policy_id, variant_id)
  WHERE archived_at IS NULL;

CREATE INDEX idx_dynamic_policy_asset_routes_policy
  ON dynamic_policy_asset_routes(actor_policy_id, enabled, id)
  WHERE archived_at IS NULL;
```

所有持久化路由都必须完成验证并持有真实 `variant_id`。RPC 失败的新路由保留在浏览器草稿中，不把未验证资产写进生产授权表。

路由表不重复保存 chain / CA；读取 DTO 和计算授权 hash 时统一连接 `dynamic_asset_variants` 获取。这样数据库不会出现 route 的 chain / CA 与 variant 实际身份不一致。

### 6.2 路由关键词表

```sql
CREATE TABLE dynamic_policy_asset_aliases (
  id bigserial PRIMARY KEY,
  route_id bigint NOT NULL,
  actor_policy_id bigint NOT NULL,
  alias_text text NOT NULL CHECK (char_length(alias_text) BETWEEN 1 AND 80),
  normalized_key text NOT NULL CHECK (length(normalized_key) > 0),
  sort_order int NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (route_id, actor_policy_id)
    REFERENCES dynamic_policy_asset_routes(id, actor_policy_id)
    ON DELETE CASCADE
);

CREATE UNIQUE INDEX uq_dynamic_policy_asset_aliases_active_key
  ON dynamic_policy_asset_aliases(actor_policy_id, normalized_key)
  WHERE archived_at IS NULL;

CREATE INDEX idx_dynamic_policy_asset_aliases_route
  ON dynamic_policy_asset_aliases(route_id, sort_order, id)
  WHERE archived_at IS NULL;
```

数据库唯一索引直接保证：一个账号策略内，同一个归一化关键词不能绑定到两个资产。

### 6.3 解析审计字段

```sql
ALTER TABLE dynamic_ca_resolution_attempts
  ADD COLUMN selected_preset_route_id bigint
    REFERENCES dynamic_policy_asset_routes(id) ON DELETE SET NULL,
  ADD COLUMN preset_route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE dynamic_ca_resolution_candidates
  ADD COLUMN preset_route_id bigint
    REFERENCES dynamic_policy_asset_routes(id) ON DELETE SET NULL,
  ADD COLUMN preset_route_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
```

即使路由之后被修改或归档，历史记录仍通过 snapshot 保存：

- route ID 和显示名称。
- 命中的关键词。
- chain + CA + variant ID。
- policy revision + context hash。

## 7. 保存链路设计

### 7.1 事务外预处理

新增 `preparePolicyUpsert(kolId, input)`：

1. 读取当前 policy 和当前路由快照。
2. 纯函数校验路由数量、字段长度和必填项。
3. 调用现有 `normalizeApprovedNameMatchKey()` 生成 `normalized_key`。
4. 检查同一路由重复、跨路由冲突，以及与仍未绑定的 legacy alias 冲突。
5. 检查路由链属于 `allowed_chain_ids`。
6. 识别新增路由以及 chain / CA 发生变化的路由。
7. 只对这些路由执行链上 RPC 验证，并发上限为 4。
8. 生成内部 prepared payload，包含输入指纹和服务端验证证据。

修改 label、aliases、排序或 enabled 时不重复 RPC。

### 7.2 事务内提交

RPC 完成后才开始数据库事务：

1. `BEGIN`。
2. 获取现有账号级 advisory lock。
3. `FOR UPDATE` 重新读取 policy 和路由。
4. 对比预处理基线的 policy ID、revision、context hash 和完整 route state hash；发生并发修改则返回 `DYNAMIC_POLICY_CONCURRENT_UPDATE`。
5. 按规范化的 `chain_id + contract_address` 排序，对每条新增或变更资产调用 `asset-registry.ensureVariant()`。
6. 重新规范化 prepared routes，并复核重新计算的 `context_hash` 与事务外结果一致，再确定 Revision。
7. upsert policy，先归档已移除的 aliases / routes，再同步当前 routes / aliases。
8. 沿用现有逻辑取消旧 Revision jobs、暂停旧 targets、归档旧动态 whitelist。
9. enqueue 6551 Watch sync。
10. `COMMIT`。

任何一步失败都整体回滚，不出现“policy 已保存但路由未保存”的半状态。

### 7.3 资产注册表

新增 `backend/domains/dynamic-signal/asset-registry.js`：

- 以 `chain_id + contract_address` 为资产级 advisory lock key，并按固定排序获取多资产锁，避免两个账号同时登记相同资产时竞争或形成锁顺序反转。
- 已存在 variant 时保留原 `asset_family_id`，只合并 `source_types` 和验证来源。
- 已有 `provider_status='verified'` 时不得被 `local_rpc` 降级；新 family 使用稳定的 chain + CA identity key。
- 不允许预设路由覆盖 GMGN 已写入的 name、symbol、market 或 security metadata。
- 新 variant 使用 `source_types=['preset_route']`、`provider_status='local_rpc'`、`tradable_status='unknown'`。
- 不写 `dynamic_candidate_index`。

路由 `label` 是用户界面名称，不应写成全局资产的官方 `name` 或 `symbol`。

## 8. RPC 验证标准

### 8.1 EVM

复用 `backend/lib/contract-chain-resolver.js` 的 `probeEvmContract()`，但只探测用户明确选择的链：

1. `eth_chainId` 必须等于链配置。
2. `eth_getCode(address, latest)` 必须返回非空合约代码。
3. 地址持久化为小写。
4. 不探测其他 EVM 链，不调用 GMGN。

### 8.2 Solana

在 `contract-chain-resolver.js` 增加 `probeSolanaMint()`，复用已安装的 `@solana/web3.js`：

1. `PublicKey` 必须可解析。
2. `getGenesisHash()` 必须等于 Solana Mainnet genesis hash。
3. `getAccountInfo(mint)` 必须返回账户。
4. `account.owner` 必须是 Token Program 或 Token-2022 Program。
5. `account.executable` 必须为 false。
6. data 长度至少覆盖 82 字节 Mint 基础结构。
7. Mint initialized 标记必须有效。

只有全部通过才返回 `local_rpc` 验证证据。

### 8.3 限流和性能

- 保存时最多并发验证 4 条变更路由。
- 单 RPC 使用现有超时边界。
- 同一次“重新验证 -> 立即保存”可使用进程内 60 秒指纹缓存减少重复 RPC；缓存最多保留 256 条并主动清理过期项。
- 缓存键必须包含 `chain_id + contract_address`，不得只按地址。
- 这部分是公链 RPC，不占 GMGN API 限额，不会增加 GMGN 429。

## 9. context_hash 与 Revision

路由必须进入动态策略授权上下文，但只包含会改变执行行为的字段。

纳入 hash：

- `enabled`。
- `chain_id`。
- 规范化后的 `contract_address`。
- 排序后的 `normalized_key[]`。

不纳入 hash：

- route 数据库 ID。
- label。
- alias 原始标点展示文本。
- sort order。
- `variant_id`。
- `verified_at` 和 verification snapshot。

这样修改显示名称或重新验证不会无意义地产生新 Revision；修改资产、关键词或启用状态一定产生新 Revision。

## 10. 运行时解析设计

### 10.1 Context 加载

`event-queue.loadContext()` 通过聚合查询加载当前 policy 下已启用、未归档的 routes / aliases / variant 信息。Worker 只能使用与 job 的 `policy_revision + context_hash` 对应的已提交路由。

### 10.2 新增 Preset Route Resolver

新增 `preset-route-resolver.js`：

1. 将 routes / aliases 展平为现有 `content-extractor` 可识别的 alias records。
2. 每个 alias record 带上 `routeId`、`variantId`、`assetFamilyId`、`assetKey`、chain 和 CA。
3. 对命中的 route 直接生成确定候选：

```js
{
  variantId,
  assetFamilyId,
  chainId,
  contractAddress,
  presetRouteId,
  routeLabel,
  matchedAliases,
  assetKey: `variant:${variantId}`,
  localPresetRoute: true,
  providerStatus: 'local_rpc',
  tradableStatus: 'unknown'
}
```

4. 路由候选不查询 Candidate Index，也不调用 Provider。

### 10.3 Intent Gate 统一资产身份

`content-extractor` 继续负责现有字符串匹配，只扩展 term metadata。`intent-gate.assetIdentity()` 调整为优先使用 `term.assetKey`。

执行前必须完成以下归并：

- 同一路由多个关键词 -> 同一个 `assetKey`。
- 与路由关键词处于同一文本范围、且标准化值一致的 Cashtag / Hashtag（例如 `$GME` 与路由词 `GME`）-> 同一个 `assetKey`。
- 路由关键词 + 相同完整 CA -> 同一个 `assetKey`。
- 不同路由 -> 不同 `assetKey`。
- 路由关键词 + 不同完整 CA -> 明确冲突。

这一步解决两类同资产误判：一是“关键词和相同 CA 被算成两个资产”，二是 `$GME` 同时被提取为 `cashtag:$GME` 和 `approved_name:GME` 后被误判为两个资产。合并只允许发生在同一文本来源、span 重叠且标准化值一致时；`$GME + $BTC` 仍是两个资产，必须拒绝。

### 10.4 Candidate Index 按需加载

预设路由分支永远不使用 Candidate Index。为了避免 Worker 现在无条件加载全量 Index，`ca-resolver` 应接受惰性的 `loadCandidateIndex()` 依赖：

- 只命中 preset route 时不加载 Index。
- 存在 Cashtag / Hashtag 等旧索引词条时才加载 Index。
- 完整 CA 继续走现有本地链解析。

P35 不删除 Cashtag、Hashtag 或完整 CA 的既有能力。

### 10.5 Resolution Policy

`resolution-policy.evaluateCandidate()` 显式识别 `localPresetRoute`：

- 必须带持久化 `variantId` 和 `presetRouteId`。
- 不要求 GMGN `provider_status='verified'`。
- 不因 `tradable_status='unknown'` 被拒绝。
- 在 record / paper / live 三种模式中都使用相同确定路由语义。
- 不依赖 live 模式当前的全局 `allowDeterministicLocalCandidate` 开关。

该豁免只适用于从当前 policy 数据库路由加载的候选，不能由事件正文或客户端请求直接构造。

### 10.6 Worker 与物化

`event-worker` 收到已解析的 preset route 时：

- 不调用 `candidateRepository.upsertCandidate()`。
- 直接使用路由已有的 `variant_id`。
- `resolution-store` 保存 route ID 和 snapshot。
- `dynamic-target-service.materialize()` 继续使用现有 variant、预算和 Revision 校验。
- Signal 的 `dynamic_authorization` 与 `authorization_snapshot` 增加 route snapshot。
- 后续 GMGN Swap、Order Query、Position 和平仓代码不增加 P35 分支。

## 11. 决策表

| 事件内容 | 结果 | 错误码 / 原因 |
|---|---|---|
| 命中同一路由的一个关键词 | 生成一个确定候选 | `PRESET_ROUTE_ALIAS` |
| 同一路由多个关键词同时出现 | 按 variant 去重 | 一个 Signal |
| `$GME` 同时命中 Cashtag 与路由词 `GME` | 按相同 assetKey 去重 | 一个 Signal |
| `$GME + $BTC`，只有 GME 属于路由 | 不交易 | `MULTIPLE_AUTHOR_ASSETS` |
| 同一内容命中不同路由 | 不交易 | `DYNAMIC_ROUTE_AMBIGUOUS` |
| 路由关键词与完整 CA 一致 | 按 assetKey 去重 | 一个 Signal |
| 路由关键词与完整 CA 冲突 | 不交易 | `DYNAMIC_ROUTE_CA_CONFLICT` |
| 只命中旧未绑定 approved alias | 不猜 CA | `DYNAMIC_ROUTE_BINDING_REQUIRED` |
| 路由链不在 allowed chains | 拒绝保存 | `DYNAMIC_ROUTE_CHAIN_NOT_ALLOWED` |
| EVM 所选链没有合约代码 | 拒绝保存 | `DYNAMIC_ROUTE_CONTRACT_NOT_FOUND` |
| Solana 地址不是有效 Mint | 拒绝保存 | `DYNAMIC_ROUTE_SOL_MINT_INVALID` |
| RPC 不可用或链身份不符 | 拒绝本次变更 | `DYNAMIC_ROUTE_RPC_UNAVAILABLE` / `DYNAMIC_ROUTE_RPC_CHAIN_MISMATCH` |
| 未命中完整 CA 或路由 | 保持现有语义 | `DYNAMIC_CA_NOT_FOUND` |

## 12. 旧数据与模板迁移

旧 `approved_aliases` 只有文字，没有可靠 CA，禁止自动猜测或自动授权。

迁移规则：

- 保留原字段作为 `legacy unbound aliases` 数据来源。
- 前端在方案 B 中显示“待绑定关键词”。
- 用户选择一条或多条旧关键词，填写链和 CA 后转为正式 route / aliases。
- 旧关键词未全部绑定或删除时，动态策略不能保存为 paper / live。
- record 模式命中旧关键词时只记录 `DYNAMIC_ROUTE_BINDING_REQUIRED`。
- 新路由保存成功后，从 `approved_aliases` 移除已绑定词条。
- 不自动查询 Candidate Index、Grok 或 GMGN 来补 CA。
- 旧模板中的 `approved_aliases` 同样显示为待绑定，不自动升级为可交易路由。

## 13. 错误响应标准

`routes.js` 目前除 NOT_FOUND 外统一返回 400，P35 实施时需要明确映射：

- `400`：JSON 结构、数量、长度或地址格式错误。
- `409`：关键词冲突、资产重复或并发 Revision 冲突。
- `422`：链不允许、合约不存在、Solana Mint 无效。
- `503`：链 RPC 暂时不可用。

响应必须包含：

```json
{
  "ok": false,
  "code": "DYNAMIC_ROUTE_ALIAS_CONFLICT",
  "error": "...",
  "details": {
    "route_id": "12",
    "alias_index": 1,
    "conflicting_route_id": "15"
  }
}
```

前端据此选中左侧具体路由并定位右侧具体字段。

## 14. 逐文件实施清单

### 14.1 新增文件

1. `backend/db/migrations/052_p35_dynamic_preset_asset_routes.sql`
2. `backend/domains/dynamic-signal/asset-registry.js`
3. `backend/domains/dynamic-signal/preset-route-schema.js`
4. `backend/domains/dynamic-signal/preset-route-verification.js`
5. `backend/domains/dynamic-signal/preset-route-repository.js`
6. `backend/domains/dynamic-signal/preset-route-resolver.js`
7. `frontend/src/pages/kol/DynamicAssetRouteWorkspace.tsx`
8. `backend/tests/p35-preset-asset-routes.test.js`

### 14.2 修改文件

1. `backend/domains/dynamic-signal/routes.js`
   - RPC 预处理移到事务外。
   - 增加 verify 辅助接口和错误状态映射。
2. `backend/domains/dynamic-signal/policy-service.js`
   - 接受 prepared routes。
   - context hash 纳入路由执行字段。
   - 保持现有 Revision 清理逻辑。
3. `backend/domains/dynamic-signal/templates.js`
   - 模板保存路由输入定义，不保存账号级证据。
4. `backend/domains/dynamic-signal/candidate-repository.js`
   - 复用 `asset-registry` 后再写 Index。
5. `backend/lib/contract-chain-resolver.js`
   - 增加选定链 EVM 验证入口和 `probeSolanaMint()`。
6. `backend/domains/dynamic-signal/content-extractor.js`
   - alias term 透传 route identity / assetKey，不改变匹配规则。
7. `backend/domains/dynamic-signal/intent-gate.js`
   - `assetIdentity()` 优先使用 assetKey。
8. `backend/domains/dynamic-signal/ca-resolver.js`
   - 合并 preset route candidate，处理冲突，按需加载 Index。
9. `backend/domains/dynamic-signal/resolution-policy.js`
   - 显式接受已验证的 `localPresetRoute`。
10. `backend/domains/dynamic-signal/event-queue.js`
    - 加载当前 Revision 的 route / alias / variant 快照。
11. `backend/domains/dynamic-signal/event-worker.js`
    - 路由候选不再写 Candidate Index。
12. `backend/domains/dynamic-signal/resolution-store.js`
    - 持久化 route ID 和 snapshot。
13. `backend/domains/dynamic-signal/dynamic-target-service.js`
    - 将 route 证据写入 Signal 授权快照。
14. `backend/domains/signal/contract-snapshot.js`
    - 文档化可选 asset route snapshot。
15. `backend/contracts/p27/signal.schema.json`
    - 增加可选路由授权结构，不破坏 P27 v1。
16. `backend/scripts/audit-db-schema.js`
    - 审计 P35 表、索引和外键。
17. `frontend/src/lib/types.ts`
    - 增加 route input / output DTO。
18. `frontend/src/pages/kol/P20Operations.tsx`
    - 接入方案 B 组件，移除新策略对 textarea 的依赖。
19. `frontend/src/index.css`
    - 只增加方案 B 组件样式，复用现有 token 和字号标准。

## 15. 测试矩阵

### 15.1 匹配纯函数

- 中文标点、空格和全半角差异命中同一路由。
- `UTILITY` / `utility` 命中同一路由。
- `GME` 命中独立单词，不命中 `GAME`。
- 同一路由两个关键词只形成一个 asset identity。
- 完整句子中的 `$GME` 与路由词 `GME` 合并为一个 asset identity，并解析到 GME 路由。
- `$GME + $BTC` 保持两个 asset identity，返回 `MULTIPLE_AUTHOR_ASSETS`。
- 不同路由同时命中返回 `DYNAMIC_ROUTE_AMBIGUOUS`。
- 路由关键词与相同 CA 去重，与不同 CA 返回冲突。
- 引用原文、回复原文和纯转发原文不产生作者自有路由命中。

### 15.2 数据库与保存

- 数据库阻止跨路由 normalized alias 重复。
- route ID 不能跨 actor policy 使用。
- route 必须持有真实 variant ID。
- route 的 chain / CA 必须由 variant 连接读取，不存在第二份可漂移字段。
- 已存在 variant 不被错误迁移到新的 family。
- 路由不产生 Candidate Index 记录。
- label / alias 变化不调用 RPC；chain / CA 变化调用一次 RPC。
- RPC 在数据库事务开始前结束。
- 并发保存返回 409，不覆盖另一份配置。
- 保存当前账号不改变全局 Engine 和其他策略状态。
- 路由执行字段变化产生新 Revision；label / verified_at 变化不产生 Revision。

### 15.3 EVM / Solana RPC

- EVM chain ID 不匹配、空 code、超时分别返回明确错误。
- Solana mainnet identity、Mint owner、data length 和 initialized 标记全部验证。
- Token Program 与 Token-2022 Mint 都可通过。
- 普通 Solana 钱包地址不能被当成 Mint。

### 15.4 全链路回归

- 原创帖完整 CA 继续产生动态信号。
- 原创帖只含预设关键词可产生同样的动态信号。
- 一个事件只生成一个 Resolution、一个 Signal 和一个 Swap Attempt。
- Signal / Authorization / Position 保留 route snapshot。
- 固定 CA 策略、关注策略、动态完整 CA、平仓链路零回归。
- P35 事件解析阶段 GMGN 请求数为 0。
- 进入既有执行链路后，GMGN 调用数与普通动态完整 CA 交易一致。

## 16. 实施与验收顺序

1. Migration + schema audit + rollback rehearsal。
2. asset registry 拆分，先证明 Candidate Repository 零回归。
3. RPC 验证服务和保存事务重排。
4. route repository、policy DTO、template DTO 和 context hash。
5. content extractor / preset resolver / intent gate / resolution policy。
6. resolution store、target 和 Signal snapshot。
7. 方案 B React 组件和响应式布局。
8. 后端全量测试、前端构建、DOM 回归。
9. 本地 record 模式验证匹配、歧义和快照。
10. xiexiu 只同步一个测试账号，确认保存不停止 Engine。
11. 使用三个关键词分别触发三个已验证 CA 的小额真实交易。
12. 每笔核对 Resolution、Signal、Swap Attempt、Order、Position 和平仓。
13. 验收通过后再扩大到其他账号。

## 17. GMGN 429 结论

P35 不会因为关键词数量增加而增加 GMGN 解析请求：

- 保存阶段只调用所选公链 RPC。
- 运行时关键词到 CA 是数据库内确定映射。
- 不调用 Grok。
- 不调用 GMGN Token / Market / K-line。
- 只有形成合法 Signal 后，才沿用现有 GMGN Swap 和 Order Query。
- P27 已有的异步资产元数据补全行为保持不变，P35 本身不新增任何 GMGN 元数据请求。

所以 P35 对 GMGN 的增量请求为 0；真实交易本身的 GMGN 请求数量与现有完整 CA 动态策略相同。

## 18. 最终审核与实施结果

### 18.1 已冻结并实现的决策

1. 正式前端采用方案 B。
2. 后端采用正规化 routes / aliases 两表，不使用 policy JSONB 作为执行真相。
3. 每条路由必须在保存前完成 RPC 验证并取得真实 variant ID。
4. 预设路由不进入 Candidate Index。
5. Intent Gate 使用统一 assetKey 解决关键词与 CA 的同资产去重。
6. 旧 approved aliases 只作为待绑定数据，不自动猜测 CA。
7. 不增加 GMGN 研究调用，不提供降级路径。

### 18.2 实施前复核补齐的遗漏

1. 路由执行字段进入 `context_hash` 和 Revision，旧队列任务不能套用新映射。
2. 保存提交除 policy revision / context 外，还比较完整 `route_state_hash`，防止 label、验证时间等非 Revision 字段被并发覆盖。
3. 存在启用路由时必须启用 `approved_name`；停用路由可以保留，但不能参与运行时匹配。
4. 前端、模板和 API 保存 payload 均剥离 `variant_id`、`asset_family_id`、`verification` 等只读授权证据。
5. 英文关键词边界按原始文本 span 判断，保留空格后的独立词命中，同时保证 `GME` 不命中 `GAME`。
6. Candidate Repository 兼容路径保持原 SQL 调用顺序；只有 P35 路由资产登记使用事务锁和已有 variant 查询。
7. `asset_route_snapshot` 只在 P35 Signal 中加入，固定 CA、关注策略和旧动态信号的授权 snapshot hash 不变。
8. 匹配预览为草稿分配与持久化 route ID 不冲突的临时身份，避免把跨路由命中错误折叠为单路由。
9. 旧关键词绑定只有在目标路由和账号总词数仍有容量时才移除旧词，避免“前端显示已绑定、实际关键词丢失”。
10. RPC 验证缓存增加 256 条硬上限和过期清理，避免 API 进程因大量不同 CA 验证而长期积累内存。

### 18.3 当前自动验收证据

- P35 专项 `17/17`：关键词规范化、歧义、CA 冲突、Cashtag 与路由词同资产归并、不同 Cashtag 多资产拒绝、RPC、缓存边界、事务外预检、并发保存、资产登记、审计快照和匹配预览全部通过。
- P20 共享链路 `22/22`：固定 CA、动态喊单、关注策略共用的解析与授权链路通过。
- 后端全量 `636/636`：固定 CA、动态喊单、关注策略、Signal、GMGN 执行、持仓和平仓回归通过。
- 前端：TypeScript production build 与 Vite production build 通过。
- `git diff --check` 无空白错误；只有仓库现有 Windows LF/CRLF 提示。
- 本轮改动限定在 P35 动态路由、其必要的可选授权快照、数据库审计、专项测试、方案 B 前端和 P35 文档/原型。
- 正式解析器离线复放 `Happy Monday Eve $GME. The chart deserves another look.` 返回 `resolved / approved_term_direct / route 4`；`$GME and $BTC` 返回 `multi_asset_ambiguous`，未放宽多资产门禁。

### 18.4 当前真实交易验收证据

本地正式链路已完成三条不同路由的小额真实买入，均通过 GMGN 下单、BSC Receipt `status=1`，并创建 `open_protected` 持仓；验收期间 GMGN 429 为 0：

| 关键词 | Signal / Attempt / Position | 交易哈希 |
|---|---|---|
| `bStocks Never Sleep` | `835 / 145 / 574` | `0xb53cac3eacf5f80e16e7403092471cb53981a0f7d062f8eea11b9cedc72f61f5` |
| `utility token` | `836 / 146 / 575` | `0x8455cf4b40c2bfe7fec48366f9a387bbff7bf6c353a765afa416bf93a5627e02` |
| `GME` | `837 / 147 / 576` | `0x4321062c6ba095dfc0060f61a9e54008119e7b8f14a3577f8d1e81b57963f030` |

完整句子 `$GME` 已在新事件中正确解析为唯一 GameStop 路由；当时同 CA 已有持仓，因此交易按既有 `DYNAMIC_CA_POSITION_EXISTS` 规则拒绝，证明多资产误判已消除且持仓去重仍然有效。

新增 `Ignore Coins` 路由完成了长文本真实闭环：

| 阶段 | 证据 |
|---|---|
| 关键词 / 路由 | `Ignore coins` / Route `5` / BSC `0xa80fc39973f5486516a8272fed46a1b2cb867777` |
| 6551 Activity / Resolution | `1704 / 28`，`resolved / approved_term_direct / Revision 9` |
| Signal / Buy Attempt / Position | `840 / 158 / 577` |
| 买入 | `0.01 BNB`，收到 `9210.717488235473712736 IgnoreCoin` |
| 买入交易 | `0x022eca4637a4eb2418ae79b3e213d197d67e2a844400d32d66efc9d498e64df3` |
| 保护持仓 | `open_protected`，`+100%` 卖出 `50%` |
| Sell Attempt | `159 / confirmed` |
| 卖出交易 | `0x532f2b6f4c4960976314ddbc123511af2c32df1d47e3dbc6e5abaf32eaa3aa9c` |
| 最终 Position | `577 / closed` |

### 18.5 真实验收中发现并修复的问题

1. 第一个 Ignore Coins 新事件生成 Signal `839` 后被 `LIVE_SCOPE_SNAPSHOT_MISMATCH` 拒绝。根因不是关键词、CA 或 GMGN，而是策略已热更新到 Revision `9`，Engine 授权快照仍停留在 Revision `8`。
2. 修复保留最终范围门禁，在 Readiness 通过且 `scope_type + scope_id + configuration fingerprint` 相同的前提下，原子刷新 Engine 的 Revision、Manifest 和授权链快照；跨策略范围、配置漂移、Revision 回退或未就绪快照仍然拒绝。
3. 修复不停止 Engine、不重放已拒绝 Signal、不新增 GMGN 调用。定向回归覆盖 Revision `8 -> 9` 热更新和跨范围拒绝，全量测试通过。
4. P25 快速交易链路有意不在买入前调用 GMGN Security / Pool / Quote。此前前端把这些“未查询字段”显示为风险观察，容易被误解为真实风险。最终规则改为：只有错误真正阻止买入时显示安全失败或执行阻断；已成功交易的缺失字段只保留在审计快照，不在信号卡片提醒。

### 18.6 尚未完成的生产验收

以下项目不得因自动测试通过而标记为完成：

1. xiexiu 部署、Migration 052、schema audit、Supervisor 角色与 Watch/Readiness 复核。
2. 将服务器动态策略数据显式同步为五条资产路由，不能假设代码部署会复制本地数据库策略数据。
3. xiexiu 部署后完成三策略与 P35 多路由的最终人工验收。

P35 当前已完成自动回归、四条路由的本地真实买入证据，以及 Ignore Coins 的真实买入和手动平仓闭环；尚未部署到 xiexiu，因此不能写成“生产部署完成”。
