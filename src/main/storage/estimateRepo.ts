// 盘中估值存储（计划书 §8：估值按 est_time 幂等 DO NOTHING）
import type { Pool } from 'pg'

export interface EstimateInput {
  fundCode: string
  estTime: Date
  estNav: number | null
  estPct: number | null
  source: string // tracking_index / page / none
}

/** 幂等写入一条盘中估值（同一 fund+时刻重复采样丢弃） */
export async function saveEstimate(pool: Pool, e: EstimateInput): Promise<boolean> {
  const res = await pool.query(
    `INSERT INTO fund_estimate (fund_code, est_time, est_nav, est_pct, source)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (fund_code, est_time) DO NOTHING`,
    [e.fundCode, e.estTime, e.estNav, e.estPct, e.source]
  )
  return (res.rowCount ?? 0) > 0
}

/** 最新一次估值（不限日期：盘中采样天然在交易时段，避免时区导致的跨天边界漏查） */
export async function latestEstimate(pool: Pool, code: string): Promise<{ estPct: number | null; estTime: Date } | null> {
  const r = await pool.query<{ est_pct: number | null; est_time: Date }>(
    `SELECT est_pct, est_time FROM fund_estimate
     WHERE fund_code = $1
     ORDER BY est_time DESC LIMIT 1`,
    [code]
  )
  return r.rows[0] ? { estPct: r.rows[0].est_pct, estTime: r.rows[0].est_time } : null
}
