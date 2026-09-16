// 新闻只读访问（计划书 M4 调整：不抓取，仅读 ai_fund 库 raw_news 表）
// 数据由另一个 24h 程序采集并已完成 LLM 增强（summary/sentiment/llm_tags 字段），本应用只读消费。
import type { Pool } from 'pg'

export interface NewsRow {
  id: string
  title: string | null
  content: string | null
  pubTime: Date | null
  source: string | null
  tags: string[]
  summary: string | null
  sentiment: string | null
  llmTags: string[]
}

type NewsQueryRow = {
  id: string
  title: string | null
  content: string | null
  pub_time: Date | null
  source: string | null
  tags: string | null
  summary: string | null
  sentiment: string | null
  llm_tags: string | null
}

const NEWS_COLUMNS = `id, title, content, pub_time, source, tags::text AS tags,
        summary, sentiment, llm_tags::text AS llm_tags`

function mapRow(row: NewsQueryRow): NewsRow {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    pubTime: row.pub_time,
    source: row.source,
    tags: safeJsonArr(row.tags),
    summary: row.summary,
    sentiment: row.sentiment,
    llmTags: safeJsonArr(row.llm_tags)
  }
}

/** 拉取最新 N 条新闻（pub_time 倒序） */
export async function recentNews(pool: Pool, limit = 50): Promise<NewsRow[]> {
  const r = await pool.query<NewsQueryRow>(
    `SELECT ${NEWS_COLUMNS} FROM raw_news ORDER BY pub_time DESC LIMIT $1`,
    [limit]
  )
  return r.rows.map(mapRow)
}

/** 拉取时间窗内的新闻（pub_time 倒序）。
 *  提醒类场景必须按时间取而不是按条数：raw_news 高峰约 30 条/小时，取"最新 120 条"只覆盖约 4 小时，
 *  盘后（19 点后）检查会漏掉当天早间的负面新闻。 */
export async function recentNewsSince(pool: Pool, hours: number, limit = 500): Promise<NewsRow[]> {
  const r = await pool.query<NewsQueryRow>(
    `SELECT ${NEWS_COLUMNS} FROM raw_news
     WHERE pub_time > now() - make_interval(hours => $1)
     ORDER BY pub_time DESC
     LIMIT $2`,
    [hours, limit]
  )
  return r.rows.map(mapRow)
}

/** 按主题/标签过滤的新闻（M6 AI 分析选材用）；tags 任一命中即可 */
export async function newsByTags(pool: Pool, tags: string[], limit = 20): Promise<NewsRow[]> {
  if (tags.length === 0) return recentNews(pool, limit)
  const r = await pool.query<NewsQueryRow>(
    `SELECT ${NEWS_COLUMNS} FROM raw_news
     WHERE llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)
     ORDER BY pub_time DESC
     LIMIT $3`,
    [tags, tags.map((t) => `%${t}%`), limit]
  )
  return r.rows.map(mapRow)
}

/** 统计信息：总条数 / 最新时间（--news 校验用） */
export async function newsStats(pool: Pool): Promise<{ count: number; latest: Date | null }> {
  const r = await pool.query<{ c: string; t: Date | null }>(
    `SELECT count(*)::text AS c, max(pub_time) AS t FROM raw_news`
  )
  return { count: Number(r.rows[0]?.c ?? 0), latest: r.rows[0]?.t ?? null }
}

function safeJsonArr(v: string | null): string[] {
  if (!v) return []
  try {
    const arr = JSON.parse(v)
    return Array.isArray(arr) ? arr.map(String) : []
  } catch {
    return []
  }
}
