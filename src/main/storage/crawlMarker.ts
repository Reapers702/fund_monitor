// 抓取标记（crawl_marker 表）：记录"某个抓取动作上次发生的时间"。
//
// 用途：给"低频但需要按周期刷新"的数据做节流判断。典型场景——重仓股（`fetch.jjcc`）季度才披露，
// 但页面不必每天重抓，应按 fetcher.holdingsRefreshDays 周期刷新；而判断依据必须是**抓取时间**，
// 不能用 fund_holdings 的报告期（季末日期，可能已过数月），也不能只看"表里有没有行"
// （纯债基解析结果可能为 0 行，会导致每轮都重抓）。
import type { Pool } from 'pg'

/** 读取标记时间（epoch ms）；不存在返回 null */
export async function getMarker(pool: Pool, marker: string): Promise<number | null> {
  const r = await pool.query<{ at: Date | null }>(`SELECT at FROM crawl_marker WHERE marker = $1`, [marker])
  const at = r.rows[0]?.at
  return at ? at.getTime() : null
}

/** 写入/刷新标记为当前时间 */
export async function setMarker(pool: Pool, marker: string): Promise<void> {
  await pool.query(
    `INSERT INTO crawl_marker (marker, at) VALUES ($1, now())
     ON CONFLICT (marker) DO UPDATE SET at = now()`,
    [marker]
  )
}

/** 批量读取标记（marker → epoch ms）；未设置的键不出现在结果里。
 *  用于一次拿到上百个标的的节流状态，避免逐个查询 */
export async function getMarkers(pool: Pool, markers: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (markers.length === 0) return out
  const r = await pool.query<{ marker: string; at: Date }>(
    `SELECT marker, at FROM crawl_marker WHERE marker = ANY($1::text[])`,
    [markers]
  )
  for (const row of r.rows) out.set(row.marker, row.at.getTime())
  return out
}

/** 批量写入/刷新标记（单条语句 unnest，避免逐条 upsert） */
export async function setMarkers(pool: Pool, markers: string[]): Promise<void> {
  if (markers.length === 0) return
  await pool.query(
    `INSERT INTO crawl_marker (marker, at)
     SELECT unnest($1::text[]), now()
     ON CONFLICT (marker) DO UPDATE SET at = now()`,
    [markers]
  )
}

/** 距上次标记经过的天数；无标记返回 Infinity（视为"从未抓过"） */
export async function markerAgeDays(pool: Pool, marker: string): Promise<number> {
  const at = await getMarker(pool, marker)
  if (at === null) return Infinity
  return (Date.now() - at) / 86_400_000
}
