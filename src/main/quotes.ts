// 行情/估值采集（计划书 M4）：对 fund_basic 中全部基金：
// 持仓股日 K 补种 + 当日实时价滚动 → stock_daily；盘中估值（T1 跟踪指数 / T2 主题 ETF）→ fund_estimate
// runQuotesCore 供 CLI（--quotes）与 IPC（quotes:run）、scheduler 共用
//
// P0 改造（降请求量，直接对应"被风控"的根因）：
//   1. 估值取价 =「批量预热 + 逐只读缓存」：一次请求取回本轮全部指数/主题ETF/重仓股行情，
//      替代原先"每只基金 1 次 + T3 每只持仓股 1 次"（10 只基金约 50 次/轮 → 1~2 次/轮）。
//      预热失败不影响正确性：逐只取价路径仍在，只是变慢。
//   2. 日 K 只在"官方日K 还没覆盖最近一个已收盘交易日"时才补拉，替代原先每次手动刷新都重拉全部 120 根。
//
// P1 修复（日K 口径，"跳过 120 只"根因）：
//   a) 判断口径：只认 source='kline' 的官方行，且目标日取"最近一个已收盘交易日"（15:30 后为今天）。
//      原口径看 max(trade_date)，盘中/盘前写进来的实时价快照行会让日K 永远"已最新"——
//      日K 既不补也不再核对，快照的价格/成交量就留在日K 表里（实测：10-12 的行 = 10-09 那根K线）。
//   b) 写入口径：官方日K 覆盖非官方行（校正），实时快照只滚动未定型行、绝不覆盖官方日K；
//      官方日K 只落"已定型"的日期（盘中那根当天部分K线不落库）。
//   c) 实时价快照只在交易日开盘后（09:15 起）滚动：盘前/非交易日拿到的行情还是上一交易日的值，
//      写成"今天"的行就是脏数据（实测：凌晨 1:30 跑的一次同步把 10-09 那根K线写成 10-12 的行）。
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema } from './storage/db'
import { cleanupWeekendStockRows, latestKlineDate, saveStockDaily } from './storage/stockRepo'
import { saveEstimate } from './storage/estimateRepo'
import { getMarkers, setMarkers } from './storage/crawlMarker'
import { beginTask, failTask, finishTask, taskPhase, taskStep, taskTick } from './tasks'
import { prefetchQuotes, secidOf, stockKlines, stockQuote } from './crawler/market'
import { estimateT1, estimateT3, findTrackingIndex } from './crawler/estimate'
import { syncFund } from './fund'
import { isTradingDay as isTradingDayCal, latestClosedTradingDayStr } from './scheduler/tradingCalendar'
import { nowMinutes } from './scheduler/time'
import { decideKlineNeed, filterFinalKlines } from './klinePlan'
import { logInfo } from './logger'
import type { Pool } from 'pg'

/** 日K 补拉最短间隔：数据源当天K线未更新时（早盘/收盘前），只按日期判断会每次刷新都全量重拉 */
const KLINE_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000

/** 当日实时价快照最早可写时刻（本地时间 09:15）：更早拿到的是上一交易日的行情 */
const SNAPSHOT_FROM_MINUTES = 9 * 60 + 15

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
  klineAdded: number // 新补入库的日K 行数
  klineFixed: number // 用官方日K 校正（覆盖实时价快照等非官方行）的行数
  klineSkipped: number // 跳过日K补拉的股票数（官方日K 已覆盖最近一个已收盘交易日）
  klineThrottled: number // 因 6 小时节流跳过的股票数（刚补过，数据源当天K线可能还没更新）
  estimates: { code: string; name: string; source: string; pct: number | null }[]
  errors: { code: string; message: string }[]
}

/** 日K 同步（补拉/校正）结果，见 syncStocksKlines */
interface KlineSyncSummary {
  total: number
  need: number
  skipped: number
  throttled: number
  added: number
  fixed: number
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
    klineFixed: 0,
    klineSkipped: 0,
    klineThrottled: 0,
    estimates: [],
    errors: []
  }

  const funds = await activeFunds(pool)
  result.fundCount = funds.length
  if (funds.length === 0) return result

  // 单飞：已在跑则抛 TaskBusyError，调用方（IPC/CLI）据此提示而不是重复抓一遍
  beginTask('quotes', funds.length, '准备标的')

  try {
    return await runQuotesBody(pool, funds, result)
  } catch (e) {
    failTask('quotes', (e as Error).message)
    throw e
  }
}

