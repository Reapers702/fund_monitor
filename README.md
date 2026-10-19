# 基金监控与 AI 推荐系统（fund_monitor）

基于 **Electron + Vue3 + TypeScript + PostgreSQL + DeepSeek** 的基金监控桌面应用。

自动抓取自选基金（净值 / 盘中估值 / 重仓股 / 个股行情），读取另一套 24h 程序已采集的财联社新闻（`ai_fund` 库），由 DeepSeek 基于"净值走势 + 重仓股 + 相关新闻 + 持仓成本"给出 **加仓/减仓/持有** 建议并推送桌面通知。

> 详细设计见 [计划书.md](./计划书.md)。

## 技术栈

| 层 | 技术 |
|---|---|
| 桌面 | Electron（主进程 Node 直连抓取，无 CORS 限制） |
| 前端 | Vue3 + TypeScript + vue-router + naive-ui + ECharts |
| 构建 | electron-vite + electron-builder |
| 数据库 | PostgreSQL（本应用库 `fund_monitor`；新闻只读 `ai_fund`） |
| AI | DeepSeek（OpenAI 兼容接口） |

## 功能

- **我的基金**：添加/停用自选基金；顶部概览条（自选数 / 盘中估值均值 / 涨跌分布 / 数据时间），卡片以**盘中估值为主指标**（左侧色条 + 底色标方向，红涨绿跌）、净值为次指标，并标注估值来源、采样时间、AI 建议、重仓股季报期；支持按估值涨跌/名称排序、一键隐藏已停用；净值 T+1 公布的时段会明确标"净值待公布"，不再把"上一交易日的净值日期"误读成"刚刷新过"
- **基金详情**：净值走势 ECharts（归一化）+ 盘中估值采样叠加、重仓股近 10 日表现、AI 建议区
- **我的持仓**：买卖录入/删除，移动加权平均成本与盈亏汇总，费率设置；另有**资金计划**——填写"计划投入基金市场"总额后，按已录入交易自动算出已投入本金 / 当前市值 / **剩余闲钱**（= 计划投入 − 已投入本金，负数表示超支）/ 各基金占组合与占计划比例（`position/position.ts` `computeCapitalSummary`）
- **新闻流**：只读 `ai_fund.raw_news` 时间线，情绪色标 + LLM 主题标签 + 关键词筛选（60s 自动轮询）
- **AI 分析**：DeepSeek 生成建议（写 `ds_advice`），非 hold 触发桌面通知
- **AI 建议复盘**：把历史建议与后续净值对齐，算后 5/10/20 个交易日的实际涨跌与方向命中率（加仓后涨、减仓后跌才算命中，hold 无方向不计入命中率）；详情页同时给出加仓/减仓后平均收益与高置信度（≥70）分档命中率——用于检验建议到底准不准，而不只是"生成过建议"。样本不足 10 条只给"命中数/总数"不折算百分比（少数样本的百分比会随噪声剧烈跳动，容易让人对噪声下判断）
- **量化指标**：分析前先把净值算成区间/年化收益、年化波动率、夏普、最大回撤、日涨占比、20 日均线、相对沪深300超额等指标再喂给 DeepSeek（模型只解读，不自行重算）
- **组合视角**（持仓页）：跨基金合并重仓股暴露、提示隐性集中度（同一只股票被多只基金共同重仓）、重仓股两两重叠度、基金日收益相关性，识别"买了好几只其实是同一批股票"；同一份组合上下文也会进 AI 分析 prompt，让建议考虑组合层面的集中风险
- **建议仓位**：AI 建议附"该基金占组合的建议比例"（`ds_advice.suggested_pct`），详情页显示建议仓位与当前占比
- **资金约束入 prompt**：AI 分析会带上用户实盘资金——买入本金 / 持有份额 / 成本价 / 市值 / 浮动盈亏，以及该基金占已投入本金、占计划投入、占组合市值三个比例；并明确"加仓不得超出剩余闲钱、超支时禁止建议加仓"，避免出现"建议加仓但你没钱"的建议
- **桌面提醒**：净值异动 / 盘中估值异动 / 估值失真 / 止盈止损 / 重仓股负面新闻五类，阈值可在设置页配置（填 0 关闭该项），设置页可手动立即检查。盘中只检查估值类（净值/持仓在盘中仍是昨日数据，提前判断会误报），其余在盘后净值确认时检查；同一只基金同类提醒每天只推一次（`alert_log` 去重），避免盘中每 5 分钟采样重复轰炸
- **多用户**：无密码按名字切换（顶栏显示当前用户，设置页管理/新建）；自选基金、持仓、费率、AI 建议（基于各自持仓）按用户隔离，基金基本信息/净值/估值/重仓股全局共享——多人收藏同一基金不重复抓取
- **托盘常驻**：关闭窗口最小化到系统托盘，后台采集/AI 分析持续运行；托盘菜单可显示主窗口或退出；设置页可开关开机自启
- **抓取通道**：`config.fetch.channel` 可选择 **Node 直连（默认）/ 浏览器隐藏窗口 / 自动（Node 失败切浏览器）**，保存即生效。浏览器通道由真实 Chromium 发同源 fetch（带 Cookie、可执行站点 JS 挑战），因此能改善**指纹/签名类**反爬；但**不能**改善 IP 与请求频率维度的风控——那两项与用哪个 HTTP 栈无关，靠采集侧降频解决。
- **设置**：DeepSeek Key / 抓取频率 / 通道 / 开机自启写回 config.json
- **估值说明**：设置后独立页面，说明 T1/T2/T3 三种估值手段的原理与精度，并列出每只自选基金当前的估值方式 + 最近 20 日"估值 vs 实际净值"误差统计
- **抓取日志**（P1）：独立页面集中展示"抓了什么、抓了多少、谁在失败、是否被风控"——按业务标签（净值:东财lsjz / 持仓:东财jjcc / 行情:东财push2 …）与目标主机聚合的次数/成功率/平均耗时、最近失败原因、最近请求明细，以及主源熔断/退避状态与本次运行的应用日志；主进程 `console.*` 现已全部落盘到 `userData/logs`，打包后也能事后排障
- **长任务进度与防重复触发**：`tasks.ts` 在主进程登记"刷新行情/估值""全部 AI 分析"的进度（阶段 / i-n / 正在处理的标的 / 最近完成明细 / 完成摘要），首页按钮直接显示阶段与进度并在运行期间禁用，顶栏另有一枚全局指示器（切到任何页面都能看到后台在跑什么）；任务状态活在主进程，因此**切页面再回来不会再出现"又能点一次"**。防重复点击的权威判定也在主进程（同名任务单飞，重复触发抛 `TaskBusyError` 而非再抓一遍），并顺带避免手动分析与调度器自动分析撞车。完成后按 `finishedAt` 幂等提示一次，切页面回来则从"上次完成"面板看到结果与结束时间。

