// 数据库连接健壮性契约测试（回归：主进程「Uncaught Exception」弹窗）。
//
// 事故现场：远端库连接被掐断时，pg 会把同一个 Error 既 reject 在途查询、又 client.emit('error')。
// client 被 checkout 在池外时没人监听 error 事件 → Node 直接抛未捕获异常 → Electron 内置兜底
// 弹出原始堆栈模态框（标题「A JavaScript error occurred in the main process」），
// 而业务代码其实已经 catch 并写了日志（见 userData/logs: [scheduler] tick 异常: Connection terminated unexpectedly）。
//
// 这里锁定三件事：① 池/client 的 error 事件被接住不再抛；② 连接级临时错误重试一次、业务错误不重试；
// ③ 建表在进程内只真正跑一遍（失败不缓存）。全部离线（不连数据库）。
import { EventEmitter } from 'events'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import type { Pool as PgPool } from 'pg'
import type { AppConfig } from '../src/main/config'
import {
  createPool,
  ensureSchema,
  ensureSchemaOnce,
  isTransientConnError
} from '../src/main/storage/db'

const cfg = {
  pg: {
    user: 'u',
    password: 'p',
    host: 'db.example',
    port: 5432,
    db: 'fund_monitor',
    sslmode: 'disable'
  },
  aiFund: {
    user: 'u',
    password: 'p',
    host: 'db.example',
    port: 5432,
    db: 'ai_fund',
    sslmode: 'disable'
  }
} as unknown as AppConfig

/** 假池：只要 options + connect（ensureSchema* 只用这两个） */
function fakePool(
  target: { host: string; port: number; database: string },
  connect: () => Promise<unknown>
): PgPool {
  return { options: target, connect } as unknown as PgPool
}

function fakeClient(onQuery?: (sql: string) => void): {
  query: (sql: string) => Promise<unknown>
  release: () => void
} {
  return {
    query: async (sql: string) => {
      onQuery?.(sql)
      return { rows: [] }
    },
    release: () => {}
  }
}

describe('pg 连接意外中断不再变成未捕获异常', () => {
  it('未加监听的裸池：emit("error") 会直接抛（弹窗根因）', () => {
    const raw = new Pool({ host: 'db.example', port: 5432, database: 'fund_monitor' })
    expect(raw.listenerCount('error')).toBe(0)
    expect(() => raw.emit('error', new Error('Connection terminated unexpectedly'))).toThrow(
      'Connection terminated unexpectedly'
    )
    void raw.end()
  })

  it('createPool 出来的池：池与 client 上都挂了监听，error 事件只记日志不抛', async () => {
    const pool = createPool(cfg)
    try {
      expect(pool.listenerCount('error')).toBeGreaterThan(0)

      // 空闲 client 断线：pg-pool 的 idleListener 会把它转成 pool.emit('error')
      expect(() =>
        pool.emit('error', new Error('Connection terminated unexpectedly'))
      ).not.toThrow()

      // 在池外 checkout 的 client 断线：这是本次弹窗的真实路径
      const client = new EventEmitter()
      pool.emit('connect', client as never)
      expect(() =>
        client.emit('error', new Error('Connection terminated unexpectedly'))
      ).not.toThrow()
    } finally {
      await pool.end()
    }
  })

  it('连接级临时故障识别：网络/DNS/被掐断为临时，SQL 业务错误不是', () => {
    expect(
      isTransientConnError(
        Object.assign(new Error('getaddrinfo ENOTFOUND tmp.reapers.top'), { code: 'ENOTFOUND' })
      )
    ).toBe(true)
    expect(
      isTransientConnError(Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }))
    ).toBe(true)
    expect(isTransientConnError(new Error('Connection terminated unexpectedly'))).toBe(true)
    expect(
      isTransientConnError(
        Object.assign(new Error('relation "fund_basic" already exists'), { code: '42P07' })
      )
    ).toBe(false)
    expect(
      isTransientConnError(
        Object.assign(new Error('password authentication failed'), { code: '28P01' })
      )
    ).toBe(false)
  })
})

describe('ensureSchema 的失败语义与重试', () => {
  it('事务中途失败会 ROLLBACK（业务错误只跑一次，不重试）', async () => {
    const sqls: string[] = []
    let connects = 0
    const pool = fakePool({ host: 'rollback', port: 1, database: 'd' }, async () => {
      connects++
      return fakeClient((sql) => {
        sqls.push(sql)
        if (/^CREATE TABLE/i.test(sql)) throw new Error('boom')
      })
    })
    await expect(ensureSchema(pool)).rejects.toThrow('boom')
    expect(sqls[0]).toBe('BEGIN')
    expect(sqls).toContain('ROLLBACK')
    expect(connects).toBe(1) // 非临时错误不重试
  })

  it('连接级错误会重试一次（短暂抖动不用等到下一个 tick）', async () => {
    let connects = 0
    const pool = fakePool({ host: 'retry', port: 1, database: 'd' }, async () => {
      connects++
      throw Object.assign(new Error('getaddrinfo ENOTFOUND tmp.reapers.top'), { code: 'ENOTFOUND' })
    })
    await expect(ensureSchema(pool)).rejects.toThrow('ENOTFOUND')
    expect(connects).toBe(2)
  })
})

describe('ensureSchemaOnce 按库记忆（避免每 30s tick 重跑 30+ 条 DDL）', () => {
  it('同一个库只真正建表一次，即使换了池对象', async () => {
    let a = 0
    let b = 0
    const target = { host: 'memo', port: 1, database: 'fund_monitor' }
    await ensureSchemaOnce(
      fakePool(target, async () => {
        a++
        return fakeClient()
      })
    )
    await ensureSchemaOnce(
      fakePool(target, async () => {
        b++
        return fakeClient()
      })
    )
    expect(a).toBe(1)
    expect(b).toBe(0)
  })

  it('建表失败不缓存：下一次调用会重新建表（断网恢复后自愈）', async () => {
    let connects = 0
    const target = { host: 'retry-once', port: 1, database: 'd' }
    const pool = fakePool(target, async () => {
      connects++
      throw Object.assign(new Error('getaddrinfo ENOTFOUND tmp.reapers.top'), { code: 'ENOTFOUND' })
    })
    await expect(ensureSchemaOnce(pool)).rejects.toThrow('ENOTFOUND')
    expect(connects).toBe(2) // 一次调用 = 1 次 + 1 次重试
    await expect(ensureSchemaOnce(pool)).rejects.toThrow('ENOTFOUND')
    expect(connects).toBe(4) // 没有被缓存，重新走一遍
  })
})
