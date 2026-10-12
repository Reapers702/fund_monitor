// 基准指数日 K（计算基金相对强弱/超额收益用）
// 沪深300（1.000300）：A 股最通用的宽基基准，"是否跑赢大盘"以此为参照。
// 带进程内缓存：AI 分析（analyze-all 逐基金）与详情页都会调，30 分钟内复用同一份，避免重复请求。
import { klinesBySecid } from './market'
import type { NavLike } from '../analyzer/metrics'

export const BENCHMARK_SECID = '1.000300'
export const BENCHMARK_NAME = '沪深300'

const CACHE_TTL_MS = 30 * 60_000
const FAIL_BACKOFF_MS = 5 * 60_000 // 抓取失败后退避：批量分析逐基金调用，失败不缓存会反复轰炸数据源
let cache: { ts: number; nav: NavLike[] } | null = null
let failUntil = 0 // 失败退避截止时间戳
// 并发去重：详情页与批量分析可能同时首次请求，避免同一时刻打两次
let inflight: Promise<NavLike[] | null> | null = null

/** 取基准指数日 K（升序）；失败/为空返回 null（调用方降级为不计算超额，不阻断主流程） */
export async function loadBenchmarkNav(): Promise<NavLike[] | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.nav
  if (Date.now() < failUntil) return null // 退避期内不请求，直接降级
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const { rows } = await klinesBySecid(BENCHMARK_SECID, 260, BENCHMARK_NAME)
      const nav = rows
        .filter((r) => r.close !== null && r.close > 0)
        .map((r) => ({ date: r.tradeDate, nav: r.close as number }))
      if (nav.length === 0) return null
      cache = { ts: Date.now(), nav }
      return nav
    } catch {
      failUntil = Date.now() + FAIL_BACKOFF_MS
      // 失败链路已由 [market] 日志输出，这里只说影响，避免重复堆异常细节
      console.warn(`[benchmark] ${BENCHMARK_NAME} 日K 不可用 → 本次分析省略超额收益`)
      return null
    } finally {
      inflight = null
    }
  })()
  return inflight
}

/** 清空缓存（手动刷新行情后调用，让超额收益用最新基准数据） */
export function clearBenchmarkCache(): void {
  cache = null
  failUntil = 0
}

/** 基准数据源状态（GUI 抓取日志页展示缓存/退避情况） */
export function benchmarkStatus(): { cached: boolean; cachedAt: number | null; backoffUntil: number | null } {
  return { cached: cache !== null, cachedAt: cache?.ts ?? null, backoffUntil: failUntil || null }
}