/** 活跃基金的全部重仓股（去重）。runQuotesCore 与收盘后日K校正共用 */
async function activeHoldingCodes(pool: Pool, funds: ActiveFund[]): Promise<string[]> {
  const all = new Set<string>()
  for (const f of funds) {
    const codes = await latestHoldingCodes(pool, f.fund_code)
    codes.forEach((c) => all.add(c))
  }
  return [...all]
}

/** runQuotesCore 主体（进度埋点已铺开，故单独拆一层，让异常统一落 failTask） */
async function runQuotesBody(pool: Pool, funds: ActiveFund[], result: QuotesResult): Promise<QuotesResult> {
  const today = todayStr()
  // 注意：这里刻意不再 clearQuoteCache()。批量预热用 force=true 覆盖所需标的，
  // 而清空整个缓存会顺带干掉"另一个正在跑的任务"刚预热好的数据（调度器估值采样与本流程可能重叠），
  // 导致对方退化成逐只取价——那正是我们要避免的请求量放大。

  // 1. 收集本轮需要的全部标的：持仓股（实时价/日K）+ 估值所需（指数/主题ETF/持仓股）
  taskPhase('quotes', '收集持仓股', funds.length)
  const stockList = await activeHoldingCodes(pool, funds)
  result.stockCount = stockList.length
  for (const f of funds) taskTick('quotes', f.fund_name)
  taskStep('quotes', `持仓涉及 ${stockList.length} 只股票（${funds.length} 只基金）`)

  let estimateSecids: string[] = []
  try {
    estimateSecids = await collectEstimateSecids(pool, funds)
  } catch (e) {
    console.warn(`[quotes] 估值标的收集失败（本轮估值将逐只取价兜底）: ${(e as Error).message}`)
  }

  // 2. 日 K 补拉/校正（**必须放在行情批量预热之前**）：这是本流程里唯一逐只请求、耗时最长的环节，
  //    若夹在"批量预热"和"读缓存写库"之间，行情缓存会在等待中过期，整批退化成逐只请求
  //    （曾实测：120 只股票 → 120 次日K + 120 次行情请求）。
  const kline = await syncStocksKlines(pool, stockList, result.errors)
  result.klineAdded = kline.added
  result.klineFixed = kline.fixed
  result.klineSkipped = kline.skipped
  result.klineThrottled = kline.throttled

  // 3. 行情批量预热：一次覆盖全部持仓股 + 指数/主题ETF（随后实时价写库与估值都读这份缓存）
  const allSecids = [...new Set([...stockList.map(secidOf), ...estimateSecids])]
  taskPhase('quotes', '行情批量预热', allSecids.length)
  await prefetchQuotesSafely(allSecids, `行情批量预热`, true, (msg, e) =>
    result.errors.push({ code: '-', message: `${msg}: ${e}` })
  )
  taskStep('quotes', `行情批量预热 ${allSecids.length} 只（含指数/ETF）`)

  // 4. 当日实时价滚动入库（读第 3 步的缓存，不再逐只请求）。
  //    只在"交易日 + 开盘后"滚动：盘前/非交易日行情还是上一交易日的值，写成"今天"的行就是脏数据
  //    （实测：凌晨 01:30 跑的一次同步把 10-09 那根K线写成了 10-12 的行）。
  //    行标 source='quote'，saveStockDaily 保证它不会覆盖已定型的官方日K。
  const snapshotOk = (await isTradingDayCal()) && nowMinutes() >= SNAPSHOT_FROM_MINUTES
  if (snapshotOk) {
    taskPhase('quotes', '实时价入库', stockList.length)
    await mapLimit(stockList, 3, async (code) => {
      try {
        const q = await stockQuote(code)
        if (q.price !== null && q.name) {
          await saveStockDaily(
            pool,
            code,
            [
              {
                tradeDate: today,
                open: q.open,
                close: q.price,
                high: q.high,
                low: q.low,
                volume: q.volume,
                amount: q.amount,
                pct: q.pct
              }
            ],
            'quote'
          )
        }
      } catch (e) {
        result.errors.push({ code, message: (e as Error).message })
      } finally {
        taskTick('quotes', code)
      }
    })
  } else {
    taskStep('quotes', '非交易时段：跳过当日实时价入库（沿用官方日K，避免把上一交易日行情当成今天）')
  }

  // 5. 盘中估值（T1 跟踪指数 / T2 主题 ETF / T3 重仓股加权）：读第 3 步同一份缓存，只补尚未取到的
  taskPhase('quotes', '估值采样', funds.length)
  const est = await estimateFunds(pool, funds, false)
  result.estimates = est.estimates
  result.errors.push(...est.errors)

  // 6. 净值增量（顺带补齐 T+1 公布的净值；幂等，无新数据则 0 条）。
  //    与 GUI"刷新行情/估值"按钮同链路，保证手动刷新时缺口立即补上（周五净值周六凌晨公布场景）
  taskPhase('quotes', '净值增量', funds.length)
  for (const f of funds) {
    try {
      await syncFund(pool, f.fund_code, () => {}, { skipDetailIfKnown: true })
      taskStep('quotes', `净值增量 ${f.fund_code} ${f.fund_name}`)
    } catch (e) {
      result.errors.push({ code: f.fund_code, message: `净值增量: ${(e as Error).message}` })
    } finally {
      taskTick('quotes', f.fund_name)
    }
  }

  finishTask(
    'quotes',
    `行情刷新完成：${funds.length} 只基金 / ${stockList.length} 只股票，估值 ${result.estimates.length} 条，` +
      `日K 补 ${result.klineAdded} 行${result.klineFixed > 0 ? `、校正 ${result.klineFixed} 行` : ''}` +
      `（已是最新 ${result.klineSkipped} 只` +
      (result.klineThrottled > 0 ? `，${result.klineThrottled} 只 6 小时内补过` : '') +
      `）` +
      (result.errors.length > 0 ? `，${result.errors.length} 处失败（见「抓取日志」页）` : '')
  )
  return result
}

