// 时点上下文单测：buildTimeContext / formatTimeContext
import { describe, it, expect } from 'vitest'
import { buildTimeContext, formatTimeContext } from '../src/main/analyzer/analyze'

function dt(y: number, mo: number, d: number, h: number, mi: number): Date {
  return new Date(y, mo - 1, d, h, mi)
}

describe('buildTimeContext（时点上下文构造）', () => {
  it('盘中交易日：phase=盘中，navIsToday=false（净值未公布）', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 10, 30), '2026-08-11', true)
    expect(t.date).toBe('2026-08-12')
    expect(t.weekday).toBe('三')
    expect(t.isTradingDay).toBe(true)
    expect(t.phase).toBe('盘中')
    expect(t.latestNavDate).toBe('2026-08-11')
    expect(t.navIsToday).toBe(false)
  })

  it('盘后交易日：净值已是今日', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 19, 0), '2026-08-12', true)
    expect(t.phase).toBe('盘后')
    expect(t.navIsToday).toBe(true)
  })

  it('非交易日盘前（周末早上）', () => {
    const t = buildTimeContext(dt(2026, 8, 15, 9, 0), '2026-08-14', false)
    expect(t.isTradingDay).toBe(false)
    expect(t.phase).toBe('盘前')
    expect(t.navIsToday).toBe(false)
  })

  it('盘前交易日（9:00 未开盘）', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 9, 0), '2026-08-11', true)
    expect(t.phase).toBe('盘前')
    expect(t.navIsToday).toBe(false)
  })

  it('午休时段归为盘前（11:31-12:59 不在盘中窗口）', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 12, 0), '2026-08-12', true)
    expect(t.phase).toBe('盘前')
  })
})

describe('formatTimeContext（时点说明文字）', () => {
  it('盘中未确认：提示以盘中估值参考', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 10, 30), '2026-08-11', true)
    const s = formatTimeContext(t)
    expect(s).toContain('2026-08-12')
    expect(s).toContain('交易日')
    expect(s).toContain('盘中')
    expect(s).toContain('最新净值尚未公布')
  })

  it('盘后已确认：明确为收盘确认值', () => {
    const t = buildTimeContext(dt(2026, 8, 12, 19, 0), '2026-08-12', true)
    const s = formatTimeContext(t)
    expect(s).toContain('收盘确认值')
    expect(s).toContain('盘后')
  })

  it('非交易日：明确标注', () => {
    const t = buildTimeContext(dt(2026, 8, 15, 9, 0), '2026-08-14', false)
    const s = formatTimeContext(t)
    expect(s).toContain('非交易日')
    expect(s).toContain('最近一个交易日')
  })
})
