// 后台调度器（计划书 §7.3）：主窗口启动后常驻，按交易时段自动执行
//  盘中（9:30-11:30, 13:00-15:00，仅交易日）：每 estimateIntervalSeconds 估值采样（T1/T2/T3）
//  盘后（15:30 起，交易日与非交易日都跑）：净值增量（每 navCheckMinutes 轮询至目标交易日净值出现或 23:00；
//    非交易日目标=最近交易日，覆盖"周五净值周六凌晨公布"场景）
//  收盘后（analyzer.minutes，默认 35 → 15:35，仅交易日）：全部基金 AI 分析 + 非 hold 通知
// 所有任务均带防重跑标记；交易日判断见 scheduler/time.ts
import { loadConfig } from './config'
import { createPool, createAiFundPool, ensureSchema } from './storage/db'
import { sampleEstimatesCore } from './quotes'
import { runAnalyzeAllCore } from './analyze'
import { syncFund } from './fund'
import { latestNavDate } from './storage/fundRepo'
import { cleanupOldEstimates, recordEstimateDiffs } from './storage/estimateRepo'
import { todayStr } from './quotes'
import { isIntraday, isAfterClose, nowMinutes } from './scheduler/time'
import { isTradingDay as isTradingDayCal, latestTradingDayStr } from './scheduler/tradingCalendar'
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

/** 是否已确认目标交易日净值（所有用户自选基金并集都出净值才算，多用户 M9）。
 *  交易日目标=today；非交易日目标=最近交易日（周五净值周六凌晨公布是常态，周六盘后也要补） */
async function navTodayConfirmed(pool: Pool, targetDate: string): Promise<boolean> {
  const funds = await pool.query<{ fund_code: string }>(
    `SELECT DISTINCT f.fund_code
     FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
     WHERE uf.is_active = 1`
  )
  if (funds.rows.length === 0) return true // 无自选基金视为完成
  for (const f of funds.rows) {
    const d = await latestNavDate(pool, f.fund_code)
    if (!d || d < targetDate) return false
  }
  return true
}

/** 净值增量：对全局活跃基金（所有用户自选并集，去重）串行 syncFund（详情+净值增量+持仓缺失补拉） */
async function runNavDaily(pool: Pool): Promise<{ done: number; total: number }> {
  const funds = await pool.query<{ fund_code: string }>(
    `SELECT DISTINCT f.fund_code
     FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
     WHERE uf.is_active = 1
     ORDER BY f.fund_code`
  )
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
  // 交易日判断：腾讯交易日历为主（含节假日/调休），接口失败降级静态休市表。
  // 估值采样/AI 分析仅交易日执行；净值增量交易日与非交易日盘后都执行（T+1 公布，周五净值周六凌晨出）
  const trading = await isTradingDayCal()
  const m = nowMinutes()
  const pool = createPool(cfg)

  try {
    await ensureSchema(pool)

    // 1. 盘中估值采样（每 estimateIntervalSeconds 一次；仅交易日）
    if (trading && isIntraday(m)) {
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
    }

    // 2. 盘后净值增量（15:30 起，每 navCheckMinutes 轮询直至目标交易日净值出现；非交易日补最近交易日）
    if (isAfterClose(m)) {
      if (!state.navTodayDone) {
        if (m <= 23 * 60) {
          const target = trading ? todayStr() : latestTradingDayStr()
          const r = await runNavDaily(pool)
          const confirmed = await navTodayConfirmed(pool, target)
          state.lastLog = `净值增量 ${r.done}/${r.total}${confirmed ? `（${target} 净值已确认）` : '（等待公布，稍后重试）'}`
          console.log(`[scheduler] ${state.lastLog}`)
          logInfo(`[scheduler] ${state.lastLog}`)
          if (confirmed || m >= 22 * 60) state.navTodayDone = true
          // 净值确认后：记录"盘中估值 vs 实际净值"误差（T3 可信度验证），并清理过期估值（保留最近 30 天）
          if (confirmed) {
            try {
              const diffRows = await recordEstimateDiffs(pool, target)
              if (diffRows > 0) logInfo(`[scheduler] 记录估值误差 ${diffRows} 条（${target}）`)
            } catch (e) {
              logWarn(`[scheduler] 估值误差记录失败: ${(e as Error).message}`)
            }
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

      // 3. 收盘后 AI 分析（analyzer.minutes 分钟时刻，默认 35 → 15:35；仅交易日，当日只跑一次）
      if (trading && !state.adviceTodayDone && m >= 15 * 60 + (Number(cfg.analyzer.minutes) || 35)) {
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

      // 非交易日盘后且无事可做时给出状态（避免误以为调度停摆）
      if (!trading && state.navTodayDone) {
        state.lastLog = '非交易日，净值已是最新'
      }
    } else if (!trading) {
      state.lastLog = '非交易日'
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
  console.log(`[scheduler] 启动（tick ${TICK_MS / 1000}s）`)
  logInfo(`[scheduler] 启动（tick ${TICK_MS / 1000}s）`)
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
