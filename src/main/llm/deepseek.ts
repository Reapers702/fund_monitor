// DeepSeek 客户端（OpenAI 兼容，计划书 §7.5：Key 未配置跳过；M6 建议）
// 用 Node 原生 https 而非全局 fetch：Electron 主进程 fetch 走代理栈，对部分域名连接不稳
import { loadConfig } from '../config'
import { logInfo } from '../logger'
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
  const temperature = opts.temperature ?? 0.3
  const maxTokens = opts.maxTokens ?? 1200
  // enable_thinking=false：关闭思考链。思考型模型（deepseek-flash 等）会先输出 reasoning_content，
  // 且其长度不定、与 max_tokens 共用额度，长 prompt 下极易吃满导致 content 为空（finish_reason=length）
  const body = JSON.stringify({
    model: cfg.deepseek.model,
    messages,
    temperature,
    max_tokens: maxTokens,
    enable_thinking: false
  })

  // 记录发往大模型的完整请求与原始响应全文（含 reasoning_content / finish_reason / usage），
  // 便于排查空响应、解析失败等问题；落盘 userData/logs/app-YYYY-MM-DD.log
  logInfo(
    `[llm] >>> model=${cfg.deepseek.model} max_tokens=${maxTokens} temperature=${temperature}\n` +
      messages.map((m) => `>>> [${m.role}]\n${m.content}`).join('\n')
  )
  const { status, text } = await rawPost(
    `${base}/chat/completions`,
    {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.deepseek.apiKey}`,
      Accept: 'application/json'
    },
    body,
    60000
  )
  logInfo(`[llm] <<< HTTP ${status}\n${text}`)
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
  const d = JSON.parse(text) as {
    choices?: { message?: { content?: string; reasoning_content?: string }; finish_reason?: string }[]
  }
  const choice = d.choices?.[0]
  const content = choice?.message?.content
  if (!content) {
    // 空响应时附带 finish_reason 与响应体片段，便于区分"思考token吃满/中转站空返回/内容过滤"
    const reason = choice?.finish_reason ?? '无choices或空choices'
    const snippet = text.length > 300 ? `${text.slice(0, 300)}…` : text
    throw new DeepseekError(`DeepSeek 空响应（finish_reason=${reason}，响应：${snippet}）`)
  }
  return content.trim()
}
