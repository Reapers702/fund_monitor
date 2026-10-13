// 日K 补拉决策（纯函数，独立便于单测）
//
// 背景（P1 修复）：原判断是"本地 stock_daily 里有没有最近交易日的行"——
// 而盘中实时价快照也会写进"当天"，于是盘前/盘中写进来的脏行会让日K 补拉被永久跳过，
// 快照的价格/成交量就留在日K 表里当收盘数据（实测：10-12 的行其实是 10-09 那根K线）。
//
// 现在只认"官方日K（source='kline'）"是否已覆盖"最近一个已收盘交易日"：
//   - 已覆盖 → have：该交易日K线已定型且入库，无需再拉
//   - 未覆盖 → 若距上次补拉不足 minIntervalMs（数据源当天K线还没更新时的兜底节流）→ throttled
//   - 否则 → fetch
export type KlineNeed = 'have' | 'throttled' | 'fetch'

export interface KlineNeedInput {
  /** 本地已有的官方日K最新日期（YYYY-MM-DD，source='kline'）；无则 null */
  latestKlineDate: string | null
  /** 最近一个已收盘交易日（其日K 应已定型） */
  latestClosed: string
  /** 上次成功补拉该股日K 的时间（epoch ms）；从未补过为 undefined */
  markerAt: number | undefined
  /** 当前时间（epoch ms） */
  now: number
  /** 同一标的两次补拉的最短间隔（ms） */
  minIntervalMs: number
}

export function decideKlineNeed(input: KlineNeedInput): KlineNeed {
  const { latestKlineDate, latestClosed, markerAt, now, minIntervalMs } = input
  if (latestKlineDate !== null && latestKlineDate >= latestClosed) return 'have'
  if (markerAt !== undefined && now - markerAt < minIntervalMs) return 'throttled'
  return 'fetch'
}

/** 只保留"已定型"的日K 行：数据源在盘中也会给出当天的部分K线，不能当收盘数据落库 */
export function filterFinalKlines<T extends { tradeDate: string }>(
  rows: T[],
  latestClosed: string
): T[] {
  return rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.tradeDate) && r.tradeDate <= latestClosed)
}
