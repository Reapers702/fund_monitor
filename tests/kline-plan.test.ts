// 日K 补拉决策单测（P1 修复："本地有最近交易日的行"曾被实时价快照满足，导致日K 永远不补/不校正）
import { describe, it, expect } from 'vitest'
import { decideKlineNeed, filterFinalKlines } from '../src/main/klinePlan'

const BASE = {
  latestClosed: '2026-10-12',
  markerAt: undefined as number | undefined,
  now: Date.parse('2026-10-13T10:00:00+08:00'),
  minIntervalMs: 6 * 60 * 60 * 1000
}

describe('decideKlineNeed（日K 是否需要向数据源核对）', () => {
  it('官方日K 已覆盖最近已收盘交易日 → have（不再重复拉）', () => {
    expect(decideKlineNeed({ ...BASE, latestKlineDate: '2026-10-12' })).toBe('have')
    expect(decideKlineNeed({ ...BASE, latestKlineDate: '2026-10-13' })).toBe('have')
  })

  it('只有实时价快照（source≠kline，即 latestKlineDate 为 null）→ 需要补拉', () => {
    // 这正是"跳过 120 只"的根因场景：stock_daily 里有 10-13 的快照行，但没有官方日K
    expect(decideKlineNeed({ ...BASE, latestKlineDate: null })).toBe('fetch')
    expect(decideKlineNeed({ ...BASE, latestKlineDate: '2026-10-09' })).toBe('fetch')
  })

  it('6 小时内刚补过（数据源当天K线可能还没更新）→ throttled', () => {
    expect(
      decideKlineNeed({
        ...BASE,
        latestKlineDate: '2026-10-09',
        markerAt: BASE.now - 60 * 60 * 1000
      })
    ).toBe('throttled')
  })

  it('超过最短间隔后可再次补拉（收盘后校正当天日K 走这条）', () => {
    expect(
      decideKlineNeed({
        ...BASE,
        latestKlineDate: '2026-10-09',
        markerAt: BASE.now - 7 * 60 * 60 * 1000
      })
    ).toBe('fetch')
  })

  it('本地已最新时不看节流标记（have 优先）', () => {
    expect(
      decideKlineNeed({ ...BASE, latestKlineDate: '2026-10-12', markerAt: BASE.now - 1000 })
    ).toBe('have')
  })
})

describe('filterFinalKlines（只落已定型的日K）', () => {
  it('剔除当天未定型的那根，保留历史', () => {
    const rows = [
      { tradeDate: '2026-10-09', close: 1 },
      { tradeDate: '2026-10-12', close: 2 },
      { tradeDate: '2026-10-13', close: 3 } // 盘中部分K线，不能当收盘数据落库
    ]
    expect(filterFinalKlines(rows, '2026-10-12').map((r) => r.tradeDate)).toEqual([
      '2026-10-09',
      '2026-10-12'
    ])
  })

  it('收盘后目标日=今天时保留当天', () => {
    const rows = [{ tradeDate: '2026-10-13', close: 3 }]
    expect(filterFinalKlines(rows, '2026-10-13')).toHaveLength(1)
  })

  it('脏日期（非 YYYY-MM-DD）被丢掉', () => {
    const rows = [{ tradeDate: '2026-10-13 00:00:00', close: 3 }]
    expect(filterFinalKlines(rows, '2026-10-13')).toHaveLength(0)
  })
})
