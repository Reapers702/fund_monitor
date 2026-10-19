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
  analyzer: { minutes: string; rulesInLLM: boolean }
  // 桌面提醒阈值（0 = 关闭该项；语义见 src/main/alerts/rules.ts）
  alerts: {
    enabled: boolean
    navMovePct: number
    estimateMovePct: number
    estimateOffPct: number
    badNews: boolean
    takeProfitPct: number
    stopLossPct: number
  }
  fetch: { channel: 'node' | 'browser' | 'auto' }
  funds: string[]
}

// 提醒检查结果（alerts:run 返回）
interface AlertRunResult {
  evaluated: number // 参与评估的（用户, 基金）对数
  triggered: number // 命中规则的条数（去重前）
  notified: number // 实际推送条数（去重后）
  items: { userId: number; fundCode: string; type: string; title: string }[]
}

// ---------- 基金 ----------

interface FundCard {
  code: string
  name: string
  isActive: number
  latestNav: string | null
  latestNavDate: string | null
  navChangePct: number | null
  navFetchedAt: string | null // 该条净值入库（抓取）时间，ISO；不是"刚刚刷新"的时间
  navPending: boolean // 今天（最近交易日）的净值还没公布 → 卡片提示"待 T+1 公布"
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
  suggestedPct: number | null // 建议该基金占组合比例 %（模型未给出为 null）
  createdAt: string
}

// ---------- 量化指标（analyzer/metrics 计算，随 fund:detail 返回） ----------

interface FundMetrics {
  sampleDays: number
  periodReturn: number | null // 区间累计涨跌 %
  annualizedReturn: number | null // 年化收益 %
  annualizedVol: number | null // 年化波动率 %
  sharpe: number | null // 夏普比率（无风险利率 2%）
  maxDrawdown: number | null // 最大回撤 %（负值）
  currentDrawdown: number | null // 当前距区间最高点回撤 %
  winRate: number | null // 日度上涨占比 %
  ret20: number | null
  ret60: number | null
  ma20: number | null
  aboveMa20: boolean | null
}

interface ExcessWindow {
  window: number
  fundRet: number | null
  benchRet: number | null
  excess: number | null
}

interface RelativeStrength {
  benchmark: string
  commonDays: number
  windows: ExcessWindow[]
}

interface FundDetail {
  basic: FundBasicRow | null
  nav: NavPoint[]
  estimate: EstPoint[]
  holdings: { reportDate: string | null; rows: HoldingWithStock[] }
  advice: AdviceRow[]
  adviceReview: AdviceReview
  metrics: FundMetrics
  relativeStrength: RelativeStrength | null // 基准日K取不到时为 null（只展示基金自身指标）
  currentWeightPct: number | null // 该基金当前占组合比例 %（无持仓为 null，用于对比建议仓位）
  valuation: FundValuation | null // 板块指数估值分位（长周期参考轴，无匹配/无快照为 null）
  ruleScore: RuleScore | null // 规则引擎参考分（四轴量化快照；无数据/计算失败为 null）
}

// ---------- 规则引擎参考分（scorer/engine.ts 确定性打分，展示用，不驱动建议） ----------

interface RuleScore {
  breakdown: {
    momentum: number // [-3,3] 动量轴
    shape: number // [-3,3] 形态轴
    intraday: number // [-3,3] 盘中轴
    news: number // [-3,3] 新闻轴
    totalRaw: number
    total: number // [-3,3] 反趋势修正后总分
    action: 'add' | 'reduce' | 'hold'
    confidence: number // 0~100
  }
  asof: string | null // 所用净值截止日
  newsCount: number // 参与打分的新闻条数
}

// ---------- 板块估值分位（index_valuation，长周期参考，非短周期方向） ----------

interface FundValuation {
  indexCode: string
  indexName: string
  pe: number | null
  pePercentile: number | null // 0~1，越低越便宜
  pb: number | null
  pbPercentile: number | null
  evaType: 'low' | 'mid' | 'high' | null // 低估/适中/高估
  tradeDate: string // 快照截至日期
}

