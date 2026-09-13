// 基金量化指标（纯函数，独立便于单测）：把净值序列算成回撤/波动/夏普/动量/胜率等结构化指标。
// 用途：喂给 AI 的建议 prompt——让模型基于"算好的指标"判断，而不是从 30 行净值里自己悟。
//
// 口径：年化按 244 个交易日；波动率用日收益标准差 × √244；夏普 =（年化收益 − 无风险利率）/ 年化波动。
// 收益不足（<2 个点）时返回 null，由调用方决定省略。

export interface NavLike {
  date: string // YYYY-MM-DD
  nav: number
}

/** 年化无风险利率（%）——夏普基准，取中国 10 年期国债近似值 */
export const RISK_FREE_ANNUAL_PCT = 2
/** 每年交易日数（A 股约 244） */
export const TRADING_DAYS_PER_YEAR = 244

export interface FundMetrics {
  sampleDays: number
  periodReturn: number | null // 区间累计涨跌 %
  annualizedReturn: number | null // 年化收益 %
  annualizedVol: number | null // 年化波动率 %
  sharpe: number | null // 夏普比率（年化）
  maxDrawdown: number | null // 最大回撤 %（负值表示回撤幅度）
  currentDrawdown: number | null // 当前距区间最高点的回撤 %
  winRate: number | null // 日度上涨占比 %
  ret20: number | null // 近 20 日涨跌 %
  ret60: number | null
  ma20: number | null // 20 日均线
  aboveMa20: boolean | null // 最新净值是否站上 20 日均线
}

function round(v: number, digits = 2): number {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** 区间累计涨跌 %（首尾） */
export function periodReturnPct(navs: number[]): number | null {
  const first = navs[0]
  const last = navs[navs.length - 1]
  if (navs.length < 2 || !(first > 0)) return null
  return round(((last - first) / first) * 100)
}

/** 最大回撤 %（负值）：区间内任一时点相对此前最高点的最大跌幅 */
export function maxDrawdownPct(navs: number[]): number | null {
  if (navs.length < 2) return null
  let peak = navs[0]
  let worst = 0
  for (const v of navs) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((v - peak) / peak) * 100
      if (dd < worst) worst = dd
    }
  }
  return round(worst)
}

/** 当前回撤 %（最新净值相对区间最高点） */
export function currentDrawdownPct(navs: number[]): number | null {
  if (navs.length < 2) return null
  const peak = Math.max(...navs)
  const last = navs[navs.length - 1]
  if (!(peak > 0)) return null
  return round(((last - peak) / peak) * 100)
}

/** 日收益序列（小数，非百分比）：(今/昨 − 1) */
export function dailyReturns(navs: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < navs.length; i++) {
    const prev = navs[i - 1]
    if (prev > 0) out.push(navs[i] / prev - 1)
  }
  return out
}

/** 年化波动率 % = 日收益标准差 × √244（样本标准差） */
export function annualizedVolPct(rets: number[]): number | null {
  if (rets.length < 2) return null
  const m = mean(rets)
  const variance = rets.reduce((a, r) => a + (r - m) ** 2, 0) / (rets.length - 1)
  return round(Math.sqrt(variance) * Math.sqrt(TRADING_DAYS_PER_YEAR) * 100)
}

/** 年化收益 %：由区间收益按交易日数折算复利 */
export function annualizedReturnPct(periodPct: number | null, tradingDays: number): number | null {
  if (periodPct === null || tradingDays <= 0) return null
  const growth = 1 + periodPct / 100
  if (growth <= 0) return null // 区间亏光/异常，无法折算
  return round((growth ** (TRADING_DAYS_PER_YEAR / tradingDays) - 1) * 100)
}

/** 夏普比率（年化）=（年化收益 − 无风险利率）/ 年化波动率 */
export function sharpeRatio(annualizedReturn: number | null, annualizedVol: number | null): number | null {
  if (annualizedReturn === null || annualizedVol === null || annualizedVol <= 0) return null
  return round((annualizedReturn - RISK_FREE_ANNUAL_PCT) / annualizedVol, 2)
}

/**
 * 汇总一只基金的量化指标。nav 顺序无关（内部按日期升序）。
 * 建议传入不少于 60 个交易日以获得有意义的年化/夏普；不足则对应字段为 null。
 */
