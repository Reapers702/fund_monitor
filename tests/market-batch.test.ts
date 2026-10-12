// 行情批量取价与缓存单测（P0 降请求量的核心契约）：
//   - N 只标的只发 1 次请求（东财 ulist 批量）
//   - 批量成功响应中缺席的标的记为负缓存，不再退化成逐只请求
//   - force=false 时命中缓存不再请求
//   - 超过 50 只分批请求
//   - 东财批量失败 → 腾讯批量降级（仍是一次请求）
// 注意：本文件不触发"连接级失败"（用 HTTP 500 而非 socket hang up），
// 否则会打开 market.ts 的 push2 熔断（进程级状态），影响后续用例。
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  httpGetJson: vi.fn(),
  httpGetText: vi.fn()
}))

vi.mock('../src/main/crawler/httpClient', () => ({
  httpGetJson: mocks.httpGetJson,
  httpGetText: mocks.httpGetText
}))

import { clearQuoteCache, prefetchQuotes, quoteBySecid } from '../src/main/crawler/market'

interface Row {
  secid: string
  price: number
  pct: number
  name?: string
}

/** 构造东财 ulist.np 响应（f2现价 f3涨跌幅 f12代码 f13市场 f14名称 …） */
function ulistPayload(rows: Row[]): { data: { diff: Record<string, unknown>[] } } {
  return {
    data: {
      diff: rows.map((r) => {
        const [mkt, code] = r.secid.split('.')
        return {
          f2: r.price,
          f3: r.pct,
          f4: 0.1,
          f5: 1234,
          f6: 5678,
          f12: code,
          f13: Number(mkt),
          f14: r.name ?? code,
          f15: r.price + 1,
          f16: r.price - 1,
          f17: r.price - 0.5,
          f18: r.price - 0.2
        }
      })
    }
  }
}

/** 构造腾讯批量响应（~ 分隔；1名称 3现价 4昨收 5今开 31涨跌额 32涨跌% 33最高 34最低 36量 37额） */
function tencentText(rows: { mktCode: string; name: string; price: number; pct: number }[]): string {
  return rows
    .map((r) => {
      const parts = new Array(38).fill('0')
      parts[1] = r.name
      parts[3] = String(r.price)
      parts[4] = String(r.price - 1)
      parts[5] = String(r.price - 0.5)
      parts[31] = '0.5'
      parts[32] = String(r.pct)
      parts[33] = String(r.price + 1)
      parts[34] = String(r.price - 1)
      parts[36] = '100'
      parts[37] = '200'
      return `v_${r.mktCode}="${parts.join('~')}";`
    })
    .join('\n')
}

beforeEach(() => {
  mocks.httpGetJson.mockReset()
  mocks.httpGetText.mockReset()
  clearQuoteCache()
})

describe('prefetchQuotes（批量取价）', () => {
  it('多只标的只发 1 次请求，随后逐只读取命中缓存', async () => {
    mocks.httpGetJson.mockResolvedValue(
      ulistPayload([
        { secid: '1.000300', price: 4287.98, pct: -0.68, name: '沪深300' },
        { secid: '1.600519', price: 1288.0, pct: 1.98, name: '贵州茅台' }
      ])
    )

    const filled = await prefetchQuotes(['1.000300', '1.600519'], { force: true })
    expect(filled).toBe(2)
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1) // 关键：2 只标的 = 1 次请求
    expect(String(mocks.httpGetJson.mock.calls[0][0])).toContain('secids=1.000300,1.600519')

    const q = await quoteBySecid('1.000300')
    expect(q.name).toBe('沪深300')
    expect(q.price).toBeCloseTo(4287.98, 4)
    expect(q.pct).toBeCloseTo(-0.68, 4)
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1) // 读缓存，未新增请求
  })

  it('批量响应中缺席的标的记为负缓存，不再退化成逐只请求', async () => {
    mocks.httpGetJson.mockResolvedValue(ulistPayload([{ secid: '1.000300', price: 4287.98, pct: -0.68 }]))

    await prefetchQuotes(['1.000300', '0.399006'], { force: true })
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1)

    await expect(quoteBySecid('0.399006')).rejects.toThrow(/无行情数据/)
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1) // 负缓存命中，没有补发单只请求
  })

  it('force=false 时命中缓存则完全不请求（缓存优先）', async () => {
    mocks.httpGetJson.mockResolvedValue(ulistPayload([{ secid: '1.000300', price: 4287.98, pct: -0.68 }]))

    await prefetchQuotes(['1.000300'], { force: true })
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1)

    const filled = await prefetchQuotes(['1.000300'], { force: false })
    expect(filled).toBe(0)
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1)
  })

  it('只补取未缓存的部分（部分命中时不整批重取）', async () => {
    mocks.httpGetJson.mockResolvedValue(ulistPayload([{ secid: '1.000300', price: 4287.98, pct: -0.68 }]))
    await prefetchQuotes(['1.000300'], { force: true })
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(1)

    mocks.httpGetJson.mockResolvedValue(ulistPayload([{ secid: '0.399006', price: 2963.82, pct: -2.61 }]))
    await prefetchQuotes(['1.000300', '0.399006'], { force: false })
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(2)
    // 第 2 次请求只带了未缓存的 0.399006
    expect(String(mocks.httpGetJson.mock.calls[1][0])).toContain('secids=0.399006')
    expect(String(mocks.httpGetJson.mock.calls[1][0])).not.toContain('1.000300')
  })

  it('超过 50 只时按每批 50 只分批请求', async () => {
    const secids = Array.from({ length: 51 }, (_, i) => `1.${600000 + i}`)
    mocks.httpGetJson.mockImplementation(async (url: string) => {
      const ids = new URL(url).searchParams.get('secids')!.split(',')
      return ulistPayload(ids.map((s) => ({ secid: s, price: 10, pct: 1 })))
    })

    await prefetchQuotes(secids, { force: true })
    expect(mocks.httpGetJson).toHaveBeenCalledTimes(2)
    const sizes = mocks.httpGetJson.mock.calls.map(
      (c) => new URL(String(c[0])).searchParams.get('secids')!.split(',').length
    )
    expect(sizes.sort((a, b) => b - a)).toEqual([50, 1])
  })

  it('东财批量返回空（疑似限流）视为失败，改走腾讯批量而不是写负缓存', async () => {
    mocks.httpGetJson.mockResolvedValue({ data: { diff: [] } })
    mocks.httpGetText.mockResolvedValue(tencentText([{ mktCode: 'sh600519', name: '贵州茅台', price: 1288, pct: 1.98 }]))

    const filled = await prefetchQuotes(['1.600519'], { force: true })
    expect(filled).toBe(1)
    expect(mocks.httpGetText).toHaveBeenCalledTimes(1)
    const q = await quoteBySecid('1.600519')
    expect(q.price).toBeCloseTo(1288, 4)
    expect(q.pct).toBeCloseTo(1.98, 4)
  })
})
