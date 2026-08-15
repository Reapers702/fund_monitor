// 交易日历（计划书 scheduler 增强）：判断某天是否为 A 股交易日
// 数据源：腾讯日 K（web.ifzq.gtimg.cn）拉基准股最近交易日列表——直接反映真实交易日（含节假日/调休/临时休市）
// 降级链：腾讯接口 → 内置静态休市表 → 仅周末判断
// 缓存：交易日列表缓存 24h，避免频繁请求（腾讯源从未被风控，但仍保留兜底）
import { httpGetJson } from '../crawler/httpClient'

// ---------- 静态休市日表（兜底；节假日为公开信息，覆盖 2026-2027） ----------
// 注意：此表仅作为接口不可用时的粗略兜底，实际以腾讯接口返回为准。
const STATIC_HOLIDAYS: string[] = [
  // 2026 年（节假日 + 调休补班日；补班日股市不开盘，故也列为非交易日）
  '2026-01-01', '2026-01-02', // 元旦
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23', // 春节(2/17除夕) 假期含调休至 2/23，2/24 恢复
  '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', // 劳动节
  '2026-06-19', // 端午(6/19)
  '2026-09-25', // 中秋(9/25)
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
  // 2027 年（仅公历固定节日；农历春节/端午/中秋日期未核实，接口不可用时此表可能漏判，
  // 属可接受的兜底误差——正常运行时以腾讯接口实时交易日为准）
  '2027-01-01', '2027-01-02', '2027-01-03', // 元旦
  '2027-04-05', // 清明(4/5 周一)
  '2027-05-01', '2027-05-02', '2027-05-03', // 劳动节
  '2027-10-01', '2027-10-02', '2027-10-03', '2027-10-04', '2027-10-05', '2027-10-06', '2027-10-07' // 国庆
]

const STATIC_SET = new Set(STATIC_HOLIDAYS)

// ---------- 腾讯交易日列表缓存 ----------

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h
const BENCH_STOCK = '600519' // 贵州茅台（常年交易、停牌极少）
const FETCH_LIMIT = 200 // 约 9 个月交易日（实测 lmt=200 有效，超大值反而被限到 30 条）

let cachedDays: Set<string> | null = null
let cachedAt = 0

interface TencentKlineResp {
  data?: Record<string, { qfqday?: string[][]; day?: string[][] }>
}

/** 拉取基准股最近交易日（腾讯前复权日K）；失败返回 null */
async function fetchTradingDays(): Promise<string[] | null> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh${BENCH_STOCK},day,,,${FETCH_LIMIT},qfq`
  try {
    const d = await httpGetJson<TencentKlineResp>(url, { referer: 'https://gu.qq.com/', retries: 1, timeoutMs: 10000 })
    const arr = d.data?.[`sh${BENCH_STOCK}`]?.qfqday ?? d.data?.[`sh${BENCH_STOCK}`]?.day ?? []
    const days = arr.map((c) => c[0]).filter((x): x is string => Boolean(x) && /^\d{4}-\d{2}-\d{2}$/.test(x))
    return days.length > 0 ? days : null
  } catch (e) {
    console.warn(`[calendar] 腾讯交易日接口失败: ${(e as Error).message}`)
    return null
  }
}

/** 获取最近交易日集合（带 24h 缓存）；接口失败返回 null（调用方走静态表兜底） */
async function getTradingDaySet(): Promise<Set<string> | null> {
  const now = Date.now()
  if (cachedDays && now - cachedAt < CACHE_TTL_MS) return cachedDays
  const days = await fetchTradingDays()
  if (!days) return null
  cachedDays = new Set(days)
  cachedAt = now
  return cachedDays
}

/** 本地日期 YYYY-MM-DD */
function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 判断某天是否交易日：
 * 1. 周末直接 false
 * 2. 腾讯交易日列表：目标日必须在列表时间范围内（首尾之间）才可用列表下结论
 * 3. 接口失败 / 超出列表范围 → 静态休市表：工作日且非休市日 → true
 */
export async function isTradingDay(d = new Date()): Promise<boolean> {
  const day = d.getDay()
  if (day === 0 || day === 6) return false // 周末

  const ds = dateStr(d)
  const set = await getTradingDaySet()
  if (set && set.size > 0) {
    // 列表按日期升序，取首尾判断目标日是否在覆盖范围内
    const sorted = [...set].sort()
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (ds >= first && ds <= last) {
      return set.has(ds)
    }
    // 超出范围（如查询很久以前的日期）→ 降级静态表
    console.warn(`[calendar] ${ds} 超出腾讯列表范围（${first}~${last}），降级静态表判断`)
  }

  // 接口失败 / 超范围 → 静态表兜底
  return !STATIC_SET.has(ds)
}

/** 仅静态表判断（同步版，测试/调试用） */
export function isTradingDayStatic(d = new Date()): boolean {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  return !STATIC_SET.has(dateStr(d))
}
