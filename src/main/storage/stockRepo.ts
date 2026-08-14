// 个股日线行情存储（计划书 §8：个股行情重复 DO NOTHING）
import type { Pool } from 'pg'
import type { KlineRow } from '../crawler/market'

/** 幂等入库日 K（含当日盘中最新价时，DO UPDATE 滚动更新当日行） */
export async function saveStockDaily(
  pool: Pool,
  code: string,
  rows: KlineRow[],
  mode: 'seed' | 'daily' = 'seed'
): Promise<number> {
  if (rows.length === 0) return 0
  const sql =
    mode === 'seed'
      ? `INSERT INTO stock_daily (stock_code, trade_date, close, open, high, low, pct, volume, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (stock_code, trade_date) DO NOTHING`
      : `INSERT INTO stock_daily (stock_code, trade_date, close, open, high, low, pct, volume, amount)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (stock_code, trade_date) DO UPDATE SET
           close = EXCLUDED.close, open = EXCLUDED.open, high = EXCLUDED.high,
           low = EXCLUDED.low, pct = EXCLUDED.pct, volume = EXCLUDED.volume, amount = EXCLUDED.amount`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    let inserted = 0
    for (const r of rows) {
      const res = await client.query(sql, [code, r.tradeDate, r.close, r.open, r.high, r.low, r.amp, r.volume, r.amount])
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
