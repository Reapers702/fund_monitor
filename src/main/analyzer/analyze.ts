// AI 分析（计划书 §7.3）：对单只基金生成 加仓/减仓/持有 建议
// 输入：近120日净值 + 量化指标（回撤/波动/夏普/相对沪深300超额）+ 今日涨跌 + 盘中估值（当日采样抽稀）
//      + 重仓股近10日表现 + 相关新闻（按重仓股/基金名过滤 ai_fund.raw_news）+ 用户持仓（份额/成本/盈亏）
// 输出：固定 JSON { action, confidence, reason }，写 ds_advice 保留 response_raw；action != hold 触发桌面通知
import type { Pool } from 'pg'
import { chatComplete, hasDeepseekKey, DeepseekError } from '../llm/deepseek'
import { navSeries, latestHoldings, fundBasic, estimateSeries, listFunds, latestHoldingsBatch, navSeriesBatch } from '../storage/queries'
import type { EstPoint, NavPoint, HoldingWithStock } from '../storage/queries'
import { newsByTags } from '../news/reader'
import { computePosition, listPositions } from '../position/position'
import type { PositionSummary } from '../position/position'
import { analyzePortfolio, formatPortfolioContext } from '../portfolio/portfolio'
import { createAiFundPool } from '../storage/db'
import { isIntraday, isAfterClose } from '../scheduler/time'
import { isTradingDay as isTradingDayCal } from '../scheduler/tradingCalendar'
import { computeFundMetrics, computeRelativeStrength, formatMetricsBlock } from './metrics'
import { BENCHMARK_NAME, loadBenchmarkNav } from '../crawler/benchmark'
import { ESTIMATE_SOURCE_NAMES } from '../crawler/estimate'
import { parseAdvice } from './parse'

export interface AnalyzeInput {
  code: string
  /** 可选：显式覆盖持仓成本（正常情况下由 fund_trade 自动计算） */
  cost?: number | null
}

export interface AnalyzeResult {
  action: 'add' | 'reduce' | 'hold'
  confidence: number
  reason: string
  /** 建议该基金占组合比例 %（模型未给出为 null） */
  suggestedPct: number | null
  raw: string
}

export interface TimeContext {
  date: string // YYYY-MM-DD
  weekday: string // 一~日
  isTradingDay: boolean
  phase: '盘前' | '盘中' | '盘后'
  latestNavDate: string | null // 最新净值所属交易日
  navIsToday: boolean // 最新净值是否就是当天（盘后已确认）
}

/** 本地日期 YYYY-MM-DD */
function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 构造时点上下文（纯函数，输入时间与净值信息，输出给 AI 的说明文字）。
 * 用于让 AI 区分"盘中估算值 vs 收盘确认净值"、"盘前预判 vs 盘后复盘"。
 * isTradingDay 由调用方异步计算（交易日历走网络/缓存），此处只做纯文本组装。
 */
export function buildTimeContext(now: Date, latestNavDate: string | null, isTradingDay: boolean): TimeContext {
  const weekday = ['日', '一', '二', '三', '四', '五', '六'][now.getDay()]
  const m = now.getHours() * 60 + now.getMinutes()
  const phase = isIntraday(m) ? '盘中' : isAfterClose(m) ? '盘后' : '盘前'

  return {
    date: dateStr(now),
    weekday,
    isTradingDay,
    phase,
    latestNavDate,
    navIsToday: latestNavDate === dateStr(now)
  }
}

/** 时点上下文 → AI 提示文字 */
export function formatTimeContext(t: TimeContext): string {
  const dayTag = t.isTradingDay ? '交易日' : '非交易日'
  const navTag = t.navIsToday
    ? '最新净值已是今日（收盘确认值）'
    : `最新净值截至 ${t.latestNavDate ?? '未知'}（${
        t.phase === '盘中' ? '今日盘中，最新净值尚未公布，以盘中估值参考' : '非最新交易日，当前数据为最近一个交易日的确认值'
      }）`
  return `分析时点：${t.date}（周${t.weekday}，${dayTag}，${t.phase}）。${navTag}。`
}

