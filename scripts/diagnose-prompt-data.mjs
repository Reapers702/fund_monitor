/**
 * AI 预测数据体检工具（自包含，只读，不调用 LLM）。
 *
 * 为什么存在：AI 建议的质量完全取决于喂给它的数据。历史上"新闻过滤命中率极低 +
 * 93% 新闻缺情绪/摘要 + 估值分位等已入库数据未注入"这类问题，只能靠手工查库发现。
 * 本脚本把这些检查固化成一条命令，便于改动前后对比、定期体检。
 *
 * 用法：
 *   node scripts/diagnose-prompt-data.mjs             # 全量体检（新闻健康 + 命中率 + prompt 快照）
 *   node scripts/diagnose-prompt-data.mjs --news      # 只看 raw_news 数据健康度
 *   node scripts/diagnose-prompt-data.mjs --hits      # 只看各基金新闻命中率
 *   node scripts/diagnose-prompt-data.mjs --prompt 161725 001550   # 渲染指定基金的真实 prompt
 *
 * 注意：prompt 渲染部分是以下线上逻辑的镜像实现，改了任一处请同步这里
 * （全脚本搜索 "镜像自" 可定位全部镜像点）：
 *   - src/main/analyzer/analyze.ts  （块拼接、新闻时效标签、净值/持仓/新闻行格式）
 *   - src/main/analyzer/metrics.ts  （量化指标与超额）
 *   - src/main/analyzer/valuation.ts（板块估值分位匹配与格式化）
 *   - src/main/news/reader.ts       （recentNewsForFunds 选材与排序）
 * 仅执行 SELECT，绝不写库。
 */
import { Pool } from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const envFile = join(root, '.env')
if (!existsSync(envFile)) {
  console.error('缺少 .env（含 PG_* 配置），请先创建。')
  process.exit(1)
}
const env = {}
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}
const need = (k) => {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`)
    process.exit(1)
  }
}
need('PG_USER')
need('PG_HOST')
need('PG_PORT')

const poolOf = (database) =>
  new Pool({
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    host: env.PG_HOST,
    port: Number(env.PG_PORT),
    database
  })
const fundPool = poolOf(env.PG_DB || 'fund_monitor')
const newsPool = poolOf(env.AI_FUND_DB || 'ai_fund')

async function show(label, sql, params = []) {
  console.log(`\n===== ${label} =====`)
  try {
    const r = await fundPool.query(sql, params)
    console.table(r.rows)
  } catch (e) {
    console.log('ERR: ' + e.message)
  }
}
async function showNews(label, sql, params = []) {
  console.log(`\n===== ${label} =====`)
  try {
    const r = await newsPool.query(sql, params)
    console.table(r.rows)
  } catch (e) {
    console.log('ERR: ' + e.message)
  }
}

// ---------- 1. raw_news 数据健康度 ----------
async function newsHealth() {
  await showNews(
    'raw_news 总量与时间跨度',
    `SELECT count(*)::int AS 总数, min(pub_time) AS 最早, max(pub_time) AS 最新 FROM raw_news`
  )
  await showNews(
    '近7天：AI 真正能用的字段覆盖率',
    `SELECT count(*)::int AS 总数,
      count(*) FILTER (WHERE title IS NOT NULL AND title <> '')::int AS 有标题,
      count(*) FILTER (WHERE summary IS NOT NULL)::int AS 有摘要,
      count(*) FILTER (WHERE sentiment IS NOT NULL)::int AS 有情绪,
      count(*) FILTER (WHERE llm_tags <> '[]'::jsonb)::int AS 有llm标签,
      round(100.0 * count(*) FILTER (WHERE summary IS NOT NULL) / greatest(count(*), 1), 1) AS 摘要覆盖率百分比
     FROM raw_news WHERE pub_time > now() - interval '7 days'`
  )
  await showNews(
    '近7天：情绪取值分布',
    `SELECT coalesce(sentiment, '(null 未标注)') AS 情绪, count(*)::int AS 条数
     FROM raw_news WHERE pub_time > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC`
  )
  await showNews(
    '近7天：数据来源分布',
    `SELECT coalesce(source, '(null)') AS 来源, count(*)::int AS 条数
     FROM raw_news WHERE pub_time > now() - interval '7 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 10`
  )
  await showNews(
    '近7天：按天分布',
    `SELECT pub_time::date AS 日期, count(*)::int AS 条数,
      count(*) FILTER (WHERE summary IS NOT NULL)::int AS 有摘要
     FROM raw_news WHERE pub_time > now() - interval '7 days' GROUP BY 1 ORDER BY 1 DESC`
  )
  await showNews(
    '库时区（判断时效窗口口径）',
    `SELECT current_setting('TimeZone') AS 时区, now() AS now_带时区, now()::timestamp AS now_无时区`
  )
  await showNews(
    '最新 8 条样本（看标题/摘要/情绪是否可用）',
    `SELECT pub_time, source, coalesce(sentiment, '(null)') AS 情绪,
      coalesce(nullif(left(title, 40), ''), '(空标题)') AS 标题,
      left(coalesce(summary, ''), 50) AS 摘要
     FROM raw_news ORDER BY pub_time DESC LIMIT 8`
  )
}

