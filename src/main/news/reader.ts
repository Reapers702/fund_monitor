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
  /**
   * 仅 recentNewsForFunds 填充：'match'=与基金/重仓股相关，'market'=降级取的大盘环境新闻。
   * 让调用方能告诉模型"这条是行业信息还是宏观背景"，避免把大盘新闻误读成该基金的消息。
   */
  relevance?: 'match' | 'market'
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

/**
 * 为一只基金挑相关新闻（AI 分析选材）。
 *
 * 为什么不用 newsByTags 直接取：实测（scripts/diagnose-prompt-data.mjs --hits）
 * 直接用"基金名+前8重仓股"过滤 + 按时间倒序取 10 条，会拿到三类废数据：
 *   1) 时效过期——全库命中几百条但近 7 天只命中个位数，返回的"最新 8 条"可能是
 *      三周乃至一个月前的新闻，而 prompt 里从未告诉模型这些新闻有多旧；
 *   2) 噪音——raw_news 中大量条目标题为空、摘要为空（近 7 天约 93% 无 LLM 增强），
 *      匹配上也只能渲染成"- [未知情绪] "一行空壳；
 *   3) 主题漂移——宽基基金（如沪深300联接）会匹配到一堆与它无关的泛泛新闻。
 *
 * 因此这里按"时效优先 + 可用性驱动降级 + 大盘背景兜底"选材：
 *   - days 天内的命中先留着；若其中"可用"（有摘要或有情绪）的不足 minMatch 条，
 *     放宽到 30 天再找；
 *   - 仍然不足 → 用最近 hours 小时的大盘新闻补足，并标记 relevance='market'。
 *     对 AI 而言"今天的大盘环境"比"一个月前的一行空壳"更有决策价值；
 *   - 排序把"有摘要/有标题"的排前面，因为调用方只截取前 N 条。
 *
 * tags 需由调用方过滤空串（空串会匹配一切）。
 */
export async function recentNewsForFunds(
  pool: Pool,
  opts: { tags: string[]; minMatch?: number; days?: number; hours?: number; limit?: number }
): Promise<NewsRow[]> {
  const tags = opts.tags.filter((t) => t.trim() !== '')
  const minMatch = opts.minMatch ?? 3
  const days = opts.days ?? 10
  const hours = opts.hours ?? 24
  const limit = opts.limit ?? 12

  // 已按 pub_time DESC 取出，后续只在应用层排序，避免重复查库
  const matched = tags.length === 0 ? [] : await newsByTags(pool, tags, limit * 4)

  const within = (rows: NewsRow[], d: number): NewsRow[] =>
    rows.filter((r) => r.pubTime !== null && r.pubTime.getTime() >= Date.now() - d * 86400000)

  let picked = within(matched, days)
  if (usableCount(picked) < minMatch) {
    const wide = within(matched, 30)
    if (usableCount(wide) > usableCount(picked)) picked = wide
  }

  const mine = rankByUsability(picked).slice(0, limit).map((r): NewsRow => ({ ...r, relevance: 'match' }))

  // 兜底：行业新闻质量不足时，补充当下大盘环境（明确标记来源，避免被误读为该基金的消息）
  if (usableCount(mine) < minMatch) {
    const market = rankByUsability(await recentNewsSince(pool, hours, limit))
      .filter((m) => m.title !== null && m.title.trim() !== '')
      .slice(0, Math.max(0, Math.min(4, limit - mine.length)))
      .map((r): NewsRow => ({ ...r, relevance: 'market' }))
    return [...mine, ...market]
  }
  return mine
}

/** 可用 = 有摘要 或 有情绪标注；只有标题的行对模型几乎无信息量 */
function usableCount(rows: NewsRow[]): number {
  return rows.filter((r) => (r.summary && r.summary.trim() !== '') || r.sentiment !== null).length
}

/**
 * 新闻可用性排序（内容质量 + 时效衰减的综合得分，小的排前）。
 *
 * 不能只按"有无摘要"分层：实测（110020）一条 20 天前、有摘要的报道会压过今天
 * 没摘要的资金流向，而调用方只截取前 N 条——模型就看不到最近发生了什么。
 * 也不能只按时间：raw_news 里大量无摘要空壳会顶掉真正有内容的条目。
 * 因此质量给基础分、天数给衰减项：同一天内"有摘要 > 只有标题 > 空壳"，
 * 但每旧 5 天让出一档质量优势（20 天前的有摘要 ≈ 今天无摘要）。
 */
function rankByUsability(rows: NewsRow[]): NewsRow[] {
  const quality = (r: NewsRow): number => (r.summary && r.summary.trim() !== '' ? 0 : r.title && r.title.trim() !== '' ? 3 : 6)
  const staleness = (r: NewsRow): number =>
    r.pubTime === null ? 0 : Math.max(0, (Date.now() - r.pubTime.getTime()) / 86400000) / 5
  const score = (r: NewsRow): number => quality(r) + staleness(r)
  return [...rows].sort((a, b) => score(a) - score(b))
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
