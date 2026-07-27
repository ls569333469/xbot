# xbot 全栈开发规范与 UI/UX 视觉标准模板 (P3_development_standards.md)

> **版本**: v1.0  
> **说明**: 本文档作为项目的全局视觉、排版、组件交互与数据传输契约的黄金标准。未来其他项目可直接复制本文档，修改首部配置后即可复用。

---

## 1. 品牌与视觉核心配置 (Brand & Identity Config)

| 配置项 | 本项目参数 | 说明 |
| :--- | :--- | :--- |
| **`[PROJECT_NAME]`** | `xbot` | 系统的核心产品品牌名称 |
| **`[BRAND_LOGO_SYMBOL]`** | `TrendingUp / Spiral` | 品牌图形隐喻及导航头部的矢量图标 |
| **`[PRIMARY_ACCENT_COLOR]`** | `hsl(250 84% 63%)` | 系统全局的主色/高亮色（如极光紫 `#6c5ce7`） |
| **`[SUCCESS_ACCENT_COLOR]`** | `hsl(154 94% 51%)` | 代表成功、盈利、通过的霓虹绿色 |
| **`[DANGER_ACCENT_COLOR]`** | `hsl(359 100% 65%)` | 代表危险、熔断、拒绝的警告红色 |
| **`[THEME_STYLE]`** | `Obsidian Glassmorphism` | 视觉层风格类型，默认采用黑曜石深景深毛玻璃 |

---

## 2. 视觉系统细节标准 (Design Token Specification)

所有前端样式资产必须通过 CSS 变量（Design Tokens）进行统领，严禁在页面组件中硬编码具体的色值、间距或圆角。

### 2.1 全局 HSL 调色板 (CSS variables)
在主样式文件（如 `index.css`）的 `:root` 节点中声明如下变量：

```css
:root {
  /* 基础背景与面板色 */
  --background: hsl(240 10% 3.9%);       /* 黑曜石深色背景 */
  --foreground: hsl(0 0% 91%);           /* 主前景色 */
  --card: rgba(15, 15, 20, 0.7);         /* 半透明磨砂卡片 bg */
  --card-hover: rgba(22, 22, 30, 0.85);  /* Hover 态卡片 bg */
  --popover: hsl(240 10% 7%);            /* 下拉菜单与对话框 */
  --border: hsl(240 5.9% 10%);           /* 细分割线 */
  --input: hsl(240 5.9% 9%);             /* 输入框底色 */

  /* 品牌语义色 */
  --color-accent: hsl(250 84% 63%);
  --color-success: hsl(154 94% 51%);
  --color-danger: hsl(359 100% 65%);
  --color-warning: hsl(40 95% 50%);

  /* 前景色与文字分层 */
  --color-text-primary: #e7e7e7;         /* 重要标题与内容 */
  --color-text-secondary: #aaaaaa;       /* 描述性/次要内容 */
  --color-text-muted: #7a7a7a;           /* 提示/次级表头内容 */
  
  /* 毛玻璃边框与投影 */
  --border-base: rgba(255, 255, 255, 0.04);
  --border-strong: rgba(255, 255, 255, 0.08);
}
```

### 2.2 精准 Spacing & Border Radius
为保证界面的紧凑度和专业感，强制采用**偶数级像素步进**：
- **间距 (Spacing)**：
  - 微量元素间距：`--space-2: 2px`、`--space-4: 4px`、`--space-6: 6px`
  - 核心组件内边距/外边距：`--space-sm: 8px`、`--space-10: 10px`、`--space-12: 12px`、`--space-md: 16px`
  - 页面大边距/模块间距：`--space-lg: 24px`、`--space-xl: 32px`、`--space-2xl: 48px`
- **圆角 (Radius)**：
  - 小标识圆角：`--radius-sm: 6px`
  - 按钮/输入框/选择器：`--radius-8: 8px`、`--radius-md: 10px`、`--radius-12: 12px`
  - 主卡片/容器圆角：`--radius-lg: 16px`、`--radius-xl: 20px`

### 2.3 字体版式标准 (Typography)
- **常规版式字体 (Lato / Inter)**：
  `font-family: "Lato", "PingFang SC", sans-serif;` 
  适用于普通文本、卡片描述、导航菜单，提供柔和现代的非衬线阅读体验。
- **等宽数据字体 (Roboto Mono / JetBrains Mono)**：
  `font-family: "Roboto Mono", monospace;`
  适用于 CA 合约地址、币价、交易哈希（Hash）、浮动盈亏（PnL）及所有数据列表中的数值，确保多位数字上下垂直对齐不位移。

---

## 3. UI 布局与组件标准 (Component Layout Standards)