## 架构说明

- **新闻不抓取**：财联社采集 + LLM 增强由另一套 24h 运行的程序完成，写入同一 PG 实例的 `ai_fund` 库 `raw_news` 表（含 `summary`/`sentiment`/`llm_tags` 字段），本应用仅通过 `config.aiFund` 只读连接消费。
- **双库并存**：本应用数据在 `fund_monitor` 库（12 张表，启动自动建表幂等）；新闻在 `ai_fund` 库。两者通常同实例同凭证、仅库名不同。
- **多用户数据面**：`app_user`（用户）+ `user_fund`（用户自选基金，含启用/停用）+ 用户级列（`fund_trade.user_id` / `ds_advice.user_id` / `fund_profile` 按 user_id）；基金数据（`fund_basic`/净值/估值/重仓股/行情）无用户维度全局共享。历史数据已迁移至默认用户 **guanxin**。当前用户持久化在 config.json `currentUserId`。
- **盘中估值三级降级**：T1 按基金名称关键词匹配跟踪指数（INDEX_RULES 17 条）→ 指数实时涨跌幅；T2 行业/主题型基金匹配同主题 ETF（ETF_RULES 20 条，fundgz 页面估值接口已下线，用主题 ETF 替代）；T3 主动型基金（无规则命中）用最近季报重仓股实时涨跌按权重加权估算（误差大仅参考，界面标注"基于季报估算"）。全部写 `fund_estimate`（source 区分），详见"估值说明"页。
- **行情多源降级**：个股/指数行情主 push2/push2his（东财），连接被拒或持续失败自动熔断 5 分钟后走腾讯 `qt.gtimg` / `web.ifzq` 降级源（`crawler/market.ts`）。
- **抓取降频纪律**（P0，防 IP 风控）：① 行情**批量取价**——一次请求取多只（东财 `ulist.np` 主 / 腾讯 `qt.gtimg` 批量降级，单次 ≤50 只），盘中估值从"每基金 1 次 + T3 每持仓股 1 次"（约 50 次/轮）压到 1~2 次/轮；② 行情 30 秒 **TTL 缓存**（同轮多只基金共享同一指数/ETF 时只算一次，批量响应中缺席的标的记为负缓存，不再退化成逐只请求）；③ **全局限流器**——所有出站请求统一排队（并发 ≤3、相邻请求间隔 120ms + 抖动，计划书 §4.3-4）；④ 日 K 只在"官方日K（`stock_daily.source='kline'`）还没覆盖最近一个**已收盘**交易日"时补拉、例行净值轮询跳过基金详情抓取；⑤ 净值轮询真正按 `fetcher.navCheckMinutes` 节流（并先查库判断是否已是最新），不再是每 30 秒全量重跑。
- **日K 口径（P1，修"刷新总跳过/日K 被实时价污染"）**：`stock_daily` 每行标 `source`——`kline`=数据源官方日K（收盘后定型，权威）/`quote`=盘中实时价快照/NULL=升级前历史行。日K 补拉只认 `kline` 行，目标日取"最近已收盘交易日"（15:30 后才是今天），因此盘中写进来的快照不再让日K 被判定为"已最新"；补拉时只落已定型的日期（盘中那根部分K线不落库），并用官方日K**覆盖**`quote`/NULL 行（历史脏行自愈）；`quote` 快照只在交易日 09:15 后滚动且绝不覆盖官方行。实测过的两个具体症状：盘中刷新总显示"日K 跳过 120 只"（快照行满足了旧判断）、凌晨非交易时段同步把上一交易日K线写成"今天"的行。收盘后调度器会做一次日K 校正（`reconcileKlinesCore`），并清理周末日期的脏行（官方日K 永远没有周六/周日）。
- **抓取请求埋点**（P1）：每次尝试都写结构化记录（主机/业务标签/状态码/耗时/字节），按标签与主机聚合后由「抓取日志」页展示；失败详情同时落文件日志。主进程 `console.*` 被 `logger.initLogger()` 接管，与 `logXxx` 写同一份 `userData/logs/app-YYYY-MM-DD.log`（此前 console 日志在打包后完全丢失）。
- **抓取通道**（`crawler/channel.ts` 纯状态 + `crawler/pageFetcher.ts` 浏览器传输）：`config.fetch.channel` 由 `config.loadConfig()/saveConfig()` 注入，GUI/调度器/所有 CLI 分支自动跟随且保存即生效。浏览器通道在页面上下文内 `fetch().text()` 取**原始响应体**（不是 DOM 的 `outerHTML`——加载 JSON 接口时它会被渲染成 HTML 包装导致无法 `JSON.parse`），并对隐藏窗口做**串行队列**（共享窗口并发导航会互相打断）；同 origin 时复用已加载页面。通道选择只影响"请求由谁发出"，不改变请求数量。
- **持仓周期刷新**（`fetcher.holdingsRefreshDays`）：重仓股按"上次抓取时间"节流（`crawl_marker` 表记键 `holdings:<基金代码>`），而不是按报告期判断——报告期是季末日期、可能已过数月，且纯债基解析结果可能为 0 行（没有行可顺带更新时间戳），只看表里有无数据会导致每轮重抓。
- **后台调度器**：主窗口启动后常驻（`scheduler.ts`），按交易时段自动执行——盘中（9:30-11:30 / 13:00-15:00，仅交易日）每 `estimateIntervalSeconds` 做一轮估值采样；盘后（15:30 起，交易日与非交易日都跑）**真正按 `navCheckMinutes` 节流**轮询净值直至出现或 23:00（轮询前先查库判断是否已是最新；`navTodayDone` 随自然日复位，避免托盘常驻跨天后第二天不再轮询），非交易日目标为最近交易日（覆盖"周五净值周六凌晨公布"场景）；收盘后（`analyzer.minutes`，默认 15:35，仅交易日）自动跑全部基金 AI 分析并推送非 hold 通知。提醒检查分两处：盘中每轮估值采样后查估值类提醒，净值确认后查净值异动/估值失真/止盈止损/重仓股负面（`cfg.alerts.enabled` 控制，`alerts/run.ts`）。任务均带防重跑标记；估值采样/AI 分析跳过非交易日（交易日历三级降级，见 `scheduler/tradingCalendar.ts`）。
- **建议复盘口径**：入场日取建议交易日**之后**第一个交易日。收盘后 15:35 出建议时当日净值尚未公布，用下一交易日作为可执行价可避免前视偏差；后 h 日涨跌 = 入场日后第 h 个交易日净值 / 入场日净值 − 1。未满 h 个交易日记为空、不进统计（不把"还没走完"当"没命中"）。
- **提醒新鲜度门禁**（`alerts/rules.ts`）：提醒文案是"当前/当日"，只能建立在当期数据上——盘中估值必须是**今天**采样的（`est_time` 本地日期=今天），净值异动/估值失真/止盈止损要求净值日期等于当期数据日期（交易日=今天，非交易日=最近交易日，覆盖周五净值周六凌晨公布）。手动触发时库里数据可能是几天前的，不校验就会推"当前估值 −4%"这种误导提醒；更糟的是去重键含交易日，误报会占掉当天名额，真实数据到达后反而不再提醒。
- **量化/组合指标纯函数化**：指标（`analyzer/metrics.ts`）、复盘（`analyzer/review.ts`）、组合聚合（`portfolio/portfolio.ts`）、提醒规则（`alerts/rules.ts`）均为无副作用纯函数，单独单测；相对强弱取沪深300（`1.000300`）日 K，进程内缓存 30 分钟避免 analyze-all 重复请求。

