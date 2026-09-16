// 组合视角单测（portfolio/portfolio）：权重口径、个股暴露聚合、集中度、重叠度、相关性
import { describe, it, expect } from 'vitest'
import { analyzePortfolio, resolveFundWeights, pearson, formatPortfolioContext, currentWeightPct, MIN_CORR_DAYS } from '../src/main/portfolio/portfolio'
import type { PortfolioFundInput } from '../src/main/portfolio/portfolio'

function navSeq(n: number, fn: (i: number) => number): { date: string; nav: number }[] {
  return Array.from({ length: n }, (_, i) => ({ date: `2026-03-${String(i + 1).padStart(2, '0')}`, nav: fn(i) }))
}

/** 两只基金：A 重仓 茅台/宁德/招行，B 重仓 茅台/五粮液；净值同涨同跌（相关性应为 1） */
function twoFunds(secondMarketValue: number | null): PortfolioFundInput[] {
  const nav = navSeq(25, (i) => 1 + i * 0.01)
  return [
    {
      code: '000001',
      name: '基金A',
      marketValue: 6000,
      holdings: [
        { stockCode: '600519', stockName: '贵州茅台', weight: 10 },
        { stockCode: '300750', stockName: '宁德时代', weight: 5 },
        { stockCode: '600036', stockName: '招商银行', weight: 3 }
      ],
      nav
    },
    {
      code: '000002',
      name: '基金B',
      marketValue: secondMarketValue,
      holdings: [
        { stockCode: '600519', stockName: '贵州茅台', weight: 8 },
        { stockCode: '000858', stockName: '五粮液', weight: 6 }
      ],
      nav
    }
  ]
}

describe('resolveFundWeights（组合权重口径）', () => {
  it('全部有持仓市值 → 按市值权重', () => {
    const r = resolveFundWeights([{ code: 'a', marketValue: 6000 }, { code: 'b', marketValue: 4000 }])
    expect(r.basis).toBe('position')
    expect(r.weights[0]).toBeCloseTo(60, 6)
    expect(r.weights[1]).toBeCloseTo(40, 6)
  })

  it('任一无持仓市值 → 退化为等权（避免未录入持仓的基金暴露被算成 0）', () => {
    const r = resolveFundWeights([{ code: 'a', marketValue: 6000 }, { code: 'b', marketValue: null }])
    expect(r.basis).toBe('equal')
    expect(r.weights).toEqual([50, 50])
  })
})

describe('pearson（相关系数）', () => {
  it('同向线性 → 1，反向 → -1，零方差 → null', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 6)
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1, 6)
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull()
  })
})

describe('analyzePortfolio（组合视角）', () => {
  it('按市值权重聚合个股暴露（暴露 = 基金权重 × 基金内权重）', () => {
    const p = analyzePortfolio(twoFunds(4000))
    expect(p.weightBasis).toBe('position')
    const maotai = p.topStocks.find((s) => s.stockCode === '600519')!
    expect(maotai.exposure).toBeCloseTo(9.2, 2) // 60%×10% + 40%×8%
    expect(maotai.fundCount).toBe(2)
    expect(maotai.funds[0].code).toBe('000001') // 贡献 6% > 3.2%，A 在前
    expect(p.totalExposure).toBeCloseTo(16.4, 2)
    expect(p.stockCount).toBe(4)
  })

  it('单只基金持有的股票不算重叠；共同重仓才算', () => {
    const p = analyzePortfolio(twoFunds(4000))
    expect(p.overlaps).toHaveLength(1)
    const o = p.overlaps[0]
    expect(o.commonCount).toBe(1)
    expect(o.commonStocks[0].stockCode).toBe('600519')
    expect(o.overlapPct).toBeCloseTo(57.1, 1) // min(10,8)/min(18,14)
  })

  it('暴露达到阈值标记 high（隐性集中度提示）', () => {
    const nav = navSeq(25, (i) => 1 + i * 0.01)
    const funds: PortfolioFundInput[] = [
      {
        code: 'a',
        name: 'A',
        marketValue: 1000,
        holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 30 }],
        nav
      },
      {
        code: 'b',
        name: 'B',
        marketValue: 1000,
        holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 30 }],
        nav
      }
    ]
    const p = analyzePortfolio(funds)
    const maotai = p.topStocks[0]
    expect(maotai.exposure).toBeCloseTo(30, 2) // 50%×30% ×2
    expect(maotai.high).toBe(true)
    expect(p.concentration.top1).toBeCloseTo(100, 1) // 只有一只股票，已知暴露内占 100%
  })

  it('集中度在已知暴露内归一化（前十大口径、合计 < 100%）', () => {
    const p = analyzePortfolio(twoFunds(4000))
    expect(p.concentration.top1).toBeCloseTo(56.1, 1) // 9.2 / 16.4
    expect(p.concentration.top3).toBeCloseTo(89.03, 1)
    expect(p.concentration.hhi).toBeGreaterThan(0.3)
    expect(p.totalExposure).toBeLessThan(100) // 前十大覆盖不足全仓，属预期
  })

  it('相关性按共同交易日对齐；样本不足 MIN_CORR_DAYS 不产出', () => {
    const p = analyzePortfolio(twoFunds(4000))
    expect(p.correlations).toHaveLength(1)
    expect(p.correlations[0].corr).toBeCloseTo(1, 3) // 净值序列相同
    expect(p.correlations[0].commonDays).toBe(24)

    const short = twoFunds(4000).map((f) => ({ ...f, nav: navSeq(10, (i) => 1 + i * 0.01) }))
    expect(analyzePortfolio(short).correlations).toHaveLength(0)
    expect(MIN_CORR_DAYS).toBe(20)
  })

  it('无重仓股：集中度为零、无重叠，但相关性仍可算', () => {
    const noHold = twoFunds(4000).map((f) => ({ ...f, holdings: [] }))
    const p = analyzePortfolio(noHold)
    expect(p.stockCount).toBe(0)
    expect(p.totalExposure).toBe(0)
    expect(p.concentration).toEqual({ top1: 0, top3: 0, top5: 0, hhi: 0 })
    expect(p.overlaps).toHaveLength(0)
    expect(p.correlations).toHaveLength(1)
  })

  it('忽略权重缺失/非正的持仓行', () => {
    const nav = navSeq(25, (i) => 1 + i * 0.01)
    const p = analyzePortfolio([
      {
        code: 'a',
        name: 'A',
        marketValue: 1000,
        holdings: [
          { stockCode: '600519', stockName: '贵州茅台', weight: null },
          { stockCode: '300750', stockName: '宁德时代', weight: 0 },
          { stockCode: '600036', stockName: '招商银行', weight: 4 }
        ],
        nav
      }
    ])
    expect(p.stockCount).toBe(1)
    expect(p.topStocks[0].stockCode).toBe('600036')
    expect(p.totalExposure).toBeCloseTo(4, 2) // 单基金等权 100% × 4%
  })
})

