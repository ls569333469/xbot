(() => {
  const option = document.body.dataset.option === 'b' ? 'b' : 'a';
  const app = document.querySelector('#app');

  const navItems = [
    ['home', '▦', '总览'],
    ['strategies', '☷', '策略中心'],
    ['kol', '◎', 'KOL'],
    ...(option === 'b' ? [['research', '⌕', '账号研究', 'P21']] : []),
    ['signals', '⌁', '信号'],
    ['positions', '↗', '持仓'],
    ['history', '◷', '交易记录'],
    ['settings', '⚙', '设置'],
  ];

  const navMarkup = navItems.map(([route, icon, label, badge]) => `
    <button type="button" data-route="${route}" class="${route === 'strategies' ? 'active' : ''}">
      <span class="nav-icon">${icon}</span><span class="nav-label">${label}</span>${badge ? `<span class="nav-new">${badge}</span>` : ''}
    </button>`).join('');

  const fixedRows = [
    ['RO', 'ROBINHOOD', 'Robinhood · 固定 CA'], ['RH', 'RHAGENT', 'Robinhood · 固定 CA'],
    ['RE', 'REAL', 'Robinhood · 固定 CA'], ['RA', 'RAXOL', 'Robinhood · 固定 CA'], ['GW', 'GWOOD', 'Robinhood · 固定 CA'],
  ].map(([mark, name, meta], index) => `<button type="button" class="row ${index === 0 ? 'selected' : ''}"><span class="row-mark">${mark}</span><span><strong>${name}</strong><small>${meta}</small></span><em class="active">运行中</em></button>`).join('');

  const dynamicRows = [
    ['X', '@wanshenme', '实盘 · BSC'], ['X', '@cryptogle', '待配置 · 多链'], ['X', '@vladtenev', '待配置 · Robinhood'],
  ].map(([mark, name, meta], index) => `<button type="button" class="row ${index === 0 ? 'selected' : ''}"><span class="row-mark">${mark}</span><span><strong>${name}</strong><small>${meta}</small></span><em class="${index ? 'pending' : 'active'}">${index ? '待配置' : '实盘运行'}</em></button>`).join('');

  const followRows = [
    { mark: 'CZ', handle: '@cz_binance', meta: '记录 · BSC · SOL · ETH', status: '已启用', cls: 'active', found: 7, unique: 2, watch: '已同步', revision: 'Revision 1' },
    { mark: 'OG', handle: '@cryptogle', meta: '记录 · 多链', status: '已启用', cls: 'active', found: 3, unique: 1, watch: '已同步', revision: 'Revision 1' },
    { mark: 'VL', handle: '@vladtenev', meta: '尚未配置交易模板', status: '待配置', cls: 'pending', found: 2, unique: 0, watch: '等待同步', revision: '未保存' },
  ];

  const followRowsMarkup = followRows.map((row, index) => `<button type="button" class="row follow-row ${index === 0 ? 'selected' : ''}" data-follow-index="${index}"><span class="row-mark">${row.mark}</span><span><strong>${row.handle}</strong><small>${row.meta}</small></span><em class="${row.cls}">${row.status}</em></button>`).join('');

  const kolRows = [
    ['H', '@heyibinance', '何一', 'BSC', 10], ['T', '@theunipcs', 'bonkbuy', '跨链', 10], ['V', '@vladtenev', '罗宾汉 CEO', 'ROBINHOOD', 10],
    ['A', '@abhishekf96', '罗宾汉业务副总裁', 'ROBINHOOD', 5], ['A', '@asteroid_bags', 'Asteroid', '未分类', 5], ['D', '@drao', '罗宾汉总经理', 'ROBINHOOD', 5],
  ].map(([mark, handle, name, tag, weight]) => `<tr><td><div class="account-cell"><span class="avatar">${mark}</span><div><strong>${handle}</strong><small>${name}</small><small class="verified">6551 已核验</small></div></div></td><td><div class="tags"><span>${tag}</span></div></td><td><div class="weight"><strong>${weight}</strong><i><span style="width:${weight * 10}%"></span></i></div></td><td><span class="active-text">● 活跃</span></td><td><button class="icon-button" title="编辑">⌁</button></td></tr>`).join('');

  const researchRows = [
    ['@cryptogle', '124', '31%', '68%', '57%', '建议记录'],
    ['@theunipcs', '96', '22%', '54%', '53%', '继续观察'],
    ['@vladtenev', '88', '9%', '36%', '48%', '数据不足'],
    ['@cz_binance', '74', '15%', '42%', '51%', '继续观察'],
  ].map(([handle, sample, intent, resolve, win, result], index) => `<tr class="${index === 0 ? 'selected-table-row' : ''}"><td><div class="account-cell"><span class="avatar">${handle.slice(1,2).toUpperCase()}</span><div><strong>${handle}</strong><small>最近 90 天原创内容</small></div></div></td><td>${sample} 帖</td><td>${intent}</td><td>${resolve}</td><td>${win}</td><td><span class="status-badge ${result === '建议记录' ? 'active' : result === '数据不足' ? '' : 'pending'}">${result}</span></td><td><button class="btn ghost">查看证据</button></td></tr>`).join('');

  const researchContent = `
    <div class="research-layout">
      <aside class="research-batches">
        <div class="list-head"><strong>研究批次</strong><span>3 个</span></div>
        <button class="batch selected"><strong>高权重账号候选</strong><small>4 个账号 · 已完成</small></button>
        <button class="batch"><strong>社区账号补充</strong><small>12 个账号 · 处理中</small></button>
        <button class="batch"><strong>历史喊单回测</strong><small>8 个账号 · 已完成</small></button>
      </aside>
      <section class="research-main">
        <div class="view-head"><div><h3>高权重账号候选</h3><p>账号清洗与历史回测结果</p></div><span class="status-badge active">已完成</span></div>
        <div class="research-form">
          <textarea class="input" aria-label="X 账号列表">@cz_binance
@cryptogle
@vladtenev
@theunipcs</textarea>
          <select class="input" aria-label="研究时间范围"><option>最近 90 天</option><option>最近 30 天</option></select>
          <button type="button" class="btn primary">开始研究</button>
        </div>
        <div class="research-meta"><div><span>输入账号</span><strong>4</strong></div><div><span>原创样本</span><strong>382</strong></div><div><span>唯一 CA 解析</span><strong>64%</strong></div><div><span>历史胜率</span><strong>56%</strong></div></div>
        <div class="table-shell"><table class="data-table"><thead><tr><th>账号</th><th>样本</th><th>直接意图</th><th>CA 解析</th><th>胜率</th><th>结论</th><th>操作</th></tr></thead><tbody>${researchRows}</tbody></table></div>
        <div class="research-note"><span>◇</span><span>研究结果可以加入 KOL 账号库或创建未启用策略草稿，不创建 6551 Watch，不进入交易链路。</span></div>
      </section>
    </div>`;

  app.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar">
        <div class="brand"><span class="brand-mark">↗</span><strong>xbot.</strong></div>
        <nav class="side-nav">${navMarkup}</nav>
        <div class="engine"><span class="shield">!</span><span>已停止</span></div>
      </aside>
      <section class="main-shell">
        <header class="topbar"><h1 id="page-title">策略中心</h1><div class="connection"><span class="connection-icon">⌁</span><span>已连接</span></div></header>
        <main class="main-panel">
          <section class="route-view active" data-route-view="strategies">
            <section class="summary">
              <div><span>全部策略</span><strong>34</strong><small>固定 30 · 动态 1 · 关注 3</small></div>
              <div><span>固定目标</span><strong>30</strong><small>CA、项目和生态关系</small></div>
              <div><span>动态账号</span><strong>1</strong><small>已配置 1 · 待配置 19</small></div>
              <div><span>关注发现</span><strong class="purple">3</strong><small>已配置 2 · 待配置 1</small></div>
              <div><span>模拟策略</span><strong>0</strong><small>仅产生模拟交易</small></div>
              <div><span>实盘策略</span><strong class="red">1</strong><small>随全局 Engine 运行</small></div>
            </section>
            <section class="shell">
              <header class="shell-header"><div><span class="eyebrow">统一策略入口</span><h2>策略中心</h2><p>在一个入口查看策略状态，并进入对应工作区编辑。</p></div><div class="runtime"><i></i><span>动态任务待命</span><button class="icon-button" title="刷新">↻</button></div></header>
              <nav class="tabs strategy-tabs"><button data-strategy-tab="fixed">固定 CA / 项目策略</button><button data-strategy-tab="dynamic">动态喊单策略</button><button class="active" data-strategy-tab="follow">新关注发现策略 <span class="tab-badge">P21</span></button><button data-strategy-tab="new">新增策略</button></nav>
              <section class="tab-panel" data-strategy-panel="fixed">
                <div class="view-head"><div><h3>固定 CA / 项目策略</h3><p>原有固定目标与生态互动策略保持不变。</p></div><button class="btn primary">＋ 进入固定策略工作区</button></div>
                <div class="split"><div class="list"><div class="list-head"><strong>固定目标列表</strong><span>30 条</span></div>${fixedRows}</div><div class="detail"><div class="detail-head"><div><span class="eyebrow">固定 CA</span><h3>ROBINHOOD</h3><p>Robinhood · 0x8f100e...d47382</p></div><span class="status-badge active">运行中</span></div><div class="detail-grid"><div><span>触发账号</span><strong>15 个唯一账号</strong></div><div><span>生态 CA 动态</span><strong>0 个</strong></div><div><span>生态互动</span><strong>15 条</strong></div><div><span>单笔 / 上限</span><strong>0.10000000 / 0.20000000</strong></div><div class="wide"><span>离场策略</span><strong>+100% 卖 50%</strong></div></div><div class="detail-note"><span class="note-icon">◇</span><span>固定目标继续沿用现有 6551 Watch 同步和 P19 交易链路。</span></div></div></div>
              </section>
              <section class="tab-panel" data-strategy-panel="dynamic">
                <div class="view-head"><div><h3>动态喊单策略</h3><p>账号发帖后解析 CA、代币符号、话题标签和项目名称。</p></div><button class="btn primary">▣ 进入动态策略工作区</button></div>
                <div class="runtime-line"><span>解析任务：待命</span><span>动态策略：1 条</span><span>待配置账号：19 个</span><span>实盘策略：1 条</span></div>
                <div class="split"><div class="list"><div class="list-head"><strong>动态账号列表</strong><span>1 已配置 · 19 待配置</span></div>${dynamicRows}</div><div class="detail"><div class="detail-head"><div><span class="eyebrow">动态喊单</span><h3>@wanshenme</h3><p>Revision 8 · Watch 已同步</p></div><span class="status-badge active">实盘运行</span></div><div class="detail-grid"><div><span>允许链</span><strong>BSC</strong></div><div><span>匹配词条</span><strong>完整 CA · 项目名称</strong></div><div><span>运行阶段</span><strong>实盘</strong></div><div><span>交易配置</span><strong>当前线上配置</strong></div><div class="wide"><span>安全边界</span><strong>先逐帖解析，再由账号级策略决定是否进入现有交易链路。</strong></div></div><div class="detail-note"><span class="note-icon">◇</span><span>P21 不修改动态喊单页面、预算、重复买入和执行逻辑。</span></div></div></div>
              </section>
              <section class="tab-panel active" data-strategy-panel="follow">
                <div class="view-head"><div><h3>新关注发现策略</h3><p>高权重账号关注新账号后，验证项目身份与官方唯一 CA。</p></div><button type="button" class="btn primary" data-open-workspace>◎ 进入关注发现工作区</button></div>
                <div class="runtime-line"><span>Follow Watch：2 已同步</span><span>今日发现：12 个</span><span>唯一 CA：3 个</span><span>交易阶段：全部记录</span></div>
                <div class="split"><div class="list"><div class="list-head"><strong>监控账号列表</strong><span>2 已配置 · 1 待配置</span></div>${followRowsMarkup}</div><div class="detail" id="follow-detail"></div></div>
              </section>
              <section class="tab-panel" data-strategy-panel="new">
                <div class="view-head"><div><h3>新增策略</h3><p>选择策略类型后进入对应工作区。</p></div><span class="runtime"><i></i>统一创建入口</span></div>
                <div class="new-grid"><button class="new-card"><span class="new-card-mark">CA</span><strong>固定 CA / 项目策略</strong><p>已知 CA、项目账号、生态互动和未发币项目监控。</p><small>当前可用 · 固定工作区</small></button><button class="new-card"><span class="new-card-mark">X</span><strong>动态喊单策略</strong><p>账号发帖后匹配 CA、代币符号或话题标签。</p><small>当前可用 · 动态工作区</small></button><button class="new-card selected"><span class="new-card-mark">◎</span><strong>新关注发现策略</strong><p>高权重账号 Follow 新账号，识别项目身份并验证官方 CA。</p><small>P21 新增 · 关注发现工作区</small></button></div><div class="new-footer"><span>创建策略不会自动启动全局 Engine。</span><button class="btn primary" data-open-workspace>继续配置 →</button></div>
              </section>
            </section>
          </section>

          <section class="route-view" data-route-view="workspace">
            <div class="workspace-top"><div class="workspace-title"><button type="button" class="back" data-back-strategies>← 返回策略中心</button><h2>新关注发现策略</h2><p>Follow 发现与官方 CA 验证工作区</p></div><span class="status-badge pending">记录阶段</span></div>
            <section class="workspace-summary"><div><span>监控账号</span><strong>@cz_binance</strong></div><div><span>Watch 状态</span><strong class="active-text">已同步</strong></div><div><span>当前 Revision</span><strong>Revision 1</strong></div><div><span>交易配置</span><strong>复用多链小额标准</strong></div></section>
            <section class="workspace-panel"><nav class="step-nav"><button class="step-button active" data-step="1"><span class="step-number">1</span><span><strong>监控账号</strong><small>Actor 与运行阶段</small></span></button><button class="step-button" data-step="2"><span class="step-number">2</span><span><strong>发现与验证</strong><small>身份、来源、唯一 CA</small></span></button><button class="step-button" data-step="3"><span class="step-number">3</span><span><strong>交易配置</strong><small>复用现有模板</small></span></button><button class="step-button" data-step="4"><span class="step-number">4</span><span><strong>确认并保存</strong><small>Revision 与 Watch</small></span></button></nav>
              <section class="step-pane active" data-step-pane="1"><div class="step-head"><div><h3>选择监控账号</h3><p>只合并 Actor 的 Follow Watch，不监控未知 Target。</p></div><span class="status-badge active">6551 已核验</span></div><div class="form-grid"><div><label class="field"><span>高权重账号</span><select class="input"><option>@cz_binance · CZ</option><option>@cryptogle · OGLE</option><option>@vladtenev · Vlad</option></select></label><div class="profile-line"><span class="avatar">CZ</span><span><strong>@cz_binance</strong><small>6551 已核验 · User ID 已锁定</small></span><span class="switch"></span></div><label class="field" style="margin-top:12px"><span>运行阶段</span><select class="input"><option>记录 · 只解析，不交易</option><option>模拟 · 复用现有模拟交易</option><option>实盘 · 复用现有实盘门禁</option></select></label></div><div class="rule-list"><div class="rule"><span class="rule-icon">✓</span><span><strong>Follow 方向确认</strong><small>仅处理高权重账号主动关注的新账号。</small></span><em>启用</em></div><div class="rule"><span class="rule-icon">✓</span><span><strong>Baseline 隔离</strong><small>历史关注列表只建立 seen 集合，不生成交易。</small></span><em>启用</em></div><div class="rule"><span class="rule-icon">✓</span><span><strong>永久行为去重</strong><small>取消后重新关注也不会重复买入。</small></span><em>启用</em></div></div></div><div class="step-actions"><span></span><button class="btn primary" data-next-step="2">下一步：发现与验证</button></div></section>
              <section class="step-pane" data-step-pane="2"><div class="step-head"><div><h3>项目身份与官方 CA</h3><p>任一必需条件不能确认时，只记录拒绝原因。</p></div><span class="status-badge active">失败关闭</span></div><div class="form-grid"><div><label class="field"><span>允许的官方来源</span><textarea class="input" readonly>Profile / Bio
置顶原创帖
近期原创帖
Profile 直连安全官网</textarea></label><label class="field"><span>允许链</span><select class="input"><option>BSC · SOL · ETH · BASE · ROBINHOOD</option></select></label></div><div class="rule-list"><div class="rule"><span class="rule-icon">✓</span><span><strong>项目身份明确</strong><small>排除个人、媒体、推广号和第三方聚合账号。</small></span><em>必需</em></div><div class="rule"><span class="rule-icon">✓</span><span><strong>官方锚点一致</strong><small>GMGN X Handle 或 Website 与账号证据一致。</small></span><em>必需</em></div><div class="rule"><span class="rule-icon">✓</span><span><strong>唯一 chain + CA</strong><small>多候选无上下文时保持歧义，不交易。</small></span><em>必需</em></div><div class="rule"><span class="rule-icon">i</span><span><strong>Grok 辅助分类</strong><small>只解释身份和风险，不能产生或授权 CA。</small></span><em>辅助</em></div></div></div><div class="step-actions"><button class="btn ghost" data-next-step="1">上一步</button><button class="btn primary" data-next-step="3">下一步：交易配置</button></div></section>
              <section class="step-pane" data-step-pane="3"><div class="step-head"><div><h3>复用现有交易配置</h3><p>P21 不新增预算模型，不改变任何线上交易字段。</p></div><span class="status-badge active">P19 原样复用</span></div><div class="form-grid"><div><label class="field"><span>交易模板</span><select class="input"><option>多链小额标准 · 当前线上模板</option><option>BNB 单链小额 · 当前线上模板</option></select></label><div class="reuse-table"><div class="reuse-row"><span>允许链与单笔金额</span><strong>读取现有模板</strong><em>不改结构</em></div><div class="reuse-row"><span>预算与次数门禁</span><strong>当前线上逻辑</strong><em>不改语义</em></div><div class="reuse-row"><span>重复买入与持仓阻断</span><strong>当前线上逻辑</strong><em>不改语义</em></div><div class="reuse-row"><span>止盈、止损与对账</span><strong>P19 / P20 现有服务</strong><em>直接复用</em></div></div></div><div class="detail-note"><span class="note-icon">◇</span><span>Follow Resolver 只物化规范化 Signal / Target。预算、仓位、时效、Revision 和 Engine 仍由现有门禁重新检查。</span></div></div><div class="step-actions"><button class="btn ghost" data-next-step="2">上一步</button><button class="btn primary" data-next-step="4">下一步：确认</button></div></section>
              <section class="step-pane" data-step-pane="4"><div class="step-head"><div><h3>确认并保存 Revision 1</h3><p>保存只影响当前关注发现策略。</p></div><span class="status-badge pending">记录阶段</span></div><div class="detail-grid"><div><span>监控账号</span><strong>@cz_binance</strong></div><div><span>事件类型</span><strong>新关注</strong></div><div><span>CA 标准</span><strong>官方来源 + GMGN 唯一</strong></div><div><span>交易配置</span><strong>多链小额标准 · 现有</strong></div><div><span>固定 CA / 动态喊单</span><strong>不修改</strong></div><div><span>Engine</span><strong>保存后不自动启动</strong></div></div><div class="detail-note"><span class="note-icon">◇</span><span>当前运行阶段为记录。Watch 同步后会开始解析 Follow 事件，但真实 Swap 调用必须保持为 0。</span></div><div class="step-actions"><button class="btn ghost" data-next-step="3">上一步</button><button class="btn primary">保存关注发现策略</button></div></section>
            </section>
          </section>

          <section class="route-view" data-route-view="kol">
            ${option === 'a' ? '<nav class="page-tabs"><button class="active" data-kol-tab="accounts">KOL 账号</button><button data-kol-tab="research">账号研究 <span class="tab-badge">P21</span></button></nav>' : ''}
            <section data-kol-panel="accounts">
              <div class="kol-toolbar"><div class="search-box"><span>⌕</span><input placeholder="搜索 Handle 或名称"></div><div class="filters"><button class="active">全部</button><button>SOL</button><button>BSC</button><button>BASE</button><button>ETH</button><button>ROBINHOOD</button><button>跨链</button><button>未分类</button></div><button class="btn primary">＋ 添加 KOL</button></div>
              <div class="runtime-line"><span>20 个账号</span><span>权重仅用于重要性标记和排序</span></div>
              <div class="table-shell"><table class="data-table"><thead><tr><th>账号</th><th>生态标签</th><th>权重</th><th>状态</th><th>操作</th></tr></thead><tbody>${kolRows}</tbody></table></div>
            </section>
            ${option === 'a' ? `<section hidden data-kol-panel="research">${researchContent}</section>` : ''}
          </section>

          ${option === 'b' ? `<section class="route-view" data-route-view="research"><div class="view-head"><div><h3>账号研究</h3><p>账号清洗与历史回测工作区</p></div><button class="btn primary">＋ 新建研究批次</button></div>${researchContent}</section>` : ''}
        </main>
      </section>
    </div>`;

  function renderFollowDetail(index) {
    const row = followRows[index] || followRows[0];
    document.querySelector('#follow-detail').innerHTML = `
      <div class="detail-head"><div><span class="eyebrow">关注发现</span><h3>${row.handle}</h3><p>${row.revision} · Follow Watch ${row.watch}</p></div><span class="status-badge ${row.cls}">${row.status}</span></div>
      <div class="detail-grid"><div><span>触发事件</span><strong>新关注</strong></div><div><span>今日发现</span><strong>${row.found} 个账号</strong></div><div><span>唯一 CA</span><strong>${row.unique} 个</strong></div><div><span>运行阶段</span><strong>${row.status === '待配置' ? '尚未创建' : '记录'}</strong></div><div><span>项目身份</span><strong>确定性规则 + Grok 辅助</strong></div><div><span>CA 来源</span><strong>Bio · 置顶原创 · 官网</strong></div><div class="wide"><span>交易配置</span><strong>${row.status === '待配置' ? '尚未选择现有交易模板' : '多链小额标准 · 复用 P19 门禁'}</strong></div></div>
      <div class="detail-note"><span class="note-icon">◇</span><span>关注发现独立保存 Policy、Revision 和证据；固定 CA、动态喊单与现有交易配置保持不变。</span></div>
      <div class="detail-actions"><button type="button" class="btn primary" data-open-workspace>${row.status === '待配置' ? '＋ 配置关注发现策略' : '进入工作区 →'}</button></div>`;
    bindWorkspaceButtons();
  }

  function showRoute(route) {
    const actual = ['strategies', 'kol', 'research', 'workspace'].includes(route) ? route : 'strategies';
    document.querySelectorAll('.route-view').forEach((view) => view.classList.toggle('active', view.dataset.routeView === actual));
    document.querySelectorAll('.side-nav button').forEach((button) => button.classList.toggle('active', button.dataset.route === actual || (actual === 'workspace' && button.dataset.route === 'strategies')));
    const titles = { strategies: '策略中心', workspace: '新关注发现策略', kol: 'KOL', research: '账号研究' };
    document.querySelector('#page-title').textContent = titles[actual] || 'xbot';
    window.scrollTo({ top: 0, behavior: 'instant' });
  }

  function showStep(step) {
    document.querySelectorAll('.step-button').forEach((button) => {
      const value = Number(button.dataset.step);
      button.classList.toggle('active', value === step);
      button.classList.toggle('complete', value < step);
    });
    document.querySelectorAll('.step-pane').forEach((pane) => pane.classList.toggle('active', Number(pane.dataset.stepPane) === step));
  }

  function bindWorkspaceButtons() {
    document.querySelectorAll('[data-open-workspace]').forEach((button) => { button.onclick = () => showRoute('workspace'); });
  }

  renderFollowDetail(0);
  bindWorkspaceButtons();

  document.querySelectorAll('.side-nav button').forEach((button) => {
    button.addEventListener('click', () => {
      const route = button.dataset.route;
      if (route === 'strategies' || route === 'kol' || route === 'research') showRoute(route);
    });
  });

  document.querySelectorAll('[data-strategy-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-strategy-tab]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-strategy-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.strategyPanel === button.dataset.strategyTab));
  }));

  document.querySelectorAll('.follow-row').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.follow-row').forEach((item) => item.classList.toggle('selected', item === button));
    renderFollowDetail(Number(button.dataset.followIndex));
  }));

  document.querySelectorAll('[data-step]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.step))));
  document.querySelectorAll('[data-next-step]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.nextStep))));
  document.querySelector('[data-back-strategies]').addEventListener('click', () => showRoute('strategies'));

  document.querySelectorAll('[data-kol-tab]').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('[data-kol-tab]').forEach((item) => item.classList.toggle('active', item === button));
    document.querySelectorAll('[data-kol-panel]').forEach((panel) => { panel.hidden = panel.dataset.kolPanel !== button.dataset.kolTab; });
  }));
})();
