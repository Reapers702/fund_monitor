// 抓取客户端（计划书 §4.3 抓取礼仪：请求伪装 + 退避重试 + 全局限流，绝不轰炸）
// 用 Node 原生 https 而非全局 fetch：Electron 主进程的 fetch 走 Chromium/代理网络栈，
// 实测对部分行情域名（腾讯）连接失败，原生 https 与 curl 等价，连通性最稳。
//
// P0/P1 改造：
//   1. 全局限流器——所有出站请求统一排队（并发 ≤3，请求间隔匀速 + 抖动），
//      替代原先"各模块各管各的、想发就发"（计划书 §4.3-4「限流自检：并发上限 ≤3」）。
//   2. GBK 解码——腾讯行情是 GBK，原来按 UTF-8 解出乱码；降级源的股票/指数名一直是乱码。
//   3. 请求埋点——每次尝试都写结构化记录（主机/标签/状态码/耗时/字节），
//      并按业务标签聚合，供 GUI「抓取日志」页回答"抓了什么、抓了多少、谁在失败"。
//   4. 通道接线——按 config.fetch.channel 走 node / browser / auto（原先该配置只写不读）。
//      node = 本文件的原生 https；browser = 隐藏窗口真实 Chromium 发同源 fetch（见 pageFetcher.ts）；
//      auto = 先 node，失败再走 browser。channel 由 config.ts 注入（本文件不依赖 electron，保持可单测）。
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { sleep } from '../utils'
import { logInfo, logWarn } from '../logger'
import { recordRequest, splitUrl } from './requestLog'
import { channelStrategy } from './channel'

export interface GetOptions {
  referer?: string
  timeoutMs?: number
  /** 重试次数（不含首次），默认 2；退避 = retryDelayMs * 2^attempt */
  retries?: number
  retryDelayMs?: number
  /** 响应编码：腾讯行情等站点为 GBK（默认 utf8） */
  encoding?: 'utf8' | 'gbk'
  /** 业务标签（中文），用于抓取日志按"抓的是什么"聚合，如「净值:东财lsjz」 */
  tag?: string
}

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

// 统一 Chrome 桌面 UA + zh-CN
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36'

// ---------- 全局限流器（计划书 §4.3-4：并发上限 ≤3） ----------

const MAX_CONCURRENT = 3 // 出站并发上限
const MIN_GAP_MS = 120 // 相邻请求最小间隔（匀速放行）
const JITTER_MS = 80 // 抖动上限：间隔不固定，避免被识别成脚本节奏

let active = 0
const waiters: (() => void)[] = []
let nextSlotAt = 0

/** 取一个发送名额：并发满则排队；取到后按"匀速 + 抖动"放行 */
async function acquireSlot(): Promise<void> {
  while (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve))
  active++
  const now = Date.now()
  const wait = nextSlotAt - now
  nextSlotAt = Math.max(now, nextSlotAt) + MIN_GAP_MS
  if (wait > 0) await sleep(wait + Math.random() * JITTER_MS)
}

function releaseSlot(): void {
  active = Math.max(0, active - 1)
  const next = waiters.shift()
  if (next) next()
}

/** 当前限流器占用情况（GUI 展示用） */
export function limiterState(): { active: number; queued: number; maxConcurrent: number; minGapMs: number } {
  return { active, queued: waiters.length, maxConcurrent: MAX_CONCURRENT, minGapMs: MIN_GAP_MS }
}

/** 按指定编码解码响应体（GBK 依赖 Node/Electron 的完整 ICU；不支持则回退 UTF-8） */
function decodeBody(buf: Buffer, encoding: 'utf8' | 'gbk'): string {
  if (encoding === 'gbk') {
    try {
      return new TextDecoder('gbk').decode(buf)
    } catch {
      /* 无 GBK 支持（精简 ICU）时按 UTF-8 处理，名称可能乱码但不影响数值解析 */
    }
  }
  return buf.toString('utf8')
}

/** 原生 https 单次请求（支持 http 降级），返回 {status, text, bytes}；受全局限流约束 */
async function rawGet(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  encoding: 'utf8' | 'gbk'
): Promise<{ status: number; text: string; bytes: number }> {
  const u = new URL(url)
  const isHttps = u.protocol === 'https:'
  const lib = isHttps ? httpsRequest : httpRequest

  await acquireSlot()
  try {
    return await new Promise((resolve, reject) => {
      const req = lib(
        {
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          method: 'GET',
          headers
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c: Buffer) => chunks.push(c))
          res.on('end', () => {
            const buf = Buffer.concat(chunks)
            resolve({ status: res.statusCode ?? 0, text: decodeBody(buf, encoding), bytes: buf.length })
          })
        }
      )
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`请求超时 ${timeoutMs}ms`))
      })
      req.on('error', (e) => reject(e))
      req.end()
    })
  } finally {
    releaseSlot()
  }
}

