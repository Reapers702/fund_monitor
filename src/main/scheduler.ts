// 后台调度器（计划书 §7.3）：主窗口启动后常驻，按交易时段自动执行
//  盘中（9:30-11:30, 13:00-15:00，仅交易日）：每 estimateIntervalSeconds 估值采样（T1/T2/T3）
//  盘后（15:30 起，交易日与非交易日都跑）：日K 校正（用数据源官方日K 覆盖当天实时价快照）+
//    净值增量（每 navCheckMinutes 轮询至目标交易日净值出现或 23:00；
//    非交易日目标=最近交易日，覆盖"周五净值周六凌晨公布"场景）
//  收盘后（analyzer.minutes，默认 35 → 15:35，仅交易日）：全部基金 AI 分析 + 非 hold 通知
// 所有任务均带防重跑标记；交易日判断见 scheduler/time.ts
import { loadConfig } from './config'
import { createPool, createAiFundPool, ensureSchemaOnce } from './storage/db'
import { reconcileKlinesCore, sampleEstimatesCore } from './quotes'
import { runAnalyzeAllCore } from './analyze'
import { isTaskBusy } from './tasks'
import { syncFund } from './fund'
import { latestNavDate } from './storage/fundRepo'
import { cleanupOldEstimates, recordEstimateDiffs } from './storage/estimateRepo'
import { runAlertCheck, cleanupAlertLog } from './alerts/run'
import { todayStr } from './quotes'
import { isIntraday, isAfterClose, nowMinutes } from './scheduler/time'
import { isTradingDay as isTradingDayCal, latestTradingDayStr } from './scheduler/tradingCalendar'
import { logInfo, logWarn } from './logger'
import type { Pool } from 'pg'

const TICK_MS = 30_000 // 每 30s 检查一次时段状态

export interface SchedulerState {
  running: boolean
  lastEstimateAt: number
  navTodayDone: boolean
  adviceTodayDone: boolean
  valuationTodayDone: boolean
  klineTodayDone: boolean
  lastLog: string
}

let state: SchedulerState = { running: false, lastEstimateAt: 0, navTodayDone: false, adviceTodayDone: false, valuationTodayDone: false, klineTodayDone: false, lastLog: '未启动' }
let timer: NodeJS.Timeout | null = null
// 本会话已做过"今日是否已分析"DB 检查的日期（跨天感知：昨天查过的结果不影响今天）
let adviceCheckedDate: string | null = null
// 本会话已确认"今日估算值快照是否已入库"的日期（跨天感知）
let valuationCheckedDate: string | null = null
// 本会话已做"今日净值轮询"的日期（跨天感知）。navTodayDone 仅在内存里，托盘常驻跨天后必须复位，
// 否则第二天起永远不再轮询净值（原实现的内存标记不复位 bug）
let navCheckedDate: string | null = null
// 上一次净值轮询的时刻：真正按 cfg.fetcher.navCheckMinutes 节流（原实现每 30s 一轮）
let lastNavRunAt = 0
// 收盘后日K 校正：本会话已检查的日期 + 上次检查时刻（数据源当天K线偶尔落定较晚，按 10 分钟重试）
let klineCheckedDate: string | null = null
let lastKlineRunAt = 0

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

