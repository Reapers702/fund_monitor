// 盘中估值块单测：formatEstimateBlock（当日过滤 + 30 分钟窗口抽稀 + 来源中文名 + 最多 12 条）
import { describe, it, expect } from 'vitest'
import { formatEstimateBlock } from '../src/main/analyzer/analyze'
import type { EstPoint } from '../src/main/storage/queries'

/** 本地日期+时分 → EstPoint（time 存 UTC ISO，与 estimateSeries 返回一致；构造与读取都在本地时区，往返稳定） */
function pt(date: string, hh: number, mm: number, pct: number | null, source = 'tracking_index'): EstPoint {
  const [y, m, d] = date.split('-').map(Number)
  return { time: new Date(y, m - 1, d, hh, mm).toISOString(), pct, source }
}

const TODAY = '2026-08-12'

describe('formatEstimateBlock（盘中估值块）', () => {
  it('无当日采样返回 null（盘前/非交易日）', () => {
    expect(formatEstimateBlock([], TODAY)).toBeNull()
    expect(formatEstimateBlock([pt('2026-08-11', 14, 30, 1.2)], TODAY)).toBeNull()
  })

  it('首行给出来源中文名 + 最新采样时间与涨跌', () => {
    const block = formatEstimateBlock([pt(TODAY, 10, 0, 0.5), pt(TODAY, 10, 30, 0.8)], TODAY)!
    const first = block.split('\n')[0]
    expect(first).toContain('跟踪指数')
    expect(first).toContain('最新 10:30')
    expect(first).toContain('0.80%')
  })

  it('同一 30 分钟窗口只留最后一条采样', () => {
    const block = formatEstimateBlock([pt(TODAY, 10, 5, 0.4), pt(TODAY, 10, 15, 0.6), pt(TODAY, 10, 28, 0.9)], TODAY)!
    const trendLines = block.split('\n').slice(2)
    expect(trendLines).toHaveLength(1)
    expect(trendLines[0]).toContain('10:28')
    expect(trendLines[0]).toContain('0.90%')
  })

  it('超过 12 个窗口时只保留最近 12 条', () => {
    const points: EstPoint[] = []
    for (let h = 9; h <= 14; h++) points.push(pt(TODAY, h, 0, h / 10), pt(TODAY, h, 30, h / 10))
    points.push(pt(TODAY, 15, 0, 1.5)) // 09:00~15:00 每 30 分钟，共 13 个不同窗口
    const block = formatEstimateBlock(points, TODAY)!
    const trendLines = block.split('\n').slice(2)
    expect(trendLines).toHaveLength(12)
    expect(trendLines[0]).toContain('09:30') // 最早的 09:00 被挤出
    expect(trendLines[trendLines.length - 1]).toContain('15:00')
  })

  it('估值缺失时显示 --', () => {
    const block = formatEstimateBlock([pt(TODAY, 10, 0, null)], TODAY)!
    expect(block).toContain('--')
  })

  it('source 映射：holdings_weighted → 重仓股加权；未知 source 保留原文', () => {
    const a = formatEstimateBlock([pt(TODAY, 10, 0, 1.1, 'holdings_weighted')], TODAY)!
    expect(a).toContain('重仓股加权')
    const b = formatEstimateBlock([pt(TODAY, 10, 0, 1.1, 'some_new_source')], TODAY)!
    expect(b).toContain('some_new_source')
  })

  it('混入昨日采样只取当日', () => {
    const block = formatEstimateBlock([pt('2026-08-11', 14, 30, 2.0), pt(TODAY, 9, 35, 0.2), pt(TODAY, 10, 5, 0.5)], TODAY)!
    const trendLines = block.split('\n').slice(2)
    expect(trendLines).toHaveLength(2)
    expect(block).not.toContain('14:30')
    expect(block).toContain('最新 10:05')
  })
})
