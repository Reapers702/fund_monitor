// DeepSeek 客户端（OpenAI 兼容，计划书 §7.5：Key 未配置跳过；M6 建议）
// 用 Node 原生 https 而非全局 fetch：Electron 主进程 fetch 走代理栈，对部分域名连接不稳
import { loadConfig } from '../config'
import { request as httpsRequest } from 'https'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

/** 是否已配置 API Key（未配置则 AI 相关功能自动跳过） */
export function hasDeepseekKey(): boolean {
  return Boolean(loadConfig().deepseek.apiKey)
}

export class DeepseekError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'DeepseekError'
  }
}

/** 原生 https POST（与 httpClient 同栈，避开 Electron 代理网络） */
function rawPost(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname,
        method: 'POST',
        headers
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时 ${timeoutMs}ms`)))
    req.on('error', (e) => reject(e))
    req.write(body)
    req.end()
  })
}

/** 单轮对话补全，返回文本（baseUrl 以 https://api.deepseek.com 为例，自动补 /chat/completions） */
export async function chatComplete(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  const cfg = loadConfig()
  if (!cfg.deepseek.apiKey) throw new DeepseekError('未配置 DeepSeek API Key')
  const base = cfg.deepseek.baseUrl.replace(/\/+$/, '')
  const { status, text } = await rawPost(
    `${base}/chat/completions`,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.deepseek.apiKey}`,
      Accept: 'application/json'
    },
    JSON.stringify({
      model: cfg.deepseek.model,
      messages,
      temperature: opts.temperature ?? 0.3,
      max_tokens: opts.maxTokens ?? 1200
    }),
    60000
  )
  if (status < 200 || status >= 300) {
    // 附带响应体细节（如中转站 SERVICE_BUSY 等业务错误），便于诊断
    const detail = (() => {
      try {
        const j = JSON.parse(text) as { message?: string; code?: string }
        return j.message ? ` (${j.code ?? ''}: ${j.message})` : ''
      } catch {
        return ''
      }
    })()
    throw new DeepseekError(`DeepSeek HTTP ${status}${detail}`, status)
  }
  const d = JSON.parse(text) as { choices?: { message?: { content?: string } }[] }
  const content = d.choices?.[0]?.message?.content
  if (!content) throw new DeepseekError('DeepSeek 空响应')
  return content.trim()
}
