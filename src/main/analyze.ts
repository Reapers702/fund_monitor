// CLI 入口：electron . --analyze <code>  /  --analyze-all（计划书 M6）
// 对基金执行 DeepSeek 分析 → 写 ds_advice；action != hold 触发桌面通知
import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema, createAiFundPool } from './storage/db'
import { analyzeFund, saveAdvice, todayStr } from './analyzer/analyze'
import { notifyAdvice } from './notifier'
import { sleep } from './utils'
import type { Pool } from 'pg'

/** 对一只基金执行分析并写库（含通知）；503/5xx 服务繁忙按指数退避重试最多 3 次 */
async function analyzeOne(
  pool: Pool,
  aiFundPool: Pool,
  code: string,
  name: string
): Promise<{ done: boolean; notified: boolean }> {
  const maxAttempts = 3
  let lastErr: unknown
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const r = await analyzeFund({ pool, aiFundPool }, code, null)
      if (!r) return { done: false, notified: false }
      await saveAdvice(pool, code, r, todayStr())
      if (r.action !== 'hold') {
        notifyAdvice(name, code, r.action, r.confidence, r.reason)
        return { done: true, notified: true }
      }
      return { done: true, notified: false }
    } catch (e) {
      lastErr = e
      const isBusy = /503|SERVICE_BUSY|429/.test((e as Error).message)
      if (attempt < maxAttempts - 1 && isBusy) {
        const delay = 3000 * 2 ** attempt
        console.warn(`[analyze] ${code} 服务繁忙，${delay / 1000}s 后重试（${attempt + 1}/${maxAttempts - 1}）: ${(e as Error).message}`)
        await sleep(delay)
        continue
      }
      console.error(`[analyze] ${code} 分析异常: ${(e as Error).message}`)
      return { done: false, notified: false }
    }
  }
  console.error(`[analyze] ${code} 重试耗尽: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`)
  return { done: false, notified: false }
}

/** 分析全部自选基金（串行，避免打爆中转站限流） */
export async function runAnalyzeAll(): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[analyze] 配置文件: ${configPath()}`)
  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[analyze] PostgreSQL 连接失败: ${(e as Error).message}`)
    return 1
  }
  try {
    await ensureSchema(pool)
  } catch (e) {
    console.error(`[analyze] 建表失败: ${(e as Error).message}`)
    return 1
  }

  const funds = await pool.query<{ fund_code: string; fund_name: string }>(
    'SELECT fund_code, fund_name FROM fund_basic WHERE is_active = 1 ORDER BY fund_code'
  )
  if (funds.rows.length === 0) {
    console.log('[analyze] 无启用中的自选基金')
    await pool.end()
    return 0
  }
  console.log(`[analyze] 待分析基金 ${funds.rows.length} 只`)

  const aiFundPool = createAiFundPool(cfg)
  let done = 0
  let notified = 0
  for (const f of funds.rows) {
    const out = await analyzeOne(pool, aiFundPool, f.fund_code, f.fund_name)
    if (out.done) done++
    if (out.notified) notified++
  }
  await aiFundPool.end().catch(() => {})
  await pool.end()
  console.log(`[analyze] 完成：成功 ${done}/${funds.rows.length} 只，通知 ${notified} 条`)
  return 0
}

/** 分析单只基金 */
export async function runAnalyzeOne(code: string): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[analyze] 配置文件: ${configPath()}`)
  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[analyze] PostgreSQL 连接失败: ${(e as Error).message}`)
    return 1
  }
  try {
    await ensureSchema(pool)
  } catch (e) {
    console.error(`[analyze] 建表失败: ${(e as Error).message}`)
    return 1
  }
  const fund = await pool.query<{ fund_code: string; fund_name: string }>(
    'SELECT fund_code, fund_name FROM fund_basic WHERE fund_code = $1',
    [code]
  )
  if (fund.rows.length === 0) {
    console.error(`[analyze] 基金 ${code} 不存在于 fund_basic，先 --fund ${code}`)
    await pool.end()
    return 1
  }
  const aiFundPool = createAiFundPool(cfg)
  const out = await analyzeOne(pool, aiFundPool, code, fund.rows[0].fund_name)
  await aiFundPool.end().catch(() => {})
  await pool.end()
  console.log(`[analyze] 完成：${out.done ? '已写入 ds_advice' : '跳过'}${out.notified ? '（已通知）' : ''}`)
  return out.done ? 0 : 2
}