export const SYSTEM_PROMPT = `你是基金投资分析助手。基于给定的场外基金数据（日净值走势、量化指标、盘中估值、重仓股近期表现、相关新闻），给出独立的 加仓/减仓/持有 建议。
规则：
1. 只依据提供的数据判断，不编造未提供的信息。
2. 输出且仅输出一个 JSON 对象，不要包含任何其他文字、markdown 代码块或解释。
3. JSON 格式严格为：{"action":"add|reduce|hold","confidence":0~100,"reason":"中文理由，150字以内","suggestedPct":0~100 或 null}。
4. action 含义：add=当前值得加仓；reduce=当前值得减仓/止盈；hold=继续持有观望。
5. 盘中估值为预测值、存在误差，仅供盘中参考；判断优先以收盘确认净值为准。
6. 量化指标（年化收益/波动率/夏普/最大回撤/相对沪深300超额）已算好，直接用于判断风险收益特征与相对强弱，不要自行重算。
7. 若给出了「组合上下文」，必须纳入判断：该基金与组合内其他基金高度重叠或高相关时，加仓是放大同一风险敞口而非分散风险，此时应更谨慎并说明；已在组合层面暴露过高的个股同理。
8. suggestedPct = 建议该基金占整个基金组合的比例（%），是给用户的执行数量参考：加仓给出高于当前的比例、减仓给出低于当前的比例、持有可给出与当前持平的比例；无持仓信息或无法判断时填 null。`

/** 估值来源 → 中文说明（与 alerts/UI 共用一份，见 crawler/estimate.ts） */
const SOURCE_NAMES = ESTIMATE_SOURCE_NAMES

/**
 * 盘中估值块：把当日采样抽稀成给 AI 看的走势文本。
 * est.time 是 UTC ISO，需按本地时区判断日期/时刻（东八区，避免 toISOString 少一天）。
 * 盘中高频采样（默认每 5 分钟一条）会撑爆 prompt，故按 30 分钟窗口抽稀、最多留 12 条。
 * 无当日采样（盘前/非交易日）返回 null，调用方不拼该块。
 */
