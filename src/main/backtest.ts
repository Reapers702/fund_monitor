// 推荐可信度回溯测试（一次性的评估工具，不作为运行时调度的一部分）
//
// 目标：评估"系统 AI 推荐对后续走势的方向判断靠不靠谱"。
// 方法：复用生产 analyzer 完全相同的 prompt 组装链（SYSTEM_PROMPT / buildUserPrompt /
//       buildTimeContext / parseAdvice / chatComplete），只是把取数换成"截至采样日 T 收盘"
//       （asof）的截断数据——即站在当时 15:35 盘后分析的视角，绝不给 T 之后的信息（无前视偏差）。
// 用 DeepSeek 对过去若干个交易日各给出建议，对比 T+1 / T+5 的真实净值涨跌与相对沪深300超额。
//
// 口径（与用户确认）：
//   - 盘后视角：采样日 T 拥有 T 及之前全部净值 + T 日当日涨跌 + 当时新闻 + 当时季报重仓股；
//   - 不带持仓：AI 仅基于净值/重仓股/新闻判断（避免把"现在才有"的持仓成本当成当时信息）；
//   - 对比 T+1 和 T+5 两个未来窗口；
//   - 不改写 ds_advice（回测结果只输出，不污染 43 条真实历史建议）。
import type { Pool } from 'pg'
import { computeFundMetrics, computeRelativeStrength, formatMetricsBlock } from './analyzer/metrics'
import type { NavLike } from './analyzer/metrics'
import { SYSTEM_PROMPT, buildUserPrompt, buildTimeContext, formatTimeContext } from './analyzer/analyze'
import { parseAdvice } from './analyzer/parse'
import { chatComplete, hasDeepseekKey } from './llm/deepseek'
import { loadConfig } from './config'
import { createPool, createAiFundPool } from './storage/db'
import type { NavPoint, EstPoint, HoldingWithStock } from './storage/queries'
import { loadBenchmarkNav, BENCHMARK_NAME } from './crawler/benchmark'

const CN: Record<string, string> = { add: '加仓', reduce: '减仓', hold: '持有' }

function dateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function todayISO(): string {
  return dateOnly(new Date())
}

function addDays(iso: string, n: number): string {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return dateOnly(d)
}

// ---------- asof（截至采样日收盘）取数 ----------

/** 净值：截至 asof 当日（含）升序，最多 limit 条 */
async function navUpTo(pool: Pool, code: string, asof: string, limit: number): Promise<NavPoint[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string; jzzzl: string | null }>(
    `SELECT trade_date, dwjz, jzzzl FROM fund_nav_daily
     WHERE fund_code = $1 AND trade_date <= $2
     ORDER BY trade_date DESC LIMIT $3`,
    [code, asof, limit]
  )
  return r.rows
    .reverse()
    .map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz), changePct: x.jzzzl === null ? null : Number(x.jzzzl) }))
}

/** 完整升序净值日期（评估未来窗口用） */
async function navDatesAll(pool: Pool, code: string): Promise<{ date: string; nav: number }[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string }>(
    `SELECT trade_date, dwjz FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date ASC`,
    [code]
  )
  return r.rows.map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz) }))
}

/** 基金基础信息（无时间维度，直接用） */
async function basic(pool: Pool, code: string): Promise<{ name: string } | null> {
  const r = await pool.query<{ fund_name: string }>(
    `SELECT fund_name FROM fund_basic WHERE fund_code = $1`,
    [code]
  )
  const x = r.rows[0]
  return x ? { name: x.fund_name } : null
}