## 环境要求

- Node.js 20+（本项目使用 24.x 验证）
- PostgreSQL（远程或本地均可）
- （可选）DeepSeek API Key——未配置时 AI 分析自动跳过

## 快速开始

```bash
npm install

# 1. 配置
#    复制 .env 模板（PG_* 为 fund_monitor 库连接，AI_FUND_* 可选覆盖新闻库）：
#    cp .env.example .env   # 若存在
#    或直接编辑首次运行生成的 config.json：
#    Windows: %APPDATA%\fund_monitor\config.json
#    macOS:   ~/Library/Application Support/fund_monitor/config.json

# 2. 校验数据库连通性 + 自动建表（需先有 fund_monitor 库，见 scripts/ensure-db.js）
npm run check

# 3. 添加自选基金（全量补种历史净值 + 持仓）
npm run fund -- 110020

# 4. 开发模式启动
npm run dev

# 5. 打包
npm run build:win
```

## 命令行工具（CLI 模式）

> 日常使用 **GUI 即可**——所有功能都有页面入口（添加基金 / 刷新行情 / AI 分析在"我的基金"页，单只分析在基金详情页）。CLI 主要用于**首次部署校验、批量补数据、脚本化定时任务和调试**；带 `npm run` 前缀的是等价快捷方式。