// ---------- 2. 各基金新闻命中率 ----------
async function hitRates() {
  const funds = await fundPool.query(
    `SELECT uf.fund_code, fb.fund_name FROM user_fund uf
     JOIN fund_basic fb USING (fund_code) WHERE uf.is_active = 1 ORDER BY uf.fund_code`
  )
  console.log(
    '\n===== 各基金新闻命中率（复刻 analyze.ts 的过滤：llm_tags/tags ?| 关键词 OR title ILIKE）====='
  )
  const rows = []
  for (const f of funds.rows) {
    const fundKeyword = fundNameKeyword(f.fund_name)
    const h = await fundPool.query(
      `SELECT h.stock_name FROM fund_holdings h
       WHERE h.fund_code = $1
         AND h.report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
       ORDER BY h.rank LIMIT 8`,
      [f.fund_code]
    )
    const tags = [fundKeyword, ...h.rows.map((r) => r.stock_name).filter(Boolean)]
    const params = [tags, tags.map((t) => `%${t}%`)]
    const cnt = await newsPool.query(
      `SELECT count(*)::int AS 全库命中,
        count(*) FILTER (WHERE pub_time > now() - interval '7 days')::int AS 近7天命中,
        round(avg(CASE WHEN pub_time > now() - interval '7 days' THEN 1 ELSE 0 END) * 100, 1) AS 近7天占比
       FROM raw_news WHERE llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)`,
      params
    )
    const got = await newsPool.query(
      `SELECT pub_time, summary, sentiment FROM raw_news
       WHERE llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)
       ORDER BY pub_time DESC LIMIT 8`,
      params
    )
    const newest = got.rows[0]?.pub_time
    const ageDays = newest ? Math.round((Date.now() - newest.getTime()) / 86400000) : null
    rows.push({
      代码: f.fund_code,
      名称: f.fund_name.slice(0, 16),
      全库命中: cnt.rows[0].全库命中,
      近7天命中: cnt.rows[0].近7天命中,
      前8条有摘要: got.rows.filter((r) => r.summary).length,
      前8条有情绪: got.rows.filter((r) => r.sentiment).length,
      最新命中距今天数: ageDays
    })
  }
  console.table(rows)
  const zero = rows.filter((r) => r.近7天命中 === 0).length
  const stale = rows.filter((r) => (r.最新命中距今天数 ?? 999) > 7).length
  console.log(
    `\n近7天命中为 0 的基金：${zero}/${rows.length}；最新命中超过 7 天的基金：${stale}/${rows.length}`
  )
  console.log('提示：命中率低不一定只是新闻少——近7天 93% 新闻缺 llm_tags，只能靠标题关键词兜底。')
}

// ---------- 3. 真实 prompt 快照（镜像 analyze.ts / metrics.ts） ----------
function fundNameKeyword(name) {
  // 镜像自 analyze.ts：去尾缀后取前 6 字作为基金主题关键词
  return name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6)
}

