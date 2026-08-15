// 持仓移动加权平均算法单测
import { describe, it, expect } from 'vitest'
import { computePositionFromTrades } from '../src/main/position/position'

describe('computePositionFromTrades（移动加权平均）', () => {
  it('两笔买入合并成本', () => {
    const r = computePositionFromTrades([
      { tradeType: 'buy', shares: 100, price: 1.0, fee: 0 },
      { tradeType: 'buy', shares: 100, price: 1.2, fee: 0 }
    ])
    expect(r.shares).toBe(200)
    expect(r.avgCost).toBeCloseTo(1.1, 6)
    expect(r.realizedPnl).toBe(0)
  })

  it('买入后部分卖出计已实现盈亏', () => {
    const r = computePositionFromTrades([
      { tradeType: 'buy', shares: 100, price: 1.0, fee: 0 },
      { tradeType: 'sell', shares: 40, price: 1.5, fee: 0 }
    ])
    expect(r.shares).toBe(60)
    expect(r.realizedPnl).toBeCloseTo(20, 6)
    expect(r.avgCost).toBeCloseTo(1.0, 6)
  })

  it('买入手续费计入成本', () => {
    const r = computePositionFromTrades([{ tradeType: 'buy', shares: 100, price: 1.0, fee: 5 }])
    expect(r.shares).toBe(100)
    expect(r.avgCost).toBeCloseTo(1.05, 6)
  })

  it('卖出超持份额时截断（不产生负持仓）', () => {
    const r = computePositionFromTrades([
      { tradeType: 'buy', shares: 50, price: 1.0, fee: 0 },
      { tradeType: 'sell', shares: 999, price: 1.0, fee: 0 }
    ])
    expect(r.shares).toBe(0)
  })

  it('卖出手续费计入已实现盈亏', () => {
    const r = computePositionFromTrades([
      { tradeType: 'buy', shares: 100, price: 1.0, fee: 0 },
      { tradeType: 'sell', shares: 100, price: 1.5, fee: 3 }
    ])
    expect(r.shares).toBe(0)
    expect(r.realizedPnl).toBeCloseTo(47, 6)
  })

  it('混合多笔：买-买-卖-买', () => {
    const r = computePositionFromTrades([
      { tradeType: 'buy', shares: 100, price: 1.0, fee: 0 },
      { tradeType: 'buy', shares: 100, price: 2.0, fee: 0 },
      { tradeType: 'sell', shares: 50, price: 1.8, fee: 0 },
      { tradeType: 'buy', shares: 50, price: 1.2, fee: 0 }
    ])
    // 成本 (100*1.0+100*2.0)/200 = 1.5；卖 50@1.8 → 已实现 0.3*50=15
    // 余 150 份成本 1.5；再买 50@1.2 → (150*1.5+50*1.2)/200 = 1.425
    expect(r.shares).toBe(200)
    expect(r.avgCost).toBeCloseTo(1.425, 6)
    expect(r.realizedPnl).toBeCloseTo(15, 6)
  })

  it('空流水返回零持仓', () => {
    const r = computePositionFromTrades([])
    expect(r.shares).toBe(0)
    expect(r.avgCost).toBe(0)
    expect(r.realizedPnl).toBe(0)
  })
})
