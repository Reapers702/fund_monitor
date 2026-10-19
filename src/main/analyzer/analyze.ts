// AI 分析（计划书 §7.3）：对单只基金生成 加仓/减仓/持有 建议
// 输入：近120日净值 + 量化指标（回撤/波动/夏普/相对沪深300超额）+ 板块估值分位 + 今日涨跌
//      + 盘中估值（当日采样抽稀）+ 重仓股近10日表现 + 相关新闻（时效优先选材，见 news/reader.ts）
//      + 用户持仓（份额/成本/盈亏）+ 组合上下文 + 规则引擎参考分
// 输出：固定 JSON { action, confidence, reason }，写 ds_advice 保留 response_raw；action != hold 触发桌面通知
// 体检工具：node scripts/diagnose-prompt-data.mjs（渲染真实 prompt 快照，检查各块是否按预期进入）
import type { Pool } from 'pg'
import { chatComplete, hasDeepseekKey, DeepseekError } from '../llm/deepseek'
import { navSeries, latestHoldings, fundBasic, estimateSeries, listFunds, latestHoldingsBatch, navSeriesBatch } from '../storage/queries'
import type { EstPoint, NavPoint, HoldingWithStock } from '../storage/queries'
import { recentNewsForFunds } from '../news/reader'
import { computePosition, listPositions } from '../position/position'
import type { PositionSummary } from '../position/position'
import { analyzePortfolio, formatPortfolioContext } from '../portfolio/portfolio'
import { createAiFundPool } from '../storage/db'
import { isIntraday, isAfterClose } from '../scheduler/time'
import { isTradingDay as isTradingDayCal } from '../scheduler/tradingCalendar'
import { computeFundMetrics, computeRelativeStrength, formatMetricsBlock } from './metrics'
import { loadIndexValuation, formatValuationBlock } from './valuation'
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

/** 新闻发布时间的时效标签：让模型一眼看出这条新闻"值多少钱"（今天/3天前/超一月） */
function newsAgeTag(pubTime: Date): string {
  const days = Math.max(0, Math.floor((Date.now() - pubTime.getTime()) / 86400000))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days <= 30) return `${days}天前`
  return '超一月'
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
4. action 含义：add=当前值得加仓；reduce=当前值得减仓/止盈；hold=操作条件不满足时持有观望。
5. 禁止默认观望，但也禁止证据不足就行动。每个 add/reduce 必须是"多重信号交叉验证成立"后的决定；多空相抵、证据不足时用 hold，并在 reason 里说明是什么信号相反。
6. 加仓(add)——必须**同时**满足以下三条才可 add，缺一不得加仓（尤其禁止仅因"跌得够多、该反弹了"就追高）：
   a) 动量转正：近20日收益为正，且相对沪深300近20日/60日超额为正、未衰减；
   b) 止跌企稳：净值最近几个交易日止跌或站上短期均线、回撤较前期高点收敛，而非仍在加速下行；
   c) 催化剂：重仓股走强、盈利/资金/新闻等偏暖，能支撑反弹延续。
   只满足一条、或虽是深跌企稳但动量与超额仍为负，一律 hold，不要抄底。
7. 减仓(reduce)——必须是"趋势性恶化"而非"单日情绪性回调"，否则不减（尤其禁止在短期底部砍仓）：
   a) 高位减仓：累计涨幅已较大（近20/60日仍明显为正）时出现高位滞涨、放量滞涨、顶背离或利空新闻；
   或 b) 破位减仓：跌破关键支撑（重要均线/前低）且其后多个交易日仍无承接、回撤持续加深，确诊为趋势破位而非单日插针；
   且 c) 负面催化：重仓股利空、资金持续净流出予以确认。
   仅单日破位、或短线回调尚未走坏就急于减仓，属过度恐慌，应力避。
