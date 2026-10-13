// 交易日历单测：静态休市表 + 周末判断 + 最近交易日（网络接口路径由实测覆盖）
import { describe, it, expect } from 'vitest'
import {
  isTradingDayStatic,
  latestClosedTradingDayStr,
  latestTradingDayStr
} from '../src/main/scheduler/tradingCalendar'

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
    expect(isTradingDayStatic(new Date(2026, 1, 15))).toBe(false) // 2026-02-15 春节假期
    expect(isTradingDayStatic(new Date(2026, 1, 17))).toBe(false) // 2026-02-17
    expect(isTradingDayStatic(new Date(2026, 1, 23))).toBe(false) // 2026-02-23 春节最后一天（调休）
  })

  it('2026 劳动节 1-5 非交易日', () => {
    expect(isTradingDayStatic(new Date(2026, 4, 1))).toBe(false) // 2026-05-01
    expect(isTradingDayStatic(new Date(2026, 4, 5))).toBe(false) // 2026-05-05
  })

  it('2027 节假日非交易日', () => {
    expect(isTradingDayStatic(new Date(2027, 9, 1))).toBe(false) // 2027-10-01 国庆（周五）
  })

  it('节假日相邻工作日为交易日（非长假）', () => {
    expect(isTradingDayStatic(new Date(2026, 0, 5))).toBe(true) // 2026-01-05 元旦后周一
    expect(isTradingDayStatic(new Date(2026, 1, 24))).toBe(true) // 2026-02-24 春节后恢复
  })
})

describe('latestTradingDayStr（最近交易日：非交易日盘后补净值的目标）', () => {
  it('周六返回上一个周五', () => {
    expect(latestTradingDayStr(new Date(2026, 7, 15))).toBe('2026-08-14') // 08-15 周六 → 08-14 周五
    expect(latestTradingDayStr(new Date(2026, 7, 16))).toBe('2026-08-14') // 08-16 周日 → 08-14 周五
  })

  it('交易日返回当天', () => {
    expect(latestTradingDayStr(new Date(2026, 7, 14))).toBe('2026-08-14') // 周五
    expect(latestTradingDayStr(new Date(2026, 7, 12))).toBe('2026-08-12') // 周三
  })

  it('长假后首个工作日返回当天', () => {
    expect(latestTradingDayStr(new Date(2026, 9, 8))).toBe('2026-10-08') // 10-08 周四，国庆后首个交易日
  })

  it('长假中间日期向前回退跨节假日', () => {
    // 2026-10-06 周二（国庆假期内）→ 上一个交易日为 2026-09-30 周三
    expect(latestTradingDayStr(new Date(2026, 9, 6))).toBe('2026-09-30')
  })
})

describe('latestClosedTradingDayStr（最近"已收盘"交易日：日K 该定型到哪一天）', () => {
  it('交易日收盘前 → 上一个交易日（当天日K 还没定型）', () => {
    expect(latestClosedTradingDayStr(new Date(2026, 9, 13, 10, 0))).toBe('2026-10-12')
    expect(latestClosedTradingDayStr(new Date(2026, 9, 13, 13, 30))).toBe('2026-10-12')
    expect(latestClosedTradingDayStr(new Date(2026, 9, 13, 15, 0))).toBe('2026-10-12') // 15:00 收盘但数据未落定
  })

  it('交易日 15:30 后 → 当天（K线应已定型，收盘校正的目标日）', () => {
    expect(latestClosedTradingDayStr(new Date(2026, 9, 13, 15, 30))).toBe('2026-10-13')
    expect(latestClosedTradingDayStr(new Date(2026, 9, 13, 21, 0))).toBe('2026-10-13')
  })

  it('周末/节假日 → 上一个交易日（周末永远没有日K）', () => {
    expect(latestClosedTradingDayStr(new Date(2026, 9, 10, 12, 0))).toBe('2026-10-09') // 周六
    expect(latestClosedTradingDayStr(new Date(2026, 9, 11, 20, 0))).toBe('2026-10-09') // 周日
    expect(latestClosedTradingDayStr(new Date(2026, 9, 2, 16, 0))).toBe('2026-09-30') // 国庆假期内
  })
})
