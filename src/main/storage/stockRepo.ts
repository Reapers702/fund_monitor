// 个股日线行情存储（计划书 §8：个股行情重复 DO NOTHING）
//
// P1 修复（"日K 被实时价快照污染"）：stock_daily 每行带 source 标记来源——
//   kline  = 数据源官方日K（收盘后定型，权威，可覆盖非官方行）
//   quote  = 盘中实时价滚动出来的当日快照（只维护"还没定型"的行，绝不覆盖官方日K）
//   NULL   = 升级前的历史行（来源不可考）→ 视为非官方，遇到官方日K 会被校正
// 详见 src/main/quotes.ts 的日K 口径说明。
import type { Pool } from 'pg'
import type { KlineRow } from '../crawler/market'

/** 行来源（写入用） */
export type StockDailySource = 'kline' | 'quote'

/** 写入结果：written=新增行数；fixed=用官方日K 校正（覆盖非官方行）的行数 */
export interface StockDailyWriteResult {
  written: number
  fixed: number
}

/** 本地已有该股最新"官方日K"日期（source='kline'）；无则 null。
 *  用途：日K 补拉前判断"已定型的日K 是否已覆盖最近一个已收盘交易日"——
 *  不能用 max(trade_date)：盘中实时价快照也会写进当天，见 quotes.ts 的口径说明。 */
export async function latestKlineDate(pool: Pool, code: string): Promise<string | null> {
  const r = await pool.query<{ d: string | null }>(
    `SELECT to_char(max(trade_date), 'YYYY-MM-DD') AS d
     FROM stock_daily WHERE stock_code = $1 AND source = 'kline'`,
    [code]
  )
  return r.rows[0]?.d ?? null
}

/** 幂等入库日线：
 *  - source='kline'（官方日K）：覆盖非 kline 的既有行（校正脏数据），
 *    但不重复改写已有的官方行（避免同一根K线反复写、也避免被延迟返回的旧值回退）。
 *  - source='quote'（盘中快照）：只滚动非官方行，绝不覆盖已定型的官方日K。 */
export async function saveStockDaily(
  pool: Pool,
  code: string,
  rows: KlineRow[],
  source: StockDailySource = 'kline'
): Promise<StockDailyWriteResult> {
  const out: StockDailyWriteResult = { written: 0, fixed: 0 }
  if (rows.length === 0) return out

  const sql = `INSERT INTO stock_daily (stock_code, trade_date, close, open, high, low, pct, volume, amount, source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (stock_code, trade_date) DO UPDATE SET
       close = EXCLUDED.close, open = EXCLUDED.open, high = EXCLUDED.high,
       low = EXCLUDED.low, pct = EXCLUDED.pct, volume = EXCLUDED.volume,
       amount = EXCLUDED.amount, source = EXCLUDED.source
     WHERE stock_daily.source IS DISTINCT FROM 'kline'
     RETURNING (xmax = 0) AS inserted`

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const r of rows) {
      const res = await client.query<{ inserted: boolean }>(sql, [
        code,
        r.tradeDate,
        r.close,
        r.open,
        r.high,
        r.low,
        r.pct,
        r.volume,
        r.amount,
        source
      ])
      if ((res.rowCount ?? 0) === 0) continue
      if (res.rows[0]?.inserted) out.written++
      else out.fixed++
    }
    await client.query('COMMIT')
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 清理"周末日期"的行情行。
 *  官方日K 永远不会有周六/周日：出现只可能是"非交易时段把上一交易日行情当成今天写入"的脏数据
 *  （且永远不会被官方日K 覆盖，会污染相关性/回测）。只按星期判断，不依赖节假日表，绝不误删。 */
export async function cleanupWeekendStockRows(pool: Pool): Promise<number> {
  const r = await pool.query(`DELETE FROM stock_daily WHERE EXTRACT(ISODOW FROM trade_date) IN (6, 7)`)
  return r.rowCount ?? 0
}
