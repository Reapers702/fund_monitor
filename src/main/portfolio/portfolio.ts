// 组合视角（纯函数，独立便于单测）：把"逐基金"的持仓合成"组合"看——
//   1) 隐性集中度：多只基金共同重仓同一只股票时，实际个股暴露 = Σ(该基金组合权重 × 该股在基金内权重)；
//   2) 重仓股重叠：两两基金的前十大重仓交集，判断是否"买了好几只其实是同一批股票"；
//   3) 基金相关性：按共同交易日对齐的日收益 Pearson 相关系数，衡量同涨同跌程度。
//
// 口径说明（UI 需一致）：
// - 基金组合权重：全部自选基金都有持仓市值时按市值权重，否则等权（避免"只持有 2 只"时其余基金暴露被算成 0）。
// - 重仓股只覆盖前十大（主动基金通常占 60-70% 仓位），故「已知暴露」合计小于 100%，
//   集中度在该已知暴露内归一化，UI 需标注"前十大口径"。
// - 相关性最少需 MIN_CORR_DAYS 个共同交易日，否则不产出（样本太少相关系数不可信）。

export interface PortfolioHolding {
  stockCode: string | null
  stockName: string | null
  weight: number | null // 该股在基金内的权重 %
}

export interface PortfolioFundInput {
  code: string
  name: string
  marketValue: number | null // 持仓市值（无持仓/未录入交易为 null）
  holdings: PortfolioHolding[]
  nav: { date: string; nav: number }[] // 用于相关性（日期对齐）
}

export type WeightBasis = 'position' | 'equal'

/** 个股已知暴露达到该比例即提示集中度风险（%） */
export const CONCENTRATION_WARN_PCT = 10
/** 相关性最少共同交易日 */
export const MIN_CORR_DAYS = 20

export interface StockExposure {
  key: string // 股票代码（缺失时用名称）
  stockCode: string | null
  stockName: string | null
  exposure: number // 组合层面暴露 %（Σ 基金权重 × 基金内权重）
  fundCount: number
  funds: { code: string; name: string; weight: number; contribution: number }[] // contribution = 组合口径贡献 %
  high: boolean // 是否达到集中度提示阈值
}

export interface OverlapPair {
  fundA: { code: string; name: string }
  fundB: { code: string; name: string }
  commonCount: number
  /** 重叠度 %：Σ min(两基金权重) / min(两基金权重合计)，100% = 较小基金基本被覆盖 */
  overlapPct: number
  commonStocks: { stockCode: string | null; stockName: string | null; weightA: number; weightB: number }[]
}

export interface FundCorrelation {
  fundA: { code: string; name: string }
  fundB: { code: string; name: string }
  commonDays: number
  corr: number // Pearson，[-1, 1]
}

export interface PortfolioAnalysis {
  fundCount: number
  weightBasis: WeightBasis
  /** 各基金组合权重（%） */
  funds: { code: string; name: string; weight: number; marketValue: number | null }[]
  /** 已知重仓股合计暴露 %（前十大口径，< 100 是正常的） */
  totalExposure: number
  stockCount: number
  concentration: { top1: number; top3: number; top5: number; hhi: number }
  topStocks: StockExposure[]
  overlaps: OverlapPair[]
  correlations: FundCorrelation[]
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function stockKey(h: PortfolioHolding): string | null {
  if (h.stockCode) return h.stockCode
  if (h.stockName) return `name:${h.stockName}`
  return null
}

/** 分配各基金的组合权重（%）：全部有持仓市值则按市值，否则等权 */
export function resolveFundWeights(funds: { code: string; marketValue: number | null }[]): {
  basis: WeightBasis
  weights: number[] // 与 funds 对齐，单位 %
} {
  const n = funds.length
  if (n === 0) return { basis: 'equal', weights: [] }
  const allHaveValue = funds.every((f) => f.marketValue !== null && f.marketValue > 0)
  if (allHaveValue) {
    const total = funds.reduce((s, f) => s + (f.marketValue as number), 0)
    if (total > 0) return { basis: 'position', weights: funds.map((f) => ((f.marketValue as number) / total) * 100) }
  }
  return { basis: 'equal', weights: funds.map(() => 100 / n) }
}

/** 日收益按日期索引：(今/昨 − 1) */
function returnsByDate(nav: { date: string; nav: number }[]): Map<string, number> {
  const points = [...nav].filter((p) => Number.isFinite(p.nav) && p.nav > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const out = new Map<string, number>()
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1].nav
    if (prev > 0) out.set(points[i].date, points[i].nav / prev - 1)
  }
  return out
}

/** Pearson 相关系数；样本不足或零方差返回 null */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n < 2) return null
  const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n
  const my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n
  let cov = 0
  let vx = 0
  let vy = 0
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx
    const dy = ys[i] - my
    cov += dx * dy
    vx += dx * dx
    vy += dy * dy
  }
  if (vx <= 0 || vy <= 0) return null
  return round(cov / Math.sqrt(vx * vy), 3)
}

/** 按共同日期对齐两组日收益 */
function alignReturns(a: Map<string, number>, b: Map<string, number>): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const [date, ra] of a) {
    const rb = b.get(date)
    if (rb !== undefined) {
      xs.push(ra)
      ys.push(rb)
    }
  }
  return { xs, ys }
}