/** 净值增量：对全局活跃基金（所有用户自选并集，去重）串行 syncFund（净值增量 + 持仓缺失补拉；
 *  详情跳过——例行轮询不必每轮都拉基金详情，省请求量） */
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
      await syncFund(pool, f.fund_code, (s) => console.log(`[scheduler] ${s}`), { skipDetailIfKnown: true })
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
    // 每 30s 一次 tick：建表只需成功一次（ensureSchemaOnce 按库记忆，失败不缓存），
    // 避免在共享库上反复跑 30+ 条 DDL 取表锁、也避免连接抖动时整个建表事务白跑
    await ensureSchemaOnce(pool)

    // 0. 指数估值快照（价值因子）：每自然日一次，收盘后（15:00 起）抓蛋卷当日快照落库，累积历史。
    //    交易/非交易日都抓（快照是日历日粒度的，周末也有当日值）；以 index_valuation 当日记录判重（跨重启不重跑）。
    {
      const today = todayStr()
      if (valuationCheckedDate !== today) {
        const rCheck = await pool.query('SELECT 1 FROM index_valuation WHERE trade_date = $1 LIMIT 1', [today])
        state.valuationTodayDone = rCheck.rows.length > 0
        valuationCheckedDate = today
      }
      if (!state.valuationTodayDone && m >= 15 * 60) {
        try {
          const { fetchIndexValuations, storeIndexValuations } = await import('./crawler/indexValuation')
          const items = await fetchIndexValuations()
          const stored = await storeIndexValuations(pool, today, items)
          state.valuationTodayDone = stored > 0
          state.lastLog = `指数估值快照 ${stored} 个板块（${today}）`
          console.log(`[scheduler] ${state.lastLog}`)
        } catch (e) {
          logWarn(`[scheduler] 指数估值快照失败: ${(e as Error).message}`)
        }
      }
    }

    // 1. 盘中估值采样（每 estimateIntervalSeconds 一次；仅交易日）
    if (trading && isIntraday(m)) {
      const intervalMs = (cfg.fetcher.estimateIntervalSeconds || 300) * 1000
      if (Date.now() - state.lastEstimateAt >= intervalMs) {
        state.lastEstimateAt = Date.now()
        const r = await sampleEstimatesCore(pool)
        state.lastLog = `估值采样 ${r.sampled} 条（${new Date().toLocaleTimeString('zh-CN', { hour12: false })}）`
        if (r.sampled > 0) {
          console.log(`[scheduler] ${state.lastLog}`)
        }
        if (r.errors > 0) logWarn(`[scheduler] 估值采样失败 ${r.errors} 条`)
        // 采样后立刻检查估值类提醒（阈值/盘中止盈止损）：估算大幅异动时当天只推一次
        if (cfg.alerts.enabled) {
          const aiFundPool = createAiFundPool(cfg)
          try {
            const a = await runAlertCheck(pool, aiFundPool, cfg, 'intraday')
            if (a.notified > 0) state.lastLog += `，盘中提醒 ${a.notified} 条`
          } catch (e) {
            logWarn(`[scheduler] 盘中提醒检查失败: ${(e as Error).message}`)
          } finally {
            await aiFundPool.end().catch(() => {})
          }
        }
      }
    }

    // 2. 盘后净值增量（15:30 起，每 navCheckMinutes 轮询直至目标交易日净值出现；非交易日补最近交易日）
    //    P0 修复：原实现每个 tick（30s）都把所有基金全量重跑一遍 syncFund，而 navCheckMinutes 配置项
    //    从未被读取——净值通常在 20:00~23:00 公布，30 秒一轮等于对同一批基金打几千次无用请求，
    //    是触发 IP 风控的主要来源。现在改为：真正按 navCheckMinutes 节流 + 轮询前先查库判是否已最新。
    if (isAfterClose(m)) {
      const navDate = todayStr()
      if (navCheckedDate !== navDate) {
        navCheckedDate = navDate // 跨天复位：新的一天重新开始轮询
        state.navTodayDone = false
        lastNavRunAt = 0
      }
      // 2.0 收盘后日K 校正（先做，让后续提醒/分析用到的是定型日K）：
      //     当天那根日K 是盘中实时价快照（source='quote'），收盘后用数据源官方日K 覆盖；
      //     数据源偶尔落定稍晚，故每 10 分钟重试直到拿到（23:00 后放弃，次日盘前/手动刷新还会补）。
      if (klineCheckedDate !== navDate) {
        klineCheckedDate = navDate
        state.klineTodayDone = false
        lastKlineRunAt = 0
      }
      if (!state.klineTodayDone) {
        const due = Date.now() - lastKlineRunAt >= 10 * 60_000
        if (m > 23 * 60) {
          state.klineTodayDone = true // 放弃当日，次日盘前/手动刷新会再核对
        } else if (due) {
          lastKlineRunAt = Date.now()
          try {
            const k = await reconcileKlinesCore(pool)
            if (k.need === 0) {
              state.klineTodayDone = true
              if (k.added > 0 || k.fixed > 0 || k.removedWeekend > 0) {
                state.lastLog = `日K 校正：新增 ${k.added} 行 / 校正 ${k.fixed} 行${k.removedWeekend > 0 ? ` / 清周末脏行 ${k.removedWeekend} 行` : ''}（${k.total} 只股票）`
                logInfo(`[scheduler] ${state.lastLog}`)
              }
            } else {
              logInfo(`[scheduler] 日K 校正待重试：${k.need}/${k.total} 只还没拿到最近交易日官方日K`)
            }
          } catch (e) {
            logWarn(`[scheduler] 日K 校正失败: ${(e as Error).message}`)
          }
        }
      }
      if (!state.navTodayDone) {
        const intervalMs = Math.max(1, Number(cfg.fetcher.navCheckMinutes) || 10) * 60_000
        const due = Date.now() - lastNavRunAt >= intervalMs
        if (m > 23 * 60) {
          state.navTodayDone = true // 23:00 后放弃当日轮询（等次日/new 会话重新开始）
        } else if (due) {
          lastNavRunAt = Date.now()
          const target = trading ? navDate : latestTradingDayStr()
          // 先查库判断是否已拿到：上个会话/重启前可能已经拉过，避免重复请求
          const already = await navTodayConfirmed(pool, target)
          if (already) {
            state.navTodayDone = true
            state.lastLog = `${target} 净值已是最新，跳过本轮轮询`
            console.log(`[scheduler] ${state.lastLog}`)
          } else {
            const r = await runNavDaily(pool)
            const confirmed = await navTodayConfirmed(pool, target)
            state.lastLog = `净值增量 ${r.done}/${r.total}${
              confirmed ? `（${target} 净值已确认）` : `（等待公布，${Math.round(intervalMs / 60_000)} 分钟后重试）`
            }`
            console.log(`[scheduler] ${state.lastLog}`)
            if (confirmed || m >= 22 * 60) state.navTodayDone = true
          }
          // 净值确认后：记录"盘中估值 vs 实际净值"误差（T3 可信度验证），并清理过期估值（保留最近 30 天）
          if (state.navTodayDone) {
            try {
              const diffRows = await recordEstimateDiffs(pool, target)
              if (diffRows > 0) logInfo(`[scheduler] 记录估值误差 ${diffRows} 条（${target}）`)
            } catch (e) {
              logWarn(`[scheduler] 估值误差记录失败: ${(e as Error).message}`)
            }
            // 净值确认后检查收盘类提醒：净值异动 / 估值失真 / 止盈止损 / 重仓股负面新闻
            if (cfg.alerts.enabled) {
              const aiFundPool = createAiFundPool(cfg)
              try {
                const a = await runAlertCheck(pool, aiFundPool, cfg, 'close')
                if (a.notified > 0) {
                  state.lastLog += `，提醒 ${a.notified} 条`
                  logInfo(`[scheduler] 收盘提醒推送 ${a.notified} 条`)
                }
              } catch (e) {
                logWarn(`[scheduler] 收盘提醒检查失败: ${(e as Error).message}`)
              } finally {
                await aiFundPool.end().catch(() => {})
              }
            }
            try {
              const removed = await cleanupOldEstimates(pool, 30)
              if (removed > 0) logInfo(`[scheduler] 清理过期估值采样 ${removed} 条`)
            } catch (e) {
              logWarn(`[scheduler] 估值清理失败: ${(e as Error).message}`)
            }
            try {
              const removed = await cleanupAlertLog(pool, 90)
              if (removed > 0) logInfo(`[scheduler] 清理过期提醒记录 ${removed} 条`)
            } catch (e) {
              logWarn(`[scheduler] 提醒记录清理失败: ${(e as Error).message}`)
            }
          }
        }
      }

      // 3. 收盘后 AI 分析（analyzer.minutes 分钟时刻，默认 35 → 15:35；仅交易日，当日只跑一次）。
      //    当日是否已分析以 ds_advice 持久化记录为准（adviceTodayDone 仅作本会话缓存）：
      //    - 重启/重新打开应用不重复补跑（记录仍在则跳过）；
      //    - 托盘常驻跨天后自动失效（次日重新查库，修复原内存标记不重置导致第二天不分析的问题）；
      //    - 手动触发（GUI/CLI）不走此分支，随时可再分析。
      if (trading && !state.adviceTodayDone && m >= 15 * 60 + (Number(cfg.analyzer.minutes) || 35)) {
        const today = todayStr()
        if (adviceCheckedDate !== today) {
          const r = await pool.query('SELECT 1 FROM ds_advice WHERE trade_date = $1 LIMIT 1', [today])
          state.adviceTodayDone = r.rows.length > 0
          adviceCheckedDate = today
          if (state.adviceTodayDone) {
            state.lastLog = `AI 分析今日已完成（${today}），跳过自动分析`
            console.log(`[scheduler] ${state.lastLog}`)
          }
        }
        if (!state.adviceTodayDone) {
          const aiFundPool = createAiFundPool(cfg)
          try {
            const r = await runAnalyzeAllCore(pool, aiFundPool, true) // 逐基金跳过今日已分析
            state.lastLog = `AI 分析 ${r.done}/${r.total}（通知 ${r.notified}）`
            console.log(`[scheduler] ${state.lastLog}`)
            state.adviceTodayDone = true
          } catch (e) {
            // 手动"全部 AI 分析"正在跑时不重复分析，也不算失败（单飞由 tasks 层裁定）
            if (isTaskBusy(e)) {
              state.lastLog = 'AI 分析已在运行，本轮自动分析跳过'
              console.warn(`[scheduler] ${state.lastLog}`)
            } else {
              console.error(`[scheduler] AI 分析失败: ${(e as Error).message}`)
            }
          } finally {
            await aiFundPool.end().catch(() => {})
          }
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
  } finally {
    await pool.end().catch(() => {})
  }
}

/** 启动调度器（主窗口 ready 后调用；幂等，重复调用返回 false） */
export function startScheduler(): boolean {
  if (timer) return false
  console.log(`[scheduler] 启动（tick ${TICK_MS / 1000}s，净值轮询间隔见设置页）`)
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
