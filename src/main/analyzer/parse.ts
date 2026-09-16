// LLM 输出解析（纯函数，独立模块便于单测）
// 提取首个 JSON 对象，校验 action/confidence/reason 合法性

export interface ParsedAdvice {
  action: 'add' | 'reduce' | 'hold'
  confidence: number
  reason: string
  /** 建议该基金占整个基金组合的比例 %（模型未给出/无法判断时为 null，不影响建议本身） */
  suggestedPct: number | null
  raw: string
}

/**
 * 解析建议仓位：接受 0~100 的数字（越界裁剪），非数字/缺失/显式 null 返回 null。
 * 老 prompt 没有该字段，必须容错——缺字段不能导致整条建议被判为非法。
 */
function parseSuggestedPct(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(100, Math.round(n * 100) / 100))
}

/** 解析 LLM 输出：提取首个 JSON 对象，校验字段合法性；非法返回 null */
export function parseAdvice(raw: string): ParsedAdvice | null {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const obj = JSON.parse(m[0]) as { action?: unknown; confidence?: unknown; reason?: unknown; suggestedPct?: unknown }
    const action = String(obj.action ?? '').toLowerCase()
    if (!['add', 'reduce', 'hold'].includes(action)) return null
    const confidence = Number(obj.confidence)
    const reason = String(obj.reason ?? '').trim()
    if (Number.isNaN(confidence) || !reason) return null
    return {
      action: action as 'add' | 'reduce' | 'hold',
      confidence: Math.max(0, Math.min(100, confidence)),
      reason,
      suggestedPct: parseSuggestedPct(obj.suggestedPct),
      raw
    }
  } catch {
    return null
  }
}
