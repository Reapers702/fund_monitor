// parseAdvice 单测：LLM 输出解析的健壮性
import { describe, it, expect } from 'vitest'
import { parseAdvice } from '../src/main/analyzer/parse'

describe('parseAdvice', () => {
  it('解析标准 JSON', () => {
    const r = parseAdvice('{"action":"add","confidence":78,"reason":"近期指数走强，重仓股普涨"}')
    expect(r).toEqual({
      action: 'add',
      confidence: 78,
      reason: '近期指数走强，重仓股普涨',
      suggestedPct: null, // 该输出未给建议仓位
      raw: '{"action":"add","confidence":78,"reason":"近期指数走强，重仓股普涨"}'
    })
  })

  it('解析 markdown 代码围栏包裹', () => {
    const r = parseAdvice('```json\n{"action":"reduce","confidence":55,"reason":"估值偏高"}\n```')
    expect(r?.action).toBe('reduce')
    expect(r?.confidence).toBe(55)
  })

  it('解析前后带多余文字', () => {
    const r = parseAdvice('分析结果如下：{"action":"hold","confidence":60,"reason":"震荡观望"} 仅供参考')
    expect(r?.action).toBe('hold')
    expect(r?.confidence).toBe(60)
  })

  it('confidence 越界时收敛到 0-100', () => {
    const r = parseAdvice('{"action":"add","confidence":150,"reason":"x"}')
    expect(r?.confidence).toBe(100)
    const r2 = parseAdvice('{"action":"add","confidence":-10,"reason":"x"}')
    expect(r2?.confidence).toBe(0)
  })

  it('非法 action 返回 null', () => {
    expect(parseAdvice('{"action":"sell","confidence":50,"reason":"x"}')).toBeNull()
    expect(parseAdvice('{"action":"BUY","confidence":50,"reason":"x"}')).toBeNull()
  })

  it('非 JSON 返回 null', () => {
    expect(parseAdvice('出错了')).toBeNull()
    expect(parseAdvice('')).toBeNull()
  })

  it('空 reason 返回 null', () => {
    expect(parseAdvice('{"action":"add","confidence":50,"reason":""}')).toBeNull()
    expect(parseAdvice('{"action":"add","confidence":50}')).toBeNull()
  })

  it('confidence 非数字返回 null', () => {
    expect(parseAdvice('{"action":"add","confidence":"高","reason":"x"}')).toBeNull()
  })

  it('suggestedPct：解析 0~100 的数字，越界裁剪、保留两位', () => {
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":25}')?.suggestedPct).toBe(25)
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":33.333}')?.suggestedPct).toBe(33.33)
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":150}')?.suggestedPct).toBe(100)
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":-5}')?.suggestedPct).toBe(0)
  })

  it('suggestedPct 缺失/为 null/非数字 → null，且不影响整条建议成立', () => {
    // 老 prompt 没有该字段：必须容错，否则历史/其他模型的输出会被整体判非法
    const noField = parseAdvice('{"action":"add","confidence":70,"reason":"x"}')
    expect(noField).not.toBeNull()
    expect(noField?.suggestedPct).toBeNull()

    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":null}')?.suggestedPct).toBeNull()
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":"高"}')?.suggestedPct).toBeNull()
    expect(parseAdvice('{"action":"add","confidence":70,"reason":"x","suggestedPct":""}')?.suggestedPct).toBeNull()
  })
})