### 3.1 18px 图标对齐法 (Axis Ghost Sidebar)
侧边栏和主菜单采用 Ghost 扁平冷峻样式：
- **左侧图标对齐轴**：所有侧边栏 Lucide 图标的显示大小统一约束为 `18px`，且必须将其包裹于一个固定等宽 Flex 容器 `<span className="flex items-center justify-center" style={{ width: '18px', height: '18px' }}>` 内。
- **排版架构**：
  ```text
  Sidebar Container (Width: 240px)
  ├── Logo Zone (Icon + Title, Border Bottom: 1px Var(--color-border))
  ├── NavLink Menu (Gap: 4px)
  │    ├── NavLink 1 (Active: border-left-color: var(--color-accent))
  │    │    ├── [18px Icon Box] ── Icon
  │    │    └── Text (Font-medium text-sm)
  │    └── NavLink 2
  └── Status Footer (Border Top: 1px Var(--color-border))
  ```

### 3.2 液态玻璃数据卡片 (Liquid Glass Panel)
卡片需具备细腻半透明悬浮质感：
```css
.glass-card {
  background: var(--color-card);
  border: 1px solid var(--border-base);
  border-radius: var(--radius-lg);
  padding: var(--space-lg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 4px 30px rgba(0, 0, 0, 0.4);
  transition: border-color var(--transition-normal), background var(--transition-normal);
}
.glass-card:hover {
  background: var(--color-card-hover);
  border-color: var(--border-strong);
}
```

### 3.3 数据表格排版 (Data Table)
- **表头 th**：高度固定为 `h-12`，字体采用 `text-xs font-semibold uppercase tracking-wider text-fg-muted bg-black/25`，提供微亮的暗表头。
- **单元格 td**：高度固定为 `h-14`，数字类单元格强制添加 `.font-mono`，实现数字绝对对齐。

### 3.4 产品信息架构与配置所有权

前端不得直接按照后端字段或迭代批次堆叠卡片。新增功能进入页面前必须先确定其归属：

- **用户决策**：进入设置页，一个决策只保留一个控制；二元决策使用开关。
- **业务数据**：进入拥有该数据的业务页，不得在设置页建立第二个维护入口。
- **运行状态**：进入运行状态视图；正常状态只显示摘要，技术指标默认折叠。
- **维护工具**：默认只保留后端或 CLI 入口，不进入日常前端。只有必须由用户立即处理的生产异常，才可在异常存在期间显示条件式恢复入口。

设置页单个视图最多三块一级内容。链级默认值、限流窗口、费用计算、重试次数和证据规则由后端 Chain Manifest 管理，前端不得复制第二份默认参数。任何无法明确页面归属的功能不得直接新增卡片。

所有维护工具必须登记在 [`maintenance_tool_registry.md`](./maintenance_tool_registry.md)，记录唯一入口、使用场景、资金副作用、前置条件、审计和前端展示策略。一次性验收完成后必须移除前端入口；前端不可见的维护代码在删除前仍需完成生产可达性审计。

前端评审必须先提供独立原型并确认以下问题：

1. 是否已有页面拥有同一数据。
2. 是否能由后端安全默认值自动完成。
3. 正常运行时是否需要持续可见。
4. 是否产生重复配置入口。
5. 是否把实现细节错误地转移给用户。

---

## 4. 消除布局跳动与原生过渡动画 (Layout Shift & Animation Standards)

### 4.1 拟真骨架占位 (Pulse Skeletons)
为彻底消灭网络延迟加载时页面的硬跳动 (Layout Shift)，必须对白名单、数据表和指标面板配置骨架屏保护。

在 `src/components/ui/Skeleton.tsx` 中预设三种骨架屏：
1. **`TableSkeleton`**：具有多行多列呼吸闪烁格。
2. **`CardSkeleton`**：内置卡片标题与指标数值占位。
3. **`FormSkeleton`**：内置网格表单输入行与按钮占位。

### 4.2 原生 CSS View Transitions 页面图层渐显
利用原生浏览器 Transitions，在新旧页面容器挂载时启用 GPU 加速的 slide-in 渐显：
```css
.page-transition-container {
  animation: pageFadeIn 300ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
  width: 100%;
  height: 100%;
}

@keyframes pageFadeIn {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
```

---

## 5. 前后端数据传输契约规范 (DTO TypeScript Contracts)

前端 API DTO 契约层与数据库 DDL 列字段格式强制采用 **100% 对齐的蛇形命名 (snake_case)**，在前端过滤层抹除开荒期驼峰命名造成的接口断层。

### 5.1 实体契约映射规范 (例)
新项目实体声明必须显式指出后端物理字段：
```typescript
export interface WhitelistEntry {
  id: string;
  contract_address: string;             // 拒绝: tokenAddress
  chain_id: ChainId;                    // 拒绝: chain
  project_name: string;                 // 拒绝: projectName
  budget_per_trade: number;             // 拒绝: budgetPerTrade
  auto_tp_pct: number;                  // 拒绝: tpPercent
  status: 'active' | 'paused';
}
```

---

## 6. 构建与合并准入检查 (Build Checklist)

1. **TypeScript 编译 0 报错**：合并/发布前必须在前端根目录执行静态分析构建命令，0 报错为准入红线。
2. **消灭 Any 与 忽略标签**：代码中严禁出现 `// @ts-ignore` 或 `any` 强制类型抹除。
3. **网络慢速测试**：在浏览器 DevTools Network 面板中模拟 Slow 3G / Fast 3G，确认骨架屏在加载时布局平稳，无任何高度塌陷及抖动。
