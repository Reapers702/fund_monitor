// 打分规则引擎（纯函数，独立便于单测）
//
// 目标：把"净值动量 / 走势形态 / 盘中估值 / 新闻情绪"各轴量化为确定性分数，加权聚合
// 成总分 S∈[-3,+3]，再经"反趋势/均值回归修正"后按阈值映射为 加仓/减仓/持有 建议。
//
// 与生产 LLM 链路的本质区别：
//   - 这里全部是确定性规则，无随机采样方差 → 历史样本可干净回测；
//   - LLM 只在 backtest 之外的可选通道里做"新闻语义 → 有界整数"，方向判断归本引擎。
//
// 本文件只做纯计算，取数（asof 截断）由调用方传入。便于单测。

import type { NavLike } from '../analyzer/metrics'
import { aggregateNewsScore } from './lexicon'

// ---------- 输入结构 ----------

export interface NewsSignal {
  text: string
  weight?: number // 相关性权重 0~1
  daysAgo?: number // 距今自然天数（时间衰减用），0 = 当天
}

export interface ScorerInput {
  /** 截至采样日的升序净值（含最新收盘确认值） */
  nav: NavLike[]
  /** 相对基准超额（近20/60日），可由调用方算好传入 */
  excess20: number | null
  excess60: number | null
  /** 当日盘中估值涨跌 %（盘中视角；库中无历史时传 null） */
  intradayPct: number | null
  news: NewsSignal[]
}

export interface ScorerWeights {
  momentum: number
  shape: number
  intraday: number
  news: number
  /** 反趋势强度：越大越抑制"追高/杀跌"（0 = 关闭反趋势修正） */
  meanRevert: number
  newsLambda: number // 新闻时间衰减系数
}

export interface ScoreBreakdown {
  momentum: number // [-3,3]
  shape: number // [-3,3]
  intraday: number // [-3,3]
  news: number // [-3,3]
  totalRaw: number // 加权和
  total: number // 反趋势修正后的总分 [-3,3]
  action: 'add' | 'reduce' | 'hold'
  confidence: number // 0~100 = |total|/3 映射
}

export const DEFAULT_WEIGHTS: ScorerWeights = {
  momentum: 0.4,
  shape: 0.25,
  intraday: 0.1,
  news: 0.25,
  meanRevert: 0.4,
  newsLambda: 0.15
}

export const ADD_THRESHOLD = 2.0
export const REDUCE_THRESHOLD = -2.0