8. 反机械：净值跌破20日均线不等于看空，站上20日均线也不等于看多；一律以"动量＋相对强弱＋催化剂"三者的交集为准，不要拿均线位置或回撤深度一刀切做结论。
9. 盘中估值为预测值、存在误差，仅供盘中参考；判断优先以收盘确认净值为准。
10. 量化指标（年化收益/波动率/夏普/最大回撤/相对沪深300超额）已算好，直接使用，不要自行重算。
11. 若给出了「组合上下文」，必须纳入：该基金与组合内其他基金高度重叠或高相关时，加仓是放大同一风险敞口而非分散风险，应更谨慎并说明；已在组合层面暴露过高的个股同理。
12. suggestedPct：加仓给高于当前的比例、减仓给低于当前的比例、持有给持平；无持仓把握可填 null。
13. 若给出了「板块估值分位」，只作长周期贵/便宜的参考轴：分位极低（如 <20%）时，深跌更可能是"便宜"而非"趋势恶化"，此时减少减仓权重、但不等于可以抄底（仍要动量/催化剂交叉验证）；分位极高（如 >80%）时，反弹更可能是"贵"而非"值得追"，此时减少加仓权重。禁止仅凭估值分位下单。
14. 新闻列表的方括号含义：[行业]=与该基金或其重仓股相关，[大盘]=行业新闻不足时的市场环境兜底（不可当成该基金的消息）；括号内是「日期|距今天数|情绪」。距今天数越大参考价值越低，超过 2 周且无摘要的旧闻不要当作"催化剂"。
15. reason 必须点明触发了哪几条交叉信号（动量/超额/企稳/催化/破位/利空/估值分位），并说明为何达成或未达成操作条件，避免"等待企稳/观察再说"这类不给出操作的套话。`

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
  news: { title: string | null; summary: string | null; sentiment: string | null; llmTags: string[]; pubTime: Date | null; relevance?: 'match' | 'market' }[]
  position: PositionSummary | null
  timeCtx: string
  estimate: EstPoint[]
  metricsBlock: string | null
  portfolioBlock: string | null
  /** 规则引擎参考分块（config.analyzer.rulesInLLM 开启时才有；null 不拼） */
  ruleBlock: string | null
  /** 板块估值分位块（index_valuation 命中该主题指数时才有；null 不拼） */
  valuationBlock: string | null
}

/** 拼装 User Prompt（导出供单测：验证指标/组合/持仓/新闻/时点/规则分各块确实进入提示词） */
export function buildUserPrompt(input: PromptInput): string {
  const { fundName, code, nav, holdings, news, position, timeCtx, estimate, metricsBlock, portfolioBlock, ruleBlock, valuationBlock } = input
  const latestNav = nav[nav.length - 1]

  const navLines = nav.slice(-30).map((p) => `${p.date} ${p.nav.toFixed(4)} (${p.changePct === null ? '--' : p.changePct.toFixed(2)}%)`).join('\n')

  const estBlock = formatEstimateBlock(estimate)

  const holdLines = holdings.rows
    .slice(0, 10)
    .map((h) => `${h.rank}. ${h.stockName ?? '?'} 权重${h.weight === null ? '--' : h.weight.toFixed(2)}% 近10日${h.lastPct === null ? '--' : h.lastPct.toFixed(2)}%`)
    .join('\n')

  const newsLines = news
    .slice(0, 8)
    .map((n) => {
      // 带发布日与"几天前"：旧实现只给标题，模型无法判断这条新闻是当天的还是三周前的
      const d = n.pubTime
      const dateTag = d ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}|${newsAgeTag(d)}` : '日期未知'
      const head = n.title && n.title.trim() !== '' ? n.title : '(无标题)'
      const body = n.summary ? ' | ' + n.summary.slice(0, 100) : ''
      // [行业]=与该基金/重仓股相关；[大盘]=相关新闻不足时的市场环境兜底（不可当成该基金的消息）
      const scope = n.relevance === 'market' ? '[大盘]' : '[行业]'
      return `- ${scope}[${dateTag}|${n.sentiment ?? '未知情绪'}] ${head}${body}`
    })
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
净值样本数：${nav.length} 条（区间累计涨跌见下方量化指标的"区间收益"）
最新净值：${latestNav.nav.toFixed(4)}（${latestNav.date}），当日涨跌 ${latestNav.changePct === null ? '--' : latestNav.changePct.toFixed(2)}%
${estBlock ? estBlock + '\n' : ''}${metricsBlock ? metricsBlock + '\n' : ''}${valuationBlock ? valuationBlock + '\n' : ''}${ruleBlock ? ruleBlock + '\n' : ''}${portfolioBlock ? portfolioBlock + '\n' : ''}${posLines}

近 30 日净值：
${navLines}

最新重仓股（报告期 ${holdings.reportDate ?? '无'}）：
${holdLines || '（无持仓数据）'}

相关新闻（最多 8 条；[行业]=与本基金/重仓股相关，[大盘]=行业新闻不足时的市场兜底；括号为「日期|距今天数|情绪」，越旧参考价值越低）：
${newsLines || '（无相关新闻）'}

请给出 加仓/减仓/持有 建议。`
}

// parseAdvice 在 ./parse（纯函数独立模块，便于单测）

export interface AnalyzeContext {
  pool: Pool
  aiFundPool: Pool
  /** 规则引擎参考分是否注入 LLM（config.analyzer.rulesInLLM，默认开） */
  rulesInLLM?: boolean
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

  // 相关新闻：基金名关键词 + 前 8 个重仓股名过滤 ai_fund.raw_news。
  // 选材走 recentNewsForFunds（时效优先 + 逐级降级 + 可用性排序），原因见该函数注释：
  // 旧实现按时间倒序取"全库最新 10 条"，实测近 7 天命中常常不足，会把三周前的旧闻当成"最新"。
  const stockNames = holdings.rows.map((h) => h.stockName).filter((s): s is string => Boolean(s)).slice(0, 8)
  const fundKeywords = [basic.name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
  const news = await recentNewsForFunds(aiFundPool, { tags: [...fundKeywords, ...stockNames], limit: 8 })

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

  // 规则引擎参考分：开关开启时计算并注入 prompt（作为交叉验证的一路参考信号，不构成独立依据）
  let ruleBlock: string | null = null
  if (ctx.rulesInLLM !== false) {
    try {
      const { computeRuleScore, formatRuleBlock } = await import('../scorer/ruleScore')
      const rs = await computeRuleScore(pool, aiFundPool, code)
      if (rs) ruleBlock = formatRuleBlock(rs)
    } catch (e) {
      console.warn(`[analyze] ${code} 规则引擎参考分计算失败（忽略继续）: ${(e as Error).message}`)
    }
  }

  // 板块估值分位：补上"该板块现在贵还是便宜"的长周期参考轴（行业主题基金尤其需要）
  let valuationBlock: string | null = null
  try {
    const val = await loadIndexValuation(pool, basic.name)
    if (val) valuationBlock = formatValuationBlock(val)
  } catch (e) {
    console.warn(`[analyze] ${code} 板块估值分位计算失败（忽略继续）: ${(e as Error).message}`)
  }

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
    portfolioBlock,
    ruleBlock,
    valuationBlock
  })
  const raw = await chatComplete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.3, maxTokens: 2000 } // 思考型模型（如 deepseek-flash）reasoning 也占用该额度，须留足，否则 content 为空
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
    const r = await analyzeFund({ pool, aiFundPool, rulesInLLM: cfg.analyzer.rulesInLLM }, code, cost)
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
