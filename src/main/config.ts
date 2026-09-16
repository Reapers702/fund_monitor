import { app } from 'electron'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'

// 配置结构（与计划书 §7.5 一致）
export interface PgConfig {
  user: string
  password: string
  host: string
  port: number
  db: string
  sslmode: string
}

export interface AppConfig {
  pg: PgConfig
  // 新闻只读数据源：另一个 24h 程序写入的 ai_fund 库 raw_news 表。
  // 通常与 pg 同实例同凭证，仅 db 不同；留空字段会继承 pg 的对应值。
  aiFund: PgConfig
  deepseek: { apiKey: string; baseUrl: string; model: string }
  fetcher: {
    navCheckMinutes: number
    holdingsRefreshDays: number
    estimateIntervalSeconds: number
  }
  analyzer: { minutes: string }
  // 桌面提醒阈值（0 = 关闭该项；详见 src/main/alerts/rules.ts 的语义说明）
  alerts: {
    enabled: boolean
    navMovePct: number // 净值单日涨跌绝对值阈值
    estimateMovePct: number // 盘中估值涨跌绝对值阈值
    estimateOffPct: number // 估值与实际净值偏离阈值（估值失真预警）
    badNews: boolean // 重仓股负面新闻提醒
    takeProfitPct: number // 持仓收益率 ≥ 该值 → 止盈
    stopLossPct: number // 持仓收益率 ≤ −该值 → 止损
  }
  fetch: { channel: 'node' | 'browser' | 'auto' }
  funds: string[]
  // 当前激活用户（多用户 M9）：应用启动后从本字段恢复；见 src/main/user.ts
  currentUserId: number
}

