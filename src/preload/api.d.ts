// 主进程 src/main/ipc.ts 与渲染进程共用的业务类型。
// 全局声明，node（src/preload/**/*）与 web（src/renderer/**）两个 tsconfig 均包含本文件。
// 注意：不要命名为 index.d.ts —— 与 index.ts 同名会被 TS 当作其编译产物而跳过。

interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
}

// ---------- 配置 ----------

interface PgConfig {
  user: string
  password: string
  host: string
  port: number
  db: string
  sslmode: string
}

interface AppConfig {
  pg: PgConfig
  aiFund: PgConfig
  deepseek: { apiKey: string; baseUrl: string; model: string }
  fetcher: { navCheckMinutes: number; holdingsRefreshDays: number; estimateIntervalSeconds: number }
  analyzer: { minutes: string }
  fetch: { channel: 'node' | 'browser' | 'auto' }
  funds: string[]
}

// ---------- 基金 ----------

interface FundCard {
  code: string
  name: string
  isActive: number
  latestNav: string | null
  latestNavDate: string | null
  navChangePct: number | null
  navFetchedAt: string | null
  estPct: number | null
  estTime: string | null
  estSource: string | null
  holdingsDate: string | null
  adviceAction: string | null
  adviceConfidence: number | null
  adviceDate: string | null
}

interface FundSyncResult {
  name: string | null
  navInserted: number
  holdingsInserted: number
  holdingsPeriods: number
  latestNav: string | null
}

interface NavPoint {
  date: string
  nav: number
  changePct: number | null
}

interface EstPoint {
  time: string
  pct: number | null
  source: string
}

interface HoldingWithStock {
  rank: number
  stockCode: string | null
  stockName: string | null
  weight: number | null
  lastClose: number | null
  lastPct: number | null
  klineCount: number
}

interface FundBasicRow {
  code: string
  name: string
  fullName: string | null
  manager: string | null
  keeper: string | null
  foundDate: string | null
  navCount: number
}

interface AdviceRow {
  id: number
  tradeDate: string
  action: string
  reason: string | null
  confidence: number | null
  createdAt: string
}

interface FundDetail {
  basic: FundBasicRow | null
  nav: NavPoint[]
  estimate: EstPoint[]
  holdings: { reportDate: string | null; rows: HoldingWithStock[] }
  advice: AdviceRow[]
}

// AI 分析运行结果（advice:analyze 返回）
interface AdviceRunResult {
  ok: boolean
  skipped: boolean
  reason: string | null
  advice: {
    action: 'add' | 'reduce' | 'hold'
    confidence: number
    reason: string
    tradeDate: string
    inserted: boolean
  } | null
}

// 行情+估值采集结果（quotes:run 返回）
interface QuotesRunResult {
  ok: boolean
  error: string | null
  result: {
    fundCount: number
    stockCount: number
    klineAdded: number
    estimates: { code: string; name: string; source: string; pct: number | null }[]
    errors: { code: string; message: string }[]
  } | null
}

// 全部基金 AI 分析结果（advice:analyzeAll 返回）
interface AnalyzeAllRunResult {
  ok: boolean
  error: string | null
  result: {
    total: number
    done: number
    notified: number
    items: {
      code: string
      name: string
      done: boolean
      notified: boolean
      action?: string
      confidence?: number
      reason?: string
    }[]
  } | null
}

// ai_fund.raw_news 只读新闻行（summary/sentiment/llm_tags 由采集程序完成 LLM 增强）
interface NewsRow {
  id: string
  title: string | null
  content: string | null
  pubTime: Date | null
  source: string | null
  tags: string[]
  summary: string | null
  sentiment: string | null
  llmTags: string[]
}

// ---------- 持仓（M7） ----------

interface PositionSummary {
  fundCode: string
  fundName: string | null
  shares: number
  avgCost: number | null
  totalCost: number
  realizedPnl: number
  latestNav: number | null
  marketValue: number | null
  floatingPnl: number | null
  pnlPct: number | null
}

