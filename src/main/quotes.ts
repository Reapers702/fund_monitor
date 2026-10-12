// 行情/估值采集（计划书 M4）：对 fund_basic 中全部基金：
// 持仓股日 K 补种 + 当日实时价滚动 → stock_daily；盘中估值（T1 跟踪指数 / T2 主题 ETF）→ fund_estimate
// runQuotesCore 供 CLI（--quotes）与 IPC（quotes:run）、scheduler 共用
//
// P0 改造（降请求量，直接对应"被风控"的根因）：
//   1. 估值取价 =「批量预热 + 逐只读缓存」：一次请求取回本轮全部指数/主题ETF/重仓股行情，
//      替代原先"每只基金 1 次 + T3 每只持仓股 1 次"（10 只基金约 50 次/轮 → 1~2 次/轮）。
//      预热失败不影响正确性：逐只取价路径仍在，只是变慢。
//   2. 日 K 只在"本地最新日线 < 最近交易日"时才补拉，替代原先每次手动刷新都重拉全部 120 根。
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema } from './storage/db'
import { saveStockDaily, latestStockDate } from './storage/stockRepo'
import { saveEstimate } from './storage/estimateRepo'
import { getMarkers, setMarkers } from './storage/crawlMarker'
import { clearQuoteCache, prefetchQuotes, secidOf, stockKlines, stockQuote } from './crawler/market'
import { estimateT1, estimateT3, findTrackingIndex } from './crawler/estimate'
import { syncFund } from './fund'
import { latestTradingDayStr } from './scheduler/tradingCalendar'
import { logInfo } from './logger'
import type { Pool } from 'pg'

/** 日K 补拉最短间隔：数据源当天K线未更新时（早盘/收盘前），只按日期判断会每次刷新都全量重拉 */
const KLINE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 日K 抓取标记键（storage/crawlMarker.ts） */
function klineMarker(code: string): string {
  return `klines:${code}`
}

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
  klineSkipped: number // 跳过日K补拉的股票数（已有最近交易日数据，或 6 小时内刚补过）
  estimates: { code: string; name: string; source: string; pct: number | null }[]
  errors: { code: string; message: string }[]
}

interface ActiveFund {
  fund_code: string
  fund_name: string
}

/** 全局活跃基金：所有用户自选的并集（去重，多人收藏同一基金只抓一次，多用户 M9） */
async function activeFunds(pool: Pool): Promise<ActiveFund[]> {
  const r = await pool.query<ActiveFund>(
    `SELECT DISTINCT f.fund_code, f.fund_name
     FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
     WHERE uf.is_active = 1
     ORDER BY f.fund_code`
  )
  return r.rows
}

/** 某基金最新报告期的持仓股代码（去重） */
async function latestHoldingCodes(pool: Pool, code: string): Promise<string[]> {
  const r = await pool.query<{ stock_code: string }>(
    `SELECT DISTINCT stock_code FROM fund_holdings
     WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
     ORDER BY stock_code`,
    [code]
  )
  return r.rows.map((x) => x.stock_code).filter((c): c is string => Boolean(c))
}

