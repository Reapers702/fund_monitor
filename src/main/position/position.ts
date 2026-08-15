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
export function computePositionFromTrades(trades: TradeLike[]): { shares: number; avgCost: number; realizedPnl: number } {
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

export async function listTrades(pool: Pool, fundCode?: string): Promise<TradeRow[]> {
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
     ${fundCode ? 'WHERE fund_code = $1' : ''}
     ORDER BY trade_date, id`,
    fundCode ? [fundCode] : []
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
export async function computePosition(pool: Pool, fundCode: string): Promise<PositionSummary> {
  const trades = await listTrades(pool, fundCode)
  const { shares, avgCost: cost, realizedPnl } = computePositionFromTrades(
    trades.map((t) => ({ tradeType: t.tradeType, shares: t.shares, price: t.price, fee: t.fee }))
  )

  const name = await pool.query<{ fund_name: string }>('SELECT fund_name FROM fund_basic WHERE fund_code = $1', [fundCode])
  const nav = await pool.query<{ dwjz: string | null }>(
    `SELECT dwjz FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date DESC LIMIT 1`,
    [fundCode]
  )
  const latestNav = nav.rows[0]?.dwjz !== undefined && nav.rows[0]?.dwjz !== null ? Number(nav.rows[0].dwjz) : null

  const marketValue = shares > 0 && latestNav !== null ? shares * latestNav : null
  const totalCost = shares > 0 ? shares * cost : 0
  const floatingPnl = marketValue !== null ? marketValue - totalCost : null
  const pnlPct = marketValue !== null && totalCost > 0 ? ((marketValue - totalCost) / totalCost) * 100 : null

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

/** 全部有交易的基金持仓汇总 */
export async function listPositions(pool: Pool): Promise<PositionSummary[]> {
  const r = await pool.query<{ fund_code: string }>(
    `SELECT DISTINCT fund_code FROM fund_trade ORDER BY fund_code`
  )
  const out: PositionSummary[] = []
  for (const row of r.rows) {
    out.push(await computePosition(pool, row.fund_code))
  }
  return out
}

/** 录入一笔交易（买入/卖出） */
export async function addTrade(
  pool: Pool,
  t: { fundCode: string; tradeType: 'buy' | 'sell'; shares: number; price: number; fee?: number; tradeDate: string; note?: string | null }
): Promise<number> {
  const res = await pool.query(
    `INSERT INTO fund_trade (fund_code, trade_type, shares, price, fee, trade_date, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [t.fundCode, t.tradeType, t.shares, t.price, t.fee ?? 0, t.tradeDate, t.note ?? null]
  )
  return res.rows[0].id as number
}

/** 删除一笔交易（按 id） */
export async function deleteTrade(pool: Pool, id: number): Promise<boolean> {
  const res = await pool.query('DELETE FROM fund_trade WHERE id = $1', [id])
  return (res.rowCount ?? 0) > 0
}

// ---------- fund_profile（费率） ----------

export interface FundProfile {
  buyFeePct: number
  sellFeePct: number
}

export async function getProfile(pool: Pool): Promise<FundProfile> {
  const r = await pool.query<{ buy_fee_pct: string; sell_fee_pct: string }>(
    `SELECT buy_fee_pct, sell_fee_pct FROM fund_profile WHERE id = 1`
  )
  if (r.rows.length === 0) return { buyFeePct: 0, sellFeePct: 0 }
  return { buyFeePct: Number(r.rows[0].buy_fee_pct), sellFeePct: Number(r.rows[0].sell_fee_pct) }
}

export async function saveProfile(pool: Pool, p: FundProfile): Promise<void> {
  await pool.query(
    `INSERT INTO fund_profile (id, buy_fee_pct, sell_fee_pct) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET buy_fee_pct = $1, sell_fee_pct = $2`,
    [p.buyFeePct, p.sellFeePct]
  )
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000
}