// ---------- AI 建议复盘（analyzer/review 计算，随 fund:detail 返回） ----------
// 入场日 = 建议交易日之后第一个交易日；后续 h 日涨跌 = 入场日后第 h 个交易日 / 入场日 - 1。

interface AdviceReviewItem {
  id: number
  tradeDate: string
  action: string
  confidence: number | null
  entryDate: string | null
  entryNav: number | null
  returns: (number | null)[] // 与 horizons 对齐的后续涨跌 %
  hits: (boolean | null)[] // 与 horizons 对齐；hold 恒 null（无方向）
}

interface AdviceReviewStat {
  horizon: number
  evaluated: number // 已满期条数（含 hold，用于判断"有无可复盘数据"）
  matured: number // 已满期的 add/reduce 条数（命中率分母）
  hits: number
  hitRate: number | null // 命中率 %
  addTotal: number
  addHit: number
  reduceTotal: number
  reduceHit: number
  avgRetAdd: number | null
  avgRetReduce: number | null
  avgRetHold: number | null
  highConfTotal: number // 已满期且置信度 ≥70 的 add/reduce 条数
  highConfHit: number
  lowConfTotal: number
  lowConfHit: number
}

interface AdviceReview {
  horizons: number[]
  minSampleForRate: number // 命中率最小样本数（低于此值不给百分比结论）
  items: AdviceReviewItem[]
  stats: AdviceReviewStat[]
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
    suggestedPct: number | null
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
    klineAdded: number // 新补入库的日K 行数
    klineFixed: number // 用官方日K 校正（覆盖实时价快照等非官方行）的行数
    klineSkipped: number // 官方日K 已覆盖最近一个已收盘交易日，跳过补拉的股票数
    klineThrottled: number // 6 小时内刚补过、被节流跳过的股票数
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
  /** 计划投入基金市场的总金额（元）；0 = 未设置 */
  marketBudget: number
}

/** 单只基金在用户资金计划中的位置（position:capital 返回） */
interface CapitalFundPosition {
  fundCode: string
  fundName: string | null
  shares: number
  avgCost: number | null
  /** 买入本金 = 当前持有份额的成本（含费用） */
  investedCost: number
  marketValue: number | null
  floatingPnl: number | null
  pnlPct: number | null
  /** 占组合市值 % */
  weightPct: number | null
  /** 占已投入本金 % */
  costWeightPct: number | null
  /** 占计划投入总额 %（未设预算时为 null） */
  budgetPct: number | null
}

/**
 * 用户资金全景（position:capital 返回）。
 * 闲钱口径 = 计划投入 − 已投入本金（现金流口径）；负数表示已超支。
 */