/**
 * 日K 核对/补拉（step 2 的独立实现，供 runQuotesCore 与收盘后自动校正共用）。
 *
 * 判断口径（P1 修复）：
 *   - 目标日 = 最近一个"已收盘"交易日（15:30 后为今天；此前是上一个交易日）——该日日K 应已定型；
 *   - 只看 source='kline' 的官方行是否已覆盖目标日；未覆盖才拉，且 6 小时内不重复拉同一标的；
 *   - 拉到后只落"已定型"的日期（数据源盘中给的当天部分K线不落库），
 *     并用官方日K 覆盖非官方行（历史脏行/实时价快照 → 校正）。
 *
 * 进度埋点用 tasks.ts：没有对应任务在跑时是空操作，所以收盘后自动校正也能安全复用本函数。
 */
async function syncStocksKlines(
  pool: Pool,
  stockList: string[],
  errors: { code: string; message: string }[]
): Promise<KlineSyncSummary> {
  const summary: KlineSyncSummary = {
    total: stockList.length,
    need: 0,
    skipped: 0,
    throttled: 0,
    added: 0,
    fixed: 0
  }
  if (stockList.length === 0) return summary

  const klineTarget = latestClosedTradingDayStr()
  const markerMap = await getMarkers(pool, stockList.map(klineMarker))
  const need: string[] = []
  for (const code of stockList) {
    const latest = await latestKlineDate(pool, code)
    const decision = decideKlineNeed({
      latestKlineDate: latest,
      latestClosed: klineTarget,
      markerAt: markerMap.get(klineMarker(code)),
      now: Date.now(),
      minIntervalMs: KLINE_MIN_INTERVAL_MS
    })
    if (decision === 'have') summary.skipped++
    else if (decision === 'throttled') summary.throttled++
    else need.push(code)
  }
  summary.need = need.length

  if (summary.skipped > 0 || summary.throttled > 0) {
    logInfo(
      `[quotes] 日K 目标日 ${klineTarget}：已是最新 ${summary.skipped} 只` +
        (summary.throttled > 0 ? `，6 小时内已补过 ${summary.throttled} 只` : '') +
        `，需补拉 ${need.length} 只`
    )
  }
  taskStep(
    'quotes',
    `日K 目标日 ${klineTarget}：需补拉 ${need.length} 只，已是最新 ${summary.skipped} 只` +
      (summary.throttled > 0 ? `，节流跳过 ${summary.throttled} 只` : '')
  )

  taskPhase('quotes', '日K补拉', need.length)
  const klineFetched: string[] = []
  await mapLimit(need, 3, async (code) => {
    try {
      const { rows } = await stockKlines(code, 120)
      const w = await saveStockDaily(pool, code, filterFinalKlines(rows, klineTarget), 'kline')
      summary.added += w.written
      summary.fixed += w.fixed
      klineFetched.push(klineMarker(code))
    } catch (e) {
      errors.push({ code, message: `日K: ${(e as Error).message}` })
    } finally {
      taskTick('quotes', code)
    }
  })
  if (klineFetched.length > 0) await setMarkers(pool, klineFetched)

  if (summary.fixed > 0)
    logInfo(`[quotes] 日K 校正 ${summary.fixed} 行（用数据源官方日K 覆盖非官方行，如实时价快照/历史脏行）`)
  return summary
}

