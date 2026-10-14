import { Pool } from 'pg'
import type { AppConfig, PgConfig } from '../config'
import { logWarn } from '../logger'
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
  const pool = new Pool({
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
  attachConnGuards(
    pool,
    `${pool.options.host ?? 'localhost'}:${pool.options.port ?? 5432}/${pool.options.database ?? ''}`
  )
  return pool
}

/**
 * 连接被服务端/网络中断时的兜底监听（必须在池创建时就挂上）。
 *
 * 背景：连接「意外断开」时 pg 会把**同一个 Error 对象**做两件事——
 *   1. reject 掉在途查询（调用方 try/catch 能拿到）；
 *   2. `client.emit('error', err)`（pg client.js 的 connection 'end' → _handleErrorEvent）。
 * 第 2 条坑在于：
 *   - client 被 checkout 在池外时，池没给它挂 error 监听 → EventEmitter 直接把异常抛出去，
 *     成为主进程「未捕获异常」（Electron 默认弹「A JavaScript error occurred in the main process /
 *     Uncaught Exception」模态框，而业务侧其实已经 catch 并记了日志）；
 *   - client 空闲在池里时由 pg-pool 的 idleListener 接住，但它会 `pool.emit('error')`，
 *     池上若也没有监听，同样变成未捕获异常。
 * 所以池和每个 client 都挂上监听：只记 WARN（同一条消息 30s 内去重，避免断网时刷屏），
 * 绝不向上抛——真正的失败仍由各调用点的 try/catch 处理，调度器 30s 后自然重试。
 */
function attachConnGuards(pool: Pool, tag: string): void {
  pool.on('error', (err) => warnConnOnce(tag, err))
  pool.on('connect', (client) => {
    client.on('error', (err) => warnConnOnce(tag, err))
  })
}

const CONN_WARN_INTERVAL_MS = 30_000
const lastConnWarnAt = new Map<string, number>()

function warnConnOnce(tag: string, err: unknown): void {
  const msg = `[db] ${tag} 连接异常（已忽略，交给调用方/下一轮重试）: ${(err as Error)?.message ?? String(err)}`
  const now = Date.now()
  if (now - (lastConnWarnAt.get(msg) ?? 0) < CONN_WARN_INTERVAL_MS) return
  if (lastConnWarnAt.size > 100) lastConnWarnAt.clear()
  lastConnWarnAt.set(msg, now)
  logWarn(msg)
}

/** 连接级（DNS/网络/被服务端掐断）的临时故障：值得重试；SQL 语法、权限等业务错误不重试 */
export function isTransientConnError(e: unknown): boolean {
  const err = e as NodeJS.ErrnoException | undefined
  const code = err?.code
  if (
    code &&
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      'ENOTFOUND',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'EAI_AGAIN'
    ].includes(code)
  ) {
    return true
  }
  const m = err?.message ?? ''
  return /Connection terminated|Connection closed|timeout exceeded when trying to connect|Client has encountered a connection error|socket hang up|terminating connection|server closed the connection/i.test(
    m
  )
}

/** 对临时连接故障重试（默认 1 次重试，短暂抖动不必等到下一个 30s tick） */
async function withConnRetry<T>(fn: () => Promise<T>, attempts = 2, delayMs = 400): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      if (i === attempts - 1 || !isTransientConnError(e)) throw e
      await new Promise((r) => setTimeout(r, delayMs))
    }
  }
  throw lastErr
}

/** 自动建表 + 单用户→多用户迁移：全部语句在单事务内执行（幂等，可安全重跑） */
export async function ensureSchema(pool: Pool): Promise<void> {
  await withConnRetry(() => runSchemaTxn(pool))
}

async function runSchemaTxn(pool: Pool): Promise<void> {
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

// 已建表成功的库（进程内记忆）：建表是幂等的 DDL，但共享库上每 30s tick 重跑 30+ 条
// CREATE/ALTER 会反复取表锁，且连接被掐断时整个事务白跑。失败不记忆 → 下次调用重跑。
const ensuredTargets = new Map<string, Promise<void>>()

/** 按目标库记忆的建表：同一进程内只真正执行一次（并发调用共享同一个 Promise）。
 *  仅用于高频调用点（调度器 tick）；需要「每次确保」的入口（启动、IPC、CLI）仍用 ensureSchema。 */
export function ensureSchemaOnce(pool: Pool): Promise<void> {
  const key = `${pool.options.host ?? ''}:${pool.options.port ?? 5432}/${pool.options.database ?? ''}`
  const hit = ensuredTargets.get(key)
  if (hit) return hit
  const guarded = ensureSchema(pool).catch((e) => {
    ensuredTargets.delete(key) // 失败不缓存：下一次调用重新建表
    throw e
  })
  ensuredTargets.set(key, guarded)
  return guarded
}

/** 连通性 + public schema 表数量统计 */
export async function pingDb(pool: Pool): Promise<number> {
  const r = await pool.query<{ c: number }>(
    `SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public'`
  )
  return r.rows[0].c
}
