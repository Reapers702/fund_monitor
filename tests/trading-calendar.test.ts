// 交易日历单测：静态休市表 + 周末判断（网络接口路径由实测覆盖）
import { describe, it, expect } from 'vitest'
import { isTradingDayStatic } from '../src/main/scheduler/tradingCalendar'

describe('isTradingDayStatic（静态交易日判断）', () => {
  it('工作日为交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 7, 10))).toBe(true) // 2026-08-10 周一
    expect(isTradingDayStatic(new Date(2026, 7, 12))).toBe(true) // 2026-08-12 周三
    expect(isTradingDayStatic(new Date(2026, 7, 14))).toBe(true) // 2026-08-14 周五
  })

  it('周六周日非交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 7, 15))).toBe(false) // 周六
    expect(isTradingDayStatic(new Date(2026, 7, 16))).toBe(false) // 周日
  })

  it('节假日（2026 元旦）非交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 0, 1))).toBe(false) // 2026-01-01 元旦（周四）
  })

  it('节假日（2026 国庆）非交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 9, 1))).toBe(false) // 2026-10-01 国庆（周四）
    expect(isTradingDayStatic(new Date(2026, 9, 2))).toBe(false) // 2026-10-02
  })

  it('节假日（2026 春节）非交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 1, 17))).toBe(false) // 2026-02-17 春节（周二）
    expect(isTradingDayStatic(new Date(2026, 1, 18))).toBe(false) // 2026-02-18
  })

  it('2027 节假日非交易日', () => {
    expect(isTradingDayStatic(new Date(2027, 9, 1))).toBe(false) // 2027-10-01 国庆（周五）
  })

  it('节假日相邻工作日为交易日（非长假）', () => {
    expect(isTradingDayStatic(new Date(2026, 0, 5))).toBe(true) // 2026-01-05 元旦后周一
  })
})
