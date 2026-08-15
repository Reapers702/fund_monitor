// 聚合查询层（渲染进程经 IPC 调用，只读）
// 拆分自各 repo 的只读逻辑：列表 / 净值序列 / 估值序列 / 持仓 / 建议 / 股票行情
import type { Pool } from 'pg'

// ---------- 基金列表 ----------

export interface FundCard {
  code: string
  name: string
  isActive: number
  latestNav: string | null // YYYY-MM-DD
  latestNavDate: string | null
  navChangePct: number | null // 当日涨跌（净值数据自带 jzzzl）
  estPct: number | null // 盘中估值（最新一次采样）
  estTime: string | null
  estSource: string | null // tracking_index / theme_etf
  holdingsDate: string | null
  adviceAction: string | null // 最新 AI 建议：add / reduce / hold
  adviceConfidence: number | null
  adviceDate: string | null // 建议交易日 YYYY-MM-DD
}

export async function listFunds(pool: Pool): Promise<FundCard[]> {
  const r = await pool.query<{
    fund_code: string
    fund_name: string
    is_active: number
    trade_date: string | null
    dwjz: string | null
    jzzzl: string | null
    holdings_date: string | null
    advice_action: string | null
    advice_confidence: string | null
    advice_date: string | null
  }>(
    `SELECT f.fund_code, f.fund_name, f.is_active,
            n.trade_date, n.dwjz, n.jzzzl,
            (SELECT to_char(max(report_date), 'YYYY-MM-DD') FROM fund_holdings h WHERE h.fund_code = f.fund_code) AS holdings_date,
            a.action AS advice_action, a.confidence AS advice_confidence,
            to_char(a.trade_date, 'YYYY-MM-DD') AS advice_date
     FROM fund_basic f
     LEFT JOIN LATERAL (
       SELECT trade_date, dwjz, jzzzl FROM fund_nav_daily
       WHERE fund_code = f.fund_code ORDER BY trade_date DESC LIMIT 1
     ) n ON true
     LEFT JOIN LATERAL (
       SELECT action, confidence, trade_date FROM ds_advice
       WHERE fund_code = f.fund_code ORDER BY trade_date DESC, id DESC LIMIT 1
     ) a ON true
     ORDER BY f.is_active DESC, f.fund_code`
  )
  // 估值单独查（最新一次采样；盘中高频，无需按服务器日期过滤——采样本身就在交易时段）
  const ests = await pool.query<{ fund_code: string; est_pct: string | null; est_time: Date; source: string }>(
    `SELECT DISTINCT ON (fund_code) fund_code, est_pct, est_time, source
     FROM fund_estimate
     ORDER BY fund_code, est_time DESC`
  )
  const estMap = new Map(ests.rows.map((e) => [
    e.fund_code,
    { estPct: e.est_pct === null ? null : Number(e.est_pct), estTime: e.est_time.toISOString(), estSource: e.source }
  ]))
  return r.rows.map((row) => ({
    code: row.fund_code,
    name: row.fund_name,
    isActive: row.is_active,
    latestNav: row.dwjz === null ? null : Number(row.dwjz).toFixed(4),
    latestNavDate: row.trade_date ? String(row.trade_date).slice(0, 10) : null,
    navChangePct: row.jzzzl === null ? null : Number(row.jzzzl),
    ...(estMap.get(row.fund_code) ?? { estPct: null, estTime: null, estSource: null }),
    holdingsDate: row.holdings_date,
    adviceAction: row.advice_action,
    adviceConfidence: row.advice_confidence === null ? null : Number(row.advice_confidence),
    adviceDate: row.advice_date
  }))
}

// ---------- 净值/估值序列（详情页图表） ----------

export interface NavPoint {
  date: string
  nav: number
  changePct: number | null
}

/** 近 N 天净值序列（含每期累计涨跌，图表用） */
export async function navSeries(pool: Pool, code: string, days = 120): Promise<NavPoint[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string; jzzzl: string | null }>(
    `SELECT trade_date, dwjz, jzzzl FROM fund_nav_daily
     WHERE fund_code = $1
     ORDER BY trade_date DESC LIMIT $2`,
    [code, days]
  )
  return r.rows
    .reverse()
    .map((x) => ({
      date: x.trade_date.toISOString().slice(0, 10),
      nav: Number(x.dwjz),
      changePct: x.jzzzl === null ? null : Number(x.jzzzl)
    }))
}

export interface EstPoint {
  time: string // ISO
  pct: number | null
  source: string
}