/** 镜像自 analyze.ts newsAgeTag */
function newsAgeTag(pubTime) {
  const days = Math.max(0, Math.floor((Date.now() - pubTime.getTime()) / 86400000))
  if (days === 0) return '今天'
  if (days === 1) return '昨天'
  if (days <= 30) return `${days}天前`
  return '超一月'
}

/** 镜像自 src/main/analyzer/valuation.ts */
const THEME_INDEX = [
  ['白酒', '中证白酒'],
  ['食品饮料', '国证食品'],
  ['消费', '主要消费'],
  ['医药', '全指医药'],
  ['医疗', '中证医疗'],
  ['生物', '全指医药'],
  ['银行', '中证银行'],
  ['证券', '证券公司'],
  ['非银', '证券公司'],
  ['保险', '证券公司'],
  ['军工', '中证军工'],
  ['国防', '中证军工'],
  ['半导体', '中证电子'],
  ['芯片', '中证电子'],
  ['电子', '中证电子'],
  ['科技', '科技龙头'],
  ['信息', '全指信息'],
  ['传媒', '中证传媒'],
  ['通信', '5G通讯'],
  ['5G', '5G通讯'],
  ['计算机', '全指信息'],
  ['软件', '全指信息'],
  ['人工智能', '科技龙头'],
  ['云计算', '全指信息'],
  ['数字', '全指信息'],
  ['新能源车', '新能源车'],
  ['新能源汽车', '新能源车'],
  ['光伏', '新能源车'],
  ['电池', '新能源车'],
  ['新能源', '新能源车'],
  ['煤炭', '中证煤炭'],
  ['有色', '中证有色'],
  ['钢铁', '中证煤炭'],
  ['环保', '中证环保'],
  ['地产', '国证地产'],
  ['房地产', '国证地产'],
  ['红利', '中证红利'],
  ['恒生科技', '恒生科技'],
  ['港股', '恒生指数'],
  ['中概', '中概互联50'],
  ['互联', '中国互联'],
  ['纳斯达克', '纳指100'],
  ['标普', '标普500'],
  ['沪深300', '沪深300'],
  ['中证500', '中证500'],
  ['中证1000', '中证1000'],
  ['上证50', '上证50'],
  ['创业板', '创业板'],
  ['科创', '科创50']
]
async function loadIndexValuation(fundName) {
  const hit = THEME_INDEX.find(([kw]) => fundName.includes(kw))
  if (!hit) return null
  const r = await fundPool.query(
    `SELECT index_name, trade_date, pe, pe_percentile, pb_percentile, roe, eva_type
       FROM index_valuation WHERE index_name = $1 ORDER BY trade_date DESC LIMIT 1`,
    [hit[1]]
  )
  const row = r.rows[0]
  if (!row) return null
  const num = (v) => (v === null ? null : Number(v))
  return {
    indexName: row.index_name,
    asof: row.trade_date ? row.trade_date.toISOString().slice(0, 10) : null,
    pePercentile: num(row.pe_percentile),
    pbPercentile: num(row.pb_percentile),
    pe: num(row.pe),
    roe: num(row.roe),
    evaType: row.eva_type
  }
}
function describePercentile(p) {
  if (p === null || !Number.isFinite(p)) return '--'
  const pct = p * 100
  const tag = pct < 20 ? '偏低' : pct < 50 ? '中低' : pct < 80 ? '中高' : '偏高'
  return `${pct.toFixed(1)}%（${tag}）`
}
function formatValuationBlock(v) {
  const parts = [
    `PE 分位 ${describePercentile(v.pePercentile)}`,
    `PB 分位 ${describePercentile(v.pbPercentile)}`
  ]
  if (v.pe !== null) parts.push(`PE ${v.pe.toFixed(2)}`)
  if (v.roe !== null) parts.push(`ROE ${(v.roe * 100).toFixed(2)}%`)
  const eva = v.evaType
    ? `，数据源估值标签【${{ low: '低估', mid: '适中', high: '高估' }[v.evaType] ?? v.evaType}】`
    : ''
  return `板块估值分位（${v.indexName}，截至 ${v.asof ?? '--'}${eva}）：${parts.join('｜')}`
}
const round = (v, d = 2) => {
  const f = 10 ** d
  return Math.round(v * f) / f
}
const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
function periodReturnPct(navs) {
  const first = navs[0]
  const last = navs[navs.length - 1]
  if (navs.length < 2 || !(first > 0)) return null
  return round(((last - first) / first) * 100)
}
function maxDrawdownPct(navs) {
  if (navs.length < 2) return null
  let peak = navs[0]
  let worst = 0
  for (const v of navs) {
    if (v > peak) peak = v
    if (peak > 0) {
      const dd = ((v - peak) / peak) * 100
      if (dd < worst) worst = dd
    }
  }
  return round(worst)
}
function currentDrawdownPct(navs) {
  if (navs.length < 2) return null
  const peak = Math.max(...navs)
  const last = navs[navs.length - 1]
  if (!(peak > 0)) return null
  return round(((last - peak) / peak) * 100)
}
function dailyReturns(navs) {
  const out = []
  for (let i = 1; i < navs.length; i++) {
    const prev = navs[i - 1]
    if (prev > 0) out.push(navs[i] / prev - 1)
  }
  return out
}
function computeFundMetrics(nav) {
  const points = [...nav]
    .filter((p) => Number.isFinite(p.nav) && p.nav > 0)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
  const navs = points.map((p) => p.nav)
  const sampleDays = Math.max(0, navs.length - 1)
  const periodPct = periodReturnPct(navs)
  const rets = dailyReturns(navs)
  const vol =
    rets.length < 2
      ? null
      : round(
          Math.sqrt(rets.reduce((a, r) => a + (r - mean(rets)) ** 2, 0) / (rets.length - 1)) *
            Math.sqrt(244) *
            100
        )
  const annRet =
    periodPct === null || sampleDays <= 0
      ? null
      : 1 + periodPct / 100 <= 0
        ? null
        : round(((1 + periodPct / 100) ** (244 / sampleDays) - 1) * 100)
  const tailRet = (w) => (navs.length < w + 1 ? null : periodReturnPct(navs.slice(-(w + 1))))
  const ma20 = navs.length >= 20 ? round(mean(navs.slice(-20)), 4) : null
  const last = navs[navs.length - 1] ?? null
  return {
    sampleDays,
    periodReturn: periodPct,
    annualizedReturn: annRet,
    annualizedVol: vol,
    sharpe: annRet === null || vol === null || vol <= 0 ? null : round((annRet - 2) / vol, 2),
    maxDrawdown: maxDrawdownPct(navs),
    currentDrawdown: currentDrawdownPct(navs),
    winRate: rets.length ? round((rets.filter((r) => r > 0).length / rets.length) * 100, 1) : null,
    ret20: tailRet(20),
    ret60: tailRet(60),
    ma20,
    aboveMa20: ma20 !== null && last !== null ? last >= ma20 : null
  }
}
function computeRelativeStrength(fund, bench, windows, benchmark) {
  const fm = new Map(fund.filter((p) => Number.isFinite(p.nav)).map((p) => [p.date, p.nav]))
  const bm = new Map(bench.filter((p) => Number.isFinite(p.nav)).map((p) => [p.date, p.nav]))
  const common = [...fm.keys()].filter((d) => bm.has(d)).sort()
  if (common.length < 2) return null
  const af = common.map((d) => fm.get(d))
  const ab = common.map((d) => bm.get(d))
  const out = windows.map((w) => {
    if (common.length < w + 1) return { window: w, fundRet: null, benchRet: null, excess: null }
    const f = periodReturnPct(af.slice(-(w + 1)))
    const b = periodReturnPct(ab.slice(-(w + 1)))
    return {
      window: w,
      fundRet: f,
      benchRet: b,
      excess: f !== null && b !== null ? round(f - b) : null
    }
  })
  return { benchmark, commonDays: common.length, windows: out }
}
function formatMetricsBlock(m, rs) {
  const pct = (v) => (v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
  const lines = [
    `量化指标（基于近 ${m.sampleDays} 个交易日净值，年化按 244 交易日）：`,
    `区间收益 ${pct(m.periodReturn)}｜年化收益 ${pct(m.annualizedReturn)}｜年化波动率 ${m.annualizedVol === null ? '--' : m.annualizedVol.toFixed(2) + '%'}｜夏普 ${m.sharpe === null ? '--' : m.sharpe.toFixed(2)}（无风险利率 2%）`,
    `最大回撤 ${pct(m.maxDrawdown)}｜当前回撤 ${pct(m.currentDrawdown)}｜日涨占比 ${m.winRate === null ? '--' : m.winRate.toFixed(1) + '%'}`,
    `近 20 日 ${pct(m.ret20)}｜近 60 日 ${pct(m.ret60)}｜20 日均线 ${m.ma20 === null ? '--' : m.ma20.toFixed(4)}（最新${m.aboveMa20 === null ? '--' : m.aboveMa20 ? '在其上方' : '在其下方'}）`
  ]
  if (rs) {
    const ws = rs.windows
      .filter((w) => w.excess !== null)
      .map(
        (w) =>
          `近 ${w.window} 日超额 ${pct(w.excess)}（基金 ${pct(w.fundRet)} / ${rs.benchmark} ${pct(w.benchRet)}）`
      )
    if (ws.length)
      lines.push(`相对${rs.benchmark}（对齐 ${rs.commonDays} 个交易日）：${ws.join('｜')}`)
  }
  return lines.join('\n')
}
async function loadFund(code) {
  const basic = (
    await fundPool.query(`SELECT fund_name AS name FROM fund_basic WHERE fund_code = $1`, [code])
  ).rows[0]
  if (!basic) throw new Error(`fund_basic 无 ${code}`)
  const nav = (
    await fundPool.query(
      `SELECT trade_date::text AS date, dwjz, jzzzl FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date DESC LIMIT 120`,
      [code]
    )
  ).rows
    .reverse()
    .map((x) => ({
      date: x.date,
      nav: Number(x.dwjz),
      changePct: x.jzzzl === null ? null : Number(x.jzzzl)
    }))
  const hr = await fundPool.query(
    `SELECT report_date, rank, stock_code, stock_name, weight FROM fund_holdings
     WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
     ORDER BY rank`,
    [code]
  )
  const rows = []
  for (const row of hr.rows) {
    let lastPct = null
    if (row.stock_code) {
      const k = await fundPool.query(
        `SELECT close FROM stock_daily WHERE stock_code = $1 ORDER BY trade_date DESC LIMIT 10`,
        [row.stock_code]
      )
      const closes = k.rows.map((x) => Number(x.close))
      if (closes.length >= 2 && closes[closes.length - 1] !== 0) {
        lastPct = ((closes[0] - closes[closes.length - 1]) / closes[closes.length - 1]) * 100
      }
    }
    rows.push({
      rank: row.rank,
      stockName: row.stock_name,
      weight: row.weight === null ? null : Number(row.weight),
      lastPct
    })
  }
  const reportDate = hr.rows[0]?.report_date
    ? hr.rows[0].report_date.toISOString().slice(0, 10)
    : null
  const est = (
    await fundPool.query(
      `SELECT est_time, est_pct, source FROM fund_estimate WHERE fund_code = $1 AND est_time > now() - interval '24 hours' ORDER BY est_time`,
      [code]
    )
  ).rows.map((x) => ({
    time: x.est_time.toISOString(),
    pct: x.est_pct === null ? null : Number(x.est_pct),
    source: x.source
  }))
  const tags = [
    fundNameKeyword(basic.name),
    ...rows
      .map((h) => h.stockName)
      .filter(Boolean)
      .slice(0, 8)
  ]
  // 镜像自 src/main/news/reader.ts recentNewsForFunds（时效优先 + 可用性驱动降级 + 大盘兜底）
  const matched = (
    await newsPool.query(
      `SELECT title, summary, sentiment, pub_time FROM raw_news
       WHERE llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)
       ORDER BY pub_time DESC LIMIT 32`,
      [tags, tags.map((t) => `%${t}%`)]
    )
  ).rows
  const within = (rs, d) =>
    rs.filter((r) => r.pub_time && r.pub_time.getTime() >= Date.now() - d * 86400000)
  const usableCount = (rs) =>
    rs.filter((r) => (r.summary && r.summary.trim() !== '') || r.sentiment !== null).length
  const usable = (rs) => {
    // 镜像自 reader.ts rankByUsability：质量基础分 + 时效衰减（每 5 天让出一档）
    const quality = (r) =>
      r.summary && r.summary.trim() !== '' ? 0 : r.title && r.title.trim() !== '' ? 3 : 6
    const staleness = (r) =>
      r.pub_time === null ? 0 : Math.max(0, (Date.now() - r.pub_time.getTime()) / 86400000) / 5
    return [...rs].sort((a, b) => quality(a) + staleness(a) - (quality(b) + staleness(b)))
  }
  const limit = 8
  let picked = within(matched, 10)
  if (usableCount(picked) < 3) {
    const wide = within(matched, 30)
    if (usableCount(wide) > usableCount(picked)) picked = wide
  }
  const mine = usable(picked)
    .slice(0, limit)
    .map((r) => ({ ...r, relevance: 'match' }))
  let news = mine
  if (usableCount(mine) < 3) {
    const market = usable(
      (
        await newsPool.query(
          `SELECT title, summary, sentiment, pub_time FROM raw_news WHERE pub_time > now() - interval '24 hours' ORDER BY pub_time DESC LIMIT 32`
        )
      ).rows
    )
      .filter((m) => m.title !== null && m.title.trim() !== '')
      .slice(0, Math.max(0, Math.min(4, limit - mine.length)))
      .map((r) => ({ ...r, relevance: 'market' }))
    news = [...mine, ...market]
  }
  const valuation = await loadIndexValuation(basic.name)
  return { basic, nav, holdings: { reportDate, rows }, est, news, tags, valuation }
}
async function loadBenchmark() {
  const r = await fundPool.query(
    `SELECT t.d AS date, t.close FROM (SELECT trade_date::text AS d, close FROM stock_daily WHERE stock_code = '000300' ORDER BY trade_date DESC LIMIT 200) t ORDER BY t.d`
  )
  if (!r.rows.length) return null
  return r.rows.map((x) => ({ date: x.date, nav: Number(x.close) }))
}
function formatEstimateBlock(est, today) {
  const localDate = (d) => {
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const points = est.filter((p) => localDate(new Date(p.time)) === today)
  if (!points.length) return null
  const buckets = new Map()
  for (const p of points) {
    const d = new Date(p.time)
    buckets.set(Math.floor((d.getHours() * 60 + d.getMinutes()) / 30), p)
  }
  const picked = [...buckets.values()].slice(-12)
  const hm = (p) => {
    const d = new Date(p.time)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  const pct = (p) => (p.pct === null ? '--' : p.pct.toFixed(2) + '%')
  const last = points[points.length - 1]
  return `盘中估值（${last.source}，最新 ${hm(last)}）：${pct(last)}
当日估值走势（每 30 分钟抽稀，共 ${picked.length} 条）：
${picked.map((p) => `${hm(p)} ${pct(p)}`).join('\n')}`
}
async function promptSnapshot(codes) {
  const bench = await loadBenchmark()
  const stats = []
  for (const code of codes) {
    const { basic, nav, holdings, est, news, tags, valuation } = await loadFund(code)
    const fm = computeFundMetrics(nav)
    const rs = bench ? computeRelativeStrength(nav, bench, [20, 60], '沪深300') : null
    const metricsBlock = formatMetricsBlock(fm, rs)
    const valuationBlock = valuation ? formatValuationBlock(valuation) : null
    const latestNav = nav[nav.length - 1]
    const navLines = nav
      .slice(-30)
      .map(
        (p) =>
          `${p.date} ${p.nav.toFixed(4)} (${p.changePct === null ? '--' : p.changePct.toFixed(2)}%)`
      )
      .join('\n')
    const estBlock = formatEstimateBlock(est, new Date().toISOString().slice(0, 10))
    const holdLines = holdings.rows
      .slice(0, 10)
      .map(
        (h) =>
          `${h.rank}. ${h.stockName ?? '?'} 权重${h.weight === null ? '--' : h.weight.toFixed(2)}% 近10日${h.lastPct === null ? '--' : h.lastPct.toFixed(2)}%`
      )
      .join('\n')
    const newsLines = news
      .slice(0, 8)
      .map((n) => {
        const d = n.pub_time
        const dateTag = d
          ? `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')}|${newsAgeTag(d)}`
          : '日期未知'
        const head = n.title && n.title.trim() !== '' ? n.title : '(无标题)'
        const body = n.summary ? ' | ' + n.summary.slice(0, 100) : ''
        const scope = n.relevance === 'market' ? '[大盘]' : '[行业]'
        return `- ${scope}[${dateTag}|${n.sentiment ?? '未知情绪'}] ${head}${body}`
      })
      .join('\n')
    const prompt = `分析时点：${new Date().toISOString().slice(0, 10)}（模拟盘后）
基金：${basic.name}（${code}）
净值样本数：${nav.length} 条（区间累计涨跌见下方量化指标的"区间收益"）
最新净值：${latestNav.nav.toFixed(4)}（${latestNav.date}），当日涨跌 ${latestNav.changePct === null ? '--' : latestNav.changePct.toFixed(2)}%
${estBlock ? estBlock + '\n' : ''}${metricsBlock}
${valuationBlock ? valuationBlock + '\n' : ''}（未录入持仓，仅基于净值与重仓股判断）

近 30 日净值：
${navLines}

最新重仓股（报告期 ${holdings.reportDate ?? '无'}）：
${holdLines || '（无持仓数据）'}

相关新闻（最多 8 条；[行业]=与本基金/重仓股相关，[大盘]=行业新闻不足时的市场兜底；括号为「日期|距今天数|情绪」，越旧参考价值越低）：
${newsLines || '（无相关新闻）'}

请给出 加仓/减仓/持有 建议。`
    console.log(`\n${'='.repeat(88)}\n### ${basic.name}（${code}）`)
    console.log(`过滤关键词：${JSON.stringify(tags)}`)
    console.log(`板块估值：${valuationBlock ?? '（无匹配指数，不注入该块）'}`)
    console.log(
      `新闻 ${news.length} 条（行业 ${news.filter((n) => n.relevance !== 'market').length} / 大盘兜底 ${news.filter((n) => n.relevance === 'market').length}），带情绪 ${news.filter((n) => n.sentiment).length}，带摘要 ${news.filter((n) => n.summary).length}`
    )
    console.log(`user prompt ${prompt.length} 字符 ≈ ${Math.round(prompt.length / 1.5)} token`)
    console.log(
      `新闻日期：${news.map((n) => (n.pub_time ? `${n.pub_time.toISOString().slice(0, 10)}(${newsAgeTag(n.pub_time)})` : '无日期')).join(', ') || '无'}`
    )
    console.log('='.repeat(88))
    console.log(prompt)
    stats.push({
      代码: code,
      名称: basic.name,
      prompt字符: prompt.length,
      估算token: Math.round(prompt.length / 1.5),
      新闻条数: news.length,
      带情绪: news.filter((n) => n.sentiment).length
    })
  }
  console.log('\n===== prompt 体量汇总 =====')
  console.table(stats)
}

// ---------- 入口 ----------
const argv = process.argv.slice(2)
const has = (f) => argv.includes(f)
const codesAfter = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv.slice(i + 1).filter((a) => !a.startsWith('--')) : []
}

async function main() {
  // 无参数 = 全量体检
  const all = argv.length === 0
  if (all || has('--news')) await newsHealth()
  if (all || has('--hits')) await hitRates()
  if (all || has('--prompt')) {
    const codes = codesAfter('--prompt')
    if (!codes.length) {
      const r = await fundPool.query(
        `SELECT uf.fund_code FROM user_fund uf WHERE uf.is_active = 1 ORDER BY uf.fund_code LIMIT 3`
      )
      for (const row of r.rows) await promptSnapshot([row.fund_code])
    } else {
      await promptSnapshot(codes)
    }
  }
  await fundPool.end()
  await newsPool.end()
}

main().catch(async (e) => {
  console.error('体检失败:', e.message)
  await fundPool.end().catch(() => {})
  await newsPool.end().catch(() => {})
  process.exit(1)
})
