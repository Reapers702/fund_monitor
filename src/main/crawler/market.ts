// 行情源（计划书 §4.1 #5/#E）：主 push2/push2his（东财），降级 腾讯 qt.gtimg / web.ifzq
// 熔断策略：push2 偶发 IP 风控（实测 socket hang up 全站 000），一旦连接被拒即熔断，
// 本次运行后续请求直接走腾讯；每 5 分钟探活一次尝试恢复。行情请求不重试（降级源保证可用性）。
//
// P0 改造（降请求量，直接对应"被风控"的根因）：
//   1. **批量取价** prefetchQuotes()：一次请求取多只（东财 ulist.np 主 / 腾讯 qt 批量降级）。
//      原先盘中每轮 = 每只基金 1 次 + T3 每只持仓股 1 次（约 50 次/轮），现在压到 1~2 次/轮。
//   2. **TTL 缓存**：同一轮里多只基金共享同一指数/主题 ETF 时只算一次；
//      调用方按需 force 刷新（采样/手动刷新），缓存只承担"同一批工作内的去重"。
//   3. 请求打业务标签（行情:东财push2 / 行情:腾讯qt…），供 GUI 抓取日志按"抓了什么"聚合。
import { httpGetJson, httpGetText } from './httpClient'
import { parseNum } from '../utils'
import { logInfo } from '../logger'

/** 东财 secid（1.000300 / 0.399006 / 1.600519）→ 腾讯/新浪市场前缀代码（sh600519 / sz399006） */
function secidToMarketCode(secid: string): string {
  const [mkt, code] = secid.split('.')
  if (mkt === '1') return `sh${code}`
  if (mkt === '0') return `sz${code}`
  return code
}

/** 6 位证券代码 → 东财 secid：沪市(6/9 开头，含 688) → 1.，深市/北交所 → 0. */
export function secidOf(code: string): string {
  return /^[69]/.test(code) ? `1.${code}` : `0.${code}`
}

// ---------- 数据源中文标识（日志用，便于一眼看清"被拒/重试/成功"链路） ----------
const SRC_EM = '东财push2' // 实时行情主源
const SRC_EM_HIS = '东财push2his' // 日K主源
const SRC_TX_Q = '腾讯qt' // 实时行情降级源
const SRC_TX_IFZQ = '腾讯ifzq' // 日K降级源

// 抓取日志标签（按"抓的是什么"聚合）
const TAG_EM_QUOTE = '行情:东财push2'
const TAG_TX_QUOTE = '行情:腾讯qt'
const TAG_EM_KLINE = '日K:东财push2his'
const TAG_TX_KLINE = '日K:腾讯ifzq'

// ---------- push2 熔断器 ----------

let push2BlockedUntil = 0 // 熔断截止时间戳（ms）；0 = 未熔断
const BLOCK_MS = 5 * 60_000 // 熔断 5 分钟后探活恢复

/** 是否处于熔断期（熔断期内直接走腾讯，不试探东财） */
function push2Blocked(): boolean {
  return Date.now() < push2BlockedUntil
}

/** 触发熔断（连接被拒/持续失败）；供 quote/klines 调用 */
function blockPush2(): void {
  if (push2BlockedUntil === 0)
    console.warn(`[market] ${SRC_EM} 连接被拒，熔断 5 分钟，行情改走 ${SRC_TX_Q}/${SRC_TX_IFZQ} 降级`)
  push2BlockedUntil = Date.now() + BLOCK_MS
}

/** 判断是否"连接级"失败（socket hang up / fetch failed / ECONNRESET 等，重试无意义） */
function isConnError(msg: string): boolean {
  return /socket hang up|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|连接被拒绝|EAI_AGAIN/i.test(msg)
}

/** 主源熔断状态（GUI 抓取日志页展示"是否正在被风控"） */
export function push2Status(): { blocked: boolean; until: number | null; source: string } {
  return { blocked: push2Blocked(), until: push2BlockedUntil || null, source: SRC_EM }
}

// ---------- 实时行情缓存（P0：同批工作内去重） ----------