export async function estimateSeries(pool: Pool, code: string): Promise<EstPoint[]> {
  // 最近 24h 采样（避免服务器/客户端时区导致的跨天边界漏查；盘中采样天然集中在本时段）
  const r = await pool.query<{ est_time: Date; est_pct: string | null; source: string }>(
    `SELECT est_time, est_pct, source FROM fund_estimate
     WHERE fund_code = $1 AND est_time > now() - interval '24 hours'
     ORDER BY est_time`,
    [code]
  )
  return r.rows.map((x) => ({ time: x.est_time.toISOString(), pct: x.est_pct === null ? null : Number(x.est_pct), source: x.source }))
}

// ---------- 持仓 + 个股行情 ----------

export interface HoldingWithStock {
  rank: number
  stockCode: string | null
  stockName: string | null
  weight: number | null
  lastClose: number | null
  lastPct: number | null // 近10日累计涨跌（首尾收盘）
  klineCount: number
}

export async function latestHoldings(pool: Pool, code: string): Promise<{ reportDate: string | null; rows: HoldingWithStock[] }> {
  const r = await pool.query<{ report_date: Date; rank: number; stock_code: string | null; stock_name: string | null; weight: string | null }>(
    `SELECT report_date, rank, stock_code, stock_name, weight FROM fund_holdings
     WHERE fund_code = $1 AND report_date = (SELECT max(report_date) FROM fund_holdings WHERE fund_code = $1)
     ORDER BY rank`,
    [code]
  )
  if (r.rows.length === 0) return { reportDate: null, rows: [] }
  const reportDate = r.rows[0].report_date.toISOString().slice(0, 10)

  const out: HoldingWithStock[] = []
  for (const row of r.rows) {
    if (!row.stock_code) {
      out.push({ rank: row.rank, stockCode: null, stockName: row.stock_name, weight: row.weight === null ? null : Number(row.weight), lastClose: null, lastPct: null, klineCount: 0 })
      continue
    }
    // 近 10 个交易日收盘（首尾）
    const k = await pool.query<{ close: string }>(
      `SELECT close FROM stock_daily WHERE stock_code = $1 ORDER BY trade_date DESC LIMIT 10`,
      [row.stock_code]
    )
    const closes = k.rows.map((x) => Number(x.close))
    const klineCount = closes.length
    const lastPct = klineCount >= 2 && closes[0] !== 0 ? ((closes[0] - closes[closes.length - 1]) / closes[closes.length - 1]) * 100 : null
    out.push({
      rank: row.rank,
      stockCode: row.stock_code,
      stockName: row.stock_name,
      weight: row.weight === null ? null : Number(row.weight),
      lastClose: closes[0] ?? null,
      lastPct,
      klineCount
    })
  }
  return { reportDate, rows: out }
}

// ---------- 基金详情基本信息 ----------

export interface FundBasicRow {
  code: string
  name: string
  fullName: string | null
  manager: string | null
  keeper: string | null
  foundDate: string | null
  navCount: number
}

export async function fundBasic(pool: Pool, code: string): Promise<FundBasicRow | null> {
  const r = await pool.query<{
    fund_code: string
    fund_name: string
    fund_full_name: string | null
    manager: string | null
    keeper: string | null
    found_date: Date | null
    nav_count: string
  }>(
    `SELECT f.fund_code, f.fund_name, f.fund_full_name, f.manager, f.keeper, f.found_date,
            (SELECT count(*)::text FROM fund_nav_daily n WHERE n.fund_code = f.fund_code) AS nav_count
     FROM fund_basic f WHERE f.fund_code = $1`,
    [code]
  )
  const x = r.rows[0]
  if (!x) return null
  return {
    code: x.fund_code,
    name: x.fund_name,
    fullName: x.fund_full_name,
    manager: x.manager,
    keeper: x.keeper,
    foundDate: x.found_date ? x.found_date.toISOString().slice(0, 10) : null,
    navCount: Number(x.nav_count)
  }
}

// ---------- AI 建议（ds_advice） ----------

export interface AdviceRow {
  id: number
  tradeDate: string
  action: string
  reason: string | null
  confidence: number | null
  createdAt: string
}

export async function adviceList(pool: Pool, code: string, limit = 20): Promise<AdviceRow[]> {
  const r = await pool.query<{ id: number; trade_date: Date; action: string; reason: string | null; confidence: string | null; created_at: Date }>(
    `SELECT id, trade_date, action, reason, confidence, created_at FROM ds_advice
     WHERE fund_code = $1 ORDER BY trade_date DESC, id DESC LIMIT $2`,
    [code, limit]
  )
  return r.rows.map((x) => ({
    id: x.id,
    tradeDate: x.trade_date.toISOString().slice(0, 10),
    action: x.action,
    reason: x.reason,
    confidence: x.confidence === null ? null : Number(x.confidence),
    createdAt: x.created_at.toISOString()
  }))
}

