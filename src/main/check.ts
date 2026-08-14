import { configPath, ensureConfigFile } from './config'
import { createPool, ensureSchema, pingDb } from './storage/db'

/**
 * 命令行校验入口：`electron . --check`
 * 1. 生成/读取 config.json（含 .env 迁移）
 * 2. 连接 PostgreSQL；失败打印引导信息并退出码 1
 * 3. 自动建表；打印 public schema 表数量
 */
export async function runCheck(): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[check] 配置文件: ${configPath()}`)
  if (!cfg.pg.user || !cfg.pg.db) {
    console.error('[check] pg 配置未填全（user/db 必填），请编辑 config.json 后重试。')
    return 1
  }

  const pool = createPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[check] PostgreSQL 连接失败: ${(e as Error).message}`)
    console.error('[check] 请确认 PostgreSQL 已启动，且 config.json 中 pg 的 host/port/user/password/db 正确。')
    return 1
  }

  try {
    await ensureSchema(pool)
    const n = await pingDb(pool)
    console.log(`[check] OK：连接成功，自动建表完成，public schema 共 ${n} 张表。`)
    return 0
  } catch (e) {
    console.error(`[check] 建表失败: ${(e as Error).message}`)
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}