// ---------- 单次尝试（两种通道统一成同一结果结构，便于埋点与降级判断） ----------

interface Attempt {
  ok: boolean
  text: string
  status: number | null
  bytes: number
  ms: number
  error: string | null
  via: 'node' | 'browser'
}

/** Node 直连通道：原生 https，失败不抛，收敛成 Attempt */
async function nodeAttempt(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  encoding: 'utf8' | 'gbk'
): Promise<Attempt> {
  const started = Date.now()
  try {
    const r = await rawGet(url, headers, timeoutMs, encoding)
    if (r.status < 200 || r.status >= 300) throw new HttpError(`HTTP ${r.status}`, r.status)
    if (!r.text) throw new HttpError('空响应')
    return { ok: true, text: r.text, status: r.status, bytes: r.bytes, ms: Date.now() - started, error: null, via: 'node' }
  } catch (e) {
    return {
      ok: false,
      text: '',
      status: e instanceof HttpError ? (e.status ?? null) : null,
      bytes: 0,
      ms: Date.now() - started,
      error: (e as Error).message,
      via: 'node'
    }
  }
}

/** 浏览器通道：隐藏窗口真实 Chromium 同源 fetch（动态 import：pageFetcher 依赖 electron，
 *  静态引入会让通过 httpClient 传递依赖的纯函数单测无法加载） */
async function browserAttempt(url: string, timeoutMs: number): Promise<Attempt> {
  const started = Date.now()
  try {
    const { browserGetText } = await import('./pageFetcher')
    const text = await browserGetText(url, timeoutMs)
    const bytes = Buffer.byteLength(text, 'utf8')
    return { ok: true, text, status: 200, bytes, ms: Date.now() - started, error: null, via: 'browser' }
  } catch (e) {
    return { ok: false, text: '', status: null, bytes: 0, ms: Date.now() - started, error: (e as Error).message, via: 'browser' }
  }
}

/**
 * 抓取文本：按通道策略尝试（node / browser / auto），失败按指数退避重试。
 * 返回前剥离 BOM+头尾空白。每次尝试都记入抓取埋点，失败同时落文件日志。
 */
export async function httpGetText(url: string, opts: GetOptions = {}): Promise<string> {
  const {
    referer,
    timeoutMs = 15000,
    retries = 2,
    retryDelayMs = 1000,
    encoding = 'utf8',
    tag = '未标注'
  } = opts
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
  if (referer) headers.Referer = referer

  const { host, path } = splitUrl(url)
  const where = `${host}${path}`
  // 每次调用读取通道策略：设置页改动后无需重启即可生效
  const strategy = channelStrategy()
  let lastError = '未知错误'
  let lastStatus: number | null = null

  for (let attempt = 0; attempt <= retries; attempt++) {
    for (const useBrowser of strategy) {
      const r = useBrowser ? await browserAttempt(url, timeoutMs) : await nodeAttempt(url, headers, timeoutMs, encoding)
      recordRequest({
        ts: Date.now() - r.ms,
        host,
        path,
        tag,
        status: r.status,
        ms: r.ms,
        bytes: r.bytes,
        attempt: attempt + 1,
        ok: r.ok,
        error: r.error
      })
      if (r.ok) {
        logInfo(
          `[http] ${r.status} ${tag} ${r.ms}ms ${r.bytes}B${r.via === 'browser' ? ' [browser]' : ''}` +
            `${attempt > 0 ? `（第${attempt + 1}次尝试）` : ''} ${where}`
        )
        return r.text.replace(/^\uFEFF/, '').trim()
      }
      lastError = r.error ?? '未知错误'
      lastStatus = r.status
      logWarn(`[http] 失败 ${tag}${r.via === 'browser' ? '(browser)' : ''} ${where} → ${lastError}`)
    }
    if (attempt < retries) {
      const delay = retryDelayMs * 2 ** attempt
      logWarn(`[http] 重试 ${attempt + 1}/${retries}（${delay}ms 后）: ${where}`)
      await sleep(delay)
    }
  }
  throw lastStatus === null ? new Error(lastError) : new HttpError(lastError, lastStatus)
}

export async function httpGetJson<T>(url: string, opts: GetOptions = {}): Promise<T> {
  const text = await httpGetText(url, opts)
  return JSON.parse(text) as T
}

/** 剥掉 JSONP 包裹：callback({...}) → {...} */
export function stripJsonp(text: string): string {
  const m = text.match(/^\s*(?:[\w$.]+)\s*\((.*)\)\s*;?\s*$/s)
  return m ? m[1] : text
}
