// CLI 拉取入口：electron . --fund 017193（计划书 M3）
// 详情(蛋卷→东财降级) → 净值(已有数据增量 / 无数据全量补种，lsjz 主 + pingzhongdata 辅) → 持仓(jjcc)
// syncFund(pool, code) 为可复用核心（IPC funds:add 与 CLI 共用）
import { configPath, ensureConfigFile, loadConfig } from './config'
import { createPool, ensureSchema } from './storage/db'
import { markerAgeDays, setMarker } from './storage/crawlMarker'
import {
  fundBasicFromDetail,
  fundBasicName,
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

export interface FundSyncOptions {
  /** 例行轮询（调度器/刷新行情）：库里已有基金名称时跳过详情抓取，省掉每轮 1 次蛋卷请求。
   *  详情字段（全称/经理/托管/成立日）不会每天变，没必要每轮都拉（P0 降请求量） */
  skipDetailIfKnown?: boolean
  /** 持仓刷新周期（天）；不传则读 config.fetcher.holdingsRefreshDays。0 表示不按周期刷新（仅缺失时抓） */
  holdingsRefreshDays?: number
}

/** 持仓抓取标记键（见 storage/crawlMarker.ts） */
function holdingsMarker(code: string): string {
  return `holdings:${code}`
}

/** 单基金数据同步核心：详情 → 净值增量/补种 → 持仓（已存在跳过）。可安全重复调用。 */
export async function syncFund(
  pool: Pool,
  code: string,
  log = (s: string) => console.log(`[fund] ${s}`),
  opts: FundSyncOptions = {}
): Promise<FundSyncResult> {
  const result: FundSyncResult = { name: null, navInserted: 0, holdingsInserted: 0, holdingsPeriods: 0, latestNav: null }

  // 1. 基础信息（例行轮询可跳过：库里已有名称就够了）
  const knownName = opts.skipDetailIfKnown ? await fundBasicName(pool, code) : null
  if (knownName) {
    result.name = knownName
    log(`${code} ${knownName}（例行轮询，跳过详情抓取）`)
  } else {
    const detail = await fundDetailWithFallback(code)
    if (detail) {
      await upsertFundBasic(pool, fundBasicFromDetail(detail))
      result.name = detail.name
      log(`${code} ${detail.name}（${detail.manager ?? '未知经理'} / ${detail.keeper ?? '未知托管'}）`)
    } else {
      log(`详情获取失败，继续拉净值（仅存数据无名称）`)
    }
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

  // 3. 持仓（缺失必拉；已存在则按 fetcher.holdingsRefreshDays 周期刷新——季报约每季度披露，页面每周看一次足够）
  const holdDate = await latestHoldingsDate(pool, code)
  const ttlDays = opts.holdingsRefreshDays ?? loadConfig().fetcher.holdingsRefreshDays
  const holdAgeDays = await markerAgeDays(pool, holdingsMarker(code))
  const ttlExpired = ttlDays > 0 && holdAgeDays >= ttlDays
  if (!holdDate || ttlExpired) {
    try {
      const reports = await jjccHoldings(code)
      let h = 0
      for (const rep of reports) {
        h += await saveHoldings(pool, code, rep.reportDate, rep.rows)
      }
      result.holdingsInserted = h
      result.holdingsPeriods = reports.length
      const why = !holdDate ? '首次抓取' : `距上次 ${Math.floor(holdAgeDays)} 天 ≥ 周期 ${ttlDays} 天`
      log(`持仓 ${reports.length} 期 / 新增 ${h} 行（${why}），最新报告期 ${reports[0]?.reportDate ?? '-'}`)
      // 抓到结果就记时间戳（即使解析出 0 期，如纯债基无股票持仓表）：
      // 否则下一轮会认为"从没抓过"而反复请求
      await setMarker(pool, holdingsMarker(code))
    } catch (e) {
      log(`持仓抓取失败: ${(e as Error).message}`)
    }
  } else {
    log(`持仓未到期（最新报告期 ${holdDate}，距上次抓取 ${Math.floor(holdAgeDays)} 天 < ${ttlDays} 天），跳过`)
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