const QUOTE_TTL_MS = 60_000
/** secid → { q, ts }；q 为 null 表示"该批次成功响应中确实没有这只"（负缓存，避免退化成逐只请求）
 *
 *  注意：这个 TTL 只是"同一批工作内去重"的兜底，**不能让慢操作夹在批量取数与消费之间**——
 *  否则缓存过期会让整批退化成逐只请求（曾实测：日K 补拉耗时数十秒，导致 120 只股票各发一次行情请求）。
 *  需要最新价的操作请用 prefetchQuotes({ force: true }) 并紧邻消费。 */
const quoteCache = new Map<string, { q: StockQuote | null; ts: number }>()

/** 重置行情缓存。生产链路不需要调用它——新鲜度由 TTL 与 prefetchQuotes({force:true}) 控制，
 *  且清空会误伤并发任务的预热结果；这里主要供单测做用例间隔离。 */
export function clearQuoteCache(): void {
  quoteCache.clear()
}

function cacheGet(secid: string): StockQuote | null | undefined {
  const e = quoteCache.get(secid)
  if (!e) return undefined
  if (Date.now() - e.ts > QUOTE_TTL_MS) {
    quoteCache.delete(secid)
    return undefined
  }
  return e.q
}

function cacheSet(secid: string, q: StockQuote | null): void {
  quoteCache.set(secid, { q, ts: Date.now() })
}

// ---------- 实时行情 ----------

export interface StockQuote {
  code: string
  name: string
  price: number | null
  open: number | null
  high: number | null
  low: number | null
  prevClose: number | null
  change: number | null
  pct: number | null // 涨跌幅 %
  volume: number | null
  amount: number | null
}

/** 实时行情（fltt=2 价格不缩放；f170=涨跌幅，T1 估值数据基础） */
export async function stockQuote(code: string): Promise<StockQuote> {
  return quoteBySecid(secidOf(code))
}

/** 按完整 secid 查实时行情（指数等非证券代码直接用，如 1.000300），push2 熔断/失败自动降级腾讯。
 *  label：可读标识（基金名/股票名），仅用于日志，便于把行情失败定位到具体标的 */
export async function quoteBySecid(secid: string, label?: string): Promise<StockQuote> {
  const code = secid.split('.')[1] ?? secid
  const who = label ? `${label}(${code})` : code

  const cached = cacheGet(secid)
  if (cached !== undefined) {
    if (cached === null) throw new Error(`${who} 无行情数据（批量查询未返回）`)
    return cached
  }

  if (push2Blocked()) {
    try {
      const q = await quoteFallbackTencent(secidToMarketCode(secid), code)
      cacheSet(secid, q)
      console.warn(`[market] 行情 ${who} ← ${SRC_EM} 熔断中，改走 ${SRC_TX_Q} 成功`)
      return q
    } catch (e2) {
      console.error(`[market] 行情 ${who} ← ${SRC_EM} 熔断中，改走 ${SRC_TX_Q} 也失败: ${(e2 as Error).message}`)
      throw e2
    }
  }
  try {
    const d = await httpGetJson<{ data?: Record<string, unknown> }>(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}` +
        `&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170&invt=2&fltt=2`,
      { referer: 'https://quote.eastmoney.com/', retries: 0, tag: TAG_EM_QUOTE }
    )
    const q = d.data ?? {}
    const quote: StockQuote = {
      code: String(q.f57 ?? code),
      name: String(q.f58 ?? ''),
      price: parseNum(q.f43),
      open: parseNum(q.f46),
      high: parseNum(q.f44),
      low: parseNum(q.f45),
      prevClose: parseNum(q.f60),
      change: parseNum(q.f169),
      pct: parseNum(q.f170),
      volume: parseNum(q.f47),
      amount: parseNum(q.f48)
    }
    cacheSet(secid, quote)
    return quote
  } catch (e) {
    const msg = (e as Error).message
    if (isConnError(msg)) blockPush2()
    try {
      const q = await quoteFallbackTencent(secidToMarketCode(secid), code)
      cacheSet(secid, q)
      console.warn(`[market] 行情 ${who} ← ${SRC_EM} 失败(${msg}) → ${SRC_TX_Q} 成功`)
      return q
    } catch (e2) {
      console.error(`[market] 行情 ${who} ← ${SRC_EM} 失败(${msg}) → ${SRC_TX_Q} 也失败: ${(e2 as Error).message}`)
      throw e2
    }
  }
}

/** 腾讯单只行情：qt.gtimg.cn/q=sh600519，GBK，~ 分隔 */
async function quoteFallbackTencent(mktCode: string, code: string): Promise<StockQuote> {
  const text = await httpGetText(`https://qt.gtimg.cn/q=${mktCode}`, {
    referer: 'https://gu.qq.com/',
    retries: 0,
    encoding: 'gbk',
    tag: TAG_TX_QUOTE
  })
  const m = text.match(/="([^"]+)"/)
  const parts = m ? m[1].split('~') : []
  if (parts.length < 35) {
    throw new Error(`腾讯行情 ${mktCode} 解析失败`)
  }
  return tencentPartsToQuote(parts, code)
}