/** 季度持仓：报告期 <= asof 的最新一期；每只重仓股近10日(<=asof)表现 */
async function holdingsUpTo(pool: Pool, code: string, asof: string): Promise<{ reportDate: string | null; rows: HoldingWithStock[] }> {
  const r = await pool.query<{ report_date: Date; rank: number; stock_code: string | null; stock_name: string | null; weight: string | null }>(
    `SELECT report_date, rank, stock_code, stock_name, weight FROM fund_holdings
     WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1 AND report_date <= $2)
     ORDER BY rank`,
    [code, asof]
  )
  if (r.rows.length === 0) return { reportDate: null, rows: [] }
  const reportDate = dateOnly(r.rows[0].report_date)
  const rows: HoldingWithStock[] = []
  for (const row of r.rows) {
    if (!row.stock_code) {
      rows.push({ rank: row.rank, stockCode: null, stockName: row.stock_name, weight: row.weight === null ? null : Number(row.weight), lastClose: null, lastPct: null, klineCount: 0 })
      continue
    }
    const k = await pool.query<{ close: string }>(
      `SELECT close FROM stock_daily WHERE stock_code = $1 AND trade_date <= $2 ORDER BY trade_date DESC LIMIT 10`,
      [row.stock_code, asof]
    )
    const closes = k.rows.map((x) => Number(x.close))
    const klineCount = closes.length
    const lastPct = klineCount >= 2 && closes[0] !== 0 ? ((closes[0] - closes[closes.length - 1]) / closes[closes.length - 1]) * 100 : null
    rows.push({
      rank: row.rank,
      stockCode: row.stock_code,
      stockName: row.stock_name,
      weight: row.weight === null ? null : Number(row.weight),
      lastClose: closes[0] ?? null,
      lastPct,
      klineCount
    })
  }
  return { reportDate, rows }
}

/** 相关新闻：截至 asof 当日 15:40（模拟当时 15:35 分析可见的全部当日新闻，含盘中） */
async function newsUpTo(pool: Pool, tags: string[], asof: string, limit = 10): Promise<{ title: string | null; summary: string | null; sentiment: string | null; llmTags: string[] }[]> {
  if (tags.length === 0) return []
  const asofAt = new Date(asof + 'T15:40:00')
  const r = await pool.query<{ title: string | null; summary: string | null; sentiment: string | null; llm_tags: string | null }>(
    `SELECT title, summary, sentiment, llm_tags::text AS llm_tags FROM raw_news
     WHERE (llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)) AND pub_time <= $3
     ORDER BY pub_time DESC LIMIT $4`,
    [tags, tags.map((t) => `%${t}%`), asofAt, limit]
  )
  return r.rows.map((x) => ({
    title: x.title,
    summary: x.summary,
    sentiment: x.sentiment,
    llmTags: (() => { try { const a = JSON.parse(x.llm_tags ?? '[]'); return Array.isArray(a) ? a.map(String) : [] } catch { return [] } })()
  }))
}

// ---------- 采样日选择 ----------

/** 在过去 recentDays 自然日内、所有基金均有净值、且每只其后至少留有 horizon+1 个净值日的日期里均匀抽 count 个 */
function pickSampleDates(funds: Map<string, { date: string; nav: number }[]>, recentDays: number, count: number, horizon = 5): string[] {
  const today = todayISO()
  const floor = addDays(today, -recentDays)
  // 每一只基金 "在该日有净值 && 其后至少 horizon 个净值日"
  const dateSet = new Map<string, boolean>()
  for (const [, seq] of funds) {
    const idx = new Map(seq.map((p, i) => [p.date, i]))
    for (const p of seq) {
      const d = p.date
      if (d < floor || d > today) continue
      if (!idx.has(d)) continue
      const i = idx.get(d)!
      if (i + horizon >= seq.length) continue // 未来窗口不足
      dateSet.set(d, (dateSet.get(d) ?? true) && true)
    }
  }
  // 只保留所有基金都满足的日期
  const ok = [...dateSet.keys()].filter((d) => {
    for (const [, seq] of funds) {
      const seqDates = new Set(seq.map((p) => p.date))
      const i = seq.findIndex((p) => p.date === d)
      if (i < 0 || !seqDates.has(d) || i + horizon >= seq.length) return false
    }
    return true
  }).sort()
  if (ok.length === 0) return []
  const take = Math.min(count, ok.length)
  if (take >= ok.length) return ok
  const out: string[] = []
  for (let k = 0; k < take; k++) out.push(ok[Math.round((k * (ok.length - 1)) / (take - 1))])
  return out
}

// ---------- 单日决策 ----------

interface Decision {
  code: string
  name: string
  asof: string
  action: string
  confidence: number
  reason: string
  suggestedPct: number | null
}