/** 单飞标志：收盘后自动校正与其它流程可能重叠，避免同时对同一批标的重复拉取 */
let reconciling = false

/**
 * 收盘后日K 校正（调度器调用）：只做"官方日K 核对/校正"这一步，不碰估值/净值，也不占
 * "刷新行情/估值"任务位（避免和用户手动刷新互斥）。返回待补拉数量，调用方据此决定是否次日重试。
 */
export async function reconcileKlinesCore(pool: Pool): Promise<{
  total: number
  need: number
  added: number
  fixed: number
  removedWeekend: number
}> {
  const empty = { total: 0, need: 0, added: 0, fixed: 0, removedWeekend: 0 }
  if (reconciling) return empty
  reconciling = true
  try {
    // 顺带清掉"周末日期"的脏行（官方日K 永远没有周六/周日；只按星期判断，不依赖节假日表）
    const removedWeekend = await cleanupWeekendStockRows(pool)
    if (removedWeekend > 0) logInfo(`[quotes] 清理周末日期的行情脏行 ${removedWeekend} 行`)

    const funds = await activeFunds(pool)
    if (funds.length === 0) return { ...empty, removedWeekend }
    const stockList = await activeHoldingCodes(pool, funds)
    const errors: { code: string; message: string }[] = []
    const kline = await syncStocksKlines(pool, stockList, errors)
    if (errors.length > 0) logInfo(`[quotes] 日K 校正有 ${errors.length} 只失败（下轮/次日重试）`)
    return {
      total: kline.total,
      need: kline.need,
      added: kline.added,
      fixed: kline.fixed,
      removedWeekend
    }
  } finally {
    reconciling = false
  }
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
      // 逐基金进度（"哪个估值完了"）：仅在 runQuotesCore 开启的任务里登记，调度器采样时无任务是空操作
      taskStep('quotes', `${f.fund_code} ${f.fund_name} ${estSourceText(est.source)} ${fmtPctText(est.estPct)}`)
    } catch (e) {
      const msg = (e as Error).message
      errors.push({ code: f.fund_code, message: `估值: ${msg}` })
      console.warn(`[quotes] ${f.fund_code} 估值失败: ${msg}`)
    } finally {
      taskTick('quotes', f.fund_name)
    }
  }
  return { estimates, errors }
}

/** 估值来源中文名（进度行用） */
function estSourceText(source: string): string {
  if (source === 'tracking_index') return 'T1 跟踪指数'
  if (source === 'theme_etf') return 'T2 主题ETF'
  if (source === 'holdings_weighted') return 'T3 重仓股加权'
  return source
}

function fmtPctText(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
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
    `[quotes] 日K 新增 ${r.klineAdded} 行、校正 ${r.klineFixed} 行（已是最新 ${r.klineSkipped} 只` +
      (r.klineThrottled > 0 ? `，6 小时内补过 ${r.klineThrottled} 只` : '') +
      `），当日实时价快照滚动（${todayStr()}，非交易时段不写）`
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
