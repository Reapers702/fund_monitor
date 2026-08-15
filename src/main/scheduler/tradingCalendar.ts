// 交易日历（计划书 scheduler 增强）：判断某天是否为 A 股交易日
// 三级降级链：
//   1. 腾讯日K（web.ifzq.gtimg.cn）拉基准股最近交易日——最准（含节假日/调休/临时休市），缓存 24h
//   2. 百度法定节假日接口（opendata.baidu.com holidayData）——权威放假安排（含调休补班日），缓存 7 天
//      （腾讯不可用或查询日期超出其列表范围时用；无临时休市信息，但覆盖绝大多数场景）
//   3. 内置静态休市表——最终兜底
import { httpGetJson, httpGetText } from '../crawler/httpClient'

// ---------- 静态休市日表（最终兜底；腾讯/百度都不可用时用） ----------
const STATIC_HOLIDAYS: string[] = [
  // 2026 年（节假日 + 调休补班日；补班日股市不开盘，故也列为非交易日）
  '2026-01-01', '2026-01-02', '2026-01-03', // 元旦（连休3天，1/4补班但股市休）
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23', // 春节（连休9天）
  '2026-04-04', '2026-04-05', '2026-04-06', // 清明
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', // 劳动节（1-5连休）
  '2026-06-19', '2026-06-20', '2026-06-21', // 端午
  '2026-09-25', '2026-09-26', '2026-09-27', // 中秋
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', // 国庆
  // 2027 年（公历固定节日；农历节日（春节/端午/中秋）日期未核实——百度接口公布后以接口为准，此处仅兜底）
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

// ---------- 百度法定节假日缓存 ----------

const BAIDU_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 天（节假日安排变更极少）

interface BaiduHolidayItem {
  name?: string
  holidayList?: string[]
  workDay?: string | string[]
}

let baiduHolidays: { holidayDays: Set<string>; workDays: Set<string> } | null = null
let baiduCachedAt = 0

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

/** 获取最近交易日集合（带 24h 缓存）；接口失败返回 null（调用方走百度/静态表兜底） */
async function getTradingDaySet(): Promise<Set<string> | null> {
  const now = Date.now()
  if (cachedDays && now - cachedAt < CACHE_TTL_MS) return cachedDays
  const days = await fetchTradingDays()
  if (!days) return null
  cachedDays = new Set(days)
  cachedAt = now
  return cachedDays
}

/** 拉取百度某年法定节假日（holidayList + 补班日 workDay）；失败返回 null */
async function fetchBaiduHolidays(year: number): Promise<{ holidayDays: Set<string>; workDays: Set<string> } | null> {
  const url =
    `https://opendata.baidu.com/data/inner?tn=reserved_all_res_tn&format=json&resource_id=52109` +
    `&query=${encodeURIComponent('法定节假日')}&year=${year}&apiType=holidayData&cb=jsonp_holiday`
  try {
    const text = await httpGetText(url, { referer: 'https://www.baidu.com/', retries: 1, timeoutMs: 10000 })
    const m = text.match(/^[^(]*\((.*)\)\s*;?\s*$/s)
    if (!m) return null
    const data = JSON.parse(m[1]) as {
      Result?: { DisplayData?: { resultData?: { tplData?: { data?: BaiduHolidayItem[] } } } }[] | null
    }
    const items = data.Result?.[0]?.DisplayData?.resultData?.tplData?.data ?? []
    if (items.length === 0) return null

    const holidayDays = new Set<string>()
    const workDays = new Set<string>()
    for (const it of items) {
      for (const d of it.holidayList ?? []) {
        if (/^\d{4}-\d{2}-\d{2}$/.test(d)) holidayDays.add(d)
      }
      // workDay 可能是字符串（单天）或数组（多天）
      const wd = it.workDay
      if (typeof wd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(wd)) workDays.add(wd)
      if (Array.isArray(wd)) {
        for (const d of wd) {
          if (/^\d{4}-\d{2}-\d{2}$/.test(d)) workDays.add(d)
        }
      }
    }
    return { holidayDays, workDays }
  } catch (e) {
    console.warn(`[calendar] 百度节假日接口失败: ${(e as Error).message}`)
    return null
  }
}

/** 获取百度节假日缓存（带 7 天缓存）；失败返回 null */
async function getBaiduHolidays(year: number): Promise<{ holidayDays: Set<string>; workDays: Set<string> } | null> {
  const now = Date.now()
  if (baiduHolidays && now - baiduCachedAt < BAIDU_CACHE_TTL_MS) return baiduHolidays
  const data = await fetchBaiduHolidays(year)
  if (!data) return null
  baiduHolidays = data
  baiduCachedAt = now
  return baiduHolidays
}

/** 本地日期 YYYY-MM-DD */
function dateStr(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 判断某天是否交易日（三级降级）：
 * 1. 周末直接 false
 * 2. 腾讯交易日列表（日期在列表范围内）→ 直接结论
 * 3. 百度法定节假日（holidayList 休假 + workDay 补班日都休市）→ 在则 false，工作日非节假日 true
 * 4. 静态表兜底
 */
export async function isTradingDay(d = new Date()): Promise<boolean> {
  const day = d.getDay()
  if (day === 0 || day === 6) return false // 周末

  const ds = dateStr(d)

  // 层1：腾讯交易日列表
  const set = await getTradingDaySet()
  if (set && set.size > 0) {
    const sorted = [...set].sort()
    const first = sorted[0]
    const last = sorted[sorted.length - 1]
    if (ds >= first && ds <= last) {
      return set.has(ds)
    }
    console.warn(`[calendar] ${ds} 超出腾讯列表范围（${first}~${last}），降级百度节假日判断`)
  }

  // 层2：百度法定节假日（休假 + 补班日都休市）
  const year = d.getFullYear()
  const baidu = await getBaiduHolidays(year)
  if (baidu) {
    if (baidu.holidayDays.has(ds) || baidu.workDays.has(ds)) return false
    return true // 工作日且非节假日/补班日 → 交易日
  }

  // 层3：静态表兜底
  return !STATIC_SET.has(ds)
}

/** 仅静态表判断（同步版，测试/调试用） */
export function isTradingDayStatic(d = new Date()): boolean {
  const day = d.getDay()
  if (day === 0 || day === 6) return false
  return !STATIC_SET.has(dateStr(d))
}
