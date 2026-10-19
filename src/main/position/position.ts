// 持仓计算（计划书 §6.8/§7.3）：按 fund_code 时间序移动加权平均
// 买入更新平均成本；卖出按 (净值−成本)×份额 计已实现盈亏；成本与盈亏均扣费率
import type { Pool } from 'pg'

export interface TradeRow {
  id: number
  fundCode: string
  tradeType: 'buy' | 'sell'
  shares: number
  price: number
  fee: number
  tradeDate: string // ISO
  note: string | null
}

export interface PositionSummary {
  fundCode: string
  fundName: string | null
  shares: number
  avgCost: number | null // 移动加权平均成本（扣费率）
  totalCost: number
  realizedPnl: number // 已实现盈亏（扣费率）
  latestNav: number | null
  marketValue: number | null
  floatingPnl: number | null
  pnlPct: number | null
}

/** 买入：新成本 = (旧份额×旧成本 + 份额×价格 + 费率) / 新份额 */
/** 卖出：已实现 = (卖出价 − 平均成本) × 份额 − 费率；份额减少，成本不变 */

export interface TradeLike {
  tradeType: 'buy' | 'sell'
  shares: number
  price: number
  fee: number
}

/**
 * 移动加权平均核心算法（纯函数，独立便于单测）：
 * 按时间序处理买卖流水，返回 份额/平均成本/已实现盈亏。
 * 卖出超持份额时截断（不会变负）。
 */
export function computePositionFromTrades(trades: TradeLike[]): {
  shares: number
  avgCost: number
  realizedPnl: number
} {
  let shares = 0
  let cost = 0 // 平均成本（无持仓时 0）
  let realizedPnl = 0

  for (const t of trades) {
    if (t.tradeType === 'buy') {
      const newShares = shares + t.shares
      cost = newShares > 0 ? (shares * cost + t.shares * t.price + t.fee) / newShares : 0
      shares = newShares
    } else {
      const sellShares = Math.min(t.shares, shares)
      realizedPnl += (t.price - cost) * sellShares - t.fee
      shares -= sellShares
    }
  }
  return { shares, avgCost: cost, realizedPnl }
}

export async function listTrades(
  pool: Pool,
  userId: number,
  fundCode?: string
): Promise<TradeRow[]> {
  const r = await pool.query<{
    id: number
    fund_code: string
    trade_type: string
    shares: string
    price: string
    fee: string
    trade_date: Date
    note: string | null
  }>(
    `SELECT id, fund_code, trade_type, shares, price, fee, trade_date, note
     FROM fund_trade
     WHERE user_id = $1 ${fundCode ? 'AND fund_code = $2' : ''}
     ORDER BY trade_date, id`,
    fundCode ? [userId, fundCode] : [userId]
  )
  return r.rows.map((x) => ({
    id: x.id,
    fundCode: x.fund_code,
    tradeType: x.trade_type as 'buy' | 'sell',
    shares: Number(x.shares),
    price: Number(x.price),
    fee: Number(x.fee),
    tradeDate: x.trade_date.toISOString(),
    note: x.note
  }))
}

