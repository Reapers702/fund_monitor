// 模拟交易回测（paper trading / portfolio simulation）—— 检验"按规则引擎信号实际调仓能否赚钱"
//
// 背景：现有回测（backtest/rulesBacktest/rotateBacktest）只统计"建议 vs 未来 T+1/T+5 涨跌"的方向命中率
//       （已证伪 ≈50%），但从不模拟"按建议实际调仓、连续持有一段时间"后的真实收益。
//       场外基金是 T 日按净值申购、T+1 确认，赎回还要到账，根本不是 T+1 卖光。
//       单日命中率≈50% 推不出真实收益≈0，因为漏掉了：买卖数量/仓位、连续调仓的复利、对比基准。
//
// 口径（与用户确认）：
//   - 信号源 = 规则引擎 score()（确定性、无随机、可复现）；引擎无 suggestedPct，故用固定档位：
//     add +addPct、reduce -reducePct、hold 不动，Σ 权重≤1，其余放现金。
//   - 成交时点 = T 日收盘净值（盘后视角，建议当日净值即成交价，无前视）。
//   - 无前视：每决策日 T 只见 T 及之前信息（复用 backtestUtil 同一套 asof 取数）。
//   - 对比"买入持有不动"和"空仓"两个基准。
import { loadConfig } from './config'
import { createPool, createAiFundPool } from './storage/db'
import { computeRelativeStrength, periodReturnPct, annualizedReturnPct, maxDrawdownPct } from './analyzer/metrics'
import { loadBenchmarkNav, BENCHMARK_NAME } from './crawler/benchmark'
import { score, DEFAULT_WEIGHTS, ADD_THRESHOLD, REDUCE_THRESHOLD } from './scorer/engine'
import type { ScorerWeights } from './scorer/engine'
import { navUpTo, navDatesAll, basic, newsUpTo } from './backtestUtil'

const CN: Record<string, string> = { add: '加仓', reduce: '减仓', hold: '持有' }

export interface SimOptions {
  codes: string[]
  capital: number // 初始资金，默认 100_000
  rangeDays: number // 区间共同交易日数（从末端往前数），默认 500
  step: number // 决策步长（共同交易日间隔），默认 5
  addPct: number // add 档位，默认 0.2
  reducePct: number // reduce 档位，默认 0.2
  addThresh?: number // 加仓阈值覆盖（默认 engine 的 2.0），仅供回测透传
  reduceThresh?: number // 减仓阈值覆盖（默认 engine 的 -2.0），仅供回测透传
  feeBuy: number // 申购费率（买入金额计），默认 0.15%
  feeSell: number // 赎回费率（卖出金额计），默认 0.5%
  weightsOverrides?: Partial<ScorerWeights>
}

export interface SimSample {
  asof: string
  code: string
  name: string
  action: 'add' | 'reduce' | 'hold'
  conf: number
  total: number
  retT1: number | null // 决策后第 1 个共同交易日涨跌（末端不足为 null）
  retT5: number | null // 决策后第 5 个共同交易日涨跌（末端不足为 null）
  hit5: boolean | null // add 后涨 / reduce 后跌（口径同 rulesBacktest）；非 add/reduce 为 null
  targetWeightAfter: number // 决策后的目标权重
}

export interface PortfolioMark {
  date: string
  totalValue: number // 策略组合市值（现金 + Σ持仓）
  buyHoldValue: number // 买入持有基准（同起点等权全仓、此后不动）
  turnover: number | null // 该日名义换手额（决策日有值，其余 null）
}

export interface SimResult {
  tradingDays: number
  decisionCount: number
  strategy: {
    totalReturnPct: number | null
    annualizedReturnPct: number | null
    maxDrawdownPct: number | null
    cashWeightEnd: number
    totalTurnover: number | null
  }
  buyHold: { totalReturnPct: number | null; annualizedReturnPct: number | null; maxDrawdownPct: number | null }
  fundContrib: { code: string; name: string; contribPct: number | null }[]
  hitRateReport: { sampleCnt: number; hitRate: number | null }
  marks: PortfolioMark[]
  samples: SimSample[]
}

const fmtPct = (v: number | null): string => (v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)

