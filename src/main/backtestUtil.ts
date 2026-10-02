// 回测公共取数工具（backtest / rulesBacktest / rotateBacktest / simBacktest 共用）
//
// 统一 asof（截至采样日收盘）无前视取数：净值/基金信息/相关新闻/日期工具。
// 原为 rulesBacktest.ts / rotateBacktest.ts 各自私有副本，现抽成公共模块行为一字不差。
import type { Pool } from 'pg'

export interface NavPoint {
  date: string
  nav: number
}

export function dateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function todayISO(): string {
  return dateOnly(new Date())
}

export function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return dateOnly(d)
}

/** 净值：截至 asof 当日（含）升序，最多 limit 条 */
export async function navUpTo(pool: Pool, code: string, asof: string, limit = 120): Promise<NavPoint[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string }>(
    `SELECT trade_date, dwjz FROM fund_nav_daily
     WHERE fund_code = $1 AND trade_date <= $2
     ORDER BY trade_date DESC LIMIT $3`,
    [code, asof, limit]
  )
  return r.rows.reverse().map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz) }))
}

/** 完整升序净值（评估未来窗口 / 组合轴） */
export async function navDatesAll(pool: Pool, code: string): Promise<NavPoint[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string }>(
    `SELECT trade_date, dwjz FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date ASC`,
    [code]
  )
  return r.rows.map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz) }))
}

export async function basic(pool: Pool, code: string): Promise<{ name: string } | null> {
  const r = await pool.query<{ fund_name: string }>(`SELECT fund_name FROM fund_basic WHERE fund_code = $1`, [code])
  const x = r.rows[0]
  return x ? { name: x.fund_name } : null
}

/**
 * 相关新闻：基金名关键词 + 前几只重仓股名 ILIKE 兜底，截至 asof 当日 15:40（模拟盘后分析的可见日期）。
 * 返回最为匹配的 title 与发布时间。
 */
export async function newsUpTo(
  aiFundPool: Pool,
  fundName: string,
  stockNames: string[],
  asof: string,
  limit = 8
): Promise<{ title: string | null; pubTime: string }[]> {
  const fundKeywords = [fundName.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
  const tags = [...new Set([...fundKeywords, ...stockNames])].slice(0, 12)
  if (tags.length === 0) return []
  const asofAt = new Date(asof + 'T15:40:00')
  const r = await aiFundPool.query<{ title: string | null; pub_time: Date }>(
    `SELECT title, pub_time FROM raw_news
     WHERE (llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)) AND pub_time <= $3
     ORDER BY pub_time DESC LIMIT $4`,
    [tags, tags.map((t) => `%${t}%`), asofAt, limit]
  )
  return r.rows.map((x) => ({ title: x.title, pubTime: x.pub_time.toISOString() }))
}