// 文件日志（计划书 M8 打磨项）：userData/logs/app-YYYY-MM-DD.log 按日滚动
// 提供 info/warn/error 三级；主进程启动时 initLogger() 初始化（获取 userData 路径需要 app ready 后）
import { app } from 'electron'
import { appendFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'

let logDir: string | null = null

/** 初始化日志目录（app ready 后调用；失败静默降级为仅控制台） */
export function initLogger(): void {
  try {
    logDir = join(app.getPath('userData'), 'logs')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
  } catch (e) {
    console.warn(`[logger] 初始化失败（降级仅控制台）: ${(e as Error).message}`)
    logDir = null
  }
}

function todayFile(): string {
  if (!logDir) return ''
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return join(logDir, `app-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}

function write(level: 'INFO' | 'WARN' | 'ERROR', msg: string): void {
  const file = todayFile()
  if (!file) return
  const ts = new Date().toISOString()
  const line = `[${ts}] [${level}] ${msg}\n`
  try {
    appendFileSync(file, line, 'utf8')
  } catch {
    /* 写失败静默（磁盘满/权限），不影响主流程 */
  }
}

export function logInfo(msg: string): void {
  write('INFO', msg)
}

export function logWarn(msg: string): void {
  write('WARN', msg)
}

export function logError(msg: string): void {
  write('ERROR', msg)
}
