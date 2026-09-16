// 提醒规则单测（alerts/rules）：各类型阈值判定、0=关闭、盘中/盘后类型分流、情绪识别、数据新鲜度门禁
import { describe, it, expect } from 'vitest'
import { evaluateAlerts, isNegativeSentiment, INTRADAY_ALERT_TYPES, CLOSE_ALERT_TYPES } from '../src/main/alerts/rules'
import type { AlertFundInput, AlertThresholds, AlertTimeContext } from '../src/main/alerts/rules'

const T: AlertThresholds = {
  navMovePct: 3,
  estimateMovePct: 3,
  estimateOffPct: 2,
  badNews: true,
  takeProfitPct: 20,
  stopLossPct: 10
}

/** 交易日当天：当期数据日期 = 今天 */
const CTX: AlertTimeContext = { today: '2026-09-16', expectedDataDate: '2026-09-16' }
/** 本地时刻的 ISO：用本地字段构造，避免测试受时区影响 */
function localIso(y: number, mo: number, d: number, h = 0, mi = 0): string {
  return new Date(y, mo - 1, d, h, mi).toISOString()
}
/** 今天 14:55 采样的估值时间 */
const EST_TODAY = localIso(2026, 9, 16, 14, 55)

function fund(over: Partial<AlertFundInput> = {}): AlertFundInput {
  return {
    code: '012322',
    name: '东财云计算指数增强C',
    navChangePct: null,
    navDate: null,
    estPct: null,
    estSource: null,
    estTime: null,
    estimateOffPct: null,
    estimateOffDate: null,
    pnlPct: null,
    badNewsTitles: [],
    ...over
  }
}

/** 只取类型，便于断言 */
function types(items: { type: string }[]): string[] {
  return items.map((i) => i.type).sort()
}

describe('isNegativeSentiment（情绪识别）', () => {
  it('识别 NEGATIVE（含大小写）与中文利空', () => {
    expect(isNegativeSentiment('NEGATIVE')).toBe(true)
    expect(isNegativeSentiment('negative')).toBe(true)
    expect(isNegativeSentiment(' 利空 ')).toBe(true)
    expect(isNegativeSentiment('POSITIVE')).toBe(false)
    expect(isNegativeSentiment('NEUTRAL')).toBe(false)
    expect(isNegativeSentiment(null)).toBe(false)
  })
})

describe('evaluateAlerts（阈值判定）', () => {
  it('净值涨跌达到阈值才提醒，未达不提醒', () => {
    expect(types(evaluateAlerts([fund({ navChangePct: -3.5, navDate: '2026-09-16' })], T, CTX))).toEqual(['nav_move'])
    expect(types(evaluateAlerts([fund({ navChangePct: 2.9, navDate: '2026-09-16' })], T, CTX))).toEqual([])
    expect(types(evaluateAlerts([fund({ navChangePct: 3, navDate: '2026-09-16' })], T, CTX))).toEqual(['nav_move']) // 等于阈值也算
  })

  it('盘中估值异动带出来源中文名与采样时刻', () => {
    const items = evaluateAlerts([fund({ estPct: 4.2, estSource: 'holdings_weighted', estTime: EST_TODAY })], T, CTX)
    expect(items[0].type).toBe('estimate_move')
    expect(items[0].body).toContain('重仓股加权')
    expect(items[0].body).toContain('14:55 采样')
    expect(items[0].body).toContain('盘中估值为预测值')
  })

  it('估值失真按绝对值判断并说明原因', () => {
    const items = evaluateAlerts([fund({ estimateOffPct: -2.4, estimateOffDate: '2026-09-16' })], T, CTX)
    expect(items[0].type).toBe('estimate_off')
    expect(items[0].title).toContain('偏差 2.40')
    expect(items[0].body).toContain('2026-09-16')
  })

  it('止盈/止损按持仓收益率方向判断（边界互斥）', () => {
    const d = '2026-09-16'
    expect(types(evaluateAlerts([fund({ pnlPct: 25, navDate: d })], T, CTX))).toEqual(['take_profit'])
    expect(types(evaluateAlerts([fund({ pnlPct: -12, navDate: d })], T, CTX))).toEqual(['stop_loss'])
    expect(types(evaluateAlerts([fund({ pnlPct: 19.9, navDate: d })], T, CTX))).toEqual([])
    expect(types(evaluateAlerts([fund({ pnlPct: -9.9, navDate: d })], T, CTX))).toEqual([])
    // -10 恰好等于止损阈值
    expect(types(evaluateAlerts([fund({ pnlPct: -10, navDate: d })], T, CTX))).toEqual(['stop_loss'])
  })

  it('重仓股负面新闻取前 2 条正文', () => {
    const items = evaluateAlerts([fund({ badNewsTitles: ['甲被减持', '乙业绩下滑', '丙被问询'] })], T, CTX)
    expect(items[0].type).toBe('bad_news')
    expect(items[0].body).toContain('甲被减持')
    expect(items[0].body).toContain('乙业绩下滑')
    expect(items[0].body).not.toContain('丙被问询')
  })

  it('阈值为 0 表示关闭该项', () => {
    const off: AlertThresholds = { ...T, navMovePct: 0, estimateMovePct: 0, estimateOffPct: 0, badNews: false, takeProfitPct: 0, stopLossPct: 0 }
    const p = fund({
      navChangePct: -9,
      navDate: '2026-09-16',
      estPct: 9,
      estTime: EST_TODAY,
      estimateOffPct: 9,
      estimateOffDate: '2026-09-16',
      pnlPct: 99,
      badNewsTitles: ['x']
    })
    expect(evaluateAlerts([p], off, CTX)).toEqual([])
  })

  it('一条数据缺失不影响其他规则（null 安全）', () => {
    expect(evaluateAlerts([fund()], T, CTX)).toEqual([])
    // 无持仓（pnlPct null）但净值异动，仍照常提醒
    expect(types(evaluateAlerts([fund({ navChangePct: -5, pnlPct: null, navDate: '2026-09-16' })], T, CTX))).toEqual(['nav_move'])
  })

  it('同一基金可同时触发多条（净值异动 + 止盈）', () => {
    expect(types(evaluateAlerts([fund({ navChangePct: 4, pnlPct: 30, navDate: '2026-09-16' })], T, CTX))).toEqual([
      'nav_move',
      'take_profit'
    ])
  })

  it('盘中只看估值类：净值/持仓是昨日数据，提前触发会误报并占掉当天去重名额', () => {
    const p = fund({
      navChangePct: -9,
      navDate: '2026-09-16',
      estPct: 5,
      estTime: EST_TODAY,
      estimateOffPct: 8,
      estimateOffDate: '2026-09-16',
      pnlPct: 50,
      badNewsTitles: ['x']
    })
    expect(types(evaluateAlerts([p], T, CTX, INTRADAY_ALERT_TYPES))).toEqual(['estimate_move'])
    expect(types(evaluateAlerts([p], T, CTX, CLOSE_ALERT_TYPES))).toEqual(['bad_news', 'estimate_off', 'nav_move', 'take_profit'])
  })
})

