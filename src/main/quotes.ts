// 行情/估值采集（计划书 M4）：对 fund_basic 中全部基金：
// 持仓股日 K 补种 + 当日实时价滚动 → stock_daily；盘中估值（T1 跟踪指数 / T2 主题 ETF）→ fund_estimate
// runQuotesCore 供 CLI（--quotes）与 IPC（quotes:run）、scheduler 共用
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema } from './storage/db'
import { saveStockDaily } from './storage/stockRepo'
import { saveEstimate } from './storage/estimateRepo'
import { stockKlines, stockQuote } from './crawler/market'
import { estimateT1, estimateT3 } from './crawler/estimate'
import type { Pool } from 'pg'

/** 本地日期 YYYY-MM-DD（行情按交易日，本机为国内时区） */
export function todayStr(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export interface QuotesResult {
  fundCount: number
  stockCount: number
  klineAdded: number
  estimates: { code: string; name: string; source: string; pct: number | null }[]
  errors: { code: string; message: string }[]
}

/** 核心采集逻辑：返回结构化结果，不负责连接池生命周期 */
export async function runQuotesCore(pool: Pool): Promise<QuotesResult> {
  const result: QuotesResult = { fundCount: 0, stockCount: 0, klineAdded: 0, estimates: [], errors: [] }

  const funds = await pool.query<{ fund_code: string; fund_name: string }>(
    'SELECT fund_code, fund_name FROM fund_basic WHERE is_active = 1 ORDER BY fund_code'
  )
  result.fundCount = funds.rows.length
  if (funds.rows.length === 0) return result

  const today = todayStr()
  const allStocks = new Set<string>()
  const stockByFund = new Map<string, string[]>()

  // 1. 每基金最新持仓股代码（去重）
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
  result.stockCount = allStocks.size

  // 2. 行情：日 K 补种 + 当日实时价滚动（并发 ≤3）
  const stockList = [...allStocks]
  await mapLimit(stockList, 3, async (code) => {
    try {
      const { rows } = await stockKlines(code, 120)
      result.klineAdded += await saveStockDaily(pool, code, rows, 'seed')
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
      result.errors.push({ code, message: (e as Error).message })
    }
  })

  // 3. 盘中估值（T1 跟踪指数 / T2 主题 ETF / T3 重仓股加权）
  for (const f of funds.rows) {
    try {
      const est = await estimateOneFund(pool, f)
      if (!est) continue
      const saved = await saveEstimate(pool, {
        fundCode: f.fund_code,
        estTime: est.estTime,
        estNav: null,
        estPct: est.estPct,
        source: est.source
      })
      if (saved) result.estimates.push({ code: f.fund_code, name: est.indexName ?? '', source: est.source, pct: est.estPct })
    } catch (e) {
      result.errors.push({ code: f.fund_code, message: `估值: ${(e as Error).message}` })
    }
  }

  return result
}

/** 对单只基金做盘中估值：T1 跟踪指数 → T2 主题 ETF → T3 重仓股加权（主动型兜底）。返回估值结果或 null */
async function estimateOneFund(
  pool: Pool,
  fund: { fund_code: string; fund_name: string }
): Promise<{ estTime: Date; estPct: number | null; source: string; indexName?: string } | null> {
  // T1/T2：按名称匹配跟踪指数/主题ETF
  const est = await estimateT1(fund.fund_name)
  if (est) {
    return { estTime: est.ts, estPct: est.pct, source: est.source, indexName: est.indexName }
  }

  // T3：主动型——最近季报重仓股按权重加权
  try {
    const holdings = await pool.query<{ stock_code: string | null; stock_name: string | null; weight: string | null }>(
      `SELECT stock_code, stock_name, weight FROM fund_holdings
       WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
       ORDER BY rank`,
      [fund.fund_code]
    )
    const rows = holdings.rows.map((r) => ({
      stockCode: r.stock_code,
      stockName: r.stock_name,
      weight: r.weight === null ? null : Number(r.weight)
    }))
    const t3 = await estimateT3(rows)
    if (t3 && t3.pct !== null) {
      return { estTime: t3.ts, estPct: t3.pct, source: t3.source, indexName: `重仓股加权（覆盖${t3.coveredWeight.toFixed(0)}%）` }
    }
  } catch (e) {
    console.warn(`[quotes] ${fund.fund_code} T3 估算失败: ${(e as Error).message}`)
  }

  return null
}

/** 盘中高频估值采样：只对启用基金做 T1/T2/T3 估值入库（T3 需查持仓，频率由调度器控制） */
export async function sampleEstimatesCore(pool: Pool): Promise<{ sampled: number; errors: number }> {
  const funds = await pool.query<{ fund_code: string; fund_name: string }>(
    'SELECT fund_code, fund_name FROM fund_basic WHERE is_active = 1 ORDER BY fund_code'
  )
  let sampled = 0
  let errors = 0
  for (const f of funds.rows) {
    try {
      const est = await estimateOneFund(pool, f)
      if (!est) continue
      const saved = await saveEstimate(pool, {
        fundCode: f.fund_code,
        estTime: est.estTime,
        estNav: null,
        estPct: est.estPct,
        source: est.source
      })
      if (saved) sampled++
    } catch (e) {
      errors++
      console.warn(`[quotes] ${f.fund_code} 估值采样失败: ${(e as Error).message}`)
    }
  }
  return { sampled, errors }
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < arr.length; i += limit) {
    const batch = await Promise.all(arr.slice(i, i + limit).map(fn))
    out.push(...batch)
  }
  return out
}

/** CLI 入口：electron . --quotes */
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

  const r = await runQuotesCore(pool)
  console.log(`[quotes] 基金 ${r.fundCount} 只，持仓股票 ${r.stockCount} 只`)
  console.log(`[quotes] 日 K 新增 ${r.klineAdded} 行，当日实时价已滚动（${todayStr()}）`)
  for (const e of r.estimates) {
    const tag = e.source === 'tracking_index' ? 'T1' : e.source === 'theme_etf' ? 'T2' : 'T3'
    console.log(`[quotes] ${e.code} ${tag} ${e.name} 实时 ${e.pct !== null ? e.pct + '%' : 'N/A'}（新采样）`)
  }
  for (const er of r.errors) {
    console.warn(`[quotes] ${er.code} 行情失败: ${er.message}`)
  }

  await pool.end()
  console.log('[quotes] 完成')
  return 0
}
