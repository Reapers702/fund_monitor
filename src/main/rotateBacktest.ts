// 相对强弱轮动回测 —— 检验"追赶近期跑得快的基金"（momentum rotation）能否用作操作依据
//
// 背景：规则打分引擎已证明纯净值/新闻信号对未来方向无预测力（命中率恒 ≈50%）。
//       本回测换一个逻辑：不预测"涨跌方向"，而是预测"相对强弱排名能否延续"——
//       即过去 N 日超额最高的基金，未来是否能继续跑赢同类平均 / 保持领先。
// 若排名随机（过去强的未来并不强），则轮动策略也无法构成 alpha。
//
// 方法：与 rulesBacktest 完全一致的 asof 取数（无前视）。
//       - 每个采样日，对各基金用 computeRelativeStrength 算过去 20/60 日相对沪深300 超额，据此排名。
//       - 评估未来 T+5 / T+10：最强 vs 最弱 vs 等权（同类平均）vs 沪深300 基准。
//       - 统计"排名持续性"：过去排名与未来收益排名的关联、最强基金跑赢同类均值的频率。
import type { Pool } from 'pg'
import { loadConfig } from './config'
import { createPool, createAiFundPool } from './storage/db'
import { computeRelativeStrength } from './analyzer/metrics'
import { loadBenchmarkNav, BENCHMARK_NAME } from './crawler/benchmark'

const dateOnly = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const todayISO = () => dateOnly(new Date())
const addDays = (iso: string, n: number): string => {
  const d = new Date(iso + 'T00:00:00')
  d.setDate(d.getDate() + n)
  return dateOnly(d)
}

/** 净值：截至 asof 当日（含）升序，用于算过去窗口超额 */
async function navUpTo(pool: Pool, code: string, asof: string, limit = 120): Promise<{ date: string; nav: number }[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string }>(
    `SELECT trade_date, dwjz FROM fund_nav_daily
     WHERE fund_code = $1 AND trade_date <= $2
     ORDER BY trade_date DESC LIMIT $3`,
    [code, asof, limit]
  )
  return r.rows.reverse().map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz) }))
}

/** 完整升序净值（评估未来窗口） */
async function navDatesAll(pool: Pool, code: string): Promise<{ date: string; nav: number }[]> {
  const r = await pool.query<{ trade_date: Date; dwjz: string }>(
    `SELECT trade_date, dwjz FROM fund_nav_daily WHERE fund_code = $1 ORDER BY trade_date ASC`,
    [code]
  )
  return r.rows.map((x) => ({ date: dateOnly(x.trade_date), nav: Number(x.dwjz) }))
}

async function basic(pool: Pool, code: string): Promise<{ name: string } | null> {
  const r = await pool.query<{ fund_name: string }>(`SELECT fund_name FROM fund_basic WHERE fund_code = $1`, [code])
  const x = r.rows[0]
  return x ? { name: x.fund_name } : null
}

