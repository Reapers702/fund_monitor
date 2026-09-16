// 基准指数日 K（计算基金相对强弱/超额收益用）
// 沪深300（1.000300）：A 股最通用的宽基基准，"是否跑赢大盘"以此为参照。
// 带进程内缓存：AI 分析（analyze-all 逐基金）与详情页都会调，30 分钟内复用同一份，避免重复请求。
import { klinesBySecid } from './market'
import type { NavLike } from '../analyzer/metrics'

export const BENCHMARK_SECID = '1.000300'
export const BENCHMARK_NAME = '沪深300'

const CACHE_TTL_MS = 30 * 60_000
let cache: { ts: number; nav: NavLike[] } | null = null
// 并发去重：详情页与批量分析可能同时首次请求，避免同一时刻打两次
let inflight: Promise<NavLike[] | null> | null = null

/** 取基准指数日 K（升序）；失败/为空返回 null（调用方降级为不计算超额，不阻断主流程） */
export async function loadBenchmarkNav(): Promise<NavLike[] | null> {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) return cache.nav
  if (inflight) return inflight

  inflight = (async () => {
    try {
      const { rows } = await klinesBySecid(BENCHMARK_SECID, 260)
      const nav = rows
        .filter((r) => r.close !== null && r.close > 0)
        .map((r) => ({ date: r.tradeDate, nav: r.close as number }))
      if (nav.length === 0) return null
      cache = { ts: Date.now(), nav }
      return nav
    } catch (e) {
      console.warn(`[benchmark] ${BENCHMARK_NAME} 日K获取失败（超额收益省略）: ${(e as Error).message}`)
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
}
