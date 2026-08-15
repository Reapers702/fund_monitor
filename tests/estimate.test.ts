// 盘中估值单测：findTrackingIndex 规则匹配（T1/T2）+ estimateT3 重仓股加权（T3）
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  quoteBySecid: vi.fn()
}))

vi.mock('../src/main/crawler/market', () => ({
  quoteBySecid: mocks.quoteBySecid,
  secidOf: (code: string) => (code.startsWith('6') ? `1.${code}` : `0.${code}`)
}))

import { findTrackingIndex, estimateT3 } from '../src/main/crawler/estimate'

describe('findTrackingIndex（T1 指数 / T2 主题ETF 规则匹配）', () => {
  it('指数型基金命中 T1 跟踪指数', () => {
    const r = findTrackingIndex('易方达沪深300ETF联接A')
    expect(r).toEqual({ secid: '1.000300', name: '沪深300', source: 'tracking_index' })
  })

  it('云计算主题基金命中 T2 主题 ETF（516510）', () => {
    const r = findTrackingIndex('东财云计算增强C')
    expect(r).toEqual({ secid: '1.516510', name: '云计算ETF', source: 'theme_etf' })
  })

  it('半导体主题命中 T2', () => {
    const r = findTrackingIndex('华夏国证半导体芯片ETF联接C')
    expect(r?.secid).toBe('1.512480')
    expect(r?.source).toBe('theme_etf')
  })

  it('主动型基金无规则命中 → null（T3 兜底）', () => {
    expect(findTrackingIndex('富国天惠成长混合')).toBeNull()
  })

  it('具体规则优先于泛化规则（中证A500 不被中证A50 截胡）', () => {
    const r = findTrackingIndex('中证A500指数ETF')
    expect(r?.name).toBe('中证A500')
  })

  it('无关键词的基金返回 null', () => {
    expect(findTrackingIndex('某某灵活配置混合')).toBeNull()
  })
})

describe('estimateT3（最近季报重仓股按权重加权）', () => {
  beforeEach(() => {
    mocks.quoteBySecid.mockReset()
  })

  it('按权重加权得到估算涨跌幅', async () => {
    mocks.quoteBySecid.mockImplementation(async (secid: string) => {
      const pct: Record<string, number> = { '1.600519': 2.0, '1.600036': -1.0 }
      return { pct: pct[secid] ?? null }
    })
    const r = await estimateT3([
      { stockCode: '600519', stockName: '贵州茅台', weight: 30 },
      { stockCode: '600036', stockName: '招商银行', weight: 20 }
    ])
    expect(r?.pct).toBeCloseTo((30 * 2.0 + 20 * -1.0) / 50, 6)
    expect(r?.coveredWeight).toBe(50)
    expect(r?.totalWeight).toBe(50)
    expect(r?.source).toBe('holdings_weighted')
    expect(r?.details).toHaveLength(2)
  })

  it('行情失败的股票不计入加权但保留展示', async () => {
    mocks.quoteBySecid.mockResolvedValue({ pct: null })
    const r = await estimateT3([
      { stockCode: '600519', stockName: '贵州茅台', weight: 30 },
      { stockCode: '000001', stockName: '平安银行', weight: 20 }
    ])
    // 全部行情失败 → 覆盖权重 0，pct 为 null（不归一化产生虚假数值）
    expect(r?.pct).toBeNull()
    expect(r?.coveredWeight).toBe(0)
    expect(r?.details).toHaveLength(2)
    expect(r?.details[0].pct).toBeNull()
  })

  it('部分股票行情失败时按实际覆盖权重归一化', async () => {
    mocks.quoteBySecid.mockImplementation(async (secid: string) => {
      return { pct: secid === '1.600519' ? 2.0 : null }
    })
    const r = await estimateT3([
      { stockCode: '600519', stockName: '贵州茅台', weight: 30 },
      { stockCode: '600036', stockName: '招商银行', weight: 20 }
    ])
    expect(r?.pct).toBeCloseTo(2.0, 6)
    expect(r?.coveredWeight).toBe(30)
    expect(r?.totalWeight).toBe(50)
  })

  it('无有效持仓（代码缺失或权重为 0/空）返回 null', async () => {
    expect(
      await estimateT3([
        { stockCode: null, stockName: '现金', weight: 50 },
        { stockCode: '600519', stockName: null, weight: 0 }
      ])
    ).toBeNull()
    expect(await estimateT3([])).toBeNull()
  })
})
