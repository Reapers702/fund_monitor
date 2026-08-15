// 多用户（M9）：当前用户管理。
// 无密码、按名字切换（本地桌面多人共用）。用户在 app_user 表；"当前用户"
// 为内存状态，持久化到 config.json（重启记住）。历史数据归默认用户 guanxin(id=1)。
import { loadConfig, saveConfig } from './config'
import type { Pool } from 'pg'

let currentUserId = 1

/** 应用启动后调用：从 config.json 恢复上次使用的用户 */
export function initUser(): void {
  currentUserId = loadConfig().currentUserId || 1
}

export function getCurrentUserId(): number {
  return currentUserId
}

/** 切换当前用户并持久化（设置页调用；前端随后整页刷新） */
export function setCurrentUserId(id: number): void {
  currentUserId = id
  const cfg = loadConfig()
  cfg.currentUserId = id
  saveConfig(cfg)
}

/** 确保默认用户 guanxin 存在（ensureSchema 后调用；新建库时兜底） */
export async function ensureDefaultUser(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO app_user (id, name) VALUES (1, 'guanxin') ON CONFLICT (id) DO NOTHING`)
}

export interface AppUserRow {
  id: number
  name: string
  createdAt: string
}

export async function listUsers(pool: Pool): Promise<AppUserRow[]> {
  const r = await pool.query<{ id: number; name: string; created_at: Date }>(
    'SELECT id, name, created_at FROM app_user ORDER BY id'
  )
  return r.rows.map((x) => ({ id: x.id, name: x.name, createdAt: x.created_at.toISOString() }))
}

/** 新建用户（名字去重）；返回新用户 id */
export async function createUser(pool: Pool, name: string): Promise<number> {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('用户名不能为空')
  const r = await pool.query<{ id: number }>(`INSERT INTO app_user (name) VALUES ($1) RETURNING id`, [trimmed])
  return r.rows[0].id
}