export function formatEstimateBlock(estimate: EstPoint[], today = dateStr(new Date())): string | null {
  const points = estimate.filter((p) => dateStr(new Date(p.time)) === today)
  if (points.length === 0) return null

  // 时间升序遍历，同一 30 分钟窗口只留最后一条
  const buckets = new Map<number, EstPoint>()
  for (const p of points) {
    const d = new Date(p.time)
    buckets.set(Math.floor((d.getHours() * 60 + d.getMinutes()) / 30), p)
  }
  const picked = [...buckets.values()].slice(-12)

  const hm = (p: EstPoint) => {
    const d = new Date(p.time)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const pct = (p: EstPoint) => (p.pct === null ? '--' : p.pct.toFixed(2) + '%')

  const last = points[points.length - 1]
  const src = SOURCE_NAMES[last.source] ?? last.source
  return `盘中估值（${src}，最新 ${hm(last)}）：${pct(last)}
当日估值走势（每 30 分钟抽稀，共 ${picked.length} 条）：
${picked.map((p) => `${hm(p)} ${pct(p)}`).join('\n')}`
}

/** 拼装 User Prompt（导出供单测：验证指标/持仓/新闻/时点各块确实进入提示词） */
/** buildUserPrompt 的输入（字段渐多，改用对象传参，避免长位置参数顺序错位） */
export interface PromptInput {
  fundName: string
  code: string
  nav: NavPoint[]
  holdings: { reportDate: string | null; rows: HoldingWithStock[] }
  news: { title: string | null; summary: string | null; sentiment: string | null; llmTags: string[] }[]
  position: PositionSummary | null
  timeCtx: string
  estimate: EstPoint[]
  metricsBlock: string | null
  portfolioBlock: string | null
}

/** 拼装 User Prompt（导出供单测：验证指标/组合/持仓/新闻/时点各块确实进入提示词） */
export function buildUserPrompt(input: PromptInput): string {
  const { fundName, code, nav, holdings, news, position, timeCtx, estimate, metricsBlock, portfolioBlock } = input
  const latestNav = nav[nav.length - 1]
  const firstNav = nav[0]
  const periodPct = firstNav && firstNav.nav > 0 ? (((latestNav.nav - firstNav.nav) / firstNav.nav) * 100).toFixed(2) : null

  const navLines = nav.slice(-30).map((p) => `${p.date} ${p.nav.toFixed(4)} (${p.changePct === null ? '--' : p.changePct.toFixed(2)}%)`).join('\n')

  const estBlock = formatEstimateBlock(estimate)

  const holdLines = holdings.rows
    .slice(0, 10)
    .map((h) => `${h.rank}. ${h.stockName ?? '?'} 权重${h.weight === null ? '--' : h.weight.toFixed(2)}% 近10日${h.lastPct === null ? '--' : h.lastPct.toFixed(2)}%`)
    .join('\n')

  const newsLines = news
    .slice(0, 8)
    .map((n) => `- [${n.sentiment ?? '未知情绪'}] ${n.title ?? ''} ${n.summary ? '| ' + n.summary.slice(0, 100) : ''}`)
    .join('\n')

  // 用户持仓（M7 录入 fund_trade 计算而来；无持仓则提示）
  const posLines =
    position && position.shares > 0
      ? `持有 ${position.shares} 份，移动加权平均成本 ${position.avgCost?.toFixed(4)}，
最新净值 ${position.latestNav?.toFixed(4) ?? '--'}，浮动盈亏 ${position.floatingPnl?.toFixed(2) ?? '--'}（收益率 ${position.pnlPct?.toFixed(2) ?? '--'}%）
请结合持仓盈亏给出建议：深套时是否止损/补仓、盈利时是否止盈。`
      : '（未录入持仓，仅基于净值与重仓股判断）'

  return `${timeCtx}
基金：${fundName}（${code}）
净值样本数：${nav.length} 条；区间涨跌：${periodPct ?? '--'}%（近${nav.length}个交易日，归一化起点）
最新净值：${latestNav.nav.toFixed(4)}（${latestNav.date}），当日涨跌 ${latestNav.changePct === null ? '--' : latestNav.changePct.toFixed(2)}%
${estBlock ? estBlock + '\n' : ''}${metricsBlock ? metricsBlock + '\n' : ''}${portfolioBlock ? portfolioBlock + '\n' : ''}${posLines}

近 30 日净值：
${navLines}

最新重仓股（报告期 ${holdings.reportDate ?? '无'}）：
${holdLines || '（无持仓数据）'}

相关新闻（最近 8 条，按重仓股/主题过滤）：
${newsLines || '（无相关新闻）'}

请给出 加仓/减仓/持有 建议。`
}

// parseAdvice 在 ./parse（纯函数独立模块，便于单测）

export interface AnalyzeContext {
  pool: Pool
  aiFundPool: Pool
}

/**
 * 组合上下文：该基金在用户组合中的位置（与哪些基金重仓重叠 / 相关性高、是否构成组合级集中度）。
 * 只有一只自选基金、或无重叠无相关性时返回 null（不拼空块）。失败不阻断分析。
 */
async function loadPortfolioContext(pool: Pool, userId: number, code: string): Promise<string | null> {
  try {
    const funds = await listFunds(pool, userId)
    const active = funds.filter((f) => f.isActive === 1)
    if (active.length < 2) return null
    const codes = active.map((f) => f.code)
    const [holds, navs, positions] = await Promise.all([
      latestHoldingsBatch(pool, codes),
      navSeriesBatch(pool, codes, 180),
      listPositions(pool, userId)
    ])
    const mv = new Map(positions.map((p) => [p.fundCode, p.marketValue]))
    const analysis = analyzePortfolio(
      active.map((f) => ({
        code: f.code,
        name: f.name,
        marketValue: mv.get(f.code) ?? null,
        holdings: holds.get(f.code) ?? [],
        nav: navs.get(f.code) ?? []
      }))
    )
    return formatPortfolioContext(analysis, code)
  } catch (e) {
    console.warn(`[analyze] ${code} 组合上下文计算失败（忽略继续）: ${(e as Error).message}`)
    return null
  }
}

/** 单基金 AI 分析主流程；返回 null 表示跳过（未配置 Key / 数据不足 / 解析失败）。
 *  userId：持仓成本按该用户计算（多用户 M9，建议基于各自持仓）；默认 1=guanxin */
export async function analyzeFund(ctx: AnalyzeContext, code: string, cost: number | null = null, userId = 1): Promise<AnalyzeResult | null> {
  const { pool, aiFundPool } = ctx
  if (!hasDeepseekKey()) {
    console.warn(`[analyze] ${code} 跳过：未配置 DeepSeek API Key`)
    return null
  }

  const basic = await fundBasic(pool, code)
  if (!basic) {
    console.warn(`[analyze] ${code} 跳过：fund_basic 无此基金，先 --fund ${code}`)
    return null
  }
  const nav = await navSeries(pool, code, 120)
  if (nav.length < 5) {
    console.warn(`[analyze] ${code} 跳过：净值数据不足（${nav.length} 条）`)
    return null
  }
  const holdings = await latestHoldings(pool, code)
  // 盘中估值：最近 24h 采样（盘前/非交易日通常为空，buildUserPrompt 内自动省略该块）
  const estimate = await estimateSeries(pool, code)

  // 用户持仓：显式 cost 参数优先；否则从该用户 fund_trade 移动加权计算（M7/M9）
  let position: PositionSummary | null = null
  if (cost !== null) {
    position = {
      fundCode: code,
      fundName: basic.name,
      shares: 0,
      avgCost: cost,
      totalCost: 0,
      realizedPnl: 0,
      latestNav: nav[nav.length - 1]?.nav ?? null,
      marketValue: null,
      floatingPnl: null,
      pnlPct: null
    }
  } else {
    const pos = await computePosition(pool, userId, code)
    position = pos.shares > 0 ? pos : null
    if (position) {
      console.log(`[analyze] ${code} 已接入持仓：${position.shares} 份，成本 ${position.avgCost?.toFixed(4)}，盈亏 ${position.floatingPnl?.toFixed(2)}`)
    }
  }

  // 相关新闻：用基金名关键词 + 前 8 个重仓股名过滤 ai_fund.raw_news
  const stockNames = holdings.rows.map((h) => h.stockName).filter((s): s is string => Boolean(s)).slice(0, 8)
  const fundKeywords = [basic.name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
  const news = await newsByTags(aiFundPool, [...fundKeywords, ...stockNames], 10)

  // 时点上下文：让 AI 区分盘中估算/收盘确认、盘前预判/盘后复盘（日历接口失败则按周末判断兜底）
  let timeCtx = ''
  try {
    const now = new Date()
    const latestNavDate = nav[nav.length - 1]?.date ?? null
    const trading = await isTradingDayCal(now)
    timeCtx = formatTimeContext(buildTimeContext(now, latestNavDate, trading))
  } catch (e) {
    console.warn(`[analyze] ${code} 时点上下文计算失败（忽略继续）: ${(e as Error).message}`)
  }

  // 量化指标：把净值算成回撤/波动/夏普/相对沪深300超额，喂给 AI（模型只解读，不自行重算）
  // 基准日K获取失败时降级为仅基金自身指标；极端情况下整体跳过指标块，不影响分析主流程
  let metricsBlock: string | null = null
  try {
    const fundMetrics = computeFundMetrics(nav)
    const benchNav = await loadBenchmarkNav()
    const rs = benchNav ? computeRelativeStrength(nav, benchNav, [20, 60], BENCHMARK_NAME) : null
    metricsBlock = formatMetricsBlock(fundMetrics, rs)
  } catch (e) {
    console.warn(`[analyze] ${code} 量化指标计算失败（忽略继续）: ${(e as Error).message}`)
  }

  // 组合上下文：单基金判断看不到"和已有基金是不是同一批股票"，这里补上
  const portfolioBlock = await loadPortfolioContext(pool, userId, code)

  const userPrompt = buildUserPrompt({
    fundName: basic.name,
    code,
    nav,
    holdings,
    news,
    position,
    timeCtx,
    estimate,
    metricsBlock,
    portfolioBlock
  })
  const raw = await chatComplete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.3, maxTokens: 500 }
  )
  const parsed = parseAdvice(raw)
  if (!parsed) {
    console.error(`[analyze] ${code} LLM 输出解析失败: ${raw.slice(0, 200)}`)
    return null
  }
  console.log(`[analyze] ${code} ${basic.name} → ${parsed.action}（置信 ${parsed.confidence}）: ${parsed.reason.slice(0, 60)}`)
  return parsed
}