/** 腾讯行情字段 → StockQuote（单只与批量共用）
 *  字段：1名称 3现价 4昨收 5今开 31涨跌额 32涨跌% 33最高 34最低 36成交量(手) 37成交额(万) */
function tencentPartsToQuote(parts: string[], code: string): StockQuote {
  return {
    code,
    name: parts[1],
    price: parseNum(parts[3]),
    open: parseNum(parts[5]),
    high: parseNum(parts[33]),
    low: parseNum(parts[34]),
    prevClose: parseNum(parts[4]),
    change: parseNum(parts[31]),
    pct: parseNum(parts[32]),
    volume: parseNum(parts[36]),
    amount: parseNum(parts[37])
  }
}

// ---------- 批量实时行情（P0：把"逐只请求"合并成"一次请求多只"） ----------

const BATCH_CHUNK = 50 // 单请求最多几只标的（URL 长度与站点容忍度折中）

export interface PrefetchOptions {
  /** true = 忽略 TTL 缓存强制刷新（估值采样/手动刷新应传 true） */
  force?: boolean
}

/** 东财 ulist 行 → StockQuote（f2现价 f3涨跌幅 f4涨跌额 f5量 f6额 f12代码 f14名称 f15高 f16低 f17开 f18昨收） */
function eastmoneyRowToQuote(row: Record<string, unknown>, fallbackCode: string): StockQuote {
  return {
    code: String(row.f12 ?? fallbackCode),
    name: String(row.f14 ?? ''),
    price: parseNum(row.f2),
    open: parseNum(row.f17),
    high: parseNum(row.f15),
    low: parseNum(row.f16),
    prevClose: parseNum(row.f18),
    change: parseNum(row.f4),
    pct: parseNum(row.f3),
    volume: parseNum(row.f5),
    amount: parseNum(row.f6)
  }
}

/**
 * 批量实时行情：一次请求取多只（东财 ulist.np 主 → 腾讯 qt 批量降级），结果写入缓存。
 *
 * 关键语义：**一次成功的批量响应对其请求成员是权威的**——响应里没出现的 secid 记为负缓存
 * （null），这样后续 quoteBySecid 不会为它再发单只请求（否则批量等于白做）。
 * 返回实际写入缓存的条数；整批失败则缓存不动，调用方回退逐只取价（功能不受影响，只是变慢）。
 */
export async function prefetchQuotes(secids: string[], opts: PrefetchOptions = {}): Promise<number> {
  const { force = false } = opts
  const uniq = [...new Set(secids.filter(Boolean))]
  // 缓存优先：非强制刷新时只请求尚未缓存的标的（已被别的批次取过的直接复用，
  // 例如手动刷新里"持仓股行情"与"估值所需指数/ETF"两批请求能互相复用，不重复取）
  const targets = force ? uniq : uniq.filter((s) => cacheGet(s) === undefined)
  if (targets.length === 0) return 0

  let filled = 0
  for (let i = 0; i < targets.length; i += BATCH_CHUNK) {
    filled += await prefetchChunk(targets.slice(i, i + BATCH_CHUNK), force)
  }
  return filled
}

