// 提醒检查 CLI 入口：electron . --alerts [--scope intraday|close]
// 不传 --scope 时盘中/盘后两轮都跑（与调度器一致）。手动触发用，同样走去重（当天同类不重复推）。
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema, createAiFundPool } from './storage/db'
import { runAlertCheck, cleanupAlertLog } from './alerts/run'
import type { AlertRunResult } from './alerts/run'

export async function runAlerts(): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[alerts] 配置文件: ${configPath()}`)
  if (!cfg.alerts.enabled) {
    console.log('[alerts] 配置中 alerts.enabled=false，跳过（如需执行请在设置页开启）')
    return 0
  }
  const idx = process.argv.indexOf('--scope')
  const scopeArg = idx >= 0 ? process.argv[idx + 1] : ''
  const scopes: ('intraday' | 'close')[] = scopeArg === 'intraday' || scopeArg === 'close' ? [scopeArg] : ['intraday', 'close']

  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[alerts] PostgreSQL 连接失败: ${(e as Error).message}`)
    return 1
  }
  try {
    await ensureSchema(pool)
  } catch (e) {
    console.error(`[alerts] 建表失败: ${(e as Error).message}`)
    await pool.end()
    return 1
  }

  const aiFundPool = createAiFundPool(cfg)
  try {
    const results: AlertRunResult[] = []
    for (const scope of scopes) {
      const r = await runAlertCheck(pool, aiFundPool, cfg, scope)
      results.push(r)
      for (const it of r.items) console.log(`  [${scope}] 用户${it.userId} ${it.fundCode} ${it.type}: ${it.title}`)
    }
    const cleaned = await cleanupAlertLog(pool, 90)
    if (cleaned > 0) console.log(`[alerts] 清理 ${cleaned} 条 90 天前记录`)
    const total = results.reduce((s, r) => s + r.notified, 0)
    console.log(`[alerts] 完成：推送 ${total} 条（同类同日已推过的不会重复推送）`)
    return 0
  } catch (e) {
    console.error(`[alerts] 执行失败: ${(e as Error).message}`)
    return 1
  } finally {
    await aiFundPool.end().catch(() => {})
    await pool.end().catch(() => {})
  }
}
