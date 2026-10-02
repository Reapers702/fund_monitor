// 规则打分回测（确定性，不调 LLM）—— 对比纯 LLM 回测的 33% 基线
//
// 目的：回答"33% 到底是模型不行，还是这些信号本身给不了方向"。
// 方法：用与 backtest.ts 完全相同的 asof 取数（净值/超额/新闻，截至采样日 T 收盘，无前视），
//       只是把 LLM 决策换成 [scorer/engine.ts] 的确定性打分规则。
// 无 LLM → 无随机性、无失败采样、无需 DeepSeek key，速度快且结果 100% 可复现。
import { loadConfig } from './config'
import { createPool, createAiFundPool } from './storage/db'
import { computeRelativeStrength } from './analyzer/metrics'
import { loadBenchmarkNav, BENCHMARK_NAME } from './crawler/benchmark'
import { aggregateNewsScore } from './scorer/lexicon'
import { score, DEFAULT_WEIGHTS, ADD_THRESHOLD, REDUCE_THRESHOLD } from './scorer/engine'
import { todayISO, addDays, navUpTo, navDatesAll, basic, newsUpTo } from './backtestUtil'

const CN: Record<string, string> = { add: '加仓', reduce: '减仓', hold: '持有' }

/** 采样日选择：与 backtest 一致的均匀抽样 */
function pickSampleDates(funds: Map<string, { date: string; nav: number }[]>, recentDays: number, count: number, horizon = 5): string[] {
  const today = todayISO()
  const floor = addDays(today, -recentDays)
  const ok: string[] = []
  for (const [, seq] of funds) {
    for (const p of seq) {
      const d = p.date
      if (d < floor || d > today) continue
      const i = seq.findIndex((x) => x.date === d)
      if (i < 0) continue
      let all = true
      for (const [, s2] of funds) {
        const j = s2.findIndex((x) => x.date === d)
        if (j < 0 || j + horizon >= s2.length) { all = false; break }
      }
      if (all) ok.push(d)
    }
    break
  }
  const uniq = [...new Set(ok)].sort()
  if (uniq.length === 0) return []
  const take = Math.min(count, uniq.length)
  if (take >= uniq.length) return uniq
  const out: string[] = []
  for (let k = 0; k < take; k++) out.push(uniq[Math.round((k * (uniq.length - 1)) / (take - 1))])
  return out
}