async function decide(ctx: { pool: Pool; aiFundPool: Pool }, code: string, name: string, asof: string, benchByDate: Map<string, number> | null): Promise<Decision> {
  const nav = await navUpTo(ctx.pool, code, asof, 120)
  const holdings = await holdingsUpTo(ctx.pool, code, asof)
  const stockNames = holdings.rows.map((h) => h.stockName).filter((s): s is string => Boolean(s)).slice(0, 8)
  const fundKeywords = [name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)]
  const news = await newsUpTo(ctx.aiFundPool, [...fundKeywords, ...stockNames], asof, 10)

  // 时点上下文：模拟采样日 15:35 盘后视角（最新净值=当日收盘确认值）
  const timeCtx = formatTimeContext(buildTimeContext(new Date(asof + 'T15:35:00'), asof, true))

  // 量化指标（仅用截至 asof 的净值；基准同样截到 asof，避免未来基准算超额）
  let metricsBlock: string | null = null
  try {
    const fundMetrics = computeFundMetrics(nav)
    let bench: NavLike[] | null = null
    if (benchByDate) {
      bench = [...benchByDate.entries()].filter(([d]) => d <= asof).sort().map(([date, nav0]) => ({ date, nav: nav0 }))
    }
    const rs = bench ? computeRelativeStrength(nav, bench, [20, 60], BENCHMARK_NAME) : null
    metricsBlock = formatMetricsBlock(fundMetrics, rs)
  } catch (e) {
    metricsBlock = null
  }

  const userPrompt = buildUserPrompt({
    fundName: name,
    code,
    nav,
    holdings,
    news,
    position: null, // 回测口径：不带持仓，避免把现在才有的持仓当成当时信息
    timeCtx,
    estimate: [] as EstPoint[], // 库中无对应采样日的历史盘中估值（盘后视角）
    metricsBlock,
    portfolioBlock: null, // 回测口径：不加载组合上下文（依赖当前持仓市值）
    ruleBlock: null // 回测口径：不注入规则分（回测检验的是 LLM 基线，规则分另有 --rules-backtest）
  })

  const raw = await chatComplete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userPrompt }
    ],
    { temperature: 0.3, maxTokens: 2000 } // 思考型模型 reasoning 亦占额度，与 analyze 口径保持一致
  )
  const parsed = parseAdvice(raw)
  if (!parsed) throw new Error(`LLM 解析失败: ${raw.slice(0, 150)}`)
  return { code, name, asof, action: parsed.action, confidence: parsed.confidence, reason: parsed.reason, suggestedPct: parsed.suggestedPct }
}

// ---------- 主流程 ----------

