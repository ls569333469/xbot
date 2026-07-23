# P8.1 X 账号显式关系模型修正方案

状态：代码与本地迁移完成，待重新执行 Watch dry-run 和 M6 真实事件验收

## 一、修正原因

P8 当前把启用的 KOL 与白名单中的项目 X 账号分别存储。信号匹配时，所有启用 KOL 会与所有启用白名单发生隐式交叉匹配。

当系统只有一个 KOL 时问题不明显；存在多组指定关系时会产生错误组合。例如只配置：

- `elonmusk -> cz_binance -> CA-A`
- `heyibinance -> liming -> CA-B`

旧模型仍可能接受 `elonmusk -> liming` 或 `heyibinance -> cz_binance`。这不符合业务语义，必须在 M6 真实行为验收前修正。

## 二、目标关系模型

每条有效监控关系固定为：

```text
行为账号（actor） -> 项目账号（target） -> CA 白名单（whitelist）
```

约束如下：

1. 同一个 CA 可以绑定多条账号关系。
2. 同一个行为账号可以绑定多个项目账号和多个 CA。
3. 同一个项目账号可以绑定多个行为账号和多个 CA。
4. 只有明确绑定到该 CA 的行为账号才能生成该 CA 的信号。
5. 关系有方向；`A -> B` 不等于 `B -> A`。
6. 同一来源行为、同一行为账号、同一 CA 仍只生成一条 canonical signal。

## 三、行为匹配规则

| 行为 | actor | target | 匹配条件 |
|---|---|---|---|
| 关注 | 新粉丝账号 | 被关注项目账号 | 必须存在完全一致的 `actor -> target -> CA` 关系 |
| 取消关注 | 取消关注账号 | 项目账号 | 只记录，不生成信号 |
| 回复 | 发帖账号 | 原推账号 | 必须命中明确关系 |
| 引用 | 发帖账号 | 被引用账号 | 必须命中明确关系 |
| 转发 | 发帖账号 | 原推账号 | 必须命中明确关系 |
| 直接提及项目账号 | 发帖账号 | 被提及账号 | 必须命中明确关系 |
| 直接发布 CA 或 Symbol | 发帖账号 | 关系中的任一项目账号 | actor 必须与该 CA 至少存在一条启用关系 |

## 四、数据与接口修改

新增 `x_signal_relations`：

- `whitelist_id`：关联 CA 白名单。
- `kol_id`：行为账号，复用 `x_kol_accounts`。
- `target_x_handle`：项目账号。
- `enabled`：关系是否启用。
- 唯一约束：`whitelist_id + kol_id + target_x_handle`。

`ca_whitelist.project_x_handles` 暂时保留为兼容字段，但只作为关系目标账号的派生快照，不再作为信号授权来源。

白名单 API 使用 `relations` 数组读写账号关系。新增行为账号时由后端按 handle 复用或创建本地 KOL 记录，不要求用户先切换到 KOL 页面操作。

## 五、旧数据迁移

为避免把错误的交叉匹配固化为真实关系：

1. 数据库中恰好只有一个启用 KOL 时，将旧白名单的每个项目账号迁移为该 KOL 的明确关系。
2. 启用 KOL 多于一个时，不自动生成交叉关系，必须在前端人工确认。
3. 不删除旧白名单、历史信号、Follow 永久去重记录或远端 Watch。
4. 本次迁移不执行任何 6551 Watch add/delete，也不启用 WSS。

## 六、前端录入

白名单表单改为“触发关系”编辑器：

```text
[行为账号 @elonmusk] -> [项目账号 @cz_binance] [添加关系]
```

- 行为账号可从已有 KOL 中选择，也可直接输入新账号。
- 项目账号支持单个输入，也支持用英文逗号、中文逗号、分号、空格或换行批量粘贴。
- 添加后显示独立关系行，可逐条删除。
- 重复关系自动去重。
- 忘记点击“添加”时，只要两侧输入完整，保存会自动收录。
- 账号统一去掉 `@`、转为小写并校验 X handle 格式。

## 七、6551 Watch 计算

- actor 角色开启 Tweet、Reply、Quote、Retweet、CA。
- target 角色开启 New Follower；Unfollower 继续由配置决定。
- 同一账号出现在多条关系或同时承担 actor/target 时，只生成一个 desired Watch，flags 取角色并集。
- Watch 成本按去重后的远端账号数量计算，不按关系数量重复计算。

## 八、验收标准

- [x] `elonmusk -> cz_binance` 只能命中该明确关系。
- [x] `heyibinance -> liming` 只能命中该明确关系。
- [x] 未配置的交叉组合不得生成信号。
- [x] 同一 actor 对同一 CA 命中多个 target 时只生成一条信号并保留关系 ID。
- [x] CA/Symbol 直接发帖只匹配该 actor 已绑定的 CA。
- [ ] Watch dry-run 按关系角色去重，且不修改未知远端 Watch。
- [x] 白名单新增和编辑可在一个表单内完成账号关系维护。
- [x] 后端测试、前端 lint 与 build 全部通过。

2026-07-21 本地迁移结果：

- 已应用 `004_explicit_x_signal_relations.sql`。
- 旧数据转换为 `wanshenme -> blackbullsol` 与 `wanshenme -> neet_sol` 两条明确关系。
- 未生成其他交叉组合，未创建远端 Watch，未启用 WSS，未触发交易。
- 自动化验证：后端 `40/40`、前端 lint、前端 build 全部通过。

## 九、执行顺序

1. 新增数据库关系表与兼容迁移。
2. 白名单 API 改为事务化保存关系。
3. Signal Matcher 按 `kol_id` 加载明确关系。
4. Watch Reconciler 只从启用关系计算 actor/target。
5. 前端改为关系编辑器。
6. 完成回归测试后重新执行 Watch dry-run。
7. 用户确认 dry-run 后，才进入 P8 M6 的 Watch apply 与真实事件验收。