export async function runRulesBacktest(
  codesOverride?: string[],
  count = 5,
  recentDays = 30,
  weightsOverrides: Partial<typeof DEFAULT_WEIGHTS> = {}
): Promise<number> {
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
      if (!b) { console.error(`[rules-backtest] ${code} 无 fund_basic，跳过`); continue }
      navMaps.set(code, seq)
      names.set(code, b.name)
    }
    const evalCodes = [...navMaps.keys()]
    if (evalCodes.length === 0) { console.error('没有可评估的基金'); return 1 }

    const sampleDates = pickSampleDates(navMaps, recentDays, count)
    if (sampleDates.length === 0) { console.error('过去30天没有满足未来窗口的采样日'); return 1 }

    const benchNav = await loadBenchmarkNav()
    const benchByDate = new Map(benchNav ? benchNav.map((p) => [p.date, p.nav]) : [])

    const weights = { ...DEFAULT_WEIGHTS, ...weightsOverrides }

    console.log('\n' + '='.repeat(100))
    console.log('规则打分回测（确定性，无 LLM）· 对比纯 LLM 33% 基线')
    console.log('='.repeat(100))
    console.log(`采样日（${sampleDates.length} 个交易日）: ${sampleDates.join(', ')}`)
    console.log(`权重: 动量=${weights.momentum} 形态=${weights.shape} 盘中=${weights.intraday} 新闻=${weights.news} 反趋势=${weights.meanRevert}`)
    console.log(`阈值: add≥+${ADD_THRESHOLD} / reduce≤-${REDUCE_THRESHOLD} · 相对基准：${BENCHMARK_NAME}`)
    console.log('-' .repeat(100))

    interface Row {
      code: string; name: string; asof: string; action: string; conf: number
      momentum: number; shape: number; news: number; total: number
      ret1: number | null; ret5: number | null; bench5: number | null; excess5: number | null
      hit5: boolean | null
    }
    const rows: Row[] = []

    // 单只基金的重仓股名（季报，无时间维度，直接用当前期作近似）
    const stockNamesCache = new Map<string, string[]>()
    async function stockNames(code: string): Promise<string[]> {
      if (stockNamesCache.has(code)) return stockNamesCache.get(code)!
      const r = await pool.query<{ stock_name: string | null }>(
        `SELECT stock_name FROM fund_holdings WHERE fund_code = $1 ORDER BY rank LIMIT 10`,
        [code]
      )
      const out = r.rows.map((x) => x.stock_name).filter((s): s is string => Boolean(s))
      stockNamesCache.set(code, out)
      return out
    }

    for (const asof of sampleDates) {
      for (const code of evalCodes) {
        const seq = navMaps.get(code)!
        const i = seq.findIndex((p) => p.date === asof)
        if (i < 0) continue
        const nav = await navUpTo(pool, code, asof, 120)
        if (nav.length < 21) continue

        // 相对基准超额（截至 asof）
        let excess20: number | null = null
        let excess60: number | null = null
        if (benchByDate.size > 0) {
          const bench = [...benchByDate.entries()].filter(([d]) => d <= asof).sort().map(([date, nav0]) => ({ date, nav: nav0 }))
          const rs = computeRelativeStrength(nav, bench, [20, 60], BENCHMARK_NAME)
          excess20 = rs?.windows[0]?.excess ?? null
          excess60 = rs?.windows[1]?.excess ?? null
        }

        // 新闻（过滤基金名 + 前10重仓股；时间衰减，最长7天）
        const stocks = await stockNames(code)
        const news = await newsUpTo(aiFundPool, names.get(code)!, stocks, asof, 8)
        const asofMs = new Date(asof + 'T15:40:00').getTime()
        const newsSignals = news
          .map((nw) => {
            const pubMs = new Date(nw.pubTime).getTime()
            return {
              text: nw.title ?? '',
              weight: 1,
              daysAgo: Math.max(0, Math.round((asofMs - pubMs) / 86400000))
            }
          })
        const newsScore = aggregateNewsScore(newsSignals, weights.newsLambda)

        // 引擎决策（盘中估值：盘后视角传 null）
        const dec = score({ nav, excess20, excess60, intradayPct: null, news: newsSignals }, weights)

        // 未来窗口（同 backtest 口径）
        const navT = seq[i].nav
        const navT1 = seq[i + 1]?.nav
        const navT5 = seq[i + 5]?.nav
        const ret1 = navT > 0 && navT1 !== undefined ? ((navT1 - navT) / navT) * 100 : null
        const ret5 = navT > 0 && navT5 !== undefined ? ((navT5 - navT) / navT) * 100 : null
        let bench5: number | null = null
        if (ret5 !== null && benchNav) {
          const b = benchByDate.get(asof)
          const bi = benchNav.findIndex((p) => p.date === asof)
          const b5 = bi >= 0 ? benchNav[bi + 5]?.nav : undefined
          if (b && b5 !== undefined && b > 0) bench5 = ((b5 - b) / b) * 100
        }
        const excess5 = ret5 !== null && bench5 !== null ? ret5 - bench5 : null
        const hit5 = dec.action === 'add' ? (ret5 !== null ? ret5 > 0 : null)
          : dec.action === 'reduce' ? (ret5 !== null ? ret5 < 0 : null) : null

        rows.push({ code, name: names.get(code)!, asof, action: dec.action, conf: dec.confidence, momentum: dec.momentum, shape: dec.shape, news: dec.news, total: dec.total, ret1, ret5, bench5, excess5, hit5 })
        console.log(`[${asof}] ${code} ${names.get(code)} → ${CN[dec.action]}（S=${dec.total.toFixed(2)}，置信 ${dec.confidence}）动量=${dec.momentum.toFixed(2)} 形态=${dec.shape.toFixed(2)} 新闻=${newsScore.toFixed(2)} | T+5=${ret5 === null ? '--' : ret5.toFixed(2) + '%'} 超额=${excess5 === null ? '--' : excess5.toFixed(2) + '%'}`)
      }
    }

    // ---------- 汇总 ----------
    console.log('\n' + '='.repeat(100))
    console.log('汇总评估')
    console.log('='.repeat(100))
    if (rows.length === 0) { console.log('没有产生任何样本'); return 1 }

    const avg = (arr: (number | null)[]) => {
      const v = arr.filter((x): x is number => x !== null)
      return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
    }
    const byAction = (a: string) => rows.filter((r) => r.action === a)
    for (const a of ['add', 'reduce', 'hold']) {
      const grp = byAction(a)
      if (grp.length === 0) continue
      const hit = grp.filter((r) => r.hit5 === true).length
      const totalDir = grp.filter((r) => r.hit5 !== null).length
      console.log(`\n[${CN[a]}] ${grp.length} 次${grp.length > 1 ? '（方向命中率 ' + (totalDir ? Math.round((hit / totalDir) * 100) + '%' : '--') + '）' : ''}`)
      console.log(`  平均 T+1 = ${avg(grp.map((r) => r.ret1)) === null ? '--' : (avg(grp.map((r) => r.ret1)) as number).toFixed(2) + '%'}`)
      console.log(`  平均 T+5 = ${avg(grp.map((r) => r.ret5)) === null ? '--' : (avg(grp.map((r) => r.ret5)) as number).toFixed(2) + '%'}  平均超额(T+5) = ${avg(grp.map((r) => r.excess5)) === null ? '--' : (avg(grp.map((r) => r.excess5)) as number).toFixed(2) + '%'}`)
    }

    const dir = rows.filter((r) => r.hit5 !== null)
    const dirHit = dir.filter((r) => r.hit5 === true)
    console.log(`\n整体方向命中率（add 后涨 / reduce 后跌，T+5）：${dir.length ? Math.round((dirHit.length / dir.length) * 100) + '%' : '--'}（${dirHit.length}/${dir.length}） | 纯 LLM 基线 = 33%`)

    // 信号方向命中率：无论阈值，直接按 S 符号当方向预测与 T+5 对比
    // （检验"信号本身能否给出方向"，而非"阈值选得对不对"）
    const sig = (g: Row[]): number | null => {
      const hit = g.filter((r) => r.ret5 !== null && ((r.total > 0 && r.ret5! > 0) || (r.total < 0 && r.ret5! < 0))).length
      return g.length ? Math.round((hit / g.length) * 100) : null
    }
    const sigPos = rows.filter((r) => r.total > 0)
    const sigNeg = rows.filter((r) => r.total < 0)
    console.log(`\n[信号方向命中率，T+5] 全部=${sig(rows) === null ? '--' : sig(rows) + '%'}（${rows.length}）｜ S>0(看涨) ${sig(sigPos) === null ? '--' : sig(sigPos) + '%'}（${sigPos.length}）｜ S<0(看跌) ${sig(sigNeg) === null ? '--' : sig(sigNeg) + '%'}（${sigNeg.length}）`)
    const excessPos = avg(sigPos.map((r) => r.excess5))
    const excessNeg = avg(sigNeg.map((r) => r.excess5))
    console.log(`[S>0 平均超额T+5] ${excessPos === null ? '--' : excessPos.toFixed(2) + '%'} ｜ [S<0 平均超额T+5] ${excessNeg === null ? '--' : excessNeg.toFixed(2) + '%'}`)

    // ---- 反转口径：信号已是反指 → 反着用（S>0 押跌 / S<0 押涨），看能否转正 ----
    {
      const revAll = rows.filter((r) => r.ret5 !== null)
      const revHit = revAll.filter((r) => (r.total > 0 ? r.ret5! < 0 : r.ret5! > 0)).length
      console.log(`\n[反转口径命中率，T+5] 全部=${revAll.length ? Math.round((revHit / revAll.length) * 100) + '%' : '--'}（${revHit}/${revAll.length}）｜ 反转后平均超额=${avg(revAll.map((r) => r.excess5)) === null ? '--' : (avg(revAll.map((r) => r.excess5)) as number).toFixed(2) + '%'}`)
    }

    // ---- 反转口径阈值扫描：|S| 越强信号越强，看反转命中是否随阈值抬升 ----
    console.log('\n[反转口径阈值扫描，T+5] S>0 押跌 / S<0 押涨：')
    for (const t of [0.3, 0.6, 1.0, 1.4]) {
      const g = rows.filter((r) => r.ret5 !== null && Math.abs(r.total) >= t)
      if (!g.length) { console.log(`   |S|≥${t}: 无样本`); continue }
      const rev = g.filter((x) => (x.total > 0 ? x.ret5! < 0 : x.ret5! > 0)).length
      const ex = avg(g.map((x) => x.excess5))
      console.log(`   |S|≥${t}: ${g.length} 样本｜反转命中 ${Math.round((rev / g.length) * 100)}%｜平均超额 ${ex === null ? '--' : ex.toFixed(2) + '%'}`)
    }

    // ---- 权重敏感性：确认"调权重能否脱离随机/反指"（meanRevert 归零，纯分量对比） ----
    {
      const variants: { name: string; mtm: number; shp: number; nws: number }[] = [
        { name: '纯动量', mtm: 1, shp: 0, nws: 0 },
        { name: '动量主导', mtm: 0.6, shp: 0.15, nws: 0.25 },
        { name: '形态主导', mtm: 0.2, shp: 0.6, nws: 0.2 },
        { name: '新闻主导', mtm: 0.2, shp: 0.2, nws: 0.6 }
      ]
      console.log('\n[权重敏感性 @ meanRevert=0，T+5] 看涨命中 ｜ 看跌命中 ｜ 反向全命中 ｜ 平均超额')
      for (const v of variants) {
        const wSum = v.mtm + v.shp + v.nws
        if (wSum <= 0) continue
        const sc = rows.filter((r) => r.ret5 !== null).map((r) => {
          const base = (r.momentum * v.mtm + r.shape * v.shp + r.news * v.nws) / wSum
          return { r, base }
        })
        const pos = sc.filter((x) => x.base > 0)
        const neg = sc.filter((x) => x.base < 0)
        const fwd = (g: typeof sc) => (g.length ? Math.round((g.filter((x) => (x.base > 0 ? x.r.ret5! > 0 : x.r.ret5! < 0)).length / g.length) * 100) : null)
        const rev = sc.length ? Math.round((sc.filter((x) => (x.base > 0 ? x.r.ret5! < 0 : x.r.ret5! > 0)).length / sc.length) * 100) : null
        const ex = avg(sc.map((x) => x.r.excess5))
        console.log(`   ${v.name}(m${v.mtm}/s${v.shp}/n${v.nws}): 看涨 ${fwd(pos) === null ? '--' : fwd(pos) + '%'}（${pos.length}）｜看跌 ${fwd(neg) === null ? '--' : fwd(neg) + '%'}（${neg.length}）｜反向 ${rev === null ? '--' : rev + '%'}｜超额 ${ex === null ? '--' : ex.toFixed(2) + '%'}`)
      }
    }

    // 命中率随总分布：看规则是否把"低分更准"体现出来
    const hitRate = (g: Row[]) => (g.length ? Math.round((g.filter((r) => r.hit5 === true).length / g.length) * 100) : null)
    const hi = dir.filter((r) => r.conf >= 70)
    const lo = dir.filter((r) => r.conf < 70)
    console.log(`置信度分层（T+5）：高置信(≥70) ${hitRate(hi) === null ? '--' : hitRate(hi) + '%'}（${hi.filter((r) => r.hit5 === true).length}/${hi.length}）｜低置信(<70) ${hitRate(lo) === null ? '--' : hitRate(lo) + '%'}（${lo.filter((r) => r.hit5 === true).length}/${lo.length}）`)

    console.log('\n完整样本（asof | 基金 | 建议 | S | T+1 | T+5 | 基准T+5 | 超额T+5）：')
    for (const r of rows) {
      console.log(`  ${r.asof} | ${r.code} ${r.name} | ${CN[r.action]} | ${r.total.toFixed(2)} | ${r.ret1 === null ? '--' : r.ret1.toFixed(2) + '%'} | ${r.ret5 === null ? '--' : r.ret5.toFixed(2) + '%'} | ${r.bench5 === null ? '--' : r.bench5.toFixed(2) + '%'} | ${r.excess5 === null ? '--' : r.excess5.toFixed(2) + '%'}`)
    }
    return 0
  } finally {
    await pool.end().catch(() => {})
    await aiFundPool.end().catch(() => {})
  }
}