interface TradeRow {
  id: number
  fundCode: string
  tradeType: 'buy' | 'sell'
  shares: number
  price: number
  fee: number
  tradeDate: string
  note: string | null
}

interface TradeInput {
  fundCode: string
  tradeType: 'buy' | 'sell'
  shares: number
  price: number
  fee?: number
  tradeDate: string
  note?: string | null
}

interface FundProfile {
  buyFeePct: number
  sellFeePct: number
}

// 后台调度器状态（scheduler:status 返回）
interface SchedulerStatus {
  running: boolean
  lastEstimateAt: number
  navTodayDone: boolean
  adviceTodayDone: boolean
  lastLog: string
}

// ---------- 估值说明页（estimate:guide 返回） ----------

// 基金名称命中估值规则的结果（tracking_index / theme_etf；未命中则为 null → T3 兜底或无估值）
interface EstimateGuideFund {
  code: string
  name: string
  isActive: number
  latestSource: string | null // 最新一次采样的 source：tracking_index / theme_etf / holdings_weighted
  latestPct: number | null
  latestTime: string | null
  holdingsDate: string | null // 最近季报报告期（T3 可用性）
  match: { source: 'tracking_index' | 'theme_etf'; name: string; secid: string } | null
}

// 估值误差统计（estimate:diff 返回）：盘中估值 vs 收盘实际净值的差异
interface EstimateDiffStat {
  fundCode: string
  fundName: string
  source: string // tracking_index / theme_etf / holdings_weighted
  samples: number // 参与统计的交易日数
  avgAbsDiff: number | null // 平均绝对误差（百分点）
  avgDiff: number | null // 平均误差（正 = 估值偏高）
  latestTradeDate: string | null
  latestDiff: number | null
  latestEst: number | null
  latestNav: number | null
}

// ---------- 多用户（M9） ----------

interface AppUserRow {
  id: number
  name: string
  createdAt: string
}

interface CurrentUser {
  id: number
  name: string
}

// 渲染进程可用的业务 API（与 src/main/ipc.ts 的 handler 一一对应）
interface FundApi {
  ping: () => Promise<string>
  getAppInfo: () => Promise<AppInfo>
  getAutoLaunch: () => Promise<boolean>
  setAutoLaunch: (enabled: boolean) => Promise<boolean>
  userGetCurrent: () => Promise<CurrentUser>
  userList: () => Promise<AppUserRow[]>
  userCreate: (name: string) => Promise<CurrentUser>
  userSwitch: (id: number) => Promise<void>
  fundsList: () => Promise<FundCard[]>
  fundsAdd: (code: string) => Promise<FundSyncResult>
  fundsToggle: (code: string, active: boolean) => Promise<void>
  estimateGuide: () => Promise<EstimateGuideFund[]>
  estimateDiff: (days?: number) => Promise<EstimateDiffStat[]>
  fundDetail: (code: string, days?: number) => Promise<FundDetail>
  adviceAnalyze: (code: string) => Promise<AdviceRunResult>
  quotesRun: () => Promise<QuotesRunResult>
  adviceAnalyzeAll: () => Promise<AnalyzeAllRunResult>
  positionList: () => Promise<PositionSummary[]>
  positionDetail: (code: string) => Promise<{ summary: PositionSummary; trades: TradeRow[] }>
  positionAddTrade: (t: TradeInput) => Promise<{ id: number; summary: PositionSummary }>
  positionDeleteTrade: (id: number) => Promise<boolean>
  positionProfile: (patch?: { buyFeePct?: number; sellFeePct?: number }) => Promise<FundProfile>
  newsRecent: (limit?: number) => Promise<NewsRow[]>
  configGet: () => Promise<AppConfig>
  configSave: (patch: Record<string, unknown>) => Promise<AppConfig>
  schedulerStatus: () => Promise<SchedulerStatus>
}