const DEFAULTS: AppConfig = {
  pg: { user: '', password: '', host: '127.0.0.1', port: 5432, db: 'fund_monitor', sslmode: 'disable' },
  aiFund: { user: '', password: '', host: '', port: 0, db: 'ai_fund', sslmode: '' },
  deepseek: { apiKey: '', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' },
  fetcher: {
    navCheckMinutes: 10,
    holdingsRefreshDays: 7,
    estimateIntervalSeconds: 300
  },
  analyzer: { minutes: '35' },
  alerts: {
    enabled: true,
    navMovePct: 3,
    estimateMovePct: 3,
    estimateOffPct: 2,
    badNews: true,
    takeProfitPct: 20,
    stopLossPct: 10
  },
  fetch: { channel: 'node' },
  funds: [],
  currentUserId: 1
}

/** 应用专属配置文件路径：userData/config.json */
export function configPath(): string {
  return join(app.getPath('userData'), 'config.json')
}

/** 旧版中文 productName 目录（基金监控与AI推荐系统）里的配置：新 userData 无 config.json 时复制过来 */
const LEGACY_USER_DATA_NAME = '基金监控与AI推荐系统'

function migrateLegacyUserData(): void {
  try {
    const newCfg = join(app.getPath('userData'), 'config.json')
    if (existsSync(newCfg)) return // 新目录已有配置，无需迁移
    const legacyCfg = join(app.getPath('appData'), LEGACY_USER_DATA_NAME, 'config.json')
    if (!existsSync(legacyCfg)) return
    mkdirSync(dirname(newCfg), { recursive: true })
    copyFileSync(legacyCfg, newCfg)
    console.log(`[config] 已从旧目录迁移配置: ${legacyCfg} -> ${newCfg}`)
  } catch (e) {
    console.error(`[config] 旧配置迁移失败:`, (e as Error).message)
  }
}

/** 项目根 .env（开发回退）：仅在首次生成模板时迁移到 config.json */
function loadDotEnvOverrides(): Record<string, string> {
  const envFile = join(process.cwd(), '.env')
  if (!existsSync(envFile)) return {}
  const out: Record<string, string> = {}
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (m && !line.trimStart().startsWith('#')) {
      out[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  }
  return out
}

interface EnvApplyOptions {
  /** 仅填充当前为空的字段（config.json 显式值优先）；false=强制覆盖（首次生成模板用） */
  fillOnlyEmpty?: boolean
}

function applyEnvOverrides(cfg: AppConfig, env: Record<string, string>, opts: EnvApplyOptions = {}): void {
  const { fillOnlyEmpty = false } = opts
  const fill = (cur: string | undefined, val: string | undefined): string | undefined => {
    if (!val) return cur
    return fillOnlyEmpty && cur ? cur : val
  }

  if (env.PG_URL) {
    try {
      const u = new URL(env.PG_URL)
      cfg.pg.user = fill(cfg.pg.user, decodeURIComponent(u.username)) ?? cfg.pg.user
      cfg.pg.password = fill(cfg.pg.password, decodeURIComponent(u.password)) ?? cfg.pg.password
      cfg.pg.host = fill(cfg.pg.host, u.hostname) ?? cfg.pg.host
      const portStr = fill(String(cfg.pg.port || ''), String(Number(u.port) || 5432))
      if (portStr) cfg.pg.port = Number(portStr)
      cfg.pg.db = fill(cfg.pg.db, u.pathname.replace(/^\//, '')) ?? cfg.pg.db
    } catch {
      /* PG_URL 非法则忽略，回退单字段 */
    }
  } else {
    if (env.PG_USER) cfg.pg.user = fill(cfg.pg.user, env.PG_USER) ?? cfg.pg.user
    if (env.PG_PASSWORD) cfg.pg.password = fill(cfg.pg.password, env.PG_PASSWORD) ?? cfg.pg.password
    if (env.PG_HOST) cfg.pg.host = fill(cfg.pg.host, env.PG_HOST) ?? cfg.pg.host
    if (env.PG_PORT) {
      const p = fill(String(cfg.pg.port || ''), env.PG_PORT)
      if (p) cfg.pg.port = Number(p)
    }
    if (env.PG_DB) cfg.pg.db = fill(cfg.pg.db, env.PG_DB) ?? cfg.pg.db
  }
  if (env.DEEPSEEK_API_KEY) cfg.deepseek.apiKey = fill(cfg.deepseek.apiKey, env.DEEPSEEK_API_KEY) ?? cfg.deepseek.apiKey
  if (env.DEEPSEEK_BASE_URL) cfg.deepseek.baseUrl = fill(cfg.deepseek.baseUrl, env.DEEPSEEK_BASE_URL) ?? cfg.deepseek.baseUrl
  if (env.DEEPSEEK_MODEL) cfg.deepseek.model = fill(cfg.deepseek.model, env.DEEPSEEK_MODEL) ?? cfg.deepseek.model

  // ai_fund 只读库：无独立配置时继承 pg 凭证，仅覆盖 db 名
  const aif = cfg.aiFund
  const fillPort = (cur: number, val: string | undefined): number => {
    const p = fill(String(cur || ''), val)
    return p ? Number(p) : cur
  }
  if (env.AI_FUND_URL) {
    try {
      const u = new URL(env.AI_FUND_URL)
      aif.user = fill(aif.user, decodeURIComponent(u.username)) ?? aif.user
      aif.password = fill(aif.password, decodeURIComponent(u.password)) ?? aif.password
      aif.host = fill(aif.host, u.hostname) ?? aif.host
      aif.port = fillPort(aif.port, String(Number(u.port) || 0))
      aif.db = fill(aif.db, u.pathname.replace(/^\//, '')) ?? aif.db
    } catch {
      /* AI_FUND_URL 非法则忽略 */
    }
  } else {
    if (env.AI_FUND_USER) aif.user = fill(aif.user, env.AI_FUND_USER) ?? aif.user
    if (env.AI_FUND_PASSWORD) aif.password = fill(aif.password, env.AI_FUND_PASSWORD) ?? aif.password
    if (env.AI_FUND_HOST) aif.host = fill(aif.host, env.AI_FUND_HOST) ?? aif.host
    if (env.AI_FUND_PORT) aif.port = fillPort(aif.port, env.AI_FUND_PORT)
    if (env.AI_FUND_DB) aif.db = fill(aif.db, env.AI_FUND_DB) ?? aif.db
  }
  // 未显式覆盖的字段回填为 pg 值（同实例常见情况）
  aif.user = aif.user || cfg.pg.user
  aif.password = aif.password || cfg.pg.password
  aif.host = aif.host || cfg.pg.host
  aif.port = aif.port || cfg.pg.port
  aif.sslmode = aif.sslmode || cfg.pg.sslmode
}

/** 按节合并，避免新增字段时旧配置缺失 */
function mergeDefaults(base: AppConfig, raw: Record<string, unknown>): AppConfig {
  const merged = structuredClone(base) as unknown as Record<string, unknown>
  for (const key of Object.keys(merged)) {
    const rv = raw[key]
    if (rv === undefined) continue
    const bv = merged[key]
    // 对象型配置节（pg/deepseek/fetcher/analyzer/fetch）逐节合并，其余（funds 等）整体覆盖
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && typeof rv === 'object' && rv !== null && !Array.isArray(rv)) {
      merged[key] = { ...(bv as object), ...(rv as object) }
    } else {
      merged[key] = rv
    }
  }
  return merged as unknown as AppConfig
}

/** ai_fund 只读库：空字段继承 pg 凭证（同实例常见情况，db 保持 ai_fund） */
function resolveAiFund(cfg: AppConfig): void {
  const aif = cfg.aiFund
  const pg = cfg.pg
  aif.user = aif.user || pg.user
  aif.password = aif.password || pg.password
  aif.host = aif.host || pg.host
  aif.port = aif.port || pg.port
  aif.sslmode = aif.sslmode || pg.sslmode
}

/** 首次运行生成模板（含 .env 迁移）；已存在则直接读取 */
export function ensureConfigFile(): AppConfig {
  migrateLegacyUserData()
  const path = configPath()
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    const cfg = mergeDefaults(DEFAULTS, {})
    applyEnvOverrides(cfg, loadDotEnvOverrides())
    writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8')
    console.log(`[config] 已生成模板: ${path}`)
    return cfg
  }
  return loadConfig()
}

export function loadConfig(): AppConfig {
  migrateLegacyUserData()
  const path = configPath()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    const cfg = mergeDefaults(DEFAULTS, raw)
    resolveAiFund(cfg)
    // .env 开发回退：config.json 中为空的字段用 .env 补全（显式配置优先）
    applyEnvOverrides(cfg, loadDotEnvOverrides(), { fillOnlyEmpty: true })
    resolveAiFund(cfg) // applyEnvOverrides 可能填了 aiFund 字段，再补一次继承
    return cfg
  } catch (e) {
    console.error(`[config] 读取失败 ${path}，回退默认配置:`, (e as Error).message)
    return structuredClone(DEFAULTS)
  }
}

export function saveConfig(cfg: AppConfig): void {
  const path = configPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cfg, null, 2), 'utf8')
}