/** 移动加权平均持仓汇总（无交易则返回 null 份额为 0） */
export async function computePosition(
  pool: Pool,
  userId: number,
  fundCode: string
): Promise<PositionSummary> {
  const trades = await listTrades(pool, userId, fundCode)
  const {
    shares,
    avgCost: cost,
    realizedPnl
  } = computePositionFromTrades(
    trades.map((t) => ({ tradeType: t.tradeType, shares: t.shares, price: t.price, fee: t.fee }))
  )

  const name = await pool.query<{ fund_name: string }>(
    'SELECT fund_name FROM fund_basic WHERE fund_code = $1',
    [fundCode]
  )
  const nav = await pool.query<{ dwjz: string | null }>(
    `SELECT dwjz FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date DESC LIMIT 1`,
    [fundCode]
  )
  const latestNav =
    nav.rows[0]?.dwjz !== undefined && nav.rows[0]?.dwjz !== null ? Number(nav.rows[0].dwjz) : null

  const marketValue = shares > 0 && latestNav !== null ? shares * latestNav : null
  const totalCost = shares > 0 ? shares * cost : 0
  const floatingPnl = marketValue !== null ? marketValue - totalCost : null
  const pnlPct =
    marketValue !== null && totalCost > 0 ? ((marketValue - totalCost) / totalCost) * 100 : null

  return {
    fundCode,
    fundName: name.rows[0]?.fund_name ?? null,
    shares: round2(shares),
    avgCost: shares > 0 ? round4(cost) : null,
    totalCost: round2(totalCost),
    realizedPnl: round2(realizedPnl),
    latestNav,
    marketValue: marketValue !== null ? round2(marketValue) : null,
    floatingPnl: floatingPnl !== null ? round2(floatingPnl) : null,
    pnlPct: pnlPct !== null ? round2(pnlPct) : null
  }
}

/** 当前用户全部有交易的基金持仓汇总 */
export async function listPositions(pool: Pool, userId: number): Promise<PositionSummary[]> {
  const r = await pool.query<{ fund_code: string }>(
    `SELECT DISTINCT fund_code FROM fund_trade WHERE user_id = $1 ORDER BY fund_code`,
    [userId]
  )
  const out: PositionSummary[] = []
  for (const row of r.rows) {
    out.push(await computePosition(pool, userId, row.fund_code))
  }
  return out
}

/** 录入一笔交易（买入/卖出） */
export async function addTrade(
  pool: Pool,
  userId: number,
  t: {
    fundCode: string
    tradeType: 'buy' | 'sell'
    shares: number
    price: number
    fee?: number
    tradeDate: string
    note?: string | null
  }
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO fund_trade (user_id, fund_code, trade_type, shares, price, fee, trade_date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [userId, t.fundCode, t.tradeType, t.shares, t.price, t.fee ?? 0, t.tradeDate, t.note ?? null]
  )
  return res.rows[0].id as number
}

/** 删除一笔交易（按 id，限当前用户） */
export async function deleteTrade(pool: Pool, userId: number, id: number): Promise<boolean> {
  const res = await pool.query('DELETE FROM fund_trade WHERE id = $1 AND user_id = $2', [
    id,
    userId
  ])
  return (res.rowCount ?? 0) > 0
}

// ---------- fund_profile（费率 + 资金计划，按用户） ----------

export interface FundProfile {
  buyFeePct: number
  sellFeePct: number
  /** 计划投入基金市场的总金额（元）；0 = 未设置 */
  marketBudget: number
}

export async function getProfile(pool: Pool, userId: number): Promise<FundProfile> {
  const r = await pool.query<{
    buy_fee_pct: string
    sell_fee_pct: string
    market_budget: string | null
  }>(`SELECT buy_fee_pct, sell_fee_pct, market_budget FROM fund_profile WHERE user_id = $1`, [
    userId
  ])
  if (r.rows.length === 0) return { buyFeePct: 0, sellFeePct: 0, marketBudget: 0 }
  return {
    buyFeePct: Number(r.rows[0].buy_fee_pct),
    sellFeePct: Number(r.rows[0].sell_fee_pct),
    marketBudget: Number(r.rows[0].market_budget ?? 0)
  }
}

export async function saveProfile(pool: Pool, userId: number, p: FundProfile): Promise<void> {
  await pool.query(
    `INSERT INTO fund_profile (user_id, buy_fee_pct, sell_fee_pct, market_budget) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id) DO UPDATE SET buy_fee_pct = $2, sell_fee_pct = $3, market_budget = $4`,
    [userId, p.buyFeePct, p.sellFeePct, p.marketBudget]
  )
}

// ---------- 资金计划（预算 / 闲钱 / 各基金占比） ----------

