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

/** 本地日期 YYYY-MM-DD（不要用 toISOString：UTC 会把东八区凌晨的日期整体前移一天） */
export function localDateStr(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const t = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(t.getTime())) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())}`
}

/** 本地时刻 HH:MM（提醒文案标注采样时间，避免把上午的采样当成实时值） */
export function localClockStr(d: Date | string | null | undefined): string | null {
  if (!d) return null
  const t = typeof d === 'string' ? new Date(d) : d
  if (Number.isNaN(t.getTime())) return null
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(t.getHours())}:${p(t.getMinutes())}`
}
