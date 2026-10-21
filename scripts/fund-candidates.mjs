/**
 * C 类基金候选池（数据驱动筛选工具）
 *
 * 做什么：
 *   1. 从本地 index_valuation 读出**估值分位最低的若干指数**（客观数据，非推荐）
 *   2. 拉取全市场基金列表（约 2.8 万只，一次请求），本地筛出 **C 类指数基金**，
 *      再与指数名匹配 —— 比"逐个指数去搜索"覆盖更全、请求更少，也不会因搜索词不巧而漏掉候选
 *   3. --detail 时抓 pingzhongdata 补充**最新规模**与申购费率（C 类应为 0）
 *   4. 输出候选清单（表格 + 可选 Markdown 文件），由你自己挑选
 *
 * ⚠️ 不做什么（重要）：
 *   本工具**不给投资建议**——不判断"该不该买"、不排序"哪只最好"、不给目标仓位。
 *   估值分位低 ≠ 会涨（本地 AI 分析就出现过"PE 分位 0% 但仍判 hold"的情形）。
 *   输出只是把客观字段摆在一起，决策由你自己做；**销售服务费（C 类的核心成本）本工具取不到**，需自行核实。
 *
 * 用法：
 *   node scripts/fund-candidates.mjs                        # 低估指数 Top10，各列 C 类候选
 *   node scripts/fund-candidates.mjs --top 20               # 覆盖更多指数
 *   node scripts/fund-candidates.mjs --index 证券公司,中证医疗  # 指定指数（名称需与估值源一致）
 *   node scripts/fund-candidates.mjs --detail               # 抓规模/费率（每指数前 3 只，请求较多）
 *   node scripts/fund-candidates.mjs --out .tmp-cand/candidates.md
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fundPool } from './diagnose-prompt-data.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const GAP_MS = 350 // 对数据源保持低频
const CACHE = '.tmp-cand/fundcode_search.json'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let lastReq = 0
async function get(url) {
  const gap = GAP_MS - (Date.now() - lastReq)
  if (gap > 0) await sleep(gap)
  lastReq = Date.now()
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, Referer: 'https://fund.eastmoney.com/' },
    signal: AbortSignal.timeout(20000)
  })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

const argv = process.argv.slice(2)
const argOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
const topN = Number(argOf('--top') ?? 10)
const wantDetail = argv.includes('--detail')
const outFile = argOf('--out')
const explicitIndexes = argOf('--index')
  ?.split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const maxPerIndex = Number(argOf('--max') ?? 6)

// ---------- 1. 取"低估指数"作为筛选方向（本地估值库，客观数据） ----------
let targets
if (explicitIndexes?.length) {
  const r = await fundPool.query(
    `SELECT index_name, pe_percentile, pb_percentile FROM index_valuation
     WHERE trade_date = (SELECT max(trade_date) FROM index_valuation) AND index_name = ANY($1)`,
    [explicitIndexes]
  )
  targets = explicitIndexes.map(
    (n) =>
      r.rows.find((x) => x.index_name === n) ?? {
        index_name: n,
        pe_percentile: null,
        pb_percentile: null
      }
  )
} else {
  const r = await fundPool.query(
    `SELECT index_name, pe_percentile, pb_percentile FROM index_valuation
     WHERE trade_date = (SELECT max(trade_date) FROM index_valuation)
       AND pe_percentile IS NOT NULL AND pe > 0
     ORDER BY pe_percentile ASC, pb_percentile ASC LIMIT $1`,
    [topN]
  )
  targets = r.rows
}
console.log(`筛选方向：${targets.length} 个估值分位偏低的指数\n`)

// ---------- 2. 全市场基金列表（带本地缓存） ----------
async function loadAllFunds() {
  if (existsSync(CACHE)) {
    const age = (Date.now() - Number(readFileSync(CACHE + '.ts', 'utf8').trim())) / 3600_000
    if (age < 24) {
      console.log(`使用缓存的全市场基金列表（${age.toFixed(1)} 小时前）`)
      return JSON.parse(readFileSync(CACHE, 'utf8'))
    }
  }
  console.log('拉取全市场基金列表…')
  const text = await get('https://fund.eastmoney.com/js/fundcode_search.js')
  const m = text.match(/\[.*\]/s)
  if (!m) throw new Error('基金列表解析失败')
  // 原始格式: [代码, 拼音缩写, 名称, 类型, 拼音全称]
  const list = JSON.parse(m[0]).map((x) => ({ code: x[0], name: x[2], type: x[3] }))
  mkdirSync(dirname(CACHE), { recursive: true })
  writeFileSync(CACHE, JSON.stringify(list))
  writeFileSync(CACHE + '.ts', String(Date.now()))
  console.log(`共 ${list.length} 只基金\n`)
  return list
}

const allFunds = await loadAllFunds()

/** C 类判断：名称以 C / C类 结尾 */
const isCClass = (name) => /C(类)?$/.test(name.trim())
/** 指数基金特征 */
const isIndexFund = (name) => /ETF联接|指数|ETF|LOF/.test(name)
const cIndexFunds = allFunds.filter((f) => isCClass(f.name) && isIndexFund(f.name))
console.log(`其中 C 类指数基金：${cIndexFunds.length} 只\n`)