| 命令 | 用途 | 日常使用 |
|---|---|---|
| `electron . --check`（`npm run check`） | 校验配置 + PG 连通 + 自动建表（首次部署跑一次） | 基本不用 |
| `electron . --fund <code>`（`npm run fund -- <code>`） | 把某只基金的数据同步入库（详情+历史净值全量补种+季度持仓），**不加入自选** | 加自选请用 GUI"我的基金"输入代码；CLI 适合脚本批量补数据 |
| `electron . --quotes`（`npm run quotes`） | 持仓股行情（日K补种+当日实时价）+ 盘中估值采样（T1/T2/T3）+ 净值增量（补 T+1 公布的净值） | 与 GUI"刷新行情/估值"按钮同一核心（也顺带补净值），日常由后台调度器自动采样，无需手动跑 |
| `electron . --news`（`npm run news`） | 验证 ai_fund 新闻只读链路 | 基本不用 |
| `electron . --alerts [--scope intraday\|close]`（`npm run alerts`） | 手动跑一轮提醒检查（不传 `--scope` 时盘中+盘后两轮都跑），同一天同类已推过的不重复推 | 与设置页"立即检查提醒"等价，日常由后台调度器按点自动执行 |
| `electron . --analyze <code>`（`npm run analyze -- <code>`） | 单只基金 AI 分析（按 guanxin 用户持仓） | 与 GUI 基金详情页"立即分析"等价，日常用 GUI |
| `electron . --analyze-all`（`npm run analyze-all`） | 所有用户 × 各自自选基金 AI 分析 | 与 GUI"全部 AI 分析"按钮等价，日常由后台调度器 15:35 自动执行 |