// ---------- 估值说明页（各基金当前估值方式） ----------

export interface EstimateGuideRow {
  code: string
  name: string
  isActive: number
  latestSource: string | null // fund_estimate 最新一次采样的 source
  latestPct: number | null
  latestTime: string | null
  holdingsDate: string | null // 最近季报报告期（T3 兜底是否可用）
}

/** 估值说明页数据：基金列表 + 最新估值来源 + 最近持仓报告期 */
export async function estimateGuide(pool: Pool): Promise<EstimateGuideRow[]> {
  const funds = await pool.query<{ fund_code: string; fund_name: string; is_active: number }>(
    'SELECT fund_code, fund_name, is_active FROM fund_basic ORDER BY is_active DESC, fund_code'
  )
  const ests = await pool.query<{ fund_code: string; est_pct: string | null; est_time: Date; source: string }>(
    `SELECT DISTINCT ON (fund_code) fund_code, est_pct, est_time, source
     FROM fund_estimate
     ORDER BY fund_code, est_time DESC`
  )
  const estMap = new Map(ests.rows.map((e) => [
    e.fund_code,
    { latestSource: e.source, latestPct: e.est_pct === null ? null : Number(e.est_pct), latestTime: e.est_time.toISOString() }
  ]))
  const holdings = await pool.query<{ fund_code: string; report_date: Date }>(
    `SELECT DISTINCT ON (fund_code) fund_code, report_date
     FROM fund_holdings
     ORDER BY fund_code, report_date DESC`
  )
  const holdingsMap = new Map(holdings.rows.map((h) => [h.fund_code, h.report_date.toISOString().slice(0, 10)]))
  return funds.rows.map((f) => ({
    code: f.fund_code,
    name: f.fund_name,
    isActive: f.is_active,
    ...(estMap.get(f.fund_code) ?? { latestSource: null, latestPct: null, latestTime: null }),
    holdingsDate: holdingsMap.get(f.fund_code) ?? null
  }))
}

// ---------- 估值误差统计（估值说明页：T1/T2/T3 可信度验证） ----------

export interface EstimateDiffStat {
  fundCode: string
  fundName: string
  source: string
  samples: number // 参与统计的交易日数
  avgAbsDiff: number | null // 平均绝对误差（百分点）
  avgDiff: number | null // 平均误差（正 = 估值偏高）
  latestTradeDate: string | null
  latestDiff: number | null
  latestEst: number | null
  latestNav: number | null
}

/** 最近 days 个自然日内每基金每种估值方式的误差统计 + 最新一条明细 */
export async function estimateDiffStats(pool: Pool, days = 20): Promise<EstimateDiffStat[]> {
  const stats = await pool.query<{
    fund_code: string
    fund_name: string
    source: string
    samples: number
    avg_abs_diff: string | null
    avg_diff: string | null
  }>(
    `SELECT d.fund_code, b.fund_name, d.source,
            count(*)::int AS samples,
            round(avg(abs(d.diff_pct))::numeric, 3) AS avg_abs_diff,
            round(avg(d.diff_pct)::numeric, 3) AS avg_diff
     FROM fund_estimate_diff d
     JOIN fund_basic b ON b.fund_code = d.fund_code
     WHERE d.trade_date > CURRENT_DATE - make_interval(days => $1)
     GROUP BY d.fund_code, b.fund_name, d.source
     ORDER BY d.fund_code, d.source`,
    [days]
  )
  const latest = await pool.query<{
    fund_code: string
    source: string
    trade_date: Date
    diff_pct: string | null
    est_pct: string | null
    nav_pct: string | null
  }>(
    `SELECT DISTINCT ON (fund_code, source) fund_code, source, trade_date, diff_pct, est_pct, nav_pct
     FROM fund_estimate_diff
     ORDER BY fund_code, source, trade_date DESC`
  )
  const latestMap = new Map(latest.rows.map((l) => [`${l.fund_code}|${l.source}`, l]))
  return stats.rows.map((s) => {
    const l = latestMap.get(`${s.fund_code}|${s.source}`)
    return {
      fundCode: s.fund_code,
      fundName: s.fund_name,
      source: s.source,
      samples: s.samples,
      avgAbsDiff: s.avg_abs_diff === null ? null : Number(s.avg_abs_diff),
      avgDiff: s.avg_diff === null ? null : Number(s.avg_diff),
      latestTradeDate: l ? l.trade_date.toISOString().slice(0, 10) : null,
      latestDiff: l && l.diff_pct !== null ? Number(l.diff_pct) : null,
      latestEst: l && l.est_pct !== null ? Number(l.est_pct) : null,
      latestNav: l && l.nav_pct !== null ? Number(l.nav_pct) : null
    }
  })
}
