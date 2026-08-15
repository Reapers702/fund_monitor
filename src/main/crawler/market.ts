// 行情源（计划书 §4.1 #5/#E）：主 push2/push2his（东财），降级 腾讯 qt.gtimg / web.ifzq
// 熔断策略：push2 偶发 IP 风控（实测 socket hang up 全站 000），一旦连接被拒即熔断，
// 本次运行后续请求直接走腾讯；每 5 分钟探活一次尝试恢复。行情请求不重试（降级源保证可用性）。
import { httpGetJson, httpGetText } from './httpClient'
import { parseNum } from '../utils'

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

// ---------- push2 熔断器 ----------

let push2BlockedUntil = 0 // 熔断截止时间戳（ms）；0 = 未熔断
const BLOCK_MS = 5 * 60_000 // 熔断 5 分钟后探活恢复

/** 是否处于熔断期（熔断期内直接走腾讯，不试探东财） */
function push2Blocked(): boolean {
  return Date.now() < push2BlockedUntil
}

/** 触发熔断（连接被拒/持续失败）；供 quote/klines 调用 */
function blockPush2(): void {
  if (push2BlockedUntil === 0) console.warn('[market] push2 连接被拒，熔断 5 分钟，行情走腾讯降级')
  push2BlockedUntil = Date.now() + BLOCK_MS
}

/** 判断是否"连接级"失败（socket hang up / fetch failed / ECONNRESET 等，重试无意义） */
function isConnError(msg: string): boolean {
  return /socket hang up|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|连接被拒绝|EAI_AGAIN/i.test(msg)
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

/** 按完整 secid 查实时行情（指数等非证券代码直接用，如 1.000300），push2 熔断/失败自动降级腾讯 */
export async function quoteBySecid(secid: string): Promise<StockQuote> {
  const code = secid.split('.')[1] ?? secid
  if (push2Blocked()) {
    return quoteFallbackTencent(secidToMarketCode(secid), code)
  }
  try {
    const d = await httpGetJson<{ data?: Record<string, unknown> }>(
      `https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}` +
        `&fields=f43,f44,f45,f46,f47,f48,f57,f58,f60,f169,f170&invt=2&fltt=2`,
      { referer: 'https://quote.eastmoney.com/', retries: 0 }
    )
    const q = d.data ?? {}
    return {
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
  } catch (e) {
    const msg = (e as Error).message
    if (isConnError(msg)) blockPush2()
    console.warn(`[market] push2 ${secid} 失败，降级腾讯: ${msg}`)
    return quoteFallbackTencent(secidToMarketCode(secid), code)
  }
}

/** 腾讯行情：qt.gtimg.cn/q=sh600519,sz000807，GBK，~ 分隔。
 *  字段：1名称 2代码 3现价 4昨收 5今开 31涨跌额 32涨跌% 33最高 34最低 36成交量(手) 37成交额(万) */
async function quoteFallbackTencent(mktCode: string, code: string): Promise<StockQuote> {
  const text = await httpGetText(`https://qt.gtimg.cn/q=${mktCode}`, { referer: 'https://gu.qq.com/', retries: 0 })
  const m = text.match(/="([^"]+)"/)
  const parts = m ? m[1].split('~') : []
  if (parts.length < 35) {
    throw new Error(`腾讯行情 ${mktCode} 解析失败`)
  }
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
  const secid = secidOf(code)
  if (push2Blocked()) {
    return klinesFallbackTencent(code, lmt)
  }
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    `&klt=101&fqt=1&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56,f57,f58&end=20500101&lmt=${lmt}`
  try {
    const d = await httpGetJson<KlineResp>(url, { referer: 'https://quote.eastmoney.com/', retries: 0 })
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
    console.warn(`[market] push2his ${code} 失败，降级腾讯日K: ${msg}`)
    return klinesFallbackTencent(code, lmt)
  }
}

/** 腾讯前复权日 K：web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,N,qfq
 *  返回 data.{code}.qfqday = [[date,open,close,high,low,volume], ...] */
async function klinesFallbackTencent(code: string, lmt: number): Promise<{ name: string; rows: KlineRow[] }> {
  const mktCode = secidToMarketCode(secidOf(code))
  const text = await httpGetText(
    `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${mktCode},day,,,${lmt},qfq`,
    { referer: 'https://gu.qq.com/', retries: 0 }
  )
  const d = JSON.parse(text) as { data?: Record<string, { qfqday?: string[][] }> }
  const arr = d.data?.[mktCode]?.qfqday ?? []
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