## 数据库

`fund_monitor` 库 14 张表（启动自动 `CREATE TABLE IF NOT EXISTS` 幂等建表 + 单用户→多用户迁移）：

| 表 | 用途 |
|---|---|
| `app_user` | 用户（多用户 M9，默认 guanxin） |
| `user_fund` | 用户自选基金（user_id + fund_code + is_active） |
| `fund_basic` | 基金基础信息（名称/经理/托管/成立日，全局共享） |
| `fund_nav_daily` | 每日净值（UNIQUE fund_code+trade_date 幂等） |
| `fund_estimate` | 盘中估值采样（T1 跟踪指数 / T2 主题ETF / T3 重仓股加权，source 区分） |
| `fund_estimate_diff` | 估值误差统计（盘中估值 vs 实际净值） |
| `fund_holdings` | 季度重仓股（报告期+权重） |
| `stock_daily` | 个股日线/实时行情 |
| `ds_advice` | DeepSeek 建议留痕（含 `suggested_pct` 建议仓位、response_raw；按 user_id 隔离） |
| `fund_trade` | 持仓买卖流水（按 user_id 隔离） |
| `fund_profile` | 费率配置（按 user_id） |
| `alert_log` | 已推送提醒留痕（UNIQUE user_id+fund_code+alert_type+trade_date 做当日去重） |
| `index_valuation` | 指数估值分位快照（蛋卷，每日一版；UNIQUE index_code+trade_date+source） |
| `crawl_marker` | 通用抓取标记（marker + at）：按周期节流"低频但需定期刷新"的抓取，如 `holdings:<基金代码>` |

新闻表 `raw_news` 位于 `ai_fund` 库（另一程序维护，本应用只读）。

## 配置说明

`config.json`（userData 目录）核心字段：

```jsonc
{
  "pg": { "host": "...", "port": 5432, "user": "...", "password": "...", "db": "fund_monitor", "sslmode": "prefer" },
  "aiFund": { /* 留空自动继承 pg 凭证，仅 db 默认 ai_fund */ },
  "deepseek": { "apiKey": "", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
  "fetcher": { "navCheckMinutes": 10, "holdingsRefreshDays": 7, "estimateIntervalSeconds": 300 },
  "analyzer": { "minutes": "35" },
  "alerts": {                          // 桌面提醒（阈值 0 = 关闭该项，设置页可改）
    "enabled": true,
    "navMovePct": 3, "estimateMovePct": 3, "estimateOffPct": 2,
    "badNews": true, "takeProfitPct": 20, "stopLossPct": 10
  },
  "fetch": { "channel": "node" },  // node / browser / auto
  "funds": []                       // 初始为空，在"我的基金"页添加
}
```

开发回退：项目根 `.env` 首次运行迁移到 config.json（支持 `PG_URL` / `PG_*` / `DEEPSEEK_API_KEY` / `AI_FUND_URL` / `AI_FUND_*`）。

## 项目结构

