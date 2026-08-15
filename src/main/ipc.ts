import { ipcMain } from 'electron'
import type { BrowserWindow } from 'electron'
import { loadConfig, saveConfig } from './config'
import { createPool, createAiFundPool, ensureSchema } from './storage/db'
import { recentNews } from './news/reader'
import {
  listFunds,
  navSeries,
  estimateSeries,
  latestHoldings,
  fundBasic,
  adviceList,
  estimateGuide
} from './storage/queries'
import { findTrackingIndex } from './crawler/estimate'
import { syncFund } from './fund'
import { analyzeFund, saveAdvice, todayStr } from './analyzer/analyze'
import { notifyAdvice } from './notifier'
import { runQuotesCore } from './quotes'
import { runAnalyzeAllCore } from './analyze'
import { getSchedulerState } from './scheduler'
import { computePosition, listPositions, listTrades, addTrade, deleteTrade, getProfile, saveProfile } from './position/position'
import type { TradeRow } from './position/position'

/**
 * 注册主进程 IPC 处理器（渲染进程经 preload 的 window.api 调用）。
 * 业务模块：funds / nav / estimate / holdings / advice / news / config。
 */
export function registerIpcHandlers(_win: BrowserWindow): void {
  // 最小链路测试：app:ping -> pong（渲染进程挂载时调用一次，日志用于验证 IPC 通断）
  ipcMain.handle('app:ping', () => {
    console.log('[ipc] app:ping -> pong')
    return 'pong'
  })

  // 应用环境信息（渲染进程"设置/关于"展示用）
  ipcMain.handle('app:getAppInfo', (): AppInfo => ({
    name: 'fund_monitor',
    version: '0.1.0',
    electron: process.versions.electron ?? '',
    node: process.versions.node ?? '',
    chrome: process.versions.chrome ?? '',
    platform: process.platform
  }))

  // ---------- 基金 ----------

  ipcMain.handle('funds:list', async (): Promise<FundCard[]> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      return await listFunds(pool)
    } catch (e) {
      console.error('[ipc] funds:list 失败:', (e as Error).message)
      throw e
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // 添加/同步基金（详情 + 净值增量/补种 + 持仓），返回同步结果
  ipcMain.handle('funds:add', async (_e, code: string): Promise<FundSyncResult> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      await ensureSchema(pool)
      return await syncFund(pool, code, (s) => console.log(`[ipc funds:add] ${s}`))
    } catch (e) {
      console.error(`[ipc] funds:add ${code} 失败:`, (e as Error).message)
      throw e
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // 停用/启用（is_active 1/0）
  ipcMain.handle('funds:toggle', async (_e, code: string, active: boolean): Promise<void> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      await pool.query('UPDATE fund_basic SET is_active = $2, updated_at = now() WHERE fund_code = $1', [
        code,
        active ? 1 : 0
      ])
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // ---------- 基金详情（聚合一次返回，减少渲染进程往返） ----------

  ipcMain.handle('fund:detail', async (_e, code: string, days = 120): Promise<FundDetail> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      const [basic, nav, est, holdings, advice] = await Promise.all([
        fundBasic(pool, code),
        navSeries(pool, code, days),
        estimateSeries(pool, code),
        latestHoldings(pool, code),
        adviceList(pool, code)
      ])
      return { basic, nav, estimate: est, holdings, advice }
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // 手动触发单基金 AI 分析（详情页"立即分析"按钮；写入 ds_advice + 非 hold 桌面通知）
  ipcMain.handle('advice:analyze', async (_e, code: string): Promise<AdviceRunResult> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    const aiFundPool = createAiFundPool(cfg)
    try {
      await ensureSchema(pool)
      const r = await analyzeFund({ pool, aiFundPool }, code, null)
      if (!r) return { ok: false, skipped: true, reason: '未配置 Key 或数据不足', advice: null }
      const tradeDate = todayStr()
      const inserted = await saveAdvice(pool, code, r, tradeDate)
      if (r.action !== 'hold') {
        const basic = await fundBasic(pool, code)
        notifyAdvice(basic?.name ?? code, code, r.action, r.confidence, r.reason)
      }
      return { ok: true, skipped: false, reason: null, advice: { ...r, tradeDate, inserted } }
    } catch (e) {
      console.error(`[ipc] advice:analyze ${code} 失败:`, (e as Error).message)
      return { ok: false, skipped: false, reason: (e as Error).message, advice: null }
    } finally {
      await pool.end().catch(() => {})
      await aiFundPool.end().catch(() => {})
    }
  })

  // 手动触发行情+估值采集（"我的基金"页"刷新行情/估值"按钮）
  ipcMain.handle('quotes:run', async (): Promise<QuotesRunResult> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      await ensureSchema(pool)
      const r = await runQuotesCore(pool)
      return { ok: true, error: null, result: r }
    } catch (e) {
      console.error('[ipc] quotes:run 失败:', (e as Error).message)
      return { ok: false, error: (e as Error).message, result: null }
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // 手动触发全部基金 AI 分析（"我的基金"页"全部AI分析"按钮）
  ipcMain.handle('advice:analyzeAll', async (): Promise<AnalyzeAllRunResult> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    const aiFundPool = createAiFundPool(cfg)
    try {
      await ensureSchema(pool)
      const r = await runAnalyzeAllCore(pool, aiFundPool)
      return { ok: true, error: null, result: r }
    } catch (e) {
      console.error('[ipc] advice:analyzeAll 失败:', (e as Error).message)
      return { ok: false, error: (e as Error).message, result: null }
    } finally {
      await pool.end().catch(() => {})
      await aiFundPool.end().catch(() => {})
    }
  })

  // 估值说明页：各基金最新估值来源 + 名称规则匹配结果（不拉实时行情）
  ipcMain.handle('estimate:guide', async (): Promise<EstimateGuideFund[]> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      const rows = await estimateGuide(pool)
      return rows.map((r) => {
        const match = findTrackingIndex(r.name)
        return {
          code: r.code,
          name: r.name,
          isActive: r.isActive,
          latestSource: r.latestSource,
          latestPct: r.latestPct,
          latestTime: r.latestTime,
          holdingsDate: r.holdingsDate,
          match: match ? { source: match.source, name: match.name, secid: match.secid } : null
        }
      })
    } catch (e) {
      console.error('[ipc] estimate:guide 失败:', (e as Error).message)
      throw e
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // ---------- 新闻（只读 ai_fund 库，采集由另一个 24h 程序完成） ----------

  ipcMain.handle('news:recent', async (_e, limit?: number): Promise<NewsRow[]> => {
    const cfg = loadConfig()
    const pool = createAiFundPool(cfg)
    try {
      return await recentNews(pool, limit ?? 50)
    } catch (e) {
      console.error('[ipc] news:recent 失败:', (e as Error).message)
      throw e
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // ---------- 持仓管理（M7） ----------

  ipcMain.handle('position:list', async (): Promise<PositionSummary[]> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      return await listPositions(pool)
    } finally {
      await pool.end().catch(() => {})
    }
  })

  ipcMain.handle('position:detail', async (_e, code: string): Promise<{ summary: PositionSummary; trades: TradeRow[] }> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      const [summary, trades] = await Promise.all([computePosition(pool, code), listTrades(pool, code)])
      return { summary, trades }
    } finally {
      await pool.end().catch(() => {})
    }
  })

  ipcMain.handle('position:addTrade', async (_e, t: TradeInput): Promise<{ id: number; summary: PositionSummary }> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      const id = await addTrade(pool, t)
      const summary = await computePosition(pool, t.fundCode)
      return { id, summary }
    } finally {
      await pool.end().catch(() => {})
    }
  })

  ipcMain.handle('position:deleteTrade', async (_e, id: number): Promise<boolean> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      return await deleteTrade(pool, id)
    } finally {
      await pool.end().catch(() => {})
    }
  })

  ipcMain.handle('position:profile', async (_e, patch?: { buyFeePct?: number; sellFeePct?: number }): Promise<FundProfile> => {
    const cfg = loadConfig()
    const pool = createPool(cfg)
    try {
      if (patch) {
        const cur = await getProfile(pool)
        await saveProfile(pool, { buyFeePct: patch.buyFeePct ?? cur.buyFeePct, sellFeePct: patch.sellFeePct ?? cur.sellFeePct })
      }
      return await getProfile(pool)
    } finally {
      await pool.end().catch(() => {})
    }
  })

  // ---------- 配置 ----------

  // 后台调度器状态（设置页展示）
  ipcMain.handle('scheduler:status', (): SchedulerStatus => getSchedulerState())

  ipcMain.handle('config:get', (): AppConfig => {
    return loadConfig()
  })

  ipcMain.handle('config:save', (_e, patch: Record<string, unknown>): AppConfig => {
    const cfg = loadConfig()
    // 只允许白名单字段覆盖（防渲染进程写入任意键）
    const allowed = new Set(['deepseek', 'fetcher', 'analyzer', 'fetch', 'funds'])
    for (const key of Object.keys(patch)) {
      if (allowed.has(key)) {
        ;(cfg as unknown as Record<string, unknown>)[key] = patch[key]
      }
    }
    saveConfig(cfg)
    return cfg
  })
}