/** 核心采集逻辑：返回结构化结果，不负责连接池生命周期 */
export async function runQuotesCore(pool: Pool): Promise<QuotesResult> {
  const result: QuotesResult = {
    fundCount: 0,
    stockCount: 0,
    klineAdded: 0,
    klineSkipped: 0,
    estimates: [],
    errors: []
  }

  const funds = await activeFunds(pool)
  result.fundCount = funds.length
  if (funds.length === 0) return result

  const today = todayStr()
  clearQuoteCache() // 手动刷新/CLI 要的是最新价，清掉上一轮的 TTL 缓存

  // 1. 收集本轮需要的全部标的：持仓股（实时价/日K）+ 估值所需（指数/主题ETF/持仓股）
  const allStocks = new Set<string>()
  const stockByFund = new Map<string, string[]>()
  for (const f of funds) {
    const codes = await latestHoldingCodes(pool, f.fund_code)
    stockByFund.set(f.fund_code, codes)
    codes.forEach((c) => allStocks.add(c))
  }
  result.stockCount = allStocks.size
  const stockList = [...allStocks]

  let estimateSecids: string[] = []
  try {
    estimateSecids = await collectEstimateSecids(pool, funds)
  } catch (e) {
    console.warn(`[quotes] 估值标的收集失败（本轮估值将逐只取价兜底）: ${(e as Error).message}`)
  }

  // 2. 日 K 补拉（**必须放在行情批量预热之前**）：这是本流程里唯一逐只请求、耗时最长的环节，
  //    若夹在"批量预热"和"读缓存写库"之间，行情缓存会在等待中过期，整批退化成逐只请求
  //    （曾实测：120 只股票 → 120 次日K + 120 次行情请求）。
  const klineTarget = latestTradingDayStr()
  const needKline: string[] = []
  const klineMarkers = stockList.map(klineMarker)
  const markerMap = await getMarkers(pool, klineMarkers)
  for (const code of stockList) {
    const latest = await latestStockDate(pool, code)
    if (latest !== null && latest >= klineTarget) {
      result.klineSkipped++ // 本地已有最近交易日的日K
      continue
    }
    // 数据源当天K线尚未更新时（早盘/收盘前），只按日期判断会每次刷新都全量重拉，
    // 故再用抓取标记兜底：同一标的 6 小时内最多补一次
    const at = markerMap.get(klineMarker(code))
    if (at !== undefined && Date.now() - at < KLINE_MIN_INTERVAL_MS) {
      result.klineSkipped++
      continue
    }
    needKline.push(code)
  }
  if (result.klineSkipped > 0)
    logInfo(`[quotes] 跳过 ${result.klineSkipped}/${stockList.length} 只股票的日K补拉（已有最近交易日数据或刚补过）`)

  const klineFetched: string[] = []
  await mapLimit(needKline, 3, async (code) => {
    try {
      const { rows } = await stockKlines(code, 120)
      result.klineAdded += await saveStockDaily(pool, code, rows, 'seed')
      klineFetched.push(klineMarker(code))
    } catch (e) {
      result.errors.push({ code, message: `日K: ${(e as Error).message}` })
    }
  })
  if (klineFetched.length > 0) await setMarkers(pool, klineFetched)

  // 3. 行情批量预热：一次覆盖全部持仓股 + 指数/主题ETF（随后实时价写库与估值都读这份缓存）
  const allSecids = [...new Set([...stockList.map(secidOf), ...estimateSecids])]
  await prefetchQuotesSafely(allSecids, `行情批量预热`, true, (msg, e) =>
    result.errors.push({ code: '-', message: `${msg}: ${e}` })
  )

  // 4. 当日实时价滚动入库（读第 3 步的缓存，不再逐只请求）
  await mapLimit(stockList, 3, async (code) => {
    try {
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

  // 5. 盘中估值（T1 跟踪指数 / T2 主题 ETF / T3 重仓股加权）：读第 3 步同一份缓存，只补尚未取到的
  const est = await estimateFunds(pool, funds, false)
  result.estimates = est.estimates
  result.errors.push(...est.errors)

  // 6. 净值增量（顺带补齐 T+1 公布的净值；幂等，无新数据则 0 条）。
  //    与 GUI"刷新行情/估值"按钮同链路，保证手动刷新时缺口立即补上（周五净值周六凌晨公布场景）
  for (const f of funds) {
    try {
      await syncFund(pool, f.fund_code, () => {}, { skipDetailIfKnown: true })
    } catch (e) {
      result.errors.push({ code: f.fund_code, message: `净值增量: ${(e as Error).message}` })
    }
  }

  return result
}

/**
 * 批量预热行情，失败只告警不中断（逐只取价会自然兜底）。
 * force=true：无视缓存强制刷新（估值采样要求"这次采样用的是此刻的价格"）
 * onError：把失败暴露给调用方的错误列表（CLI/GUI 能直接看到）
 */
async function prefetchQuotesSafely(
  secids: string[],
  what: string,
  force = true,
  onError?: (msg: string, e: string) => void
): Promise<void> {
  if (secids.length === 0) return
  try {
    const filled = await prefetchQuotes(secids, { force })
    if (filled === 0) {
      // 区分"能省就省"和"真的失败"：force 且一只都没取回 = 整批失败（不会抛错，由 prefetchChunk 吞掉）
      if (force) {
        console.warn(`[quotes] ${what} 整批未取回（${secids.length} 只），将回退逐只取价`)
        onError?.(`${what}整批未取回`, `${secids.length} 只`)
      } else {
        logInfo(`[quotes] ${what}：${secids.length} 只全部命中缓存，本次 0 次请求`)
      }
      return
    }
    logInfo(`[quotes] ${what} 一次取回 ${filled}/${secids.length} 只（替代逐只请求）`)
  } catch (e) {
    const msg = (e as Error).message
    console.warn(`[quotes] ${what}失败，回退逐只取价: ${msg}`)
    onError?.(`${what}失败`, msg)
  }
}

interface EstimateOutcome {
  code: string
  name: string
  source: string
  pct: number | null
}

/**
 * 汇总本轮估值所需的全部行情 secid：T1/T2 命中的指数/主题 ETF + T3 兜底基金的重仓股。
 * 命中规则的基金不需要查库，只有走 T3 的基金才查其最新重仓股代码。
 */
async function collectEstimateSecids(pool: Pool, funds: ActiveFund[]): Promise<string[]> {
  const secids = new Set<string>()
  const t3Funds: string[] = []
  for (const f of funds) {
    const m = findTrackingIndex(f.fund_name)
    if (m) secids.add(m.secid)
    else t3Funds.push(f.fund_code)
  }
  if (t3Funds.length > 0) {
    const r = await pool.query<{ stock_code: string }>(
      `SELECT DISTINCT h.stock_code
       FROM fund_holdings h
       WHERE h.fund_code = ANY($1) AND h.stock_code IS NOT NULL AND h.stock_code <> ''
         AND h.report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = h.fund_code)`,
      [t3Funds]
    )
    for (const row of r.rows) secids.add(secidOf(row.stock_code))
  }
  return [...secids]
}

/** 对一批基金做估值采样并入库：先批量预热行情，逐只逻辑据此命中缓存（不再逐只发请求）。
 *  forcePrefetch=true（盘中定时采样）强制刷新价格，保证"这次采样 = 此刻价格"；
 *  false（手动刷新链路，刚批量取过持仓股价）复用缓存，只补取尚未取过的指数/ETF。 */
async function estimateFunds(
  pool: Pool,
  funds: ActiveFund[],
  forcePrefetch = true
): Promise<{ estimates: EstimateOutcome[]; errors: { code: string; message: string }[] }> {
  const estimates: EstimateOutcome[] = []
  const errors: { code: string; message: string }[] = []

  try {
    const secids = await collectEstimateSecids(pool, funds)
    await prefetchQuotesSafely(secids, '估值行情批量预热', forcePrefetch)
  } catch (e) {
    // 收集阶段失败同样不影响正确性：逐只取价兜底
    console.warn(`[quotes] 估值行情标的收集失败，回退逐只取价: ${(e as Error).message}`)
  }

  for (const f of funds) {
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
      if (saved) estimates.push({ code: f.fund_code, name: est.indexName ?? '', source: est.source, pct: est.estPct })
    } catch (e) {
      const msg = (e as Error).message
      errors.push({ code: f.fund_code, message: `估值: ${msg}` })
      console.warn(`[quotes] ${f.fund_code} 估值失败: ${msg}`)
    }
  }
  return { estimates, errors }
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
      return {
        estTime: t3.ts,
        estPct: t3.pct,
        source: t3.source,
        indexName: `重仓股加权（覆盖${t3.coveredWeight.toFixed(0)}%）`
      }
    }
  } catch (e) {
    console.warn(`[quotes] ${fund.fund_code} T3 估算失败: ${(e as Error).message}`)
  }

  return null
}

/** 盘中高频估值采样：对全局活跃基金（所有用户自选并集，去重）做 T1/T2/T3 估值入库 */
export async function sampleEstimatesCore(pool: Pool): Promise<{ sampled: number; errors: number }> {
  const funds = await activeFunds(pool)
  if (funds.length === 0) return { sampled: 0, errors: 0 }
  const r = await estimateFunds(pool, funds)
  return { sampled: r.estimates.length, errors: r.errors.length }
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
  console.log(
    `[quotes] 日 K 新增 ${r.klineAdded} 行（跳过 ${r.klineSkipped} 只已有当日数据），当日实时价已滚动（${todayStr()}）`
  )
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