```
src/
├── main/                  # 主进程
│   ├── index.ts           # 入口 + CLI 分支（--check/--fund/--quotes/--news/--alerts/--analyze/--analyze-all/--valuation/--*-backtest）
│   ├── ipc.ts             # IPC 处理器（funds/position/news/advice/alerts/config/crawl:stats/logs）
│   ├── config.ts          # 配置（config.json + .env 回退）
│   ├── logger.ts          # 文件日志 + 接管 console + 内存环形缓冲（不依赖 electron，抓取层可安全引用）
│   ├── crawler/           # 抓取（httpClient 限流/埋点 · requestLog 结构化统计 · pageFetcher/eastmoney/danjuan/market 批量取价/estimate/benchmark）
│   ├── news/reader.ts     # 只读 ai_fund.raw_news
│   ├── analyzer/analyze.ts# DeepSeek 建议（取数→prompt→解析→入库）
│   ├── analyzer/metrics.ts# 量化指标（回撤/波动/夏普/相对沪深300超额，纯函数）
│   ├── analyzer/review.ts # 建议复盘（后续 N 日涨跌/命中率，纯函数）
│   ├── portfolio/portfolio.ts # 组合视角（重仓股重叠/集中度/相关性，纯函数）
│   ├── alerts/            # 提醒（rules.ts 纯规则 / run.ts 取数+去重+通知）
│   ├── position/          # 移动加权平均持仓计算
│   ├── storage/           # pg 连接/建表/各表读写 + queries 聚合查询层
│   └── notifier.ts        # Electron 桌面通知
├── preload/               # contextBridge（api.d.ts 共享类型）
└── renderer/src/          # Vue3 前端（views: Dashboard/FundDetail/Position/News/Settings/EstimateGuide/Logs）
```

## 开发命令

```bash
npm run dev          # 开发模式（HMR）
npm run typecheck    # TS 类型检查（node + web）
npm test             # vitest 单测（持仓算法 / LLM 解析与 prompt 组装 / 交易时段 / 交易日历 / 估值规则 / 量化指标 / 建议复盘 / 组合聚合 / 提醒规则）
npm run build        # 类型检查 + 构建
npm run build:win    # NSIS 安装包
```

### 排查与实验工具（`scripts/`）

`scripts/` 下是独立 node 脚本，覆盖 **AI 预测数据体检 / prompt 改动 A/B 实验 / prompt 组装断言 / 建库 / 识图**。
用法、参数、成本与坑（如 LLM 中转站限流、为什么必须重复采样）见 **[scripts/README.md](scripts/README.md)**。

```bash
node scripts/diagnose-prompt-data.mjs              # AI 预测数据体检（新闻健康度/命中率/prompt 快照）
node scripts/diagnose-prompt-data.mjs --prompt 161725   # 渲染某只基金 AI 实际收到的完整 prompt
node scripts/ab-prompt-compare.mjs --repeat 3      # 同日 A/B：改动前后两版 prompt 对比建议
node scripts/verify-prompt-blocks.mjs              # 用真实 analyze.ts 跑 prompt 组装断言
```

## 待实现（Roadmap）

当前 M1-M8 主体已完成并可用，以下为后续可选项（按优先级大致排序）：