export async function runBacktest(codesOverride?: string[], count = 5, recentDays = 30): Promise<number> {
  if (!hasDeepseekKey()) {
    console.error('未配置 DeepSeek API Key，无法评估（.env: DEEPSEEK_API_KEY）')
    return 2
  }
  const cfg = loadConfig()
  const pool = createPool(cfg)
  const aiFundPool = createAiFundPool(cfg)
  try {
    // 待评估基金：未指定则取当前用户活跃自选（guanxin）
    let codes = codesOverride ?? null
    if (!codes) {
      const r = await pool.query<{ fund_code: string }>(
        `SELECT f.fund_code FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
         WHERE uf.user_id = $1 AND uf.is_active = 1 ORDER BY f.fund_code`,
        [cfg.currentUserId]
      )
      codes = r.rows.map((x) => x.fund_code)
    }

    // 预取各基金完整净值（评估未来窗口 + 采样日选择）
    const navMaps = new Map<string, { date: string; nav: number }[]>()
    const names = new Map<string, string>()
    for (const code of codes) {
      const [b, seq] = await Promise.all([basic(pool, code), navDatesAll(pool, code)])
      if (!b) { console.error(`[backtest] ${code} 无 fund_basic，跳过`); continue }
      navMaps.set(code, seq)
      names.set(code, b.name)
    }
    const evalCodes = [...navMaps.keys()]
    if (evalCodes.length === 0) { console.error('没有可评估的基金'); return 1 }

    const sampleDates = pickSampleDates(navMaps, recentDays, count)
    if (sampleDates.length === 0) { console.error('过去30天没有满足未来窗口的采样日'); return 1 }

    // 基准沪深300（相对超额用）
    const benchNav = await loadBenchmarkNav()
    const benchByDate = new Map(benchNav ? benchNav.map((p) => [p.date, p.nav]) : [])

    console.log('\n' + '='.repeat(100))
    console.log('基金 AI 推荐 · 可信度回溯评估（盘后视角，无前视偏差）')
    console.log('='.repeat(100))
    console.log('评估口径：复用生产 analyzer 同一套 prompt；采样日 T 只见 T 及之前信息；')
    console.log('基准入场 = T 日收盘净值；T+1/T+5 = 之后第 1/5 个交易日净值相对 T 的涨跌。')
    console.log(`采样日（${sampleDates.length} 个交易日）: ${sampleDates.join(', ')}`)
    console.log(`相对基准：${BENCHMARK_NAME} 同期涨跌（超额 = 基金 − 基准）。`)
    console.log('判定：加仓(add) 期望后续涨、减仓(reduce) 期望后续跌（上调仓方向正确）；持有(hold) 中性不计方向。')
    console.log('-' .repeat(100))

    interface Row {
      code: string; name: string; asof: string; action: string; conf: number; reason: string
      ret1: number | null; ret5: number | null; bench5: number | null; excess5: number | null
      hit5: boolean | null
    }
    const rows: Row[] = []

    for (const asof of sampleDates) {
      for (const code of evalCodes) {
        const seq = navMaps.get(code)!
        const i = seq.findIndex((p) => p.date === asof)
        if (i < 0) continue // 该基金当天无净值（不同基金成立日/净值缺失），跳过
        try {
          const d = await decide({ pool, aiFundPool }, code, names.get(code)!, asof, benchByDate)
          const navT = seq[i].nav
          const navT1 = seq[i + 1]?.nav
          const navT5 = seq[i + 5]?.nav
          const ret1 = navT > 0 && navT1 !== undefined ? ((navT1 - navT) / navT) * 100 : null
          const ret5 = navT > 0 && navT5 !== undefined ? ((navT5 - navT) / navT) * 100 : null
          let bench5: number | null = null
          if (ret5 !== null && benchByDate.size > 0) {
            const b = benchByDate.get(asof)
            const bi = benchNav ? benchNav.findIndex((p) => p.date === asof) : -1
            const b5 = bi >= 0 ? benchNav![bi + 5]?.nav : undefined
            if (b && b5 !== undefined && b > 0) bench5 = ((b5 - b) / b) * 100
          }
          const excess5 = ret5 !== null && bench5 !== null ? ret5 - bench5 : null
          const hit5 = d.action === 'add' ? (ret5 !== null ? ret5 > 0 : null)
            : d.action === 'reduce' ? (ret5 !== null ? ret5 < 0 : null)
            : null
          rows.push({ code, name: names.get(code)!, asof, action: d.action, conf: d.confidence, reason: d.reason, ret1, ret5, bench5, excess5, hit5 })
          console.log(`[${asof}] ${code} ${names.get(code)} → ${CN[d.action]}（置信 ${d.confidence}）T+1=${ret1 === null ? '--' : ret1.toFixed(2) + '%'} | T+5=${ret5 === null ? '--' : ret5.toFixed(2) + '%'}（基准 ${bench5 === null ? '--' : bench5.toFixed(2) + '%'}，超额 ${excess5 === null ? '--' : excess5.toFixed(2) + '%'}）`)
          console.log(`       ${d.reason}`)
        } catch (e) {
          console.error(`  [${asof}] ${code} 评估失败: ${(e as Error).message}`)
        }
      }
    }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(100))
    console.log('汇总评估')
    console.log('='.repeat(100))
    if (rows.length === 0) { console.log('没有产生任何样本（可能 DeepSeek 调用全部失败）'); return 1 }

    const avg = (arr: (number | null)[]) => {
      const v = arr.filter((x): x is number => x !== null)
      if (v.length === 0) return null
      return v.reduce((a, b) => a + b, 0) / v.length
    }
    const pctArr = (arr: (number | null)[]) => arr.map((x) => x === null ? '--' : `${x >= 0 ? '+' : ''}${x.toFixed(2)}%`).join(' / ')

    const byAction = (a: string) => rows.filter((r) => r.action === a)
    for (const a of ['add', 'reduce', 'hold']) {
      const grp = byAction(a)
      if (grp.length === 0) continue
      const hit = grp.filter((r) => r.hit5 === true).length
      const totalDir = grp.filter((r) => r.hit5 !== null).length
      console.log(`\n[${CN[a]}] ${grp.length} 次${grp.length > 1 ? '（方向命中率 ' + (totalDir ? Math.round((hit / totalDir) * 100) : '--') + '%）' : ''}`)
      console.log(`  平均 T+1 = ${avg(grp.map((r) => r.ret1)) === null ? '--' : (avg(grp.map((r) => r.ret1)) as number).toFixed(2) + '%'}`)
      console.log(`  平均 T+5 = ${avg(grp.map((r) => r.ret5)) === null ? '--' : (avg(grp.map((r) => r.ret5)) as number).toFixed(2) + '%'}  平均超额(T+5) = ${avg(grp.map((r) => r.excess5)) === null ? '--' : (avg(grp.map((r) => r.excess5)) as number).toFixed(2) + '%'}`)
      console.log(`  明细：${grp.map((r) => `${r.asof.slice(5)}:${r.ret5 === null ? '--' : r.ret5.toFixed(2) + '%'}`).join('  ')}`)
    }

    const dir = rows.filter((r) => r.hit5 !== null)
    const dirHit = dir.filter((r) => r.hit5 === true)
    console.log(`\n整体方向命中率（add 后涨 / reduce 后跌，T+5）：${dir.length ? Math.round((dirHit.length / dir.length) * 100) + '%' : '--'}（${dirHit.length}/${dir.length}）`)

    // 置信度分层：高置信(>=70) vs 低置信的方向命中率，看置信度是否真的更准
    const hi = dir.filter((r) => r.conf >= 70)
    const lo = dir.filter((r) => r.conf < 70)
    const hitRate = (g: Row[]) => (g.length ? Math.round((g.filter((r) => r.hit5 === true).length / g.length) * 100) : null)
    console.log(`置信度分层（T+5 方向命中率）：高置信(≥70) ${hitRate(hi) === null ? '--' : hitRate(hi) + '%'}（${hi.filter((r) => r.hit5 === true).length}/${hi.length}）｜低置信(<70) ${hitRate(lo) === null ? '--' : hitRate(lo) + '%'}（${lo.filter((r) => r.hit5 === true).length}/${lo.length}）`)

    // 每只基金维度
    console.log('\n按基金：')
    for (const code of evalCodes) {
      const g = rows.filter((r) => r.code === code)
      if (g.length === 0) continue
      console.log(`  ${code} ${names.get(code)}：${CN[g[0].action]}×${byAction(g[0].action).filter((r) => r.code === code).length}｜平均 T+5 = ${avg(g.map((r) => r.ret5)) === null ? '--' : (avg(g.map((r) => r.ret5)) as number).toFixed(2) + '%'}｜超额 = ${avg(g.map((r) => r.excess5)) === null ? '--' : (avg(g.map((r) => r.excess5)) as number).toFixed(2) + '%'}`)
    }

    // 样本明细全表
    console.log('\n完整样本（asof | 基金 | 建议 | 置信 | T+1 | T+5 | 基准T+5 | 超额T+5）：')
    for (const r of rows) {
      console.log(`  ${r.asof} | ${r.code} ${r.name} | ${CN[r.action]} | ${r.conf} | ${pctArr([r.ret1])} | ${pctArr([r.ret5])} | ${pctArr([r.bench5])} | ${pctArr([r.excess5])}`)
    }
    console.log('\n[结论] 上方汇总仅描述建议与后续真实走势的统计关系，不构成投资建议；样本小（每基金' + sampleDates.length + '日），参考时注意置信区间。')
    return 0
  } finally {
    await pool.end().catch(() => {})
    await aiFundPool.end().catch(() => {})
  }
}