// LLM 输出解析（纯函数，独立模块便于单测）
// 提取首个 JSON 对象，校验 action/confidence/reason 合法性

export interface ParsedAdvice {
  action: 'add' | 'reduce' | 'hold'
  confidence: number
  reason: string
  raw: string
}

/** 解析 LLM 输出：提取首个 JSON 对象，校验字段合法性；非法返回 null */
export function parseAdvice(raw: string): ParsedAdvice | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as { action?: unknown; confidence?: unknown; reason?: unknown }
    const action = String(obj.action ?? '').toLowerCase()
    if (!['add', 'reduce', 'hold'].includes(action)) return null
    const confidence = Number(obj.confidence)
    const reason = String(obj.reason ?? '').trim()
    if (Number.isNaN(confidence) || !reason) return null
    return { action: action as 'add' | 'reduce' | 'hold', confidence: Math.max(0, Math.min(100, confidence)), reason, raw }
  } catch {
    return null
  }
}