- [x] **托盘 + 开机自启**：关窗最小化到系统托盘（后台采集继续），托盘菜单"显示主窗口/退出"；设置页开关 `app.setLoginItemSettings`（启动后最小化到托盘）
- [x] ~~**自动更新**：`electron-builder.yml` 的 publish url 仍是 `example.com` 占位，接入 electron-updater 后支持版本推送~~（暂不考虑，日后再说）
- [x] ~~**打包代码签名**：当前 NSIS 安装包未签名，Windows SmartScreen 会有未知发布者警告~~（暂不考虑，日后再说）
- [x] **日志保留策略**：日志按日滚动（`userData/logs/app-YYYY-MM-DD.log`），启动时自动清理 30 天前日志
- [x] **主动型基金盘中估值（T3）**：161005 等无跟踪标的的主动型基金，用最近季报前十大重仓股实时涨跌按权重加权估算（误差较大仅参考，页面标注"基于季报估算"；`fundgz` 已下线，未走页面估值方案）
- [x] **估值误差统计**：盘后净值确认时记录当日最后一次盘中估值与实际净值的差值（`fund_estimate_diff`），估值说明页展示最近 20 日各基金 T1/T2/T3 的平均绝对误差，量化 T3 可信度
- [x] **AI 建议闭环复盘**：历史建议 vs 后续净值（后 5/10/20 个交易日），命中率 / 加仓减仓后平均收益 / 高置信度分档，详情页展示（`analyzer/review.ts`）；样本不足 10 条只给命中数不折算百分比
- [x] **量化指标入 prompt**：回撤/波动率/夏普/相对沪深300超额等先算好再喂 LLM，模型不自行重算（`analyzer/metrics.ts`）
- [x] **组合视角**：跨基金重仓股暴露与隐性集中度、两两重叠度、日收益相关性（`portfolio/portfolio.ts`）；同一份组合上下文进 AI prompt
- [x] **建议仓位**：prompt 要求模型给出该基金的建议组合占比（`ds_advice.suggested_pct`），详情页显示建议仓位与当前占比
- [x] **板块估值分位入 prompt**：按基金名匹配主题指数（`index_valuation`，60+ 指数的 PE/PB 历史分位与 ROE），作为"该板块贵还是便宜"的长周期参考轴；分位极低时减少减仓权重、极高时减少加仓权重，但禁止单独作为下单依据（`analyzer/valuation.ts`）
- [x] **新闻时效选材**：`raw_news` 按"全库最新 N 条"取会拿到三周前旧闻且无新鲜度标注，改为时效优先 + 可用性驱动降级（行业新闻质量不足时用最近 24h 大盘新闻兜底，并标注 `[行业]/[大盘]` 与「日期\|距今天数\|情绪」）（`news/reader.ts`）
- [x] **资金计划与闲钱**：持仓页可设置"计划投入基金市场"金额，按已录入交易自动算出已投入本金 / 当前市值 / **剩余闲钱**（= 计划投入 − 已投入本金，负值为超支）/ 各基金占组合与占计划比例；同一份资金约束进 AI prompt，加仓建议不得超出闲钱、超支时禁止加仓（`position/position.ts` `computeCapitalSummary`）
- [x] **提醒扩展**：五类提醒（净值异动/盘中估值异动/估值失真/止盈止损/重仓股负面）阈值可配 + `alert_log` 当日去重 + 数据新鲜度门禁（`alerts/`）
- [x] **抓取通道接线**：`config.fetch.channel`（node/browser/auto）原先只写不读（`channel.ts`/`pageFetcher.ts` 是死代码，设置页选项无任何效果）。现已接入：纯状态模块 `crawler/channel.ts` + `pageFetcher.browserGetText()`（原始响应体 + 串行队列 + origin 复用），由 `config.loadConfig()/saveConfig()` 注入，保存即生效。**注意**：页面通道只能改善指纹/签名类反爬，不能解决 IP 与频率维度的风控。
- [x] **持仓刷新周期接线**：`fetcher.holdingsRefreshDays` 原先只写不读（重仓股只有"首次必拉"）。现已按 `crawl_marker` 记录的上次抓取时间节流刷新。
- [ ] **全市场基金池/筛选**：当前只有"已知基金"的监控（自选列表新增靠手输代码），缺全市场基金池与筛选维度（主题/费率/规模/回撤/经理任期）——"推荐"目前落在"对已知基金给建议"，尚未覆盖"从全市场挑出候选"
- [ ] **可选数据源**：雪球个股行情（需会话 cookie，隐藏窗口种 cookie 方案）等

> 已完成：**法定节假日交易日历**（腾讯日K交易日 + 百度法定节假日 + 静态休市表三级降级，见 `scheduler/tradingCalendar.ts`）；**估值说明页**（T1/T2/T3 方法说明 + 各基金当前方式，见"估值说明"菜单）；**多用户（M9）**（自选/持仓/建议按用户隔离，基金数据全局共享不重复抓取，历史数据归 guanxin）；**抓取降频与可观测性**（批量取价 + TTL/负缓存 + 全局限流 + 净值轮询按配置节流 + 请求埋点 + 「抓取日志」页，见 `crawler/market.ts`、`crawler/requestLog.ts`、`views/LogsView.vue`）。

## 免责声明

本工具仅供个人学习与数据跟踪使用，不构成任何投资建议。所有行情/净值数据来源于公开接口，接口形态可能变化；请遵守目标站点使用条款，保持低频个人使用。

## License

Private / internal use only.