/** 由指数名派生匹配关键词（指数名与基金名常不完全一致） */
function keywordsOf(indexName) {
  const noNum = indexName.replace(/[0-9]+$/, '') // 中概互联50 → 中概互联
  const stripped = noNum.replace(
    /^(中证|国证|全指|沪深|上证|深证|恒生|标普|MSCI|央视|基本面|主要)/,
    ''
  )
  return [...new Set([indexName, noNum, stripped].filter((s) => s && s.length >= 2))]
}

// ---------- 3. 匹配 ----------
const results = []
for (const t of targets) {
  const kws = keywordsOf(t.index_name)
  const cands = cIndexFunds.filter((f) => kws.some((k) => f.name.includes(k))).slice(0, maxPerIndex)
  results.push({
    指数: t.index_name,
    PE分位: t.pe_percentile === null ? null : Math.round(t.pe_percentile * 1000) / 10,
    PB分位: t.pb_percentile === null ? null : Math.round(t.pb_percentile * 1000) / 10,
    候选: cands.map((c) => ({ ...c }))
  })
}

// ---------- 4. 可选：补规模/费率（每指数前 3 只，控制请求量） ----------
if (wantDetail) {
  console.log('抓取规模/费率（每指数前 3 只）…')
  for (const r of results) {
    for (const c of r.候选.slice(0, 3)) {
      try {
        const t = await get(`https://fund.eastmoney.com/pingzhongdata/${c.code}.js`)
        // 注意：这里不要对整段做「去引号」——Data_fluctuationScale 是 JSON 字面量，
        // 全局 replace(/"/g,'') 会把 JSON 的键和字符串引号一起删掉，导致 parse 失败。
        // 只对费率/金额这类带引号的标量单独去引号。
        const pickRaw = (n) =>
          t.match(new RegExp(`var\\s+${n}\\s*=\\s*([^;]*);`))?.[1]?.trim() ?? ''
        const s = JSON.parse(pickRaw('Data_fluctuationScale') || '{}')
        c.scale = s.series?.[s.series.length - 1]?.y ?? null
        c.scaleDate = s.categories?.[s.categories.length - 1] ?? null
        c.buyRate = pickRaw('fund_Rate').replace(/"/g, '') || null
        c.minBuy = pickRaw('fund_minsg').replace(/"/g, '') || null
      } catch {
        /* 单只失败不影响整体 */
      }
    }
  }
}

// ---------- 5. 输出 ----------
console.log('\n\n===== C 类指数基金候选（按"估值分位偏低的指数"分组；非投资建议）=====')
for (const r of results) {
  console.log(`\n【${r.指数}】PE 分位 ${r.PE分位 ?? '--'}% ｜ PB 分位 ${r.PB分位 ?? '--'}%`)
  if (r.候选.length === 0) {
    console.log('  （全市场 C 类指数基金中未匹配到该指数，可能确实没有场外 C 类产品）')
    continue
  }
  console.table(
    r.候选.map((c) => ({
      代码: c.code,
      名称: c.name,
      规模亿: c.scale ?? '--',
      规模截止: c.scaleDate ?? '--',
      申购费率: c.buyRate ?? '--',
      起购元: c.minBuy ?? '--'
    }))
  )
}

console.log(
  '\n提示：C 类免申购费但按日计提销售服务费（通常 0.2%~0.8%/年，本工具取不到，需自行核实）；\n' +
    '持有 <7 天赎回费 1.5%（惩罚性）；规模过小（如 <2 亿）有清盘风险；ETF 联接基金与 ETF 有细微跟踪差异。\n' +
    '估值分位低 ≠ 会涨。以上仅为客观字段罗列，不构成投资建议。'
)

if (outFile) {
  mkdirSync(dirname(outFile), { recursive: true })
  const lines = [
    `# C 类基金候选池（生成于 ${new Date().toISOString()}）`,
    '',
    '> 数据驱动筛选，**非投资建议**。估值分位低 ≠ 会涨；销售服务费需自行核实。',
    ''
  ]
  for (const r of results) {
    lines.push(`## ${r.指数}（PE 分位 ${r.PE分位 ?? '--'}%｜PB 分位 ${r.PB分位 ?? '--'}%）`, '')
    if (r.候选.length === 0) {
      lines.push('（未匹配到场外 C 类产品）', '')
      continue
    }
    lines.push(
      '| 代码 | 名称 | 规模(亿) | 规模截止 | 申购费率 | 起购(元) |',
      '|---|---|---|---|---|---|'
    )
    for (const c of r.候选) {
      lines.push(
        `| ${c.code} | ${c.name} | ${c.scale ?? '--'} | ${c.scaleDate ?? '--'} | ${c.buyRate ?? '--'} | ${c.minBuy ?? '--'} |`
      )
    }
    lines.push('')
  }
  writeFileSync(outFile, lines.join('\n'))
  console.log(`\n已写入：${resolve(outFile)}`)
}

await fundPool.end().catch(() => {})
