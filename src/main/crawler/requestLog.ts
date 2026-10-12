// 抓取请求埋点（P1）：进程内环形缓冲 + 分维度累计统计，供 GUI「抓取日志」页展示。
//
// 与 logger.ts 的分工：
//   - logger.ts（文件日志）  ：给人看的行文本，用于事后排障，按日滚动落盘
//   - 本模块（结构化统计）    ：给界面看的聚合结果，回答"抓了什么 / 抓了多少 / 成功率 / 谁在失败"
//
// 只做内存记录，不落库：单次运行的抓取画像足够回答问题，重启清零不误导（避免把历史累计
// 当成"本次运行"）。失败详情同时会经 logger 落到文件，长期留痕靠文件日志。

/** 单次 HTTP 请求记录 */
export interface RequestRecord {
  ts: number // 开始时刻（ms）
  host: string // 目标主机
  path: string // 路径 + （截断的）query
  tag: string // 业务标签（中文），如「净值:东财lsjz」
  status: number | null // HTTP 状态码；连接级失败为 null
  ms: number // 耗时（ms）
  bytes: number // 响应体字节数
  attempt: number // 第几次尝试，1 = 首次
  ok: boolean
  error: string | null
}

/** 单一维度（业务标签 / 主机）的累计统计 */
export interface DimensionStat {
  key: string
  total: number
  ok: number
  fail: number
  avgMs: number // 平均耗时（含失败）
  lastTs: number // 最近一次请求时刻（ms）
  lastError: string | null // 最近一次失败原因（成功后保留历史值，便于回看）
}

export interface RequestStats {
  since: number // 统计起点（本进程首次记录请求的时刻）
  total: number
  ok: number
  fail: number
  byTag: DimensionStat[]
  byHost: DimensionStat[]
  /** 最近请求（时间倒序） */
  recent: RequestRecord[]
  /** 最近失败（时间倒序） */
  failures: RequestRecord[]
}

const RING_MAX = 500 // 最近请求保留条数
const FAIL_MAX = 100 // 失败列表保留条数
const PATH_MAX = 140 // path 截断长度（东财批量行情 URL 很长，避免撑爆界面）

let since = 0
let total = 0
let okCount = 0
let failCount = 0

const ring: RequestRecord[] = []
const failures: RequestRecord[] = []
const byTag = new Map<string, DimensionStat>()
const byHost = new Map<string, DimensionStat>()

function accumulate(map: Map<string, DimensionStat>, key: string, r: RequestRecord): void {
  let s = map.get(key)
  if (!s) {
    s = { key, total: 0, ok: 0, fail: 0, avgMs: 0, lastTs: 0, lastError: null }
    map.set(key, s)
  }
  // 用移动平均累计总耗时，避免额外维护时长总和
  s.avgMs = (s.avgMs * s.total + r.ms) / (s.total + 1)
  s.total++
  if (r.ok) s.ok++
  else {
    s.fail++
    s.lastError = r.error
  }
  if (r.ts >= s.lastTs) s.lastTs = r.ts
}

/** 记录一次请求（httpClient 每次尝试都会调用，含失败） */
export function recordRequest(r: RequestRecord): void {
  if (since === 0) since = r.ts
  total++
  if (r.ok) okCount++
  else failCount++

  accumulate(byTag, r.tag, r)
  accumulate(byHost, r.host, r)

  ring.unshift(r)
  if (ring.length > RING_MAX) ring.length = RING_MAX

  if (!r.ok) {
    failures.unshift(r)
    if (failures.length > FAIL_MAX) failures.length = FAIL_MAX
  }
}

function sorted(map: Map<string, DimensionStat>): DimensionStat[] {
  return [...map.values()].sort((a, b) => b.total - a.total || a.key.localeCompare(b.key, 'zh'))
}

/** 当前统计快照（供 IPC 返回；结构是普通对象，可安全序列化） */
export function requestStats(): RequestStats {
  return {
    since,
    total,
    ok: okCount,
    fail: failCount,
    byTag: sorted(byTag),
    byHost: sorted(byHost),
    recent: [...ring],
    failures: [...failures]
  }
}

/** 清空统计（手动重置；正常运行不需要） */
export function resetRequestLog(): void {
  since = 0
  total = 0
  okCount = 0
  failCount = 0
  ring.length = 0
  failures.length = 0
  byTag.clear()
  byHost.clear()
}

/** 从 URL 拆出 host 与（截断的）path，供界面按主机聚合 */
export function splitUrl(url: string): { host: string; path: string } {
  try {
    const u = new URL(url)
    const full = u.pathname + u.search
    return {
      host: u.hostname,
      path: full.length > PATH_MAX ? `${full.slice(0, PATH_MAX)}…` : full
    }
  } catch {
    return { host: '未知', path: url.slice(0, PATH_MAX) }
  }
}
