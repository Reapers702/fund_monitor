// 通用小工具
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 解析可能为空的数值字符串："1.8284" → 1.8284；""/null/undefined → null */
export function parseNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isNaN(n) ? null : n
}

/** 去掉东财数字字段中的千分位逗号："1,900.26" → "1900.26" */
export function stripThousand(s: unknown): string {
  return String(s ?? '').replace(/,/g, '')
}
