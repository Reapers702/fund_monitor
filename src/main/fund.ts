// CLI 拉取入口：electron . --fund 017193（计划书 M3）
// 详情(蛋卷→东财降级) → 净值(已有数据增量 / 无数据全量补种，lsjz 主 + pingzhongdata 辅) → 持仓(jjcc)
// syncFund(pool, code) 为可复用核心（IPC funds:add 与 CLI 共用）
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema } from './storage/db'
import {
  fundBasicFromDetail,
  latestHoldingsDate,
  latestNavDate,
  saveHoldings,
  saveNavRows,
  upsertFundBasic
} from './storage/fundRepo'
import { fundDetailWithFallback, normalizePingzhongToNavs } from './crawler/danjuan'
import { jjccHoldings, lsjzNav, pingzhongdata } from './crawler/eastmoney'
import type { Pool } from 'pg'

export interface FundSyncResult {
  name: string | null
  navInserted: number
  holdingsInserted: number
  holdingsPeriods: number
  latestNav: string | null
}

/** 单基金数据同步核心：详情 → 净值增量/补种 → 持仓（已存在跳过）。可安全重复调用。 */
export async function syncFund(pool: Pool, code: string, log = (s: string) => console.log(`[fund] ${s}`)): Promise<FundSyncResult> {
  const result: FundSyncResult = { name: null, navInserted: 0, holdingsInserted: 0, holdingsPeriods: 0, latestNav: null }

  // 1. 基础信息
  const detail = await fundDetailWithFallback(code)
  if (detail) {
    await upsertFundBasic(pool, fundBasicFromDetail(detail))
    result.name = detail.name
    log(`${code} ${detail.name}（${detail.manager ?? '未知经理'} / ${detail.keeper ?? '未知托管'}）`)
  } else {
    log(`详情获取失败，继续拉净值（仅存数据无名称）`)
  }

  // 2. 净值
  const latest = await latestNavDate(pool, code)
  if (latest) {
    const { rows } = await lsjzNav(code, { since: latest })
    const fresh = rows.filter((r) => r.fsrq && r.fsrq > latest)
    if (fresh.length === 0) {
      log(`净值已是最新（${latest}），无需更新`)
    } else {
      result.navInserted = await saveNavRows(pool, code, fresh, 'daily')
      result.latestNav = fresh[0].fsrq
      log(`增量净值 ${result.navInserted}/${fresh.length} 条，最新 ${fresh[0].fsrq}`)
    }
  } else {
    try {
      const { rows, totalCount } = await lsjzNav(code)
      result.navInserted = await saveNavRows(pool, code, rows, 'seed')
      result.latestNav = rows[0]?.fsrq ?? null
      log(`全量补种 ${result.navInserted}/${totalCount} 条（lsjz 分页）`)
    } catch (e) {
      log(`lsjz 补种失败，降级 pingzhongdata: ${(e as Error).message}`)
      const data = await pingzhongdata(code)
      const navs = normalizePingzhongToNavs(data)
      result.navInserted = await saveNavRows(pool, code, navs, 'seed')
      result.latestNav = navs[0]?.fsrq ?? null
      log(`全量补种 ${result.navInserted} 条（pingzhongdata 降级）`)
    }
  }

  // 3. 持仓（首次必拉；TTL 刷新交给调度）
  const holdDate = await latestHoldingsDate(pool, code)
  if (!holdDate) {
    try {
      const reports = await jjccHoldings(code)
      let h = 0
      for (const rep of reports) {
        h += await saveHoldings(pool, code, rep.reportDate, rep.rows)
      }
      result.holdingsInserted = h
      result.holdingsPeriods = reports.length
      log(`持仓 ${reports.length} 期 / 新增 ${h} 行，最新报告期 ${reports[0]?.reportDate ?? '-'}`)
    } catch (e) {
      log(`持仓抓取失败: ${(e as Error).message}`)
    }
  } else {
    log(`持仓已存在（最新 ${holdDate}），跳过`)
  }

  return result
}

export async function runFund(code: string): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[fund] 配置文件: ${configPath()}`)
  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[fund] PostgreSQL 连接失败: ${(e as Error).message}`)
    return 1
  }
  try {
    await ensureSchema(pool)
  } catch (e) {
    console.error(`[fund] 建表失败: ${(e as Error).message}`)
    return 1
  }

  await syncFund(pool, code)

  await pool.end()
  console.log('[fund] 完成')
  return 0
}