describe('evaluateAlerts（数据新鲜度门禁）', () => {
  // 手动触发（--alerts / 设置页按钮）时库里数据可能陈旧：拿一个月前的采样推"当前估值 -4%"会误导，
  // 而且去重键含交易日，误报会占掉当天名额，真实数据到达后反而不再提醒。
  it('过期盘中估值不触发（隔夜/无采样时间）', () => {
    const stale = fund({ estPct: 9, estSource: 'theme_etf', estTime: localIso(2026, 9, 15, 14, 0) })
    expect(evaluateAlerts([stale], T, CTX, INTRADAY_ALERT_TYPES)).toEqual([])
    expect(evaluateAlerts([fund({ estPct: 9, estTime: null })], T, CTX, INTRADAY_ALERT_TYPES)).toEqual([])
    // 同一天但日期字段不同（跨月）也不认
    expect(evaluateAlerts([fund({ estPct: 9, estTime: localIso(2026, 8, 19, 14, 0) })], T, CTX, INTRADAY_ALERT_TYPES)).toEqual([])
  })

  it('过期净值/估值失真/持仓收益率都不触发', () => {
    const stale = fund({
      navChangePct: -9,
      navDate: '2026-09-11',
      estimateOffPct: 8,
      estimateOffDate: '2026-08-19',
      pnlPct: 50
    })
    expect(evaluateAlerts([stale], T, CTX, CLOSE_ALERT_TYPES)).toEqual([])
    // 无净值日期（无净值数据）同样不触发止盈止损
    expect(types(evaluateAlerts([fund({ pnlPct: 50 })], T, CTX, CLOSE_ALERT_TYPES))).toEqual([])
  })

  it('非交易日：当期数据日期=最近交易日，周五净值周六盘后仍可评', () => {
    const satCtx: AlertTimeContext = { today: '2026-09-19', expectedDataDate: '2026-09-18' } // 周六 / 周五
    expect(types(evaluateAlerts([fund({ navChangePct: -4, navDate: '2026-09-18' })], T, satCtx, CLOSE_ALERT_TYPES))).toEqual(['nav_move'])
    // 周五采的估值周六不能当"当前估值"
    const friEst = localIso(2026, 9, 18, 14, 30)
    expect(evaluateAlerts([fund({ estPct: 6, estTime: friEst })], T, satCtx, INTRADAY_ALERT_TYPES)).toEqual([])
  })
})