/** 写 ds_advice（含原始响应留痕）；返回是否新插入。userId：建议归属用户（多用户 M9） */
export async function saveAdvice(pool: Pool, code: string, r: AnalyzeResult, tradeDate: string, userId = 1): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO ds_advice (fund_code, trade_date, action, reason, confidence, suggested_pct, response_raw, user_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())`,
    [code, tradeDate, r.action, r.reason, r.confidence, r.suggestedPct, JSON.stringify({ raw: r.raw }), userId]
  )
  return (res.rowCount ?? 0) > 0
}

/** 供 CLI/IPC 使用的统一入口：组装双连接池 + 执行分析 + 写库 + 返回结果 */
export async function runAnalyzeForFund(
  code: string,
  cost: number | null = null
): Promise<{ result: AnalyzeResult | null; inserted: boolean; tradeDate: string }> {
  const { loadConfig } = await import('../config')
  const { createPool } = await import('../storage/db')
  const cfg = loadConfig()
  const pool = createPool(cfg)
  const aiFundPool = createAiFundPool(cfg)
  try {
    const r = await analyzeFund({ pool, aiFundPool }, code, cost)
    if (!r) return { result: null, inserted: false, tradeDate: todayStr() }
    const tradeDate = todayStr()
    const inserted = await saveAdvice(pool, code, r, tradeDate)
    return { result: r, inserted, tradeDate }
  } finally {
    await pool.end().catch(() => {})
    await aiFundPool.end().catch(() => {})
  }
}

/** 本地日期 YYYY-MM-DD（交易日按国内时区） */
export function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export { DeepseekError }
