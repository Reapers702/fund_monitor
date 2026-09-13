// AI 建议复盘单测（analyzer/review）：入场日口径、命中判定、未满期处理、置信度分档
import { describe, it, expect } from 'vitest'
import { evaluateAdviceReviews, HIGH_CONFIDENCE } from '../src/main/analyzer/review'
import type { ReviewAdviceInput, ReviewNavPoint } from '../src/main/analyzer/review'

/** 构造连续交易日的净值序列（date 为 2026-01-01 起的第 n 日，净值按传入数组） */
function navs(values: number[]): ReviewNavPoint[] {
  return values.map((v, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, '0')}`,
    nav: v
  }))
}

function advice(id: number, tradeDate: string, action: string, confidence: number | null = null): ReviewAdviceInput {
  return { id, tradeDate, action, confidence }
}

describe('evaluateAdviceReviews（建议后 N 日复盘）', () => {
  it('入场日取建议日之后第一个交易日（避免前视偏差）', () => {
    const nav = navs([1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6])
    const r = evaluateAdviceReviews([advice(1, '2026-01-01', 'add')], nav, [1])
    expect(r.items[0].entryDate).toBe('2026-01-02')
    expect(r.items[0].entryNav).toBeCloseTo(1.1, 6)
    // 入场后 1 日：1.2 / 1.1 - 1 ≈ +9.09%
    expect(r.items[0].returns[0]).toBeCloseTo(9.0909, 3)
  })

  it('add 后续上涨算命中，reduce 后续上涨算未命中', () => {
    const nav = navs([1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5])
    const r = evaluateAdviceReviews(
      [advice(1, '2026-01-01', 'add'), advice(2, '2026-01-01', 'reduce')],
      nav,
      [2]
    )
    expect(r.items[0].hits[0]).toBe(true)
    expect(r.items[1].hits[0]).toBe(false)
    // 分母只算 add/reduce，命中 1/2
    expect(r.stats[0].matured).toBe(2)
    expect(r.stats[0].hits).toBe(1)
    expect(r.stats[0].hitRate).toBeCloseTo(50, 6)
  })

  it('hold 无方向：不计入命中率，但统计后续收益（已评估仍计数）', () => {
    const nav = navs([1.0, 1.0, 1.1, 1.2, 1.3])
    const r = evaluateAdviceReviews([advice(1, '2026-01-01', 'hold')], nav, [2])
    expect(r.stats[0].matured).toBe(0)
    expect(r.stats[0].evaluated).toBe(1) // 有可复盘数据，只是无方向
    expect(r.stats[0].hitRate).toBeNull()
    expect(r.stats[0].avgRetHold).toBeCloseTo(20, 6) // 1.0 → 1.2
    expect(r.items[0].hits[0]).toBeNull()
  })

  it('未满 N 个交易日不给收益，避免把"还没走完"当成"没命中"', () => {
    const nav = navs([1.0, 1.1, 1.2])
    const r = evaluateAdviceReviews([advice(1, '2026-01-01', 'add')], nav, [5, 10])
    expect(r.items[0].returns).toEqual([null, null])
    expect(r.items[0].hits).toEqual([null, null])
    expect(r.stats.every((s) => s.matured === 0 && s.evaluated === 0 && s.hitRate === null)).toBe(true)
  })

  it('建议日晚于全部净值（太新）时入场日为空', () => {
    const nav = navs([1.0, 1.1])
    const r = evaluateAdviceReviews([advice(1, '2026-02-01', 'add')], nav, [5])
    expect(r.items[0].entryDate).toBeNull()
    expect(r.items[0].entryNav).toBeNull()
    expect(r.items[0].returns[0]).toBeNull()
  })

  it('置信度分档：高置信 ≥70 与低置信分开统计', () => {
    const nav = navs([1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5])
    const r = evaluateAdviceReviews(
      [advice(1, '2026-01-01', 'add', 90), advice(2, '2026-01-01', 'add', 50)],
      nav,
      [2]
    )
    const s = r.stats[0]
    expect(s.highConfTotal).toBe(1)
    expect(s.highConfHit).toBe(1)
    expect(s.lowConfTotal).toBe(1)
    expect(s.lowConfHit).toBe(1)
    expect(HIGH_CONFIDENCE).toBe(70)
  })

  it('净值序列乱序不影响结果（内部按日期升序）', () => {
    const ordered = navs([1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6])
    const shuffled = [...ordered].reverse()
    const a = evaluateAdviceReviews([advice(1, '2026-01-01', 'add')], ordered, [3])
    const b = evaluateAdviceReviews([advice(1, '2026-01-01', 'add')], shuffled, [3])
    expect(b.items[0].returns[0]).toBeCloseTo(a.items[0].returns[0]!, 6)
    expect(b.items[0].entryDate).toBe(a.items[0].entryDate)
  })

  it('add 后平均收益与 reduce 后平均收益分开统计', () => {
    // 同一入场日下 add 与 reduce 的后续收益各自成组（add 组涨 10%，reduce 组同样涨 10% = 减错）
    const nav = navs([1.0, 1.0, 1.1, 1.0, 1.0, 1.0, 1.0])
    const r = evaluateAdviceReviews(
      [advice(1, '2026-01-01', 'add'), advice(2, '2026-01-01', 'reduce')],
      nav,
      [1]
    )
    expect(r.stats[0].avgRetAdd).toBeCloseTo(10, 6)
    expect(r.stats[0].avgRetReduce).toBeCloseTo(10, 6)
  })
})
