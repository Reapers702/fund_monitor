// 调度器交易时段判断单测
import { describe, it, expect } from 'vitest'
import { isTradingDay, isIntraday, isAfterClose } from '../src/main/scheduler/time'

describe('isTradingDay（交易日判断，仅周末）', () => {
  it('周一到周五为交易日', () => {
    expect(isTradingDay(new Date(2026, 7, 10))).toBe(true) // 周一
    expect(isTradingDay(new Date(2026, 7, 11))).toBe(true) // 周二
    expect(isTradingDay(new Date(2026, 7, 14))).toBe(true) // 周五
  })

  it('周六周日非交易日', () => {
    expect(isTradingDay(new Date(2026, 7, 15))).toBe(false) // 周六
    expect(isTradingDay(new Date(2026, 7, 16))).toBe(false) // 周日
  })
})

describe('isIntraday（盘中时段）', () => {
  it('上午 9:30-11:30 为盘中', () => {
    expect(isIntraday(9 * 60 + 30)).toBe(true)
    expect(isIntraday(10 * 60)).toBe(true)
    expect(isIntraday(11 * 60 + 30)).toBe(true)
  })

  it('午休 11:31-12:59 非盘中', () => {
    expect(isIntraday(11 * 60 + 31)).toBe(false)
    expect(isIntraday(12 * 60)).toBe(false)
    expect(isIntraday(12 * 60 + 59)).toBe(false)
  })

  it('下午 13:00-15:00 为盘中', () => {
    expect(isIntraday(13 * 60)).toBe(true)
    expect(isIntraday(14 * 60 + 30)).toBe(true)
    expect(isIntraday(15 * 60)).toBe(true)
  })

  it('盘前/盘后非盘中', () => {
    expect(isIntraday(9 * 60 + 29)).toBe(false)
    expect(isIntraday(15 * 60 + 1)).toBe(false)
    expect(isIntraday(0)).toBe(false)
  })
})

describe('isAfterClose（盘后）', () => {
  it('15:30 及之后为盘后', () => {
    expect(isAfterClose(15 * 60 + 30)).toBe(true)
    expect(isAfterClose(18 * 60)).toBe(true)
    expect(isAfterClose(23 * 60 + 59)).toBe(true)
  })

  it('盘中/盘前非盘后', () => {
    expect(isAfterClose(15 * 60 + 29)).toBe(false)
    expect(isAfterClose(9 * 60)).toBe(false)
    expect(isAfterClose(0)).toBe(false)
  })
})
