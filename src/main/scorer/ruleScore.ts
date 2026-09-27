// 规则引擎参考分（M10）—— 详情页展示 + 可选注入 LLM prompt 作为一路交叉验证信号
//
// 重要定位（避免重蹈覆辙）：
//   回测已证明规则总分对未来 T+5/T+10 方向命中率恒≈50%（动量/形态/新闻/超额均无预测力），
//   因此本模块输出的"规则动作/总分"**不单独构成操作依据**，只作两类用途：
//     1) 详情页展示：把"动量/形态/盘中/新闻"四轴当前量化为数字，让用户看到多维状态快照；
//     2) 注入 LLM：作为交叉验证的**一路参考信号**（由 LLM 结合其他数据综合判断，不盲从）。
//   开关：config.analyzer.rulesInLLM（默认开，可在设置页关闭）。
import type { Pool } from 'pg'
import { navSeries, latestHoldings, estimateSeries, fundBasic } from '../storage/queries'
import { computeRelativeStrength } from '../analyzer/metrics'
import { loadBenchmarkNav, BENCHMARK_NAME } from '../crawler/benchmark'
import { score, DEFAULT_WEIGHTS } from './engine'
import type { ScoreBreakdown } from './engine'
import { newsByTags } from '../news/reader'

export interface RuleScoreResult {
  breakdown: ScoreBreakdown
  /** 所用净值截止日（YYYY-MM-DD） */
  asof: string | null
  /** 参与打分的新闻条数 */
  newsCount: number
}

/**
 * 计算单只基金的规则引擎参考分（生产视角，非回测）：
 *  - 动量/超额：近 120 日净值 + 相对沪深300（基准取不到则跳过超额项）
 *  - 盘中轴：最近一条估算涨跌（无当日估算则 0）
 *  - 新闻轴：基金名 + 前 8 重仓股过滤 ai_fund.raw_news，时间衰减（最长 7 天）
 * 任一关键数据不足返回 null（调用方按"无规则分"处理，不阻断）。
 */
export async function computeRuleScore(pool: Pool, aiFundPool: Pool, code: string): Promise<RuleScoreResult | null> {
  try {
    const basic = await fundBasic(pool, code)
    if (!basic) return null
    const nav = await navSeries(pool, code, 120)
    if (nav.length < 21) return null

    const holdings = await latestHoldings(pool, code)
    const stocks = holdings.rows.map((h) => h.stockName).filter((s): s is string => Boolean(s)).slice(0, 8)
    const fundKeywords = [basic.name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
    const news = await newsByTags(aiFundPool, [...fundKeywords, ...stocks], 8)
    const nowMs = Date.now()
    const newsSignals = news.map((n) => ({
      text: n.title ?? '',
      weight: 1,
      daysAgo: Math.max(0, Math.round((nowMs - (n.pubTime ? n.pubTime.getTime() : nowMs)) / 86400000))
    }))

    // 盘中轴：最近一条非空估算涨跌（盘前/非交易日无数据则传 null → 盘中轴 0）
    const est = await estimateSeries(pool, code)
    let intradayPct: number | null = null
    for (const e of [...est].reverse()) {
      if (e.pct !== null) {
        intradayPct = e.pct
        break
      }
    }

    let excess20: number | null = null
    let excess60: number | null = null
    const benchNav = await loadBenchmarkNav()
    if (benchNav) {
      const rs = computeRelativeStrength(nav, benchNav, [20, 60], BENCHMARK_NAME)
      excess20 = rs?.windows[0]?.excess ?? null
      excess60 = rs?.windows[1]?.excess ?? null
    }

    const breakdown = score({ nav, excess20, excess60, intradayPct, news: newsSignals }, DEFAULT_WEIGHTS)
    return { breakdown, asof: nav[nav.length - 1]?.date ?? null, newsCount: newsSignals.length }
  } catch (e) {
    console.warn(`[rule-score] ${code} 计算失败（忽略继续）: ${(e as Error).message}`)
    return null
  }
}

const ACTION_CN = { add: '加仓', reduce: '减仓', hold: '持有' } as const

/** 规则分 → 给 LLM 看的参考块（明确标注参考性质，避免被当成方向指令） */
export function formatRuleBlock(r: RuleScoreResult): string {
  const b = r.breakdown
  return `规则引擎参考分（确定性打分，仅作交叉验证的**一路参考信号**，不单独构成操作依据，请综合其他数据独立判断）：
- 动量轴 ${b.momentum.toFixed(2)} / 形态轴 ${b.shape.toFixed(2)} / 盘中轴 ${b.intraday.toFixed(2)} / 新闻轴 ${b.news.toFixed(2)}（各轴 ∈[-3,+3]）
- 加权总分 ${b.total.toFixed(2)}（[-3,+3]）→ 规则动作【${ACTION_CN[b.action]}】置信 ${b.confidence}/100（净值截至 ${r.asof ?? '--'}，相关新闻 ${r.newsCount} 条）`
}
