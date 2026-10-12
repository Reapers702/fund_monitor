// 文件日志（计划书 M8 打磨项）：userData/logs/app-YYYY-MM-DD.log 按日滚动
// 提供 info/warn/error/debug 四级；主进程启动时 initLogger() 初始化（获取 userData 路径需要 app ready 后）
// 保留策略：启动时清理 KEEP_DAYS 天前的日志文件（按文件名日期判断）
//
// P1 改造：initLogger() 会**接管主进程 console.\***，把原本只打印到 stdout 的日志一并落盘。
// 原因：打包后的 GUI 应用没有 stdout，而抓取层（market/eastmoney/quotes/httpClient）大量用
// console.warn/error 汇报"哪只标的、哪条链路失败"——那些正是排障时最需要的信息，之前全部丢失。
// 接管后无需改动 200+ 处调用点，console 与 logXxx 两个入口都会写进同一份日志文件。
//
// 同时保留一个内存环形缓冲（recentLogs），供 GUI「抓取日志」页直接展示，不必去翻文件。
import { appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'fs'
import { join } from 'path'

const KEEP_DAYS = 30
const RING_MAX = 500 // 内存中保留的最近日志条数（超出丢弃最旧）
const MAX_MSG_LEN = 4000 // 单条日志长度上限（LLM 全文/长堆栈截断，避免单行过大）

export type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface LogEntry {
  ts: number // 写入时刻（ms）
  level: LogLevel
  msg: string
}

let logDir: string | null = null
let patched = false
const ring: LogEntry[] = []

/** 初始化日志目录（app ready 后调用；失败静默降级为仅控制台），并清理过期日志、接管 console。
 *  userDataDir 由调用方（index.ts）传入 app.getPath('userData')——logger 刻意不 import electron，
 *  这样 httpClient 等被抓取层引用的模块可以安全使用它（单测直接 import 时不会拉起 electron）。 */
export function initLogger(userDataDir: string): void {
  try {
    logDir = join(userDataDir, 'logs')
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true })
    cleanupOldLogs()
  } catch (e) {
    console.warn(`[logger] 初始化失败（降级仅控制台）: ${(e as Error).message}`)
    logDir = null
  }
  patchConsole()
}

/** 日志目录绝对路径（GUI「打开日志目录」用）；未初始化返回 null */
export function getLogDir(): string | null {
  return logDir
}

/** 今日日志文件绝对路径；未初始化返回 null */
export function getLogFilePath(): string | null {
  return todayFile() || null
}

/** 最近日志（时间倒序，最新在前） */
export function recentLogs(limit = 200): LogEntry[] {
  const n = Math.max(0, Math.min(limit, ring.length))
  const out: LogEntry[] = []
  for (let i = 0; i < n; i++) out.push(ring[ring.length - 1 - i])
  return out
}

/**
 * 接管主进程 console：先按原样输出到 stdout（开发模式仍可见），再落盘 + 进环形缓冲。
 * 幂等：重复调用只生效一次（避免 console 被层层包裹）。
 */
function patchConsole(): void {
  if (patched) return
  patched = true
  const map: [keyof Console, LogLevel][] = [
    ['log', 'INFO'],
    ['info', 'INFO'],
    ['warn', 'WARN'],
    ['error', 'ERROR'],
    ['debug', 'DEBUG']
  ]
  for (const [method, level] of map) {
    const orig = (console[method] as (...a: unknown[]) => void).bind(console)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(console as any)[method] = (...args: unknown[]): void => {
      orig(...args)
      write(level, formatArgs(args))
    }
  }
}

/** 把 console 的多参数拼成一行文本（Error 带堆栈，对象走 JSON） */
function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === 'string') return a
      if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
      if (a === null || a === undefined) return String(a)
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
    .slice(0, MAX_MSG_LEN)
}

/** 删除 KEEP_DAYS 天前的 app-YYYY-MM-DD.log（按文件名日期字符串比较） */
function cleanupOldLogs(): void {
  if (!logDir) return
  const d = new Date()
  d.setDate(d.getDate() - KEEP_DAYS)
  const p = (n: number) => String(n).padStart(2, '0')
  const cutoff = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  try {
    for (const f of readdirSync(logDir)) {
      const m = f.match(/^app-(\d{4}-\d{2}-\d{2})\.log$/)
      if (m && m[1] < cutoff) unlinkSync(join(logDir, f))
    }
  } catch (e) {
    console.warn(`[logger] 清理过期日志失败: ${(e as Error).message}`)
  }
}

function todayFile(): string {
  if (!logDir) return ''
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return join(logDir, `app-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`)
}

function write(level: LogLevel, msg: string): void {
  const entry: LogEntry = { ts: Date.now(), level, msg }
  ring.push(entry)
  if (ring.length > RING_MAX) ring.shift()

  const file = todayFile()
  if (!file) return
  const line = `[${new Date(entry.ts).toISOString()}] [${level}] ${msg}\n`
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

export function logDebug(msg: string): void {
  write('DEBUG', msg)
}
