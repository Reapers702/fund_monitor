// CLI 拉取入口：electron . --quotes（计划书 M4）
// 对 fund_basic 中全部基金：持仓股日 K 补种 + 当日实时价滚动 → stock_daily；跟踪指数 T1 估值 → fund_estimate
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema } from './storage/db'
import { saveStockDaily } from './storage/stockRepo'
import { saveEstimate } from './storage/estimateRepo'
import { stockKlines, stockQuote } from './crawler/market'
import { estimateT1 } from './crawler/estimate'

/** 本地日期 YYYY-MM-DD（行情按交易日，本机为国内时区） */
function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < arr.length; i += limit) {
    const batch = await Promise.all(arr.slice(i, i + limit).map(fn))
    out.push(...batch)
  }
  return out
}

export async function runQuotes(): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[quotes] 配置文件: ${configPath()}`)
  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[quotes] PostgreSQL 连接失败: ${(e as Error).message}`)
    return 1
  }
  try {
    await ensureSchema(pool)
  } catch (e) {
    console.error(`[quotes] 建表失败: ${(e as Error).message}`)
    return 1
  }

  const funds = await pool.query<{ fund_code: string; fund_name: string }>(
    'SELECT fund_code, fund_name FROM fund_basic ORDER BY fund_code'
  )
  if (funds.rows.length === 0) {
    console.log('[quotes] fund_basic 为空，先用 --fund <code> 添加基金')
    await pool.end()
    return 0
  }

  const today = todayStr()
  const allStocks = new Set<string>()

  // 1. 每基金最新持仓股代码（去重）
  const stockByFund = new Map<string, string[]>()
  for (const f of funds.rows) {
    const r = await pool.query<{ stock_code: string }>(
      `SELECT DISTINCT stock_code FROM fund_holdings
       WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
       ORDER BY stock_code`,
      [f.fund_code]
    )
    const codes = r.rows.map((x) => x.stock_code).filter((c): c is string => Boolean(c))
    stockByFund.set(f.fund_code, codes)
    codes.forEach((c) => allStocks.add(c))
  }
  console.log(`[quotes] 基金 ${funds.rows.length} 只，持仓股票 ${allStocks.size} 只`)

  // 2. 行情：日 K 补种 + 当日实时价滚动（并发 ≤3）
  const stockList = [...allStocks]
  let kAdded = 0
  await mapLimit(stockList, 3, async (code) => {
    try {
      const { rows } = await stockKlines(code, 120)
      kAdded += await saveStockDaily(pool, code, rows, 'seed')
      const q = await stockQuote(code)
      if (q.price !== null && q.name) {
        await saveStockDaily(
          pool,
          code,
          [{ tradeDate: today, open: q.open, close: q.price, high: q.high, low: q.low, volume: q.volume, amount: q.amount, amp: null }],
          'daily'
        )
      }
    } catch (e) {
      console.warn(`[quotes] ${code} 行情失败: ${(e as Error).message}`)
    }
  })
  console.log(`[quotes] 日 K 新增 ${kAdded} 行，当日实时价已滚动（${today}）`)

  // 3. 盘中估值（T1 跟踪指数 / T2 主题 ETF 实时涨跌幅）
  for (const f of funds.rows) {
    try {
      const est = await estimateT1(f.fund_name)
      if (!est) {
        console.log(`[quotes] ${f.fund_code} ${f.fund_name}：无匹配跟踪标的（落 T3，主动型无盘中估值）`)
        continue
      }
      const saved = await saveEstimate(pool, {
        fundCode: f.fund_code,
        estTime: est.ts,
        estNav: null,
        estPct: est.pct,
        source: est.source
      })
      const tag = est.source === 'tracking_index' ? 'T1' : 'T2'
      console.log(`[quotes] ${f.fund_code} ${tag} ${est.indexName} 实时 ${est.pct !== null ? est.pct + '%' : 'N/A'}${saved ? '（新采样）' : ''}`)
    } catch (e) {
      console.warn(`[quotes] ${f.fund_code} 估值失败: ${(e as Error).message}`)
    }
  }

  await pool.end()
  console.log('[quotes] 完成')
  return 0
}
