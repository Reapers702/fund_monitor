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

- **我的基金**：添加/停用自选基金，卡片展示最新净值、当日涨跌、盘中估值（T1 跟踪指数实时）
- **基金详情**：净值走势 ECharts（归一化）+ 盘中估值采样叠加、重仓股近 10 日表现、AI 建议区
- **我的持仓**：买卖录入/删除，移动加权平均成本与盈亏汇总，费率设置
- **新闻流**：只读 `ai_fund.raw_news` 时间线，情绪色标 + LLM 主题标签 + 关键词筛选（60s 自动轮询）
- **AI 分析**：DeepSeek 生成建议（写 `ds_advice`），非 hold 触发桌面通知
- **设置**：DeepSeek Key / 抓取频率 / 通道写回 config.json

## 架构说明

- **新闻不抓取**：财联社采集 + LLM 增强由另一套 24h 运行的程序完成，写入同一 PG 实例的 `ai_fund` 库 `raw_news` 表（含 `summary`/`sentiment`/`llm_tags` 字段），本应用仅通过 `config.aiFund` 只读连接消费。
- **双库并存**：本应用数据在 `fund_monitor` 库（8 张表，启动自动建表幂等）；新闻在 `ai_fund` 库。两者通常同实例同凭证、仅库名不同。
- **盘中估值 T1**：按基金名称关键词匹配跟踪指数（INDEX_RULES 17 条）→ push2 实时涨跌幅 → 写 `fund_estimate`。主动型基金落 T2（隐藏窗口页面估值，见 M8 打磨项）。

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

| 命令 | 说明 |
|---|---|
| `electron . --check` | 校验配置 + PG 连通 + 自动建表（`npm run check`） |
| `electron . --fund <code>` | 添加/同步单只基金（详情+净值+持仓） |
| `electron . --quotes` | 持仓股行情 + T1 盘中估值采样（`npm run quotes`） |
| `electron . --news` | 验证 ai_fund 新闻只读链路（`npm run news`） |
| `electron . --analyze <code>` | 单基金 AI 分析（`npm run analyze -- <code>`） |
| `electron . --analyze-all` | 全部自选基金 AI 分析（`npm run analyze-all`） |
| `electron . --page-test <url>` | 隐藏窗口抓页验证 |
| `electron . --screenshot <path> [--route <hash>]` | 开发辅助：加载页面截图 |

> 注：Windows Git Bash 下 `--route "/"` 需加 `MSYS_NO_PATHCONV=1` 前缀，否则 `/` 会被转成路径。

## 数据库

`fund_monitor` 库 8 张表（启动自动 `CREATE TABLE IF NOT EXISTS` 幂等建表）：

| 表 | 用途 |
|---|---|
| `fund_basic` | 基金基础信息（名称/经理/托管/成立日） |
| `fund_nav_daily` | 每日净值（UNIQUE fund_code+trade_date 幂等） |
| `fund_estimate` | 盘中估值采样（T1 跟踪指数实时） |
| `fund_holdings` | 季度重仓股（报告期+权重） |
| `stock_daily` | 个股日线/实时行情 |
| `ds_advice` | DeepSeek 建议留痕（含 response_raw） |
| `fund_trade` | 持仓买卖流水 |
| `fund_profile` | 费率配置 |

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
│   ├── index.ts           # 入口 + CLI 分支（--check/--fund/--quotes/--news/--analyze/--screenshot）
│   ├── ipc.ts             # IPC 处理器（funds/position/news/advice/config）
│   ├── config.ts          # 配置（config.json + .env 回退）
│   ├── crawler/           # 抓取（httpClient/pageFetcher/eastmoney/danjuan/market/estimate）
│   ├── news/reader.ts     # 只读 ai_fund.raw_news
│   ├── analyzer/analyze.ts# DeepSeek 建议（取数→prompt→解析→入库）
│   ├── position/          # 移动加权平均持仓计算
│   ├── storage/           # pg 连接/建表/各表读写 + queries 聚合查询层
│   └── notifier.ts        # Electron 桌面通知
├── preload/               # contextBridge（api.d.ts 共享类型）
└── renderer/src/          # Vue3 前端（views: Dashboard/FundDetail/Position/News/Settings）
```

## 开发命令

```bash
npm run dev          # 开发模式（HMR）
npm run typecheck    # TS 类型检查（node + web）
npm test             # vitest 单测（持仓算法 / LLM 解析 / 交易时段判断）
npm run build        # 类型检查 + 构建
npm run build:win    # NSIS 安装包
```

## 待实现（Roadmap）

当前 M1-M8 主体已完成并可用，以下为后续可选项（按优先级大致排序）：

- [ ] **托盘 + 开机自启**：监控类应用常驻后台，最小化到系统托盘；可配置开机自启（配合 scheduler 自动采集）
- [ ] **自动更新**：`electron-builder.yml` 的 publish url 仍是 `example.com` 占位，接入 electron-updater 后支持版本推送
- [ ] **打包代码签名**：当前 NSIS 安装包未签名，Windows SmartScreen 会有未知发布者警告
- [ ] **法定节假日交易日历**：scheduler 目前只判断周末，节假日（春节/国庆等休市日）会空跑；可接入交易日历数据源
- [ ] **日志保留策略**：日志按日滚动但无限累积，可加"仅保留最近 N 天"自动清理
- [ ] **主动型基金页面估值（T3）**：161005 等无跟踪标的的主动型基金目前无盘中估值；天天基金 `fundgz` 接口已下线，需找替代数据源
- [ ] **可选数据源**：雪球个股行情（需会话 cookie，隐藏窗口种 cookie 方案）等

## 免责声明

本工具仅供个人学习与数据跟踪使用，不构成任何投资建议。所有行情/净值数据来源于公开接口，接口形态可能变化；请遵守目标站点使用条款，保持低频个人使用。

## License

Private / internal use only.