describe('currentWeightPct（当前占组合比例，用于对比建议仓位）', () => {
  it('按持仓市值占总市值的比例计算', () => {
    const ps = [
      { fundCode: 'a', marketValue: 6000 },
      { fundCode: 'b', marketValue: 4000 }
    ]
    expect(currentWeightPct(ps, 'a')).toBeCloseTo(60, 6)
    expect(currentWeightPct(ps, 'b')).toBeCloseTo(40, 6)
  })

  it('无持仓 / 总市值为 0 / 该基金不在持仓中 → null（没有"当前占比"可比）', () => {
    expect(currentWeightPct([], 'a')).toBeNull()
    expect(currentWeightPct([{ fundCode: 'a', marketValue: null }], 'a')).toBeNull()
    expect(currentWeightPct([{ fundCode: 'a', marketValue: 0 }], 'a')).toBeNull()
    expect(currentWeightPct([{ fundCode: 'b', marketValue: 100 }], 'a')).toBeNull()
  })
})

describe('formatPortfolioContext（喂给 AI 的单基金组合上下文）', () => {
  it('描述组合权重、重叠基金与共同重仓股', () => {
    const p = analyzePortfolio(twoFunds(4000))
    const text = formatPortfolioContext(p, '000001')!
    expect(text).toContain('组合上下文')
    expect(text).toContain('该基金占组合 60%')
    expect(text).toContain('按持仓市值')
    expect(text).toContain('基金B')
    expect(text).toContain('重仓重叠度 57.1%')
    expect(text).toContain('贵州茅台')
  })

  it('站在另一只基金视角时方向对称（基金对名称取对方）', () => {
    const p = analyzePortfolio(twoFunds(4000))
    const text = formatPortfolioContext(p, '000002')!
    expect(text).toContain('该基金占组合 40%')
    expect(text).toContain('基金A')
  })

  it('只有一只基金 / 无重叠无相关性时返回 null（不拼空块）', () => {
    const single = twoFunds(4000).slice(0, 1)
    expect(formatPortfolioContext(analyzePortfolio(single), '000001')).toBeNull()

    // 两只基金完全不同的重仓股，且净值序列无共同交易日（无法算相关性）
    const nav = navSeq(25, (i) => 1 + i * 0.01)
    const disjoint = [
      { code: 'a', name: 'A', marketValue: 1000, holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 10 }], nav },
      { code: 'b', name: 'B', marketValue: 1000, holdings: [{ stockCode: '000858', stockName: '五粮液', weight: 10 }], nav: [] }
    ]
    expect(formatPortfolioContext(analyzePortfolio(disjoint), 'a')).toBeNull()
  })

  it('组合层面暴露偏高的个股会被点出', () => {
    const nav = navSeq(25, (i) => 1 + i * 0.01)
    const funds: PortfolioFundInput[] = [
      {
        code: 'a',
        name: 'A',
        marketValue: 1000,
        holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 30 }],
        nav
      },
      {
        code: 'b',
        name: 'B',
        marketValue: 1000,
        holdings: [{ stockCode: '600519', stockName: '贵州茅台', weight: 30 }],
        nav
      }
    ]
    const text = formatPortfolioContext(analyzePortfolio(funds), 'a')!
    expect(text).toContain('合计暴露已偏高')
    expect(text).toContain('贵州茅台')
    expect(text).toContain('组合 30%')
  })
})
