// AI 建议事后复盘（纯函数，独立便于单测）：把 ds_advice 的历史建议与后续净值对齐，
// 算"建议方向对不对"（命中率）与"照做能赚多少"（后续 N 日涨跌）。
//
// 口径（重要，UI 需与之一致）：
// - 入场日 = 建议交易日之后的第一个有净值的交易日。收盘后 15:35 出建议时当日净值尚未公布，
//   用"下一交易日"作为可执行价更贴近真实，避免用当日净值带来的前视偏差。
// - 后续 h 日涨跌 = (入场日后第 h 个交易日净值 / 入场日净值 - 1) × 100。
// - 命中：add 后续上涨算命中；reduce 后续下跌算命中；hold 无方向，不计入命中率（仅统计后续收益）。
// - 未满 h 个交易日（含入场日缺失）→ 该 horizon 记 null，不进统计，避免把"还没走完"当"没命中"。

export interface ReviewAdviceInput {
  id: number
  tradeDate: string // YYYY-MM-DD
  action: string // add / reduce / hold
  confidence: number | null
}

export interface ReviewNavPoint {
  date: string // YYYY-MM-DD
  nav: number
}

export const DEFAULT_HORIZONS = [5, 10, 20] as const

/** 置信度分档阈值：≥ 视为高置信（用于检验"高置信是否真更准"） */
export const HIGH_CONFIDENCE = 70

/**
 * 命中率最小样本数：分母低于此值只展示"命中数/总数"、不折算成百分比。
 * 5 个样本算出来的 0% 与 200 个样本的 0% 含义天差地别，给百分比会让人对噪声下判断。
 */
export const MIN_SAMPLE_FOR_RATE = 10

export interface AdviceReviewItem {
  id: number
  tradeDate: string
  action: string
  confidence: number | null
  entryDate: string | null // 入场交易日（建议日之后第一个有净值的交易日）
  entryNav: number | null
  returns: (number | null)[] // 与 horizons 对齐的后续涨跌 %
  hits: (boolean | null)[] // 与 horizons 对齐；hold 恒 null（无方向）
}

export interface AdviceReviewStat {
  horizon: number
  evaluated: number // 已满期条数（含 hold，用于判断"有无可复盘数据"）
  matured: number // 已满期的 add/reduce 条数（命中率分母；hold 无方向不计）
  hits: number
  hitRate: number | null // 命中率 %
  addTotal: number
  addHit: number
  reduceTotal: number
  reduceHit: number
  avgRetAdd: number | null // add 建议后平均后续收益 %
  avgRetReduce: number | null // reduce 建议后平均后续收益 %（为正说明"减错了"）
  avgRetHold: number | null // hold 建议后平均后续收益 %
  highConfTotal: number // 已满期且置信度 ≥ HIGH_CONFIDENCE 的 add/reduce 条数
  highConfHit: number
  lowConfTotal: number
  lowConfHit: number
}

export interface AdviceReviewResult {
  horizons: number[]
  /** 命中率最小样本数（随结果下发，避免渲染进程另存一份阈值导致口径漂移） */
  minSampleForRate: number
  items: AdviceReviewItem[]
  stats: AdviceReviewStat[]
}

/** 该建议是否命中：add 涨、reduce 跌才算对 */
function isHit(action: string, ret: number): boolean {
  return action === 'add' ? ret > 0 : ret < 0
}

function avg(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/**
 * 对一批建议做复盘。advice/nav 顺序无关（内部按日期升序处理）。
 * 保留 advice 的输入顺序输出 items（列表按建议时间倒序展示时无需再排）。
 */
export function evaluateAdviceReviews(
  advice: ReviewAdviceInput[],
  nav: ReviewNavPoint[],
  horizons: readonly number[] = DEFAULT_HORIZONS
): AdviceReviewResult {
  const points = [...nav].filter((p) => Number.isFinite(p.nav)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  const items: AdviceReviewItem[] = advice.map((a) => {
    // 入场日：建议日之后第一个交易日（date 为 YYYY-MM-DD，字符串比较等价于日期比较）
    const entryIdx = points.findIndex((p) => p.date > a.tradeDate)
    if (entryIdx < 0) {
      return {
        id: a.id,
        tradeDate: a.tradeDate,
        action: a.action,
        confidence: a.confidence,
        entryDate: null,
        entryNav: null,
        returns: horizons.map(() => null),
        hits: horizons.map(() => null)
      }
    }
    const entry = points[entryIdx]

    const returns = horizons.map((h) => {
      const exit = points[entryIdx + h]
      if (!exit || entry.nav <= 0) return null
      return +(((exit.nav - entry.nav) / entry.nav) * 100).toFixed(4)
    })

    const hits = horizons.map((_, i) => {
      const ret = returns[i]
      if (ret === null || (a.action !== 'add' && a.action !== 'reduce')) return null
      return isHit(a.action, ret)
    })

    return {
      id: a.id,
      tradeDate: a.tradeDate,
      action: a.action,
      confidence: a.confidence,
      entryDate: entry.date,
      entryNav: entry.nav,
      returns,
      hits
    }
  })

  const stats: AdviceReviewStat[] = horizons.map((horizon, i) => {
    const rets = items.map((it) => it.returns[i])
    let evaluated = 0
    let matured = 0
    let hits = 0
    let addTotal = 0
    let addHit = 0
    let reduceTotal = 0
    let reduceHit = 0
    let highConfTotal = 0
    let highConfHit = 0
    const addRets: number[] = []
    const reduceRets: number[] = []
    const holdRets: number[] = []

    items.forEach((it, idx) => {
      const ret = rets[idx]
      if (ret === null) return
      evaluated++
      if (it.action === 'hold') {
        holdRets.push(ret) // 无方向，不进命中率统计
        return
      }
      matured++
      const hit = isHit(it.action, ret)
      if (hit) hits++
      if (it.action === 'add') {
        addTotal++
        addRets.push(ret)
        if (hit) addHit++
      } else {
        reduceTotal++
        reduceRets.push(ret)
        if (hit) reduceHit++
      }
      if (it.confidence !== null && it.confidence >= HIGH_CONFIDENCE) {
        highConfTotal++
        if (hit) highConfHit++
      }
    })

    return {
      horizon,
      evaluated,
      matured,
      hits,
      hitRate: matured > 0 ? +((hits / matured) * 100).toFixed(1) : null,
      addTotal,
      addHit,
      reduceTotal,
      reduceHit,
      avgRetAdd: avg(addRets) === null ? null : +avg(addRets)!.toFixed(3),
      avgRetReduce: avg(reduceRets) === null ? null : +avg(reduceRets)!.toFixed(3),
      avgRetHold: avg(holdRets) === null ? null : +avg(holdRets)!.toFixed(3),
      highConfTotal,
      highConfHit,
      lowConfTotal: matured - highConfTotal,
      lowConfHit: hits - highConfHit
    }
  })

  return { horizons: [...horizons], minSampleForRate: MIN_SAMPLE_FOR_RATE, items, stats }
}
