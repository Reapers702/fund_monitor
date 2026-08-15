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

- **我的基金**：添加/停用自选基金，卡片展示最新净值、当日涨跌、盘中估值（T1 跟踪指数 / T2 主题ETF / T3 重仓股加权）
- **基金详情**：净值走势 ECharts（归一化）+ 盘中估值采样叠加、重仓股近 10 日表现、AI 建议区
- **我的持仓**：买卖录入/删除，移动加权平均成本与盈亏汇总，费率设置
- **新闻流**：只读 `ai_fund.raw_news` 时间线，情绪色标 + LLM 主题标签 + 关键词筛选（60s 自动轮询）
- **AI 分析**：DeepSeek 生成建议（写 `ds_advice`），非 hold 触发桌面通知
- **多用户**：无密码按名字切换（顶栏显示当前用户，设置页管理/新建）；自选基金、持仓、费率、AI 建议（基于各自持仓）按用户隔离，基金基本信息/净值/估值/重仓股全局共享——多人收藏同一基金不重复抓取
- **托盘常驻**：关闭窗口最小化到系统托盘，后台采集/AI 分析持续运行；托盘菜单可显示主窗口或退出；设置页可开关开机自启
- **设置**：DeepSeek Key / 抓取频率 / 通道 / 开机自启写回 config.json
- **估值说明**：设置后独立页面，说明 T1/T2/T3 三种估值手段的原理与精度，并列出每只自选基金当前的估值方式 + 最近 20 日"估值 vs 实际净值"误差统计

## 架构说明

- **新闻不抓取**：财联社采集 + LLM 增强由另一套 24h 运行的程序完成，写入同一 PG 实例的 `ai_fund` 库 `raw_news` 表（含 `summary`/`sentiment`/`llm_tags` 字段），本应用仅通过 `config.aiFund` 只读连接消费。
- **双库并存**：本应用数据在 `fund_monitor` 库（11 张表，启动自动建表幂等）；新闻在 `ai_fund` 库。两者通常同实例同凭证、仅库名不同。
- **多用户数据面**：`app_user`（用户）+ `user_fund`（用户自选基金，含启用/停用）+ 用户级列（`fund_trade.user_id` / `ds_advice.user_id` / `fund_profile` 按 user_id）；基金数据（`fund_basic`/净值/估值/重仓股/行情）无用户维度全局共享。历史数据已迁移至默认用户 **guanxin**。当前用户持久化在 config.json `currentUserId`。
- **盘中估值三级降级**：T1 按基金名称关键词匹配跟踪指数（INDEX_RULES 17 条）→ 指数实时涨跌幅；T2 行业/主题型基金匹配同主题 ETF（ETF_RULES 20 条，fundgz 页面估值接口已下线，用主题 ETF 替代）；T3 主动型基金（无规则命中）用最近季报重仓股实时涨跌按权重加权估算（误差大仅参考，界面标注"基于季报估算"）。全部写 `fund_estimate`（source 区分），详见"估值说明"页。
- **行情多源降级**：个股/指数行情主 push2/push2his（东财），连接被拒或持续失败自动熔断 5 分钟后走腾讯 `qt.gtimg` / `web.ifzq` 降级源（`crawler/market.ts`）。
- **后台调度器**：主窗口启动后常驻（`scheduler.ts`），按交易时段自动执行——盘中（9:30-11:30 / 13:00-15:00）每 `estimateIntervalSeconds` 做一轮估值采样；盘后（15:30 起）按 `navCheckMinutes` 轮询当日净值直至出现或 23:00；收盘后（`analyzer.minutes`，默认 15:35）自动跑全部基金 AI 分析并推送非 hold 通知。任务均带防重跑标记，非交易日自动跳过（交易日历三级降级，见 `scheduler/tradingCalendar.ts`）。

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
| `electron . --quotes`（`npm run quotes`） | 持仓股行情（日K补种+当日实时价）+ 盘中估值采样（T1/T2/T3） | 与 GUI"刷新行情/估值"按钮同一核心，日常由后台调度器自动采样，无需手动跑 |
| `electron . --news`（`npm run news`） | 验证 ai_fund 新闻只读链路 | 基本不用 |
| `electron . --analyze <code>`（`npm run analyze -- <code>`） | 单只基金 AI 分析（按 guanxin 用户持仓） | 与 GUI 基金详情页"立即分析"等价，日常用 GUI |
| `electron . --analyze-all`（`npm run analyze-all`） | 所有用户 × 各自自选基金 AI 分析 | 与 GUI"全部 AI 分析"按钮等价，日常由后台调度器 15:35 自动执行 |
| `electron . --ai-test` | 验证 DeepSeek 链路（配置/连通/一次对话） | 调试用 |
| `electron . --calendar-test` | 交易日历自检（三级降级：腾讯日K → 百度节假日 → 静态表） | 调试用 |
| `electron . --page-test <url>` | 隐藏窗口抓页验证 | 调试用 |
| `electron . --screenshot <path> [--route <hash>] [--viewport-height <px>]` | 开发辅助：加载页面截图（加高视口截整页） | 开发用 |

