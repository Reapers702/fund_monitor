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

/** 清理过期估值采样（默认保留最近 30 天；盘中 30s 采样数据量大，需定期清理防膨胀） */
export async function cleanupOldEstimates(pool: Pool, keepDays = 30): Promise<number> {
  const res = await pool.query(
    `DELETE FROM fund_estimate WHERE est_time < now() - make_interval(days => $1)`,
    [keepDays]
  )
  return res.rowCount ?? 0
}

/**
 * 记录某交易日"盘中估值 vs 收盘实际净值"误差（T3 可信度验证）：
 * 取当日最后一次估值采样（est_time 在当日），与 fund_nav_daily 当日 jzzzl 对比，写 fund_estimate_diff。
 * 每基金每天一行（upsert），仅记录估值与净值都非空的交易日。
 */
export async function recordEstimateDiffs(pool: Pool, tradeDate: string): Promise<number> {
  const res = await pool.query(
    `INSERT INTO fund_estimate_diff (fund_code, trade_date, source, est_pct, nav_pct, diff_pct)
     SELECT e.fund_code, $1::date, e.source, e.est_pct, n.jzzzl, round((e.est_pct - n.jzzzl)::numeric, 4)
     FROM (
       SELECT DISTINCT ON (fund_code) fund_code, source, est_pct
       FROM fund_estimate
       WHERE est_time >= $1::date AND est_time < $1::date + interval '1 day'
       ORDER BY fund_code, est_time DESC
     ) e
     JOIN fund_nav_daily n ON n.fund_code = e.fund_code AND n.trade_date = $1::date
     WHERE e.est_pct IS NOT NULL AND n.jzzzl IS NOT NULL
     ON CONFLICT (fund_code, trade_date) DO UPDATE SET
       source = EXCLUDED.source,
       est_pct = EXCLUDED.est_pct,
       nav_pct = EXCLUDED.nav_pct,
       diff_pct = EXCLUDED.diff_pct,
       created_at = now()`,
    [tradeDate]
  )
  return res.rowCount ?? 0
}
