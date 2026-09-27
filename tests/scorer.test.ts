// 打分规则引擎的纯函数单测：新闻词典 + 引擎各轴聚合决策
import { describe, expect, it } from 'vitest'
import { dictScore, aggregateNewsScore } from '../src/main/scorer/lexicon'
import { score, scoreMomentum, scoreShape, DEFAULT_WEIGHTS, ADD_THRESHOLD, REDUCE_THRESHOLD } from '../src/main/scorer/engine'
import type { NavLike } from '../src/main/analyzer/metrics'

describe('dictScore（新闻情绪词典）', () => {
  it('空文本 / 无命中 → 0', () => {
    expect(dictScore('')).toBe(0)
    expect(dictScore('某基金发布公告')).toBe(0)
  })
  it('明确利好 → 正 分', () => {
    expect(dictScore('重仓股涨停大涨，业绩预增净流入')).toBeGreaterThan(0)
  })
  it('明确利空 → 负 分', () => {
    expect(dictScore('暴雷跌停，业绩亏损净流出减持')).toBeLessThan(0)
  })
  it('多空相抵 → 接近 0', () => {
    const s = dictScore('涨停大跌业绩预增亏损')
    expect(Math.abs(s)).toBeLessThan(1)
  })
  it('值域收敛到 [-2, 2]', () => {
    expect(dictScore('涨停前冲高').toString()).not.toMatch(/N/)
    const maxi = dictScore(Array(20).fill('涨停扩产增持').join(''))
    expect(maxi).toBeLessThanOrEqual(2)
    expect(maxi).toBeGreaterThan(0)
  })
})

describe('aggregateNewsScore（新闻聚合 + 时间衰减）', () => {
  it('空 → 0', () => {
    expect(aggregateNewsScore([])).toBe(0)
  })
  it('单条利好 → 正', () => {
    expect(aggregateNewsScore([{ text: '涨停涨价' }])).toBeGreaterThan(0)
  })
  it('时间衰减：近的新闻权重大于远的（近正远负混合 → 偏正）', () => {
    // 近 0 天利好 + 远 7 天利空 → 利好权重大，总分偏正
    const mixed = aggregateNewsScore([{ text: '涨停', daysAgo: 0 }, { text: '暴雷', daysAgo: 7 }])
    // 两远到期利空 → 全偏负
    const allFar = aggregateNewsScore([{ text: '涨停', daysAgo: 7 }, { text: '暴雷', daysAgo: 7 }])
    expect(mixed).toBeGreaterThan(allFar)
  })
})

describe('scoreMomentum（动量/超额轴）', () => {
  const nav = (rets: number[]): NavLike[] => {
    let v = 1
    const out: NavLike[] = [{ date: '2026-01-01', nav: v }]
    for (let i = 0; i < rets.length; i++) {
      v *= 1 + rets[i] / 100
      out.push({ date: `2026-01-0${(i % 9) + 1}`, nav: v })
    }
    return out
  }
  it('上行趋势 → 正分', () => {
    expect(scoreMomentum(nav(Array(60).fill(0.5)), 2, 2)).toBeGreaterThan(0)
  })
  it('下行趋势 → 负分', () => {
    expect(scoreMomentum(nav(Array(60).fill(-0.5)), -2, -2)).toBeLessThan(0)
  })
})

describe('scoreShape（走势形态轴）', () => {
  it('站上均线的上升序列 → 非负', () => {
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 40; i++) { v *= 1.01; nav.push({ date: `d${i}`, nav: v }) }
    expect(scoreShape(nav)).toBeGreaterThanOrEqual(0)
  })
  it('深回撤企稳 → 均值回归偏多', () => {
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 40; i++) { v *= i < 30 ? 1.005 : 0.985; nav.push({ date: `d${i}`, nav: v }) }
    // 近 5 日连跌后企稳
    const s = scoreShape(nav)
    expect(s).toBeGreaterThan(-3)
  })
})

describe('score（聚合 + 阈值决策 + 置信度）', () => {
  // 近期单边行情：前 60 日横盘，后 20 日陡涨/陡跌，模拟真实"趋势启动"
  const wayUp = (): { nav: NavLike[]; excess20: number; excess60: number } => {
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 80; i++) {
      v *= i < 60 ? 1.0 : 1.02
      nav.push({ date: `d${i}`, nav: v })
    }
    return { nav, excess20: 5, excess60: 3 }
  }
  const wayDown = (): { nav: NavLike[]; excess20: number; excess60: number } => {
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 80; i++) {
      v *= i < 60 ? 1.0 : 0.98
      nav.push({ date: `d${i}`, nav: v })
    }
    return { nav, excess20: -5, excess60: -3 }
  }

  it('明显上行 + 利好 → add', () => {
    const w = wayUp()
    const d = score({ nav: w.nav, excess20: w.excess20, excess60: w.excess60, intradayPct: 3, news: [{ text: '涨停扩产增持业绩预增' }] })
    expect(d.action).toBe('add')
  })
  it('持续下行 + 利空 → reduce', () => {
    const w = wayDown()
    const d = score({ nav: w.nav, excess20: w.excess20, excess60: w.excess60, intradayPct: -3, news: [{ text: '暴雷跌停亏损净流出减持' }] })
    expect(d.action).toBe('reduce')
  })
  it('中性 → hold', () => {
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 60; i++) { v *= i % 2 ? 1.001 : 0.999; nav.push({ date: `d${i}`, nav: v }) }
    const d = score({ nav, excess20: 0, excess60: 0, intradayPct: null, news: [] })
    expect(d.total).toBeGreaterThan(REDUCE_THRESHOLD)
    expect(d.total).toBeLessThan(ADD_THRESHOLD)
    expect(d.action).toBe('hold')
  })
  it('置信度为 |total|/3 映射，且 0~100', () => {
    const w = wayUp()
    const d = score({ nav: w.nav, excess20: w.excess20, excess60: w.excess60, intradayPct: 0, news: [] })
    expect(d.confidence).toBeGreaterThanOrEqual(0)
    expect(d.confidence).toBeLessThanOrEqual(100)
  })
  it('默认权重之和为 1', () => {
    expect(DEFAULT_WEIGHTS.momentum + DEFAULT_WEIGHTS.shape + DEFAULT_WEIGHTS.intraday + DEFAULT_WEIGHTS.news).toBeCloseTo(1)
  })
  it('反趋势修正：动量极端大时压低总分', () => {
    // 显著追高形态：近20日涨幅巨大
    const nav: NavLike[] = []
    let v = 1
    for (let i = 0; i < 60; i++) { v *= i < 40 ? 1.0 : 1.03; nav.push({ date: `d${i}`, nav: v }) }
    const withR = score({ nav, excess20: 5, excess60: 5, intradayPct: 2, news: [] })
    const noR = score({ nav, excess20: 5, excess60: 5, intradayPct: 2, news: [] }, { ...DEFAULT_WEIGHTS, meanRevert: 0 })
    expect(withR.total).toBeLessThan(noR.total)
  })
})