async function prefetchChunk(chunk: string[], force: boolean): Promise<number> {
  // 熔断期直接走腾讯，不试探东财
  if (!push2Blocked()) {
    try {
      return await prefetchChunkEastmoney(chunk, force)
    } catch (e) {
      const msg = (e as Error).message
      if (isConnError(msg)) blockPush2()
      console.warn(`[market] 批量行情 ← ${SRC_EM} 失败(${msg}) → ${SRC_TX_Q} 批量降级`)
    }
  }
  try {
    return await prefetchChunkTencent(chunk, force)
  } catch (e) {
    console.error(`[market] 批量行情 ${SRC_EM}/${SRC_TX_Q} 均失败，本轮回退逐只取价: ${(e as Error).message}`)
    return 0
  }
}

/** 东财批量：ulist.np/get?secids=1.000300,0.399006&fltt=2 */
async function prefetchChunkEastmoney(chunk: string[], force: boolean): Promise<number> {
  if (!force && chunk.every((s) => cacheGet(s) !== undefined)) return 0 // 全在缓存内，无需请求
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?secids=${chunk.join(',')}` +
    `&fields=f2,f3,f4,f5,f6,f12,f13,f14,f15,f16,f17,f18&fltt=2&invt=2`
  const d = await httpGetJson<{ data?: { diff?: unknown } }>(url, {
    referer: 'https://quote.eastmoney.com/',
    retries: 0,
    tag: TAG_EM_QUOTE
  })
  const raw = d.data?.diff
  const rows: Record<string, unknown>[] = Array.isArray(raw)
    ? (raw as Record<string, unknown>[])
    : raw && typeof raw === 'object'
      ? Object.values(raw as Record<string, Record<string, unknown>>)
      : []

  // 空响应视为失败：站点被限流时可能回 200 但 data.diff 为空，
  // 若把它当成"这批标的都没有行情"就会写满负缓存 → 本轮估值全空。改为抛错，走腾讯批量降级。
  if (rows.length === 0) throw new Error(`${SRC_EM} 批量返回空（请求 ${chunk.length} 只）`)

  const want = new Set(chunk)
  const seen = new Set<string>()
  for (const row of rows) {
    const code = String(row.f12 ?? '')
    const mkt = String(row.f13 ?? '')
    if (!code || !mkt) continue
    const secid = `${mkt}.${code}`
    // 只认本次请求的成员（站点偶尔回带其他标的），避免污染缓存
    if (!want.has(secid)) continue
    cacheSet(secid, eastmoneyRowToQuote(row, code))
    seen.add(secid)
  }
  // 请求成功但成员缺席 → 负缓存（权威结论：这只当前无行情）
  for (const s of chunk) if (!seen.has(s)) cacheSet(s, null)
  logInfo(`[market] 批量行情 ${SRC_EM} 一次取回 ${seen.size}/${chunk.length} 只`)
  return seen.size
}

/** 腾讯批量：qt.gtimg.cn/q=sh600519,sz000001（GBK） */
async function prefetchChunkTencent(chunk: string[], force: boolean): Promise<number> {
  if (!force && chunk.every((s) => cacheGet(s) !== undefined)) return 0
  const mktToSecid = new Map<string, string>()
  for (const s of chunk) mktToSecid.set(secidToMarketCode(s), s)

  const text = await httpGetText(`https://qt.gtimg.cn/q=${[...mktToSecid.keys()].join(',')}`, {
    referer: 'https://gu.qq.com/',
    retries: 0,
    encoding: 'gbk',
    tag: TAG_TX_QUOTE
  })

  const seen = new Set<string>()
  for (const m of text.matchAll(/v_([a-zA-Z]{2}\d+)="([^"]*)"/g)) {
    const secid = mktToSecid.get(m[1])
    if (!secid) continue
    const parts = m[2].split('~')
    if (parts.length < 35) continue
    cacheSet(secid, tencentPartsToQuote(parts, secid.split('.')[1] ?? secid))
    seen.add(secid)
  }
  for (const s of chunk) if (!seen.has(s)) cacheSet(s, null)
  logInfo(`[market] 批量行情 ${SRC_TX_Q} 一次取回 ${seen.size}/${chunk.length} 只`)
  return seen.size
}

// ---------- 日 K（主 push2his 东财，降级 腾讯 web.ifzq.gtimg.cn） ----------