export function computeFundMetrics(nav: NavLike[]): FundMetrics {
  const points = [...nav].filter((p) => Number.isFinite(p.nav) && p.nav > 0).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const navs = points.map((p) => p.nav)
  const sampleDays = Math.max(0, navs.length - 1)

  const periodPct = periodReturnPct(navs)
  const rets = dailyReturns(navs)
  const vol = annualizedVolPct(rets)
  const annRet = annualizedReturnPct(periodPct, sampleDays)

  const tailRet = (window: number): number | null => {
    if (navs.length < window + 1) return null
    const slice = navs.slice(-(window + 1))
    return periodReturnPct(slice)
  }

  const ma20 = navs.length >= 20 ? round(mean(navs.slice(-20)), 4) : null
  const last = navs[navs.length - 1] ?? null

  return {
    sampleDays,
    periodReturn: periodPct,
    annualizedReturn: annRet,
    annualizedVol: vol,
    sharpe: sharpeRatio(annRet, vol),
    maxDrawdown: maxDrawdownPct(navs),
    currentDrawdown: currentDrawdownPct(navs),
    winRate: rets.length > 0 ? round((rets.filter((r) => r > 0).length / rets.length) * 100, 1) : null,
    ret20: tailRet(20),
    ret60: tailRet(60),
    ma20,
    aboveMa20: ma20 !== null && last !== null ? last >= ma20 : null
  }
}

// ---------- 相对基准（相对强弱 / 超额收益） ----------

export interface ExcessWindow {
  window: number // 交易日
  fundRet: number | null // 基金区间涨跌 %
  benchRet: number | null // 基准区间涨跌 %
  excess: number | null // 超额 = 基金 − 基准
}

export interface RelativeStrength {
  benchmark: string
  commonDays: number // 基金与基准对齐后的共同交易日数
  windows: ExcessWindow[] // 各窗口的超额收益
}

/**
 * 基金相对基准的超额收益。按日期取交集对齐（基金净值日与指数交易日可能不完全重合），
 * 每个窗口取对齐序列的最后 window+1 个点算首尾涨跌。共同交易日不足窗口则不产出该窗口（fundRet=null）。
 */
export function computeRelativeStrength(
  fund: NavLike[],
  bench: NavLike[],
  windows: readonly number[] = [20, 60],
  benchmark = '沪深300'
): RelativeStrength | null {
  const fundMap = new Map(fund.filter((p) => Number.isFinite(p.nav)).map((p) => [p.date, p.nav]))
  const benchMap = new Map(bench.filter((p) => Number.isFinite(p.nav)).map((p) => [p.date, p.nav]))
  const common = [...fundMap.keys()].filter((d) => benchMap.has(d)).sort()
  if (common.length < 2) return null

  const alignedFund = common.map((d) => fundMap.get(d) as number)
  const alignedBench = common.map((d) => benchMap.get(d) as number)

  const out: ExcessWindow[] = windows.map((w) => {
    if (common.length < w + 1) return { window: w, fundRet: null, benchRet: null, excess: null }
    const f = periodReturnPct(alignedFund.slice(-(w + 1)))
    const b = periodReturnPct(alignedBench.slice(-(w + 1)))
    return { window: w, fundRet: f, benchRet: b, excess: f !== null && b !== null ? round(f - b) : null }
  })

  return { benchmark, commonDays: common.length, windows: out }
}

/** 指标 → 给 AI 看的文字块（值是算好的，模型只需解读，不要自己算） */
export function formatMetricsBlock(m: FundMetrics, rs: RelativeStrength | null): string {
  const pct = (v: number | null) => (v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
  const lines = [
    `量化指标（基于近 ${m.sampleDays} 个交易日净值，年化按 244 交易日）：`,
    `区间收益 ${pct(m.periodReturn)}｜年化收益 ${pct(m.annualizedReturn)}｜年化波动率 ${m.annualizedVol === null ? '--' : m.annualizedVol.toFixed(2) + '%'}｜夏普 ${m.sharpe === null ? '--' : m.sharpe.toFixed(2)}（无风险利率 ${RISK_FREE_ANNUAL_PCT}%）`,
    `最大回撤 ${pct(m.maxDrawdown)}｜当前回撤 ${pct(m.currentDrawdown)}｜日涨占比 ${m.winRate === null ? '--' : m.winRate.toFixed(1) + '%'}`,
    `近 20 日 ${pct(m.ret20)}｜近 60 日 ${pct(m.ret60)}｜20 日均线 ${m.ma20 === null ? '--' : m.ma20.toFixed(4)}（最新${m.aboveMa20 === null ? '--' : m.aboveMa20 ? '在其上方' : '在其下方'}）`
  ]
  if (rs) {
    const ws = rs.windows
      .filter((w) => w.excess !== null)
      .map((w) => `近 ${w.window} 日超额 ${pct(w.excess)}（基金 ${pct(w.fundRet)} / ${rs.benchmark} ${pct(w.benchRet)}）`)
    if (ws.length > 0) lines.push(`相对${rs.benchmark}（对齐 ${rs.commonDays} 个交易日）：${ws.join('｜')}`)
  }
  return lines.join('\n')
}