export async function runSimBacktest(opts: SimOptions): Promise<number> {
  const cfg = loadConfig()
  const pool = createPool(cfg)
  const aiFundPool = createAiFundPool(cfg)
  try {
    // ---- 基金集合 ----
    let codes = opts.codes
    if (!codes || codes.length === 0) {
      const r = await pool.query<{ fund_code: string }>(
        `SELECT f.fund_code FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
         WHERE uf.user_id = $1 AND uf.is_active = 1 ORDER BY f.fund_code`,
        [cfg.currentUserId]
      )
      codes = r.rows.map((x) => x.fund_code)
    }

    const names = new Map<string, string>()
    const allNav = new Map<string, { date: string; nav: number }[]>()
    for (const code of codes) {
      const [b, seq] = await Promise.all([basic(pool, code), navDatesAll(pool, code)])
      if (!b) { console.error(`[sim] ${code} 无 fund_basic，跳过`); continue }
      if (seq.length === 0) { console.error(`[sim] ${code} 无净值，跳过`); continue }
      names.set(code, b.name)
      allNav.set(code, seq)
    }
    const evalCodes = [...names.keys()]
    if (evalCodes.length === 0) { console.error('[sim] 没有可模拟的基金'); return 1 }

    // ---- 共同交易日轴（只取所有基金共同存在的净值日） ----
    const commonSet = new Set(allNav.get(evalCodes[0])!.map((p) => p.date))
    for (const code of evalCodes) {
      const set = new Set(allNav.get(code)!.map((p) => p.date))
      for (const d of commonSet) if (!set.has(d)) commonSet.delete(d)
    }
    const commonAll = [...commonSet].sort()
    const axis = commonAll.slice(-opts.rangeDays)
    if (axis.length < 21) { console.error('[sim] 共同交易日本不足，无法模拟'); return 1 }
    const startDate = axis[0]
    const endDate = axis[axis.length - 1]

    // ---- 参数 ----
    const addPct = opts.addPct > 0 ? opts.addPct : 0
    const reducePct = opts.reducePct > 0 ? opts.reducePct : 0
    const feeBuy = opts.feeBuy > 0 ? opts.feeBuy : 0
    const feeSell = opts.feeSell > 0 ? opts.feeSell : 0
    const step = Math.max(1, Math.round(opts.step) || 5)
    const weights: ScorerWeights = { ...DEFAULT_WEIGHTS, ...(opts.weightsOverrides ?? {}) }
    // 决策阈值：加仓阈值/减仓阈值取透传值，缺省回落 engine 常量
    const addThresh = opts.addThresh !== undefined ? opts.addThresh : ADD_THRESHOLD
    const reduceThresh = opts.reduceThresh !== undefined ? opts.reduceThresh : REDUCE_THRESHOLD

    // code -> 完整净值按 date 建索引（未来窗口用）
    const navIdx = new Map<string, Map<string, number>>()
    for (const code of evalCodes) {
      const m = new Map<string, number>()
      allNav.get(code)!.forEach((p, i) => m.set(p.date, i))
      navIdx.set(code, m)
    }

    // ---- 组合状态 ----
    const shares = new Map<string, number>()
    const targetWeight = new Map<string, number>()
    const costBasis = new Map<string, number>() // 累计净投入（建仓+买入，卖出冲减，近似）
    let cash = 0

    // ---- 买入持有基准：起点等权全仓、此后不动 ----
    const bhShares = new Map<string, number>()

    const samples: SimSample[] = []
    const marks: PortfolioMark[] = []
    const lastNav = new Map<string, number>()
    let decisionCount = 0
    let totalTurnover = 0
    let totalBuyAmt = 0
    let totalSellAmt = 0 // 累计单边申购/赎回金额（算总费用用）

    const navAt = (code: string, date: string): number | null => allNav.get(code)!.find((p) => p.date === date)?.nav ?? null

    // 决策日集合（共同交易日索引）；axis[0]（建仓日）一定在内
    const decisionIdx = new Set<number>()
    for (let i = 0; i < axis.length; i += step) decisionIdx.add(i)
    decisionIdx.add(0)

    console.log('\n' + '='.repeat(100))
    console.log('模拟交易回测（paper trading）· 按规则引擎信号连续调仓看累计收益')
    console.log('='.repeat(100))
    console.log(`基金（${evalCodes.length} 只）: ${evalCodes.map((c) => `${c} ${names.get(c)}`).join('、')}`)
    console.log(`区间：${startDate} ~ ${endDate}（共同交易日 ${axis.length} 个），初始资金 ¥${opts.capital.toLocaleString()}`)
    console.log(`决策步长：每 ${step} 个共同交易日｜档位 add+${Math.round(addPct * 100)}% / reduce-${Math.round(reducePct * 100)}% ｜阈值 add≥+${addThresh} / reduce≤${reduceThresh} ｜费率 申购${Math.round(feeBuy * 10000) / 100}% / 赎回${Math.round(feeSell * 10000) / 100}%`)
    console.log('-' .repeat(100))

    for (let ai = 0; ai < axis.length; ai++) {
      const date = axis[ai]
      // 共同交易日必有净值，直接更新 lastNav
      for (const code of evalCodes) {
        const n = navAt(code, date)
        if (n !== null) lastNav.set(code, n)
      }

      // 建仓：起点等权全仓
      if (ai === 0) {
        const active = evalCodes.filter((c) => lastNav.has(c))
        const w0 = active.length ? 1 / active.length : 0
        for (const code of active) {
          const n = lastNav.get(code)!
          const mv = opts.capital * w0
          shares.set(code, mv / n)
          targetWeight.set(code, w0)
          costBasis.set(code, mv)
          bhShares.set(code, mv / n)
        }
        cash = opts.capital * (1 - w0 * active.length) // 理论上 0
        // 建仓即一次满仓申购，计申购费
        cash -= opts.capital * w0 * active.length * feeBuy
        totalBuyAmt += opts.capital * w0 * active.length
        decisionCount++
        totalTurnover += opts.capital // 建仓名义换手 = 满仓资金
      }

      // 决策日调仓（非建仓日）
      if (decisionIdx.has(ai) && ai !== 0) {
        decisionCount++
        // 对每只基金出信号，更新目标权重
        for (const code of evalCodes) {
          if (!lastNav.has(code)) continue
          const navHist = await navUpTo(pool, code, date, 120)
          if (navHist.length < 21) continue // 取数不足，权重不动

          let excess20: number | null = null
          let excess60: number | null = null
          try {
            const benchNav = await loadBenchmarkNav()
            const bench = benchNav ? benchNav.filter((p) => p.date <= date) : []
            if (bench.length > 0) {
              const rs = computeRelativeStrength(navHist, bench, [20, 60], BENCHMARK_NAME)
              excess20 = rs?.windows[0]?.excess ?? null
              excess60 = rs?.windows[1]?.excess ?? null
            }
          } catch { /* 基准取不到则超额为 null */ }

          const news = await newsUpTo(aiFundPool, names.get(code)!, [], date, 8)
          const asofMs = new Date(date + 'T15:40:00').getTime()
          const newsSignals = news.map((nw) => {
            const pubMs = new Date(nw.pubTime).getTime()
            return { text: nw.title ?? '', weight: 1, daysAgo: Math.max(0, Math.round((asofMs - pubMs) / 86400000)) }
          })

          const dec = score({ nav: navHist, excess20, excess60, intradayPct: null, news: newsSignals }, weights, { add: addThresh, reduce: reduceThresh })
          const act = dec.action as 'add' | 'reduce' | 'hold'
          const prev = targetWeight.get(code) ?? 0
          const next = act === 'add' ? prev + addPct : act === 'reduce' ? prev - reducePct : prev
          targetWeight.set(code, Math.max(0, Math.min(1, next)))

          // 未来窗口
          let retT1: number | null = null
          let retT5: number | null = null
          let hit5: boolean | null = null
          const ci = navIdx.get(code)!.get(date)
          if (ci !== undefined) {
            const full = allNav.get(code)!
            const base = full[ci].nav
            const n1 = full[ci + 1]?.nav
            const n5 = full[ci + 5]?.nav
            if (base > 0 && n1 !== undefined) retT1 = ((n1 - base) / base) * 100
            if (base > 0 && n5 !== undefined) retT5 = ((n5 - base) / base) * 100
            if (act === 'add') hit5 = retT5 !== null ? retT5 > 0 : null
            else if (act === 'reduce') hit5 = retT5 !== null ? retT5 < 0 : null
          }
          samples.push({ asof: date, code, name: names.get(code)!, action: act, conf: dec.confidence, total: dec.total, retT1, retT5, hit5, targetWeightAfter: targetWeight.get(code)! })
        }

        // Σ 权重 ≤ 1（溢出则等比例归一，现金 0）
        let wSum = 0
        for (const code of evalCodes) wSum += targetWeight.get(code) ?? 0
        const norm = wSum > 1
        if (norm) {
          for (const code of evalCodes) targetWeight.set(code, (targetWeight.get(code) ?? 0) / wSum)
        }

        // 按 T 日净值成交：先重估组合现值，再调到目标权重
        let totalValue = cash
        for (const code of evalCodes) totalValue += (shares.get(code) ?? 0) * (lastNav.get(code) ?? 0)
        let turnover = 0
        let buyAmt = 0
        let sellAmt = 0 // 本决策日单边买入/卖出金额（计费用）
        for (const code of evalCodes) {
          const n = lastNav.get(code)
          if (!n) continue
          const w = targetWeight.get(code) ?? 0
          const targetMV = totalValue * w
          const oldMV = (shares.get(code) ?? 0) * n
          const delta = oldMV - targetMV // >0 卖出回笼 / <0 买入支出
          shares.set(code, n > 0 ? targetMV / n : 0)
          cash += delta
          turnover += Math.abs(delta)
          // 成本基准（净投入）：买入加、卖出减，**不截断**。
          // 浮盈清仓时（成本100/市值150/全卖）净投入应变成 -50，把 +50 剩余市值差留作已实现贡献，
          // 以保证 cash + ΣcostBasis ≡ capital - 总费用 恒等（Σ贡献才能自洽=策略收益）。
          if (delta < 0) {
            costBasis.set(code, (costBasis.get(code) ?? 0) - delta)
            buyAmt += -delta
          } else {
            costBasis.set(code, (costBasis.get(code) ?? 0) - delta)
            sellAmt += delta
          }
        }
        // 单边费率：申购按买入额、赎回按卖出额
        cash -= buyAmt * feeBuy
        cash -= sellAmt * feeSell
        totalBuyAmt += buyAmt
        totalSellAmt += sellAmt
        totalTurnover += turnover
      }

      // 记录市值点
      let tv = cash
      for (const code of evalCodes) tv += (shares.get(code) ?? 0) * (lastNav.get(code) ?? 0)
      let bh = 0
      for (const code of evalCodes) bh += (bhShares.get(code) ?? 0) * (lastNav.get(code) ?? 0)
      marks.push({ date, totalValue: tv, buyHoldValue: bh, turnover: decisionIdx.has(ai) ? totalTurnover : null })
    }

    // ---- 汇总 ----
    console.log('\n' + '='.repeat(100))
    console.log('汇总评估')
    console.log('='.repeat(100))
    if (marks.length === 0) { console.log('没有产生任何市值点'); return 1 }

    const stratVals = marks.map((m) => m.totalValue)
    const bhVals = marks.map((m) => m.buyHoldValue)
    const stratReturn = periodReturnPct(stratVals)
    const bhReturn = periodReturnPct(bhVals)
    const tradingDays = axis.length

    const cashEnd = cash
    const strat: SimResult['strategy'] = {
      totalReturnPct: stratReturn,
      annualizedReturnPct: annualizedReturnPct(stratReturn, tradingDays),
      maxDrawdownPct: maxDrawdownPct(stratVals),
      cashWeightEnd: opts.capital > 0 ? cashEnd / opts.capital : 0,
      totalTurnover
    }
    const bh = { totalReturnPct: bhReturn, annualizedReturnPct: annualizedReturnPct(bhReturn, tradingDays), maxDrawdownPct: maxDrawdownPct(bhVals) }

    const dir = samples.filter((s) => s.hit5 !== null)
    const dirHit = dir.filter((s) => s.hit5 === true).length

    const fundContrib: { code: string; name: string; contribPct: number | null }[] = []
    for (const code of evalCodes) {
      const endMV = (shares.get(code) ?? 0) * (lastNav.get(code) ?? 0)
      const cb = costBasis.get(code) ?? 0
      fundContrib.push({ code, name: names.get(code)!, contribPct: opts.capital > 0 ? ((endMV - cb) / opts.capital) * 100 : null })
    }

    console.log(`\n【策略】（step=${step}, add±${Math.round(addPct * 100)}%, thresh≥+${addThresh}/${reduceThresh}, 申购${Math.round(feeBuy * 10000) / 100}%/赎回${Math.round(feeSell * 10000) / 100}%）`)
    console.log(`  累计收益 ${fmtPct(strat.totalReturnPct)} ｜ 年化 ${fmtPct(strat.annualizedReturnPct)} ｜ 最大回撤 ${fmtPct(strat.maxDrawdownPct)} ｜ 期末现金占比 ${(strat.cashWeightEnd * 100).toFixed(1)}%`)
    console.log(`  决策 ${decisionCount} 次 ｜ 总换手 ¥${totalTurnover.toLocaleString()}（≈${((totalTurnover / opts.capital) * 100).toFixed(0)}% 初始资金）`)
    console.log('\n【买入持有基准】（起点等权全仓，此后不动）')
    console.log(`  累计收益 ${fmtPct(bh.totalReturnPct)} ｜ 年化 ${fmtPct(bh.annualizedReturnPct)} ｜ 最大回撤 ${fmtPct(bh.maxDrawdownPct)}`)
    console.log('\n【空仓基准】累计收益 0.00%（现金无收益）')
    console.log('\n【动作分布】' + (Object.keys(CN) as (keyof typeof CN)[]).map((a) => `${CN[a]} ×${samples.filter((s) => s.action === a).length}`).join(' ｜ '))

    const sumContrib = fundContrib.reduce((s, f) => s + (f.contribPct ?? 0), 0)
    // 自洽校验：Σ(endMV - costBasis) = totalValueEnd - capital + 总费用，故 策略收益 = Σ贡献 - 费用%
    const totalFeePct = opts.capital > 0 ? ((totalBuyAmt * feeBuy + totalSellAmt * feeSell) / opts.capital) * 100 : 0
    console.log('\n【每基金贡献】（分解，(期末市值-净投入)/初始资金；不截断净投入以保自洽）')
    for (const f of fundContrib) console.log(`  ${f.code} ${f.name}: ${fmtPct(f.contribPct)}`)
    console.log(`  Σ 贡献 ${fmtPct(sumContrib)} ｜ 总费用 ${fmtPct(totalFeePct)} ｜ 策略 ${fmtPct(strat.totalReturnPct)}（校验：Σ贡献 ± 费用 ≈ 策略）`)

    console.log('\n【方向命中率 vs 模拟累计收益（并列）】')
    console.log(`  方向命中率（T+5，决策样本，add后涨/reduce后跌）: ${dir.length ? Math.round((dirHit / dir.length) * 100) + '%' : '--'}（${dirHit}/${dir.length}）  ← 与 rulesBacktest 同口径`)
    console.log(`  模拟累计收益（step=${step}, add±${Math.round(addPct * 100)}%, thresh≥+${addThresh}/${reduceThresh}, 申购${Math.round(feeBuy * 10000) / 100}%/赎回${Math.round(feeSell * 10000) / 100}%）: ${fmtPct(strat.totalReturnPct)} ｜ 年化 ${fmtPct(strat.annualizedReturnPct)} ｜ 买入持有 ${fmtPct(bh.totalReturnPct)} ｜ 现金 0%`)
    console.log('  注：命中率只看单次方向（≈随机 50%）；模拟收益整合了调仓频率/幅度/现金占比/交易损耗/连续复利——命中率高不一定赚钱（高频瞎换、长期空仓都会脱钩），并列才能回答「建议能否用来赚钱」。')

    console.log('\n【净值曲线抽样】（日期 | 策略 | 买入持有 | 空仓），单位累计收益 %：')
    const stepMark = Math.max(1, Math.floor(marks.length / 20))
    for (let i = 0; i < marks.length; i += stepMark) {
      const m = marks[i]
      const s = opts.capital > 0 ? ((m.totalValue - opts.capital) / opts.capital) * 100 : null
      const b = opts.capital > 0 ? ((m.buyHoldValue - opts.capital) / opts.capital) * 100 : null
      console.log(`  ${m.date} | ${fmtPct(s)} | ${fmtPct(b)} | 0.00%`)
    }

    console.log(`\n[结论] 模拟只把规则信号按固定档位调仓，费率（申购${Math.round(feeBuy * 10000) / 100}%/赎回${Math.round(feeSell * 10000) / 100}%）、现金无收益；与买入持有/空仓对比看信号是否真创造 alpha。样本有限，注意置信区间。`)
    return 0
  } finally {
    await pool.end().catch(() => {})
    await aiFundPool.end().catch(() => {})
  }
}