/** 单只基金在用户资金计划中的位置 */
export interface CapitalFundPosition {
  fundCode: string
  fundName: string | null
  shares: number
  avgCost: number | null
  /** 买入本金 = 当前持有份额的成本（含费用） */
  investedCost: number
  marketValue: number | null
  floatingPnl: number | null
  pnlPct: number | null
  /** 占组合市值 %；无持仓市值时为 null */
  weightPct: number | null
  /** 占已投入本金 % */
  costWeightPct: number | null
  /** 占计划投入总额 %；未设预算时为 null */
  budgetPct: number | null
}

/**
 * 用户资金全景：计划投入多少、已投多少、还剩多少闲钱、各基金占多少。
 *
 * 闲钱口径：**计划投入 − 已投入本金**（不是 − 当前市值）。
 * 理由：这是"还能再买多少"的现金流口径——持仓涨了不代表能多投钱，跌了也不代表闲钱变少；
 * 按市值算会让"还能加仓多少"随行情漂移，反而不符合用户的资金直觉。
 * 当前总资产另用「市值 + 闲钱」表达，兼顾两种视角。
 */
export interface CapitalSummary {
  /** 基金市场计划投入总额（元）；0 = 未设置 */
  marketBudget: number
  /** 已投入本金合计（元） */
  investedCost: number
  /** 当前持仓市值合计（元；缺行情的基金不计入） */
  marketValue: number
  /** 浮动盈亏合计；完全无市值数据时为 null */
  floatingPnl: number | null
  /** 已投入本金占计划投入 %；未设预算时为 null */
  usedPct: number | null
  /**
   * 剩余闲钱 = 计划投入 − 已投入本金；未设预算时为 null。
   * 已投入超过预算时为**负数**（超支），UI 与 AI 都应按"已无闲钱、不要再加仓"处理。
   */
  spareCash: number | null
  /** 剩余闲钱占计划投入 %；未设预算时为 null */
  sparePct: number | null
  /** 当前总资产 = 持仓市值 + 闲钱；未设预算时为 null */
  totalAsset: number | null
  funds: CapitalFundPosition[]
}

/** 汇总当前用户的资金全景（无交易时各项为 0，不报错） */
export async function computeCapitalSummary(pool: Pool, userId: number): Promise<CapitalSummary> {
  const [profile, positions] = await Promise.all([
    getProfile(pool, userId),
    listPositions(pool, userId)
  ])
  const budget = profile.marketBudget

  const investedCost = round2(positions.reduce((s, p) => s + p.totalCost, 0))
  const hasValue = positions.some((p) => p.marketValue !== null)
  const marketValue = round2(positions.reduce((s, p) => s + (p.marketValue ?? 0), 0))
  const floatingPnl = hasValue ? round2(marketValue - investedCost) : null

  const withBudget = budget > 0
  const spareCash = withBudget ? round2(budget - investedCost) : null

  return {
    marketBudget: round2(budget),
    investedCost,
    marketValue,
    floatingPnl,
    usedPct: withBudget ? round2((investedCost / budget) * 100) : null,
    spareCash,
    sparePct: spareCash !== null ? round2((spareCash / budget) * 100) : null,
    totalAsset: spareCash !== null ? round2(marketValue + spareCash) : null,
    funds: positions.map((p) => ({
      fundCode: p.fundCode,
      fundName: p.fundName,
      shares: p.shares,
      avgCost: p.avgCost,
      investedCost: p.totalCost,
      marketValue: p.marketValue,
      floatingPnl: p.floatingPnl,
      pnlPct: p.pnlPct,
      weightPct:
        marketValue > 0 && p.marketValue !== null
          ? round2((p.marketValue / marketValue) * 100)
          : null,
      costWeightPct: investedCost > 0 ? round2((p.totalCost / investedCost) * 100) : null,
      budgetPct: withBudget ? round2((p.totalCost / budget) * 100) : null
    }))
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
