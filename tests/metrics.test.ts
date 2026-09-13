// 量化指标单测（analyzer/metrics）：回撤/波动/年化/夏普/相对基准超额
import { describe, it, expect } from 'vitest'
import {
  periodReturnPct,
  maxDrawdownPct,
  currentDrawdownPct,
  dailyReturns,
  annualizedVolPct,
  annualizedReturnPct,
  sharpeRatio,
  computeFundMetrics,
  computeRelativeStrength,
  formatMetricsBlock
} from '../src/main/analyzer/metrics'
import type { NavLike } from '../src/main/analyzer/metrics'

/** 递增序列：1.00 起每日 +0.01，共 n 点 */
function rising(n: number): NavLike[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    nav: +(1 + i * 0.01).toFixed(4)
  }))
}

describe('metrics（基础指标）', () => {
  it('区间涨跌取首尾', () => {
    expect(periodReturnPct([1, 1.1, 1.21])).toBeCloseTo(21, 6)
    expect(periodReturnPct([1.21, 1.1, 1])).toBeCloseTo(-17.36, 2)
    expect(periodReturnPct([1])).toBeNull()
  })

  it('最大回撤取峰谷最大跌幅（负值）', () => {
    expect(maxDrawdownPct([1, 1.2, 0.9, 1.0])).toBeCloseTo(-25, 6)
    expect(maxDrawdownPct([1, 1.2, 1.3])).toBeCloseTo(0, 6) // 单边上行无回撤
  })

  it('当前回撤为最新价相对区间最高点', () => {
    expect(currentDrawdownPct([1, 1.2, 0.9])).toBeCloseTo(-25, 6)
    expect(currentDrawdownPct([1, 0.8, 1.2])).toBeCloseTo(0, 6)
  })

  it('日收益与年化波动：无波动序列波动为 0', () => {
    const rets = dailyReturns([1, 1.1, 1.21])
    expect(rets).toHaveLength(2)
    expect(rets[0]).toBeCloseTo(0.1, 9)
    expect(rets[1]).toBeCloseTo(0.1, 9)
    expect(annualizedVolPct([0, 0, 0])).toBeCloseTo(0, 6)
    expect(annualizedVolPct([0.01])).toBeNull() // 样本不足
  })

  it('年化收益按 244 交易日复利折算', () => {
    expect(annualizedReturnPct(10, 244)).toBeCloseTo(10, 4)
    expect(annualizedReturnPct(21, 122)).toBeCloseTo(46.41, 2) // 1.21^2 − 1
    expect(annualizedReturnPct(null, 100)).toBeNull()
  })

  it('夏普 =（年化收益 − 无风险）/ 年化波动', () => {
    expect(sharpeRatio(10, 20)).toBeCloseTo(0.4, 6) // (10−2)/20
    expect(sharpeRatio(10, 0)).toBeNull()
    expect(sharpeRatio(null, 20)).toBeNull()
  })
})

describe('computeFundMetrics（汇总）', () => {
  it('单边上行：无回撤、日涨占比 100%、站上均线', () => {
    const m = computeFundMetrics(rising(61))
    expect(m.sampleDays).toBe(60)
    expect(m.periodReturn).toBeCloseTo(60, 6) // 1.00 → 1.60
    expect(m.maxDrawdown).toBeCloseTo(0, 6)
    expect(m.currentDrawdown).toBeCloseTo(0, 6)
    expect(m.winRate).toBeCloseTo(100, 6)
    expect(m.ret20).toBeCloseTo(14.29, 2)
    expect(m.ret60).toBeCloseTo(60, 6)
    expect(m.ma20).toBeCloseTo(1.505, 4)
    expect(m.aboveMa20).toBe(true)
    expect(m.annualizedVol).not.toBeNull()
    expect(m.sharpe).not.toBeNull()
  })

  it('单边下行：最大回撤等于总跌幅、日涨占比 0%、跌破均线', () => {
    const down = rising(61).map((p, i) => ({ ...p, nav: +(1.6 - i * 0.01).toFixed(4) }))
    const m = computeFundMetrics(down)
    expect(m.periodReturn).toBeCloseTo(-37.5, 2) // 1.60 → 1.00
    expect(m.winRate).toBeCloseTo(0, 6)
    expect(m.aboveMa20).toBe(false)
    expect(m.maxDrawdown).toBeLessThan(0)
  })

  it('净值不足：短序列只给能算的字段，其余 null', () => {
    const m = computeFundMetrics(rising(10))
    expect(m.ret20).toBeNull() // 不足 21 点
    expect(m.ret60).toBeNull()
    expect(m.ma20).toBeNull()
    expect(m.aboveMa20).toBeNull()
    expect(m.periodReturn).not.toBeNull()
  })

  it('忽略非正净值与乱序输入', () => {
    const ok = computeFundMetrics(rising(5))
    const withBad = computeFundMetrics([
      { date: '2026-01-03', nav: 1.02 },
      { date: '2026-01-01', nav: 1.0 },
      { date: '2026-01-99', nav: 0 }, // 非正，忽略
      { date: '2026-01-05', nav: 1.04 },
      { date: '2026-01-02', nav: 1.01 }
    ])
    expect(withBad.sampleDays).toBe(3)
    expect(withBad.periodReturn).toBeCloseTo(4, 6)
    expect(ok.periodReturn).toBeCloseTo(4, 6)
  })
})

describe('computeRelativeStrength（相对基准超额）', () => {
  const fund: NavLike[] = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    nav: +(1 + i * 0.01).toFixed(4)
  }))
  // 基准只有后 7 天，且横盘
  const bench: NavLike[] = Array.from({ length: 7 }, (_, i) => ({
    date: `2026-01-${String(i + 4).padStart(2, '0')}`,
    nav: 2.0
  }))

  it('按日期交集对齐，窗口不足则不产出', () => {
    const rs = computeRelativeStrength(fund, bench, [3, 6, 10], '沪深300')
    expect(rs).not.toBeNull()
    expect(rs!.commonDays).toBe(7)
    expect(rs!.windows.find((w) => w.window === 3)!.excess).toBeCloseTo(2.83, 2)
    expect(rs!.windows.find((w) => w.window === 6)!.excess).toBeCloseTo(5.83, 2)
    // 共同交易日 7 < 10+1，该窗口无数据
    expect(rs!.windows.find((w) => w.window === 10)!.excess).toBeNull()
  })

  it('无重叠日期返回 null', () => {
    const far: NavLike[] = [{ date: '2025-01-01', nav: 1 }, { date: '2025-01-02', nav: 1.1 }]
    expect(computeRelativeStrength(fund, far, [3])).toBeNull()
  })

  it('指标块包含夏普与超额文字', () => {
    const text = formatMetricsBlock(computeFundMetrics(rising(61)), computeRelativeStrength(fund, bench, [6]))
    expect(text).toContain('夏普')
    expect(text).toContain('超额')
    expect(text).toContain('沪深300')
  })
})