> 注：Windows Git Bash 下 `--route "/"` 需加 `MSYS_NO_PATHCONV=1` 前缀，否则 `/` 会被转成路径。

## 数据库

`fund_monitor` 库 11 张表（启动自动 `CREATE TABLE IF NOT EXISTS` 幂等建表 + 单用户→多用户迁移）：

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
| `ds_advice` | DeepSeek 建议留痕（含 response_raw；按 user_id 隔离） |
| `fund_trade` | 持仓买卖流水（按 user_id 隔离） |
| `fund_profile` | 费率配置（按 user_id） |

新闻表 `raw_news` 位于 `ai_fund` 库（另一程序维护，本应用只读）。

## 配置说明

`config.json`（userData 目录）核心字段：

```jsonc
{
  "pg": { "host": "...", "port": 5432, "user": "...", "password": "...", "db": "fund_monitor", "sslmode": "prefer" },
  "aiFund": { /* 留空自动继承 pg 凭证，仅 db 默认 ai_fund */ },
  "deepseek": { "apiKey": "", "baseUrl": "https://api.deepseek.com", "model": "deepseek-chat" },
  "fetcher": { "navCheckMinutes": 10, "holdingsRefreshDays": 7, "estimateIntervalSeconds": 30 },
  "analyzer": { "minutes": "35" },
  "fetch": { "channel": "node" },  // node / browser / auto
  "funds": []                       // 初始为空，在"我的基金"页添加
}
```

开发回退：项目根 `.env` 首次运行迁移到 config.json（支持 `PG_URL` / `PG_*` / `DEEPSEEK_API_KEY` / `AI_FUND_URL` / `AI_FUND_*`）。

## 项目结构

```
src/
├── main/                  # 主进程
│   ├── index.ts           # 入口 + CLI 分支（--check/--fund/--quotes/--news/--analyze/--analyze-all/--ai-test/--calendar-test/--screenshot）
│   ├── ipc.ts             # IPC 处理器（funds/position/news/advice/config）
│   ├── config.ts          # 配置（config.json + .env 回退）
│   ├── crawler/           # 抓取（httpClient/pageFetcher/eastmoney/danjuan/market/estimate）
│   ├── news/reader.ts     # 只读 ai_fund.raw_news
│   ├── analyzer/analyze.ts# DeepSeek 建议（取数→prompt→解析→入库）
│   ├── position/          # 移动加权平均持仓计算
│   ├── storage/           # pg 连接/建表/各表读写 + queries 聚合查询层
│   └── notifier.ts        # Electron 桌面通知
├── preload/               # contextBridge（api.d.ts 共享类型）
└── renderer/src/          # Vue3 前端（views: Dashboard/FundDetail/Position/News/Settings/EstimateGuide）
```

## 开发命令

```bash
npm run dev          # 开发模式（HMR）
npm run typecheck    # TS 类型检查（node + web）
npm test             # vitest 单测（持仓算法 / LLM 解析 / 交易时段 / 交易日历 / 估值规则）
npm run build        # 类型检查 + 构建
npm run build:win    # NSIS 安装包
```

## 待实现（Roadmap）

当前 M1-M8 主体已完成并可用，以下为后续可选项（按优先级大致排序）：

- [x] **托盘 + 开机自启**：关窗最小化到系统托盘（后台采集继续），托盘菜单"显示主窗口/退出"；设置页开关 `app.setLoginItemSettings`（启动后最小化到托盘）
- [x] ~~**自动更新**：`electron-builder.yml` 的 publish url 仍是 `example.com` 占位，接入 electron-updater 后支持版本推送~~（暂不考虑，日后再说）
- [x] ~~**打包代码签名**：当前 NSIS 安装包未签名，Windows SmartScreen 会有未知发布者警告~~（暂不考虑，日后再说）
- [x] **日志保留策略**：日志按日滚动（`userData/logs/app-YYYY-MM-DD.log`），启动时自动清理 30 天前日志
- [x] **主动型基金盘中估值（T3）**：161005 等无跟踪标的的主动型基金，用最近季报前十大重仓股实时涨跌按权重加权估算（误差较大仅参考，页面标注"基于季报估算"；`fundgz` 已下线，未走页面估值方案）
- [x] **估值误差统计**：盘后净值确认时记录当日最后一次盘中估值与实际净值的差值（`fund_estimate_diff`），估值说明页展示最近 20 日各基金 T1/T2/T3 的平均绝对误差，量化 T3 可信度
- [ ] **可选数据源**：雪球个股行情（需会话 cookie，隐藏窗口种 cookie 方案）等

> 已完成：**法定节假日交易日历**（腾讯日K交易日 + 百度法定节假日 + 静态休市表三级降级，见 `scheduler/tradingCalendar.ts`）；**估值说明页**（T1/T2/T3 方法说明 + 各基金当前方式，见"估值说明"菜单）；**多用户（M9）**（自选/持仓/建议按用户隔离，基金数据全局共享不重复抓取，历史数据归 guanxin）。

## 免责声明

本工具仅供个人学习与数据跟踪使用，不构成任何投资建议。所有行情/净值数据来源于公开接口，接口形态可能变化；请遵守目标站点使用条款，保持低频个人使用。

## License

Private / internal use only.
