// AI 分析（计划书 §7.3）：对单只基金生成 加仓/减仓/持有 建议
// 输入：近120日净值 + 今日涨跌 + 重仓股近10日表现 + 相关新闻（按重仓股/基金名过滤 ai_fund.raw_news）+ 用户持仓（份额/成本/盈亏）
// 输出：固定 JSON { action, confidence, reason }，写 ds_advice 保留 response_raw；action != hold 触发桌面通知
import type { Pool } from 'pg'
import { chatComplete, hasDeepseekKey, DeepseekError } from '../llm/deepseek'
import { navSeries, latestHoldings, fundBasic } from '../storage/queries'
import { newsByTags } from '../news/reader'
import { computePosition } from '../position/position'
import type { PositionSummary } from '../position/position'
import { createAiFundPool } from '../storage/db'
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
  raw: string
}

const SYSTEM_PROMPT = `你是基金投资分析助手。基于给定的场外基金数据（日净值走势、重仓股近期表现、相关新闻），给出独立的 加仓/减仓/持有 建议。
规则：
1. 只依据提供的数据判断，不编造未提供的信息。
2. 输出且仅输出一个 JSON 对象，不要包含任何其他文字、markdown 代码块或解释。
3. JSON 格式严格为：{"action":"add|reduce|hold","confidence":0~100,"reason":"中文理由，150字以内"}。
4. action 含义：add=当前值得加仓；reduce=当前值得减仓/止盈；hold=继续持有观望。`

function buildUserPrompt(
  fundName: string,
  code: string,
  nav: Awaited<ReturnType<typeof navSeries>>,
  holdings: Awaited<ReturnType<typeof latestHoldings>>,
  news: { title: string | null; summary: string | null; sentiment: string | null; llmTags: string[] }[],
  position: PositionSummary | null
): string {
  const latestNav = nav[nav.length - 1]
  const firstNav = nav[0]
  const periodPct = firstNav && firstNav.nav > 0 ? (((latestNav.nav - firstNav.nav) / firstNav.nav) * 100).toFixed(2) : null

  const navLines = nav.slice(-30).map((p) => `${p.date} ${p.nav.toFixed(4)} (${p.changePct === null ? '--' : p.changePct.toFixed(2)}%)`).join('\n')

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

  return `基金：${fundName}（${code}）
净值样本数：${nav.length} 条；区间涨跌：${periodPct ?? '--'}%（近${nav.length}个交易日，归一化起点）
最新净值：${latestNav.nav.toFixed(4)}（${latestNav.date}），当日涨跌 ${latestNav.changePct === null ? '--' : latestNav.changePct.toFixed(2)}%
${posLines}

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

/** 单基金 AI 分析主流程；返回 null 表示跳过（未配置 Key / 数据不足 / 解析失败） */
export async function analyzeFund(ctx: AnalyzeContext, code: string, cost: number | null = null): Promise<AnalyzeResult | null> {
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

  // 用户持仓：显式 cost 参数优先；否则从 fund_trade 移动加权计算（M7）
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
    const pos = await computePosition(pool, code)
    position = pos.shares > 0 ? pos : null
    if (position) {
      console.log(`[analyze] ${code} 已接入持仓：${position.shares} 份，成本 ${position.avgCost?.toFixed(4)}，盈亏 ${position.floatingPnl?.toFixed(2)}`)
    }
  }

  // 相关新闻：用基金名关键词 + 前 8 个重仓股名过滤 ai_fund.raw_news
  const stockNames = holdings.rows.map((h) => h.stockName).filter((s): s is string => Boolean(s)).slice(0, 8)
  const fundKeywords = [basic.name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
  const news = await newsByTags(aiFundPool, [...fundKeywords, ...stockNames], 10)

  const userPrompt = buildUserPrompt(basic.name, code, nav, holdings, news, position)
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

/** 写 ds_advice（含原始响应留痕）；返回是否新插入 */
export async function saveAdvice(pool: Pool, code: string, r: AnalyzeResult, tradeDate: string): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO ds_advice (fund_code, trade_date, action, reason, confidence, response_raw, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())`,
    [code, tradeDate, r.action, r.reason, r.confidence, JSON.stringify({ raw: r.raw })]
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
