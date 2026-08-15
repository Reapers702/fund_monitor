import { Pool } from 'pg'
import type { AppConfig, PgConfig } from '../config'
import { SCHEMA_STATEMENTS, MIGRATION_STATEMENTS } from './schema'

// pg 连接池（计划书 §7.5/§8：启动校验连通性 + 自动建表，幂等可重跑）
export function createPool(cfg: AppConfig): Pool {
  return createPoolFrom(cfg.pg)
}

/** 新闻只读数据源：ai_fund 库（另一个 24h 程序写入 raw_news 表） */
export function createAiFundPool(cfg: AppConfig): Pool {
  return createPoolFrom(cfg.aiFund)
}

function createPoolFrom(pg: PgConfig): Pool {
  const ssl = pg.sslmode ?? 'disable'
  return new Pool({
    user: pg.user || undefined,
    password: pg.password || undefined,
    host: pg.host || undefined,
    port: pg.port,
    database: pg.db || undefined,
    // prefer：尝试加密连接，失败由调用方回退非加密（check.ts 处理）
    ...(ssl === 'disable' ? {} : { ssl: { rejectUnauthorized: false } }),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000
  })
}

/** 自动建表 + 单用户→多用户迁移：全部语句在单事务内执行（幂等，可安全重跑） */
export async function ensureSchema(pool: Pool): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    for (const sql of SCHEMA_STATEMENTS) {
      await client.query(sql)
    }
    for (const sql of MIGRATION_STATEMENTS) {
      await client.query(sql)
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** 连通性 + public schema 表数量统计 */
export async function pingDb(pool: Pool): Promise<number> {
  const r = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public'`
  )
  return r.rows[0].c
}