/**
 * 组合分析主入口。funds 顺序即输出顺序（建议按自选顺序传入）。
 * 持仓为空/权重缺失的股票会被跳过；没有任何重仓股时集中度与重叠为空、相关性仍可算。
 */
export function analyzePortfolio(funds: PortfolioFundInput[], topN = 10): PortfolioAnalysis {
  const { basis, weights } = resolveFundWeights(funds)

  // ---- 个股暴露聚合 ----
  const stockMap = new Map<string, StockExposure>()
  let totalExposure = 0

  funds.forEach((f, i) => {
    const w = weights[i] ?? 0
    for (const h of f.holdings) {
      const key = stockKey(h)
      if (!key || h.weight === null || !(h.weight > 0)) continue
      const contribution = (w * h.weight) / 100
      totalExposure += contribution
      const cur = stockMap.get(key)
      if (cur) {
        cur.exposure += contribution
        cur.fundCount++
        cur.funds.push({ code: f.code, name: f.name, weight: h.weight, contribution })
      } else {
        stockMap.set(key, {
          key,
          stockCode: h.stockCode,
          stockName: h.stockName,
          exposure: contribution,
          fundCount: 1,
          funds: [{ code: f.code, name: f.name, weight: h.weight, contribution }],
          high: false
        })
      }
    }
  })

  const exposures = [...stockMap.values()]
  for (const e of exposures) {
    e.exposure = round(e.exposure)
    e.funds = e.funds.map((x) => ({ ...x, contribution: round(x.contribution) })).sort((a, b) => b.contribution - a.contribution)
    e.high = e.exposure >= CONCENTRATION_WARN_PCT
  }
  exposures.sort((a, b) => b.exposure - a.exposure || a.key.localeCompare(b.key))

  // 集中度：在已知暴露内归一化
  const denom = exposures.reduce((s, e) => s + e.exposure, 0)
  const concentration = (() => {
    if (denom <= 0) return { top1: 0, top3: 0, top5: 0, hhi: 0 }
    const shares = exposures.map((e) => e.exposure / denom)
    const sumTop = (n: number) => round(shares.slice(0, n).reduce((a, b) => a + b, 0) * 100)
    return {
      top1: sumTop(1),
      top3: sumTop(3),
      top5: sumTop(5),
      hhi: round(shares.reduce((a, s) => a + s * s, 0), 4)
    }
  })()

  // ---- 两两重仓股重叠 ----
  const overlaps: OverlapPair[] = []
  for (let i = 0; i < funds.length; i++) {
    for (let j = i + 1; j < funds.length; j++) {
      const a = funds[i]
      const b = funds[j]
      const mapA = new Map<string, { h: PortfolioHolding; w: number }>()
      for (const h of a.holdings) {
        const k = stockKey(h)
        if (k && h.weight !== null && h.weight > 0) mapA.set(k, { h, w: h.weight })
      }
      const mapB = new Map<string, { h: PortfolioHolding; w: number }>()
      for (const h of b.holdings) {
        const k = stockKey(h)
        if (k && h.weight !== null && h.weight > 0) mapB.set(k, { h, w: h.weight })
      }

      const sumA = [...mapA.values()].reduce((s, x) => s + x.w, 0)
      const sumB = [...mapB.values()].reduce((s, x) => s + x.w, 0)
      if (sumA <= 0 || sumB <= 0) continue

      const commonStocks: OverlapPair['commonStocks'] = []
      let minSum = 0
      for (const [k, xa] of mapA) {
        const xb = mapB.get(k)
        if (!xb) continue
        minSum += Math.min(xa.w, xb.w)
        commonStocks.push({
          stockCode: xa.h.stockCode ?? xb.h.stockCode,
          stockName: xa.h.stockName ?? xb.h.stockName,
          weightA: xa.w,
          weightB: xb.w
        })
      }
      if (commonStocks.length === 0) continue
      commonStocks.sort((p, q) => Math.min(q.weightA, q.weightB) - Math.min(p.weightA, p.weightB))
      overlaps.push({
        fundA: { code: a.code, name: a.name },
        fundB: { code: b.code, name: b.name },
        commonCount: commonStocks.length,
        overlapPct: round((minSum / Math.min(sumA, sumB)) * 100, 1),
        commonStocks
      })
    }
  }
  overlaps.sort((p, q) => q.overlapPct - p.overlapPct || q.commonCount - p.commonCount)

  // ---- 两两相关性 ----
  const corrMaps = funds.map((f) => returnsByDate(f.nav))
  const correlations: FundCorrelation[] = []
  for (let i = 0; i < funds.length; i++) {
    for (let j = i + 1; j < funds.length; j++) {
      const { xs, ys } = alignReturns(corrMaps[i], corrMaps[j])
      if (xs.length < MIN_CORR_DAYS) continue
      const corr = pearson(xs, ys)
      if (corr === null) continue
      correlations.push({
        fundA: { code: funds[i].code, name: funds[i].name },
        fundB: { code: funds[j].code, name: funds[j].name },
        commonDays: xs.length,
        corr
      })
    }
  }
  correlations.sort((p, q) => q.corr - p.corr)

  return {
    fundCount: funds.length,
    weightBasis: basis,
    funds: funds.map((f, i) => ({ code: f.code, name: f.name, weight: round(weights[i] ?? 0), marketValue: f.marketValue })),
    totalExposure: round(totalExposure),
    stockCount: exposures.length,
    concentration,
    topStocks: exposures.slice(0, topN),
    overlaps,
    correlations
  }
}
