// 基金数据存储（计划书 §8：UNIQUE + ON CONFLICT 幂等，多客户端并发安全）
import type { Pool } from 'pg'
import type { FundDetail } from '../crawler/danjuan'
import type { NavRow } from '../crawler/eastmoney'

// ---------- fund_basic ----------

export interface FundBasicInput {
  code: string
  name: string
  fullName?: string | null
  manager?: string | null
  keeper?: string | null
  foundDate?: string | null
}

/** 基础信息 upsert（蛋卷详情 / 东财降级名称） */
export async function upsertFundBasic(pool: Pool, fund: FundBasicInput): Promise<void> {
  await pool.query(
    `INSERT INTO fund_basic (fund_code, fund_name, fund_full_name, manager, keeper, found_date, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (fund_code) DO UPDATE SET
       fund_name = EXCLUDED.fund_name,
       fund_full_name = COALESCE(EXCLUDED.fund_full_name, fund_basic.fund_full_name),
       manager = COALESCE(EXCLUDED.manager, fund_basic.manager),
       keeper = COALESCE(EXCLUDED.keeper, fund_basic.keeper),
       found_date = COALESCE(EXCLUDED.found_date, fund_basic.found_date),
       updated_at = now()`,
    [fund.code, fund.name, fund.fullName ?? null, fund.manager ?? null, fund.keeper ?? null, fund.foundDate ?? null]
  )
}

export function fundBasicFromDetail(d: FundDetail): FundBasicInput {
  return {
    code: d.code,
    name: d.name,
    fullName: d.fullName,
    manager: d.manager,
    keeper: d.keeper,
    foundDate: d.foundDate
  }
}

// ---------- fund_nav_daily ----------

/** 最新净值日期；无数据返回 null */
export async function latestNavDate(pool: Pool, code: string): Promise<string | null> {
  const r = await pool.query<{ d: string | null }>(
    `SELECT to_char(max(trade_date), 'YYYY-MM-DD') AS d FROM fund_nav_daily WHERE fund_code = $1`,
    [code]
  )
  return r.rows[0]?.d ?? null
}

/**
 * 幂等写入净值。
 * mode=seed：历史补种 DO NOTHING（可安全重跑）
 * mode=daily：当日滚动更新 DO UPDATE（T 日净值可能盘后多次公布修正）
 */
export async function saveNavRows(
  pool: Pool,
  code: string,
  rows: NavRow[],
  mode: 'seed' | 'daily'
): Promise<number> {
  if (rows.length === 0) return 0
  const sql =
    mode === 'seed'
      ? `INSERT INTO fund_nav_daily (fund_code, trade_date, dwjz, ljjz, jzzzl, sgzt, shzt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (fund_code, trade_date) DO NOTHING`
      : `INSERT INTO fund_nav_daily (fund_code, trade_date, dwjz, ljjz, jzzzl, sgzt, shzt)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (fund_code, trade_date) DO UPDATE SET
           dwjz = EXCLUDED.dwjz, ljjz = EXCLUDED.ljjz, jzzzl = EXCLUDED.jzzzl,
           sgzt = EXCLUDED.sgzt, shzt = EXCLUDED.shzt`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (const r of rows) {
      if (!r.fsrq) continue
      const res = await client.query(sql, [
        code,
        r.fsrq,
        r.dwjz,
        r.ljjz,
        r.jzzzl,
        r.sgzt,
        r.shzt
      ])
      inserted += (res.rowCount ?? 0) > 0 ? 1 : 0
    }
    await client.query('COMMIT')
    return inserted
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

// ---------- fund_holdings ----------

/** 最近持仓报告日期；无返回 null */
export async function latestHoldingsDate(pool: Pool, code: string): Promise<string | null> {
  const r = await pool.query<{ d: string | null }>(
    `SELECT to_char(max(report_date), 'YYYY-MM-DD') AS d FROM fund_holdings WHERE fund_code = $1`,
    [code]
  )
  return r.rows[0]?.d ?? null
}

export async function saveHoldings(
  pool: Pool,
  code: string,
  reportDate: string,
  rows: { rank: number; stockCode: string | null; stockName: string | null; weight: number | null }[]
): Promise<number> {
  if (rows.length === 0) return 0
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (const r of rows) {
      const res = await client.query(
        `INSERT INTO fund_holdings (fund_code, report_date, rank, stock_code, stock_name, weight)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (fund_code, report_date, rank) DO NOTHING`,
        [code, reportDate, r.rank, r.stockCode, r.stockName, r.weight]
      )
      inserted += (res.rowCount ?? 0) > 0 ? 1 : 0
    }
    await client.query('COMMIT')
    return inserted
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}