function pct(v: number | null): string {
  return v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

export async function runRotateBacktest(codesOverride?: string[], count = 40, recentDays = 500): Promise<number> {
  const cfg = loadConfig()
  const pool = createPool(cfg)
  const aiFundPool = createAiFundPool(cfg)
  try {
    let codes = codesOverride ?? null
    if (!codes) {
      const r = await pool.query<{ fund_code: string }>(
        `SELECT f.fund_code FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
         WHERE uf.user_id = $1 AND uf.is_active = 1 ORDER BY f.fund_code`,
        [cfg.currentUserId]
      )
      codes = r.rows.map((x) => x.fund_code)
    }

    const navMaps = new Map<string, { date: string; nav: number }[]>()
    const names = new Map<string, string>()
    for (const code of codes) {
      const [b, seq] = await Promise.all([basic(pool, code), navDatesAll(pool, code)])
      if (!b) { console.error(`[rotate-backtest] ${code} 无 fund_basic，跳过`); continue }
      navMaps.set(code, seq)
      names.set(code, b.name)
    }
    const evalCodes = [...navMaps.keys()]
    if (evalCodes.length < 2) { console.error(`[rotate-backtest] 活跃基金仅 ${evalCodes.length} 只（轮动需 ≥2 只）`); return 1 }

    // 采样日：取各基金共同存在的日期，均匀抽 count 个；每个采样日需留出未来窗口（取最大 horizon=10）
    const today = todayISO()
    const floor = addDays(today, -recentDays)
    const firstSeq = navMaps.get(evalCodes[0])!
    const ok: string[] = []
    for (const p of firstSeq) {
      const d = p.date
      if (d < floor || d > today) continue
      const i = firstSeq.findIndex((x) => x.date === d)
      if (i < 0) continue
      let all = true
      for (const [, s2] of navMaps) {
        const j = s2.findIndex((x) => x.date === d)
        if (j < 0 || j + 10 >= s2.length) { all = false; break }
      }
      if (all) ok.push(d)
    }
    const uniq = [...new Set(ok)].sort()
    if (uniq.length === 0) { console.error('[rotate-backtest] 采样日期内没有满足未来窗口的共同交易日'); return 1 }
    const take = Math.min(count, uniq.length)
    const sampleDates = uniq.length === take ? uniq : Array.from({ length: take }, (_, k) => uniq[Math.round((k * (uniq.length - 1)) / (take - 1))])

    const benchNav = await loadBenchmarkNav()
    const benchByDate = new Map(benchNav ? benchNav.map((p) => [p.date, p.nav]) : [])
    const benchSorted = benchNav ? [...benchNav].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)) : []

    console.log('\n' + '='.repeat(100))
    console.log('相对强弱轮动回测（无前视）· 检验"过去强→未来强"是否成立')
    console.log('='.repeat(100))
    console.log(`基金（${evalCodes.length} 只）: ${evalCodes.map((c) => `${c} ${names.get(c)}`).join('、')}`)
    console.log(`采样日 ${sampleDates.length} 个（近 ${recentDays} 天）: ${sampleDates.join(', ')}`)
    console.log(`排名依据：过去 20/60 日相对${BENCHMARK_NAME}超额 → 最强/最弱持仓，未来评估 T+5 / T+10`)
    console.log('-' .repeat(100))

    interface Sample {
      asof: string
      code: string
      name: string
      excess20: number | null
      excess60: number | null
      ret5: number | null
      ret10: number | null
      // 未来窗口同类平均（同期所有基金均值）与基准
      peer5: number | null
      peer10: number | null
      bench5: number | null
      bench10: number | null
    }
    const rows: Sample[] = []

    for (const asof of sampleDates) {
      // 这一天的同类未来均值（后统一算）
      for (const code of evalCodes) {
        const seq = navMaps.get(code)!
        const i = seq.findIndex((p) => p.date === asof)
        if (i < 0) continue
        const nav = await navUpTo(pool, code, asof, 120)
        if (nav.length < 61) continue
        let excess20: number | null = null
        let excess60: number | null = null
        if (benchByDate.size > 0) {
          const bench = [...benchByDate.entries()].filter(([d]) => d <= asof).sort().map(([date, nav0]) => ({ date, nav: nav0 }))
          const rs = computeRelativeStrength(nav, bench, [20, 60], BENCHMARK_NAME)
          excess20 = rs?.windows[0]?.excess ?? null
          excess60 = rs?.windows[1]?.excess ?? null
        }
        const base = seq[i].nav
        const n5 = seq[i + 5]?.nav
        const n10 = seq[i + 10]?.nav
        const ret5 = base > 0 && n5 !== undefined ? ((n5 - base) / base) * 100 : null
        const ret10 = base > 0 && n10 !== undefined ? ((n10 - base) / base) * 100 : null
        rows.push({ asof, code, name: names.get(code)!, excess20, excess60, ret5, ret10, peer5: null, peer10: null, bench5: null, bench10: null })
      }
    }

    // 填同类平均 + 基准，并打印每个采样日的排名
    const byDate = new Map<string, Sample[]>()
    for (const r of rows) {
      if (!byDate.has(r.asof)) byDate.set(r.asof, [])
      byDate.get(r.asof)!.push(r)
    }
    for (const [asof, grp] of byDate) {
      const p5 = avg(grp.map((r) => r.ret5))
      const p10 = avg(grp.map((r) => r.ret10))
      for (const r of grp) { r.peer5 = p5; r.peer10 = p10 }
      // 基准未来
      const bi = benchSorted.findIndex((p) => p.date === asof)
      const b0 = benchByDate.get(asof)
      for (const r of grp) {
        if (bi >= 0 && b0) {
          const b5 = benchSorted[bi + 5]?.nav
          const b10 = benchSorted[bi + 10]?.nav
          r.bench5 = b0 > 0 && b5 !== undefined ? ((b5 - b0) / b0) * 100 : null
          r.bench10 = b0 > 0 && b10 !== undefined ? ((b10 - b0) / b0) * 100 : null
        }
      }
      // 打印：按 excess20 降序排名
      const sorted = [...grp].sort((a, b) => (b.excess20 ?? -999) - (a.excess20 ?? -999))
      console.log(`[${asof}] 近20日超额：` + sorted.map((r) => `${r.name.trim().slice(0, 12)} ${pct(r.excess20)}`).join(' ｜ ') + ` | 未来T+5: ${sorted.map((r) => `${r.name.trim().slice(0, 12)} ${pct(r.ret5)}`).join(' ｜ ')}`)
    }

    if (rows.length === 0) { console.error('[rotate-backtest] 没有产生样本'); return 1 }

    // ---------- 汇总：排名持续性 ----------
    console.log('\n' + '='.repeat(100))
    console.log('汇总评估')
    console.log('='.repeat(100))

    const byDateArr = [...byDate.entries()]

    // 每个采样日取最强 / 最弱（按 excess20），对比它们未来相对同类均值与相对基准的胜率
    let strongBeatPeer5 = 0, strongBeatPeer10 = 0, weakBeatPeer5 = 0, weakBeatPeer10 = 0
    let strongBeatBench5 = 0, weakBeatBench5 = 0
    let strongUp5 = 0, weakUp5 = 0
    let tot5 = 0, tot10 = 0
    interface DayStat {
      asof: string
      strongEx20: number | null
      strongRet5: number | null
      strongRet10: number | null
      weakRet5: number | null
      weakRet10: number | null
      peer5: number | null
      peer10: number | null
      bench5: number | null
    }
    const dayStats: DayStat[] = []

    for (const [, grp] of byDateArr) {
      const ranged = grp.filter((r) => r.excess20 !== null && r.ret5 !== null && r.ret10 !== null)
      if (ranged.length < 2) continue
      const sorted = [...ranged].sort((a, b) => (b.excess20 ?? -999) - (a.excess20 ?? -999))
      const strong = sorted[0]
      const weak = sorted[sorted.length - 1]
      const peer5 = strong.peer5, peer10 = strong.peer10, bench5 = strong.bench5
      if (peer5 !== null) {
        tot5++
        if (strong.ret5! > peer5) strongBeatPeer5++
        if (weak.ret5! > peer5) weakBeatPeer5++
        if (strong.ret5! > 0) strongUp5++
        if (weak.ret5! > 0) weakUp5++
        if (bench5 !== null) {
          if (strong.ret5! > bench5) strongBeatBench5++
          if (weak.ret5! > bench5) weakBeatBench5++
        }
      }
      if (peer10 !== null) {
        tot10++
        if (strong.ret10! > peer10) strongBeatPeer10++
        if (weak.ret10! > peer10) weakBeatPeer10++
      }
      dayStats.push({ asof: strong.asof, strongEx20: strong.excess20, strongRet5: strong.ret5, strongRet10: strong.ret10, weakRet5: weak.ret5, weakRet10: weak.ret10, peer5, peer10, bench5 })
    }
    const rate = (a: number, b: number) => (b ? Math.round((a / b) * 100) + '%' : '--')

    console.log('\n[排名持续性核心检验] 最强/最弱（按过去20日超额）未来相对表现：')
    console.log(`  最强 T+5 跑赢同类均值: ${rate(strongBeatPeer5, tot5)}（${strongBeatPeer5}/${tot5}）｜ T+5 上涨 ${rate(strongUp5, tot5)} ｜ T+5 跑赢${BENCHMARK_NAME} ${rate(strongBeatBench5, tot5)}`)
    console.log(`  最弱 T+5 跑赢同类均值: ${rate(weakBeatPeer5, tot5)}（${weakBeatPeer5}/${tot5}）｜ T+5 上涨 ${rate(weakUp5, tot5)} ｜ T+5 跑赢${BENCHMARK_NAME} ${rate(weakBeatBench5, tot5)}`)
    console.log(`  最强 T+10 跑赢同类均值: ${rate(strongBeatPeer10, tot10)}（${strongBeatPeer10}/${tot10}）｜ 最弱 T+10 跑赢同类均值: ${rate(weakBeatPeer10, tot10)}（${weakBeatPeer10}/${tot10}）`)

    // 收益对比：持最强 vs 持最弱 vs 等权(同类平均) vs 基准
    const aRet = (pick: (d: DayStat) => number | null) => {
      const v = dayStats.map((d) => pick(d)).filter((x): x is number => x !== null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    const strong5 = aRet((d) => d.strongRet5)
    const strong10 = aRet((d) => d.strongRet10)
    const weak5 = aRet((d) => d.weakRet5)
    const weak10 = aRet((d) => d.weakRet10)
    const peer5avg = aRet((d) => d.peer5)
    const peer10avg = aRet((d) => d.peer10)
    const bench5avg = aRet((d) => d.bench5)
    // 每次仅用最强 vs 最弱能消掉同期市场方向（市场共同因子）
    const spread5 = strong5 !== null && weak5 !== null ? strong5 - weak5 : null
    const spread10 = strong10 !== null && weak10 !== null ? strong10 - weak10 : null

    console.log('\n[平均收益对比] 同一同比、最强 vs 最弱 vs 同类等权 vs 基准：')
    console.log(`  T+5  最强 ${pct(strong5)} ｜ 最弱 ${pct(weak5)} ｜ 强−弱价差 ${pct(spread5)} ｜ 同类均值 ${pct(peer5avg)} ｜ 基准 ${pct(bench5avg)}`)
    console.log(`  T+10 最强 ${pct(strong10)} ｜ 最弱 ${pct(weak10)} ｜ 强−弱价差 ${pct(spread10)} ｜ 同类均值 ${pct(peer10avg)}`)

    // 排名自相关：过去20日超额排名 与 未来 T+10 收益排名 的 Spearman（跨全部样本）
    console.log('\n[横截面排名相关性] 过去20日超额 与 未来收益：')
    for (const horizon of [5, 10]) {
      const pairList: { pastEx: number; futRet: number }[] = []
      for (const r of rows) {
        const fut = horizon === 5 ? r.ret5 : r.ret10
        if (r.excess20 !== null && fut !== null) pairList.push({ pastEx: r.excess20, futRet: fut })
      }
      const spearman = rankCorrelation(pairList.map((p) => p.pastEx), pairList.map((p) => p.futRet))
      console.log(`  excess20 vs 未来T+${horizon}: rank-correlation(ρ) = ${spearman === null ? '--' : spearman.toFixed(3)}（|ρ| 接近0 = 排名随机，越正越持续）`)
    }

    // 用途判定
    const spreadPos = spread5 !== null ? spread5 > 0 : null
    const beat = strongBeatPeer5 / (tot5 || 1)
    console.log('\n' + '='.repeat(100))
    if (spreadPos && beat > 0.6) {
      console.log('结论：过去弱排名对未来有稳定正贡献（跑赢同类均值 >60%、强-弱价差为正）→ 相对强弱可作为操作依据。')
    } else {
      console.log('结论：过去强排名对未来无稳定优势 → 相对强弱排名不具持续性，轮动难以作为操作依据（与规则引擎一致）。')
    }
    console.log(`判据参考：最强 T+5 跑赢同类均值 ${rate(strongBeatPeer5, tot5)}（理想>60%）、强−弱 T+5 价差 ${pct(spread5)}（理想为正）`)
    return 0
  } finally {
    await pool.end().catch(() => {})
    await aiFundPool.end().catch(() => {})
  }
}

function avg(arr: (number | null)[]): number | null {
  const v = arr.filter((x): x is number => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

/** Spearman 秩相关系数（处理并列） */
function rankCorrelation(xs: number[], ys: number[]): number | null {
  if (xs.length < 3 || xs.length !== ys.length) return null
  const rank = (arr: number[]) => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const ranks = new Array(arr.length)
    let i = 0
    while (i < idx.length) {
      let j = i
      while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j++
      const r = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) ranks[idx[k].i] = r
      i = j + 1
    }
    return ranks
  }
  const rx = rank(xs), ry = rank(ys)
  const n = rx.length
  const mx = rx.reduce((a, b) => a + b, 0) / n
  const my = ry.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) {
    sxy += (rx[i] - mx) * (ry[i] - my)
    sxx += (rx[i] - mx) ** 2
    syy += (ry[i] - my) ** 2
  }
  if (sxx === 0 || syy === 0) return null
  return sxy / Math.sqrt(sxx * syy)
}