interface CapitalSummary {
  marketBudget: number
  investedCost: number
  marketValue: number
  floatingPnl: number | null
  usedPct: number | null
  spareCash: number | null
  sparePct: number | null
  totalAsset: number | null
  funds: CapitalFundPosition[]
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

// ---------- 组合视角（portfolio:analysis 返回，纯函数见 main/portfolio/portfolio.ts） ----------

interface PortfolioStockExposure {
  key: string
  stockCode: string | null
  stockName: string | null
  exposure: number // 组合层面暴露 %（Σ 基金权重 × 基金内权重）
  fundCount: number
  funds: { code: string; name: string; weight: number; contribution: number }[]
  high: boolean // 是否达到集中度提示阈值
}

interface PortfolioOverlapPair {
  fundA: { code: string; name: string }
  fundB: { code: string; name: string }
  commonCount: number
  overlapPct: number // 重叠度 %：共同持股 min 权重和 / 较小基金权重合计
  commonStocks: {
    stockCode: string | null
    stockName: string | null
    weightA: number
    weightB: number
  }[]
}

interface PortfolioFundCorrelation {
  fundA: { code: string; name: string }
  fundB: { code: string; name: string }
  commonDays: number
  corr: number
}

interface PortfolioAnalysis {
  fundCount: number
  weightBasis: 'position' | 'equal' // 组合权重口径：按持仓市值 / 等权
  funds: { code: string; name: string; weight: number; marketValue: number | null }[]
  totalExposure: number // 已知重仓股合计暴露 %（前十大口径，< 100 正常）
  stockCount: number
  concentration: { top1: number; top3: number; top5: number; hhi: number }
  topStocks: PortfolioStockExposure[]
  overlaps: PortfolioOverlapPair[]
  correlations: PortfolioFundCorrelation[]
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

// ---------- 抓取日志（P1：crawl:stats / logs:recent 返回） ----------

/** 单次抓取请求记录（主进程 crawler/requestLog.ts） */
interface CrawlRequestRecord {
  ts: number // 开始时刻（ms）
  host: string
  path: string
  tag: string // 业务标签（中文），如「净值:东财lsjz」
  status: number | null // 连接级失败为 null
  ms: number
  bytes: number
  attempt: number // 第几次尝试，1 = 首次
  ok: boolean
  error: string | null
}

/** 单一维度（业务标签 / 主机）的累计统计 */
interface CrawlDimensionStat {
  key: string
  total: number
  ok: number
  fail: number
  avgMs: number
  lastTs: number
  lastError: string | null
}

/** 抓取统计（本次运行累计；重启清零，避免把历史累计误当本次） */
interface CrawlStats {
  since: number
  total: number
  ok: number
  fail: number
  byTag: CrawlDimensionStat[]
  byHost: CrawlDimensionStat[]
  recent: CrawlRequestRecord[]
  failures: CrawlRequestRecord[]
  limiter: { active: number; queued: number; maxConcurrent: number; minGapMs: number }
  channel: 'node' | 'browser' | 'auto' // 当前抓取通道（config.fetch.channel，实时生效）
  push2: { blocked: boolean; until: number | null; source: string } // 主行情源是否熔断（被风控）
  benchmark: { cached: boolean; cachedAt: number | null; backoffUntil: number | null }
  calendar: { tencentBackoffUntil: number | null; cachedDays: number }
}

/** 应用日志行（logger.ts 内存环形缓冲；与日志文件同源） */
interface LogEntry {
  ts: number
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'
  msg: string
}

type TaskKind = 'quotes' | 'analyzeAll'
type TaskState = 'idle' | 'running' | 'done' | 'error'

/** 长任务进度（主进程 tasks.ts 登记；渲染进程轮询展示，切页面不丢） */
interface TaskProgress {
  kind: TaskKind
  label: string
  state: TaskState
  startedAt: number
  finishedAt: number | null
  phase: string | null // 当前阶段：日K补拉 / 行情批量预热 / 估值采样 / 净值增量 / AI 分析
  total: number // 当前阶段条目总数
  done: number // 当前阶段已完成数
  current: string | null // 正在处理的标的
  recent: string[] // 最近完成的明细（最新在前）
  summary: string | null // 完成摘要（切页面回来也能看到刷完了什么）
  error: string | null
}

interface LogsPayload {
  entries: LogEntry[]
  dir: string | null // 日志目录（未初始化时 null）
  file: string | null // 今日日志文件
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
  positionProfile: (patch?: {
    buyFeePct?: number
    sellFeePct?: number
    marketBudget?: number
  }) => Promise<FundProfile>
  positionCapital: () => Promise<CapitalSummary>
  portfolioAnalysis: () => Promise<PortfolioAnalysis>
  newsRecent: (limit?: number) => Promise<NewsRow[]>
  configGet: () => Promise<AppConfig>
  configSave: (patch: Record<string, unknown>) => Promise<AppConfig>
  schedulerStatus: () => Promise<SchedulerStatus>
  alertsRun: () => Promise<AlertRunResult>
  crawlStats: () => Promise<CrawlStats>
  taskStatus: () => Promise<TaskProgress[]>
  logsRecent: (limit?: number) => Promise<LogsPayload>
  logsOpenDir: () => Promise<string>
}
