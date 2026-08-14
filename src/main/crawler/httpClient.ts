// Node 通道抓取客户端（计划书 §4.3 抓取礼仪：请求伪装 + 退避重试，绝不轰炸）
// 用 Node 原生 https 而非全局 fetch：Electron 主进程的 fetch 走 Chromium/代理网络栈，
// 实测对部分行情域名（腾讯）连接失败，原生 https 与 curl 等价，连通性最稳。
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'
import { sleep } from '../utils'

export interface GetOptions {
  referer?: string
  timeoutMs?: number
  /** 重试次数（不含首次），默认 2；退避 = retryDelayMs * 2^attempt */
  retries?: number
  retryDelayMs?: number
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

/** 原生 https 单次请求（支持 http 降级），返回 {status, text} */
function rawGet(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? httpsRequest : httpRequest
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
          const text = Buffer.concat(chunks).toString('utf8')
          resolve({ status: res.statusCode ?? 0, text })
        })
      }
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时 ${timeoutMs}ms`))
    })
    req.on('error', (e) => reject(e))
    req.end()
  })
}

/**
 * 抓取文本：失败按指数退避重试（交互场景用短退避，调度场景调用方传长退避）。
 * 返回前剥离 BOM+头尾空白。
 */
export async function httpGetText(url: string, opts: GetOptions = {}): Promise<string> {
  const { referer, timeoutMs = 15000, retries = 2, retryDelayMs = 1000 } = opts
  const headers: Record<string, string> = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9'
  }
  if (referer) headers.Referer = referer

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { status, text } = await rawGet(url, headers, timeoutMs)
      if (status < 200 || status >= 300) throw new HttpError(`HTTP ${status}`, status)
      if (!text) throw new HttpError('空响应')
      return text.replace(/^\uFEFF/, '').trim()
    } catch (e) {
      lastErr = e
      if (attempt < retries) {
        const delay = retryDelayMs * 2 ** attempt
        console.warn(`[http] 重试 ${attempt + 1}/${retries}（${delay}ms 后）: ${url} → ${(e as Error).message}`)
        await sleep(delay)
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
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