/** 可选决策阈值覆盖（默认用上方常量；仅供回测/调参透传，生产不改动） */
export interface ScoreThresholds {
  add?: number
  reduce?: number
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function pct(xs: number[]): number {
  if (xs.length < 2) return 0
  const first = xs[0]
  const last = xs[xs.length - 1]
  if (!(first > 0)) return 0
  return ((last - first) / first) * 100
}

// ---------- 各轴打分 ----------

/** 动量/超额轴：近20日收益 + 相对基准超额，前向趋势 → 正向（标度放宽到 ±3，让强趋势能触达操作阈值） */
export function scoreMomentum(nav: NavLike[], excess20: number | null, excess60: number | null): number {
  if (nav.length < 21) return 0
  const closes = nav.map((p) => p.nav)
  const ret20 = pct(closes.slice(-21))
  const ret60 = closes.length >= 61 ? pct(closes.slice(-61)) : null
  let s = 0
  // 近20日动量：正 → +，且越强越多
  s += clamp(ret20 / 2, -2, 2)
  // 短中期动量一致性修正：20 与 60 同向时置信提升
  if (ret60 !== null) {
    s += clamp((ret20 - ret60) / 4, -1, 1) // 20日加速 vs 60日
    // 动量中枢：60日为正 → 加
    s += clamp(ret60 / 8, -0.8, 0.8)
  }
  // 相对基准超额：跑赢沪深300 → 正向
  if (excess20 !== null) s += clamp(excess20 / 4, -1.5, 1.5)
  if (excess60 !== null) s += clamp(excess60 / 8, -0.5, 0.5)
  return clamp(s, -3, 3)
}

/** 走势形态轴：均线位置 + 回撤深度（越深企稳 → 均值回归偏多，越浅滞涨 → 中性） */
export function scoreShape(nav: NavLike[]): number {
  if (nav.length < 21) return 0
  const closes = nav.map((p) => p.nav)
  const last = closes[closes.length - 1]
  const ma20 = closes.slice(-20).reduce((a, b) => a + b, 0) / 20
  let s = 0
  // 站上/跌破 20 日均线
  if (ma20 > 0) s += last >= ma20 ? 1 : -1
  // 当前回撤 vs 区间高点（近 60 日）
  const window = closes.slice(-60)
  const peak = Math.max(...window)
  const drawdown = peak > 0 ? ((last - peak) / peak) * 100 : 0
  // 近 3 日是否止跌企稳（由负转正）
  const last3 = closes.slice(-4)
  const prev3 = pct(last3.slice(0, 3))
  const latest = pct(last3.slice(-2))
  const stabilizing = prev3 < 0 && latest >= 0
  // 深回撤反弹分：仅当"深回撤 且 已止跌企稳"才给（防空手接飞刀）；仍在创新低不给
  if (drawdown <= -15 && stabilizing) s += clamp(Math.abs(drawdown) / 30, 0.3, 1.5)
  // 连跌后止跌再小幅加
  if (stabilizing) s += 0.5
  return clamp(s, -3, 3)
}

/** 盘中估值轴：当日估算涨跌 → 正负；斜率（尾盘加速）微调 */
export function scoreIntraday(intradayPct: number | null): number {
  if (intradayPct === null) return 0
  return clamp(intradayPct / 1.5, -2, 2)
}

// ---------- 聚合 + 决策 ----------

export function score(
  input: ScorerInput,
  weights: ScorerWeights = DEFAULT_WEIGHTS,
  thresholds?: ScoreThresholds
): ScoreBreakdown {
  const w = weights
  const momentum = scoreMomentum(input.nav, input.excess20, input.excess60)
  const shape = scoreShape(input.nav)
  const intraday = scoreIntraday(input.intradayPct)

  // 新闻聚合：复用 lexicon，返回 [-3,3]
  const news = aggregateNewsScore(
    input.news.map((n) => ({ text: n.text, weight: n.weight, daysAgo: n.daysAgo })),
    w.newsLambda
  )

  const wSum = w.momentum + w.shape + w.intraday + w.news
  const base = wSum > 0 ? (momentum * w.momentum + shape * w.shape + intraday * w.intraday + news * w.news) / wSum : 0
  let total = base

  // 反趋势/均值回归修正：抑制"追高/杀跌"（软化而非封顶，真强趋势仍可触达操作阈值）
  if (w.meanRevert > 0 && input.nav.length >= 21) {
    const closes = input.nav.map((p) => p.nav)
    const ret20 = pct(closes.slice(-21))
    // 短期已大涨 → 减分，防在反弹高位追入（只有超过 12% 的显著追高才扣，且上限 0.24）
    if (total > 0 && ret20 > 12) total -= w.meanRevert * clamp((ret20 - 12) / 8, 0, 0.8)
    // 中长期仍深度下行 → 即便动量短正也不过度看多（需 ≥61 日才有 60 日口径）
    if (input.nav.length >= 61) {
      const ret60 = pct(closes.slice(-61))
      if (ret60 < -10) total -= w.meanRevert * clamp(-ret60 / 30, 0, 0.6)
    }
  }
  total = clamp(total, -3, 3)

  const action = total >= (thresholds?.add ?? ADD_THRESHOLD) ? 'add' : total <= (thresholds?.reduce ?? REDUCE_THRESHOLD) ? 'reduce' : 'hold'
  const confidence = Math.round((Math.abs(total) / 3) * 100)

  return { momentum, shape, intraday, news, totalRaw: base, total, action, confidence }
}