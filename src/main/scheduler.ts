// 后台调度器（计划书 §7.3）：主窗口启动后常驻，按交易时段自动执行
//  盘中（9:30-11:30, 13:00-15:00）：每 estimateIntervalSeconds 估值采样（T1/T2）
//  盘后（15:30 起）：净值增量（每 navCheckMinutes 轮询至当日净值出现或 23:00）
//  收盘后（analyzer.minutes，默认 35 → 15:35）：全部基金 AI 分析 + 非 hold 通知
// 所有任务均带防重跑标记；交易日判断见 scheduler/time.ts
import { loadConfig } from './config'
import { createPool, createAiFundPool, ensureSchema } from './storage/db'
import { sampleEstimatesCore } from './quotes'
import { runAnalyzeAllCore } from './analyze'
import { syncFund } from './fund'
import { latestNavDate } from './storage/fundRepo'
import { cleanupOldEstimates } from './storage/estimateRepo'
import { todayStr } from './quotes'
import { isTradingDay, isIntraday, isAfterClose, nowMinutes } from './scheduler/time'
import { logInfo, logWarn, logError } from './logger'
import type { Pool } from 'pg'

const TICK_MS = 30_000 // 每 30s 检查一次时段状态

export interface SchedulerState {
  running: boolean
  lastEstimateAt: number
  navTodayDone: boolean
  adviceTodayDone: boolean
  lastLog: string
}

let state: SchedulerState = { running: false, lastEstimateAt: 0, navTodayDone: false, adviceTodayDone: false, lastLog: '未启动' }
let timer: NodeJS.Timeout | null = null

/** 今天是否已确认当日净值（latestNavDate >= today） */
async function navTodayConfirmed(pool: Pool): Promise<boolean> {
  const funds = await pool.query<{ fund_code: string }>('SELECT fund_code FROM fund_basic WHERE is_active = 1')
  if (funds.rows.length === 0) return true // 无自选基金视为完成
  for (const f of funds.rows) {
    const d = await latestNavDate(pool, f.fund_code)
    if (!d || d < todayStr()) return false
  }
  return true
}

/** 净值增量：对启用基金串行 syncFund（详情+净值增量+持仓缺失补拉） */
async function runNavDaily(pool: Pool): Promise<{ done: number; total: number }> {
  const funds = await pool.query<{ fund_code: string }>('SELECT fund_code FROM fund_basic WHERE is_active = 1 ORDER BY fund_code')
  let done = 0
  for (const f of funds.rows) {
    try {
      await syncFund(pool, f.fund_code, (s) => console.log(`[scheduler] ${s}`))
      done++
    } catch (e) {
      console.error(`[scheduler] ${f.fund_code} 净值增量失败: ${(e as Error).message}`)
    }
  }
  return { done, total: funds.rows.length }
}

async function tick(): Promise<void> {
  const cfg = loadConfig()
  if (!isTradingDay()) {
    state.lastLog = '非交易日，跳过'
    return
  }
  const m = nowMinutes()
  const pool = createPool(cfg)

  try {
    await ensureSchema(pool)

    // 1. 盘中估值采样（每 estimateIntervalSeconds 一次）
    if (isIntraday(m)) {
      const intervalMs = (cfg.fetcher.estimateIntervalSeconds || 30) * 1000
      if (Date.now() - state.lastEstimateAt >= intervalMs) {
        state.lastEstimateAt = Date.now()
        const r = await sampleEstimatesCore(pool)
        state.lastLog = `估值采样 ${r.sampled} 条（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`
        if (r.sampled > 0) {
          console.log(`[scheduler] ${state.lastLog}`)
          logInfo(`[scheduler] ${state.lastLog}`)
        }
        if (r.errors > 0) logWarn(`[scheduler] 估值采样失败 ${r.errors} 条`)
      }
    } else if (isAfterClose(m)) {
      // 2. 盘后净值增量（15:30 起，每 navCheckMinutes 轮询直至当日净值出现）
      if (!state.navTodayDone) {
        if (m <= 23 * 60) {
          const r = await runNavDaily(pool)
          const confirmed = await navTodayConfirmed(pool)
          state.lastLog = `净值增量 ${r.done}/${r.total}${confirmed ? '（当日净值已确认）' : '（等待公布，稍后重试）'}`
          console.log(`[scheduler] ${state.lastLog}`)
          logInfo(`[scheduler] ${state.lastLog}`)
          if (confirmed || m >= 22 * 60) state.navTodayDone = true
          // 当日净值确认后顺带清理过期估值（保留最近 30 天，防盘中采样膨胀）
          if (confirmed) {
            try {
              const removed = await cleanupOldEstimates(pool, 30)
              if (removed > 0) logInfo(`[scheduler] 清理过期估值采样 ${removed} 条`)
            } catch (e) {
              logWarn(`[scheduler] 估值清理失败: ${(e as Error).message}`)
            }
          }
        } else {
          state.navTodayDone = true
        }
      }

      // 3. 收盘后 AI 分析（analyzer.minutes 分钟时刻，默认 35 → 15:35；当日只跑一次）
      if (!state.adviceTodayDone && m >= 15 * 60 + (Number(cfg.analyzer.minutes) || 35)) {
        const aiFundPool = createAiFundPool(cfg)
        try {
          const r = await runAnalyzeAllCore(pool, aiFundPool)
          state.lastLog = `AI 分析 ${r.done}/${r.total}（通知 ${r.notified}）`
          console.log(`[scheduler] ${state.lastLog}`)
          logInfo(`[scheduler] ${state.lastLog}`)
          state.adviceTodayDone = true
        } catch (e) {
          console.error(`[scheduler] AI 分析失败: ${(e as Error).message}`)
          logError(`[scheduler] AI 分析失败: ${(e as Error).message}`)
        } finally {
          await aiFundPool.end().catch(() => {})
        }
      }
    }
  } catch (e) {
    console.error(`[scheduler] tick 异常: ${(e as Error).message}`)
    logError(`[scheduler] tick 异常: ${(e as Error).message}`)
  } finally {
    await pool.end().catch(() => {})
  }
}

/** 启动调度器（主窗口 ready 后调用；幂等，重复调用返回 false） */
export function startScheduler(): boolean {
  if (timer) return false
  console.log(`[scheduler] 启动（tick ${TICK_MS / 1000}s，交易日 ${isTradingDay() ? '是' : '否'}）`)
  logInfo(`[scheduler] 启动（tick ${TICK_MS / 1000}s，交易日 ${isTradingDay() ? '是' : '否'}）`)
  state.running = true
  state.lastEstimateAt = 0
  state.navTodayDone = false
  state.adviceTodayDone = false
  void tick() // 启动即检查一次
  timer = setInterval(() => void tick(), TICK_MS)
  return true
}

/** 停止调度器（窗口关闭/退出时调用） */
export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  state.running = false
}

/** 当前调度状态（设置页可展示；渲染进程经 IPC 读取） */
export function getSchedulerState(): SchedulerState {
  return { ...state }
}