export interface KlineRow {
  tradeDate: string // 2026-08-12
  open: number | null
  close: number | null
  high: number | null
  low: number | null
  volume: number | null
  amount: number | null
  amp: number | null // 振幅 %
}

interface KlineResp {
  data?: {
    code?: string
    name?: string
    klines?: string[]
  }
}

/**
 * 日 K（klt=101, 前复权 fqt=1）。返回按日期升序。
 * klines 行格式: "date,open,close,high,low,volume,amount,amp%"
 */
export async function stockKlines(code: string, lmt = 120): Promise<{ name: string; rows: KlineRow[] }> {
  return klinesBySecid(secidOf(code), lmt)
}

/** 按完整 secid 取日 K（指数等非证券代码直接用，如 1.000300 沪深300；push2his 熔断/失败降级腾讯）。
 *  label：可读标识（基金名/指数名），仅用于日志 */
export async function klinesBySecid(
  secid: string,
  lmt = 120,
  label?: string
): Promise<{ name: string; rows: KlineRow[] }> {
  const code = secid.split('.')[1] ?? secid
  const who = label ? `${label}(${code})` : code
  if (push2Blocked()) {
    try {
      const r = await klinesFallbackTencent(secid, lmt)
      console.warn(`[market] 日K ${who} ← ${SRC_EM_HIS} 熔断中，改走 ${SRC_TX_IFZQ} 成功(${r.rows.length}条)`)
      return r
    } catch (e2) {
      console.error(`[market] 日K ${who} ← ${SRC_EM_HIS} 熔断中，改走 ${SRC_TX_IFZQ} 也失败: ${(e2 as Error).message}`)
      throw e2
    }
  }
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&end=20500101&lmt=${lmt}`
  try {
    const d = await httpGetJson<KlineResp>(url, {
      referer: 'https://quote.eastmoney.com/',
      retries: 0,
      tag: TAG_EM_KLINE
    })
    const rows: KlineRow[] = []
    for (const line of d.data?.klines ?? []) {
      const c = line.split(',')
      if (c.length < 8) continue
      rows.push({
        tradeDate: c[0],
        open: parseNum(c[1]),
        close: parseNum(c[2]),
        high: parseNum(c[3]),
        low: parseNum(c[4]),
        volume: parseNum(c[5]),
        amount: parseNum(c[6]),
        amp: parseNum(c[7])
      })
    }
    return { name: d.data?.name ?? '', rows }
  } catch (e) {
    const msg = (e as Error).message
    if (isConnError(msg)) blockPush2()
    try {
      const r = await klinesFallbackTencent(secid, lmt)
      console.warn(`[market] 日K ${who} ← ${SRC_EM_HIS} 失败(${msg}) → ${SRC_TX_IFZQ} 成功(${r.rows.length}条)`)
      return r
    } catch (e2) {
      console.error(`[market] 日K ${who} ← ${SRC_EM_HIS} 失败(${msg}) → ${SRC_TX_IFZQ} 也失败: ${(e2 as Error).message}`)
      throw e2
    }
  }
}

/** 腾讯前复权日 K：web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,N,qfq
 *  返回 data.{code}.qfqday = [[date,open,close,high,low,volume], ...]；指数无复权数据，取 data.{code}.day */
async function klinesFallbackTencent(secid: string, lmt: number): Promise<{ name: string; rows: KlineRow[] }> {
  const mktCode = secidToMarketCode(secid)
  const code = secid.split('.')[1] ?? secid
  const text = await httpGetText(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mktCode},day,,,${lmt},qfq`,
    { referer: 'https://gu.qq.com/', retries: 0, tag: TAG_TX_KLINE }
  )
  const d = JSON.parse(text) as { data?: Record<string, { qfqday?: string[][]; day?: string[][] }> }
  const arr = d.data?.[mktCode]?.qfqday ?? d.data?.[mktCode]?.day ?? []
  const rows: KlineRow[] = arr.map((c) => ({
    tradeDate: c[0],
    open: parseNum(c[1]),
    close: parseNum(c[2]),
    high: parseNum(c[3]),
    low: parseNum(c[4]),
    volume: parseNum(c[5]),
    amount: null,
    amp: null
  }))
  return { name: code, rows }
}
