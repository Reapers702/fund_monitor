/**
 * 同日 A/B 对比：同一批基金、同一天的数据，用「改动前」与「改动后」两版**真实代码**各问一次 AI，
 * 检查两个未 push 的 commit 新增的信息是否真的改变了建议、以及理由是否用上了新数据。
 *
 * 为什么必须"同日"而不是历史回测：
 *   - 板块估值分位（index_valuation）只有最近 8 个交易日快照（2026-09-27 起）。
 *     2 个月前根本不存在当时的估值分位，用今天的值去套历史 = 未来信息穿越，结果必然虚高。
 *     而"今天用今天的估值分位"完全合法 —— 所以只有同日 A/B 才能测到估值块的影响。
 *   - 历史窗口只能测新闻选材那一路（raw_news 历史完整），那是另一套脚本的事。
 *
 * 基线是 git 历史里的真实旧代码，不是手工复刻：
 *   旧版 = git archive <基线> 导出的源码树（渲染逻辑与它自带的 SYSTEM_PROMPT 都是当时的），
 *          且脚本不传估值块/资金块、新闻固定用"全库最新 10 条"（旧选材口径）
 *   新版 = 当前工作区：上述三块齐全
 * 两版共用同一份净值/重仓股/指标数据，变量只有这三处 —— 正是被比较的改动。
 *
 * --base 的语义（重要）：它换的是"旧版代码"，但**对比变量是固定的**（估值分位 / 资金与仓位 /
 * 新闻时效选材这三块）。所以 --base 应指向"这三块改动之前的提交"（默认 621c6f6）；
 * 随便指一个别的提交，差异里会混入无关变量（例如该提交自己的持仓块文案变化）。
 *
 * 用法：
 *   node scripts/ab-prompt-compare.mjs                              # 默认 8 只代表性基金
 *   node scripts/ab-prompt-compare.mjs --repeat 3                   # 每版重复 3 次（强烈建议，见下）
 *   node scripts/ab-prompt-compare.mjs --temp 0                     # 确定性对照（默认已是 0）
 *   node scripts/ab-prompt-compare.mjs --codes 161725,001594        # 指定基金
 *   node scripts/ab-prompt-compare.mjs --base <git-ref>             # 换基线提交
 *   node scripts/ab-prompt-compare.mjs --dump                       # 额外落盘两版完整 prompt
 *
 * 为什么建议 --repeat ≥3：LLM 有采样随机性，实测同一数据同一 prompt 跑 3 次会出现
 * hold/add/hold 混合。单次 A/B 的"方向变化"大部分是噪声 —— 本项目第一次单次实验得出
 * "3/8 方向变化"，重复 3 次后发现那 3 只全部属于版本内不稳定，真实差异是 0。
 *
 * 输出：控制台对比表 + .tmp-ab/ab-result.json（含两版完整 prompt、原始响应、每次运行的结论与用量）
 */
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { execSync } from 'node:child_process'
import { build } from 'esbuild'
import {
  fundPool,
  newsPool,
  loadFund,
  loadBenchmark,
  loadPositions,
  loadCapital,
  computeFundMetrics,
  computeRelativeStrength,
  formatMetricsBlock,
  formatValuationBlock,
  formatCapitalBlock,
  formatEstimateBlock,
  fundNameKeyword
} from './diagnose-prompt-data.mjs'

// ---------- 配置 ----------
const TMP = '.tmp-ab'
/** 默认基金：覆盖有估值分位匹配的不同板块 */
const DEFAULT_CODES = ['161725', '001594', '004069', '017469', '001550', '161024', '501057', '100032']

const argv = process.argv.slice(2)
const argOf = (f) => {
  const i = argv.indexOf(f)
  return i >= 0 ? argv[i + 1] : undefined
}
/**
 * 基线提交：默认 621c6f6（本工具诞生时"两个 AI 数据 commit"的父提交）。
 * 比较别的改动时用 `--base <git-ref>` 指定该改动之前的提交即可。
 */
const OLD_REF = argOf('--base') ?? '621c6f6'
const codes = (argOf('--codes') ?? DEFAULT_CODES.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
const dumpPrompts = argv.includes('--dump')
/** 每个版本重复调用次数：单次结果含 LLM 随机性，重复才能区分"真信号"与"噪声" */
const repeat = Math.max(1, Number(argOf('--repeat') ?? 1))
/** 采样温度：线上 analyze.ts 已改为 0（可复现）；--temp 0.3 可对照改前的随机摆动 */
const TEMP = Number(argOf('--temp') ?? 0)
const userId = 1

// .env 读 LLM 配置（与 src/main/llm/deepseek.ts 同口径）
const env = {}
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].trim()
}
const LLM_BASE = (env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/+$/, '')
const LLM_MODEL = env.DEEPSEEK_MODEL || 'deepseek-chat'
const LLM_KEY = env.DEEPSEEK_API_KEY

// ---------- 1. 准备两版代码并打包 ----------
mkdirSync(TMP, { recursive: true })
const stubPath = resolve(`${TMP}/electron-stub.mjs`)
writeFileSync(
  stubPath,
  `export const app = { getPath: () => '.', getVersion: () => '0.0.0', isPackaged: false, on: () => {}, whenReady: async () => {} }
export const BrowserWindow = class { static getAllWindows() { return [] } }
export const shell = { openPath: async () => '', openExternal: async () => {} }
export const ipcMain = { handle: () => {}, on: () => {} }
export const Notification = class { static isSupported() { return false } show() {} }
export const Tray = class {}
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
export const nativeImage = { createFromPath: () => ({}) }
export default { app, BrowserWindow, shell, ipcMain, Notification, Tray, Menu, nativeImage }
`
)

// 导出父提交的 src/main 树（真实旧代码，自洽解析其相对 import）
// 目录名带 ref：换了 --base 就走独立目录，不会被上一次的缓存污染
const oldDir = `${TMP}/old-${OLD_REF.replace(/[^a-zA-Z0-9._-]/g, '_')}`
mkdirSync(oldDir, { recursive: true })
if (existsSync(`${oldDir}/src/main/analyzer/analyze.ts`)) {
  console.log(`基线代码 ${OLD_REF} 已存在，跳过导出`)
} else {
  try {
    execSync(`git archive ${OLD_REF} src/main | tar x -C ${oldDir}`, { shell: 'bash', stdio: ['ignore', 'ignore', 'pipe'] })
    console.log(`已导出基线代码 ${OLD_REF} → ${oldDir}`)
  } catch (e) {
    console.error(`导出基线失败：${(e.stderr ?? e).toString().slice(0, 300)}`)
    process.exit(1)
  }
}

async function bundle(entry, outfile, label) {
  const out = await build({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    external: ['pg'],
    alias: { electron: stubPath },
    outfile,
    logLevel: 'error'
  })
  if (out.errors.length) throw new Error(`${label} 打包失败`)
  return outfile
}

await bundle(`${oldDir}/src/main/analyzer/analyze.ts`, `${TMP}/analyze-old.mjs`, '旧版')
await bundle('src/main/analyzer/analyze.ts', `${TMP}/analyze-new.mjs`, '新版')
const oldMod = await import(`../${TMP}/analyze-old.mjs`)
const newMod = await import(`../${TMP}/analyze-new.mjs`)
console.log('两版代码已打包（旧版来自 git 历史，新版来自工作区）')

// ---------- 2. 旧版新闻选材（复刻 621c6f6 的 newsByTags：全库最新 10 条，无时效/归属） ----------
async function loadOldNews(tags) {
  const r = await newsPool.query(
    `SELECT title, summary, sentiment FROM raw_news
     WHERE llm_tags ?| $1 OR tags ?| $1 OR title ILIKE ANY ($2)
     ORDER BY pub_time DESC LIMIT 10`,
    [tags, tags.map((t) => `%${t}%`)]
  )
  return r.rows.map((x) => ({ title: x.title, summary: x.summary, sentiment: x.sentiment, llmTags: [] }))
}

// ---------- 3. LLM 调用（参数与 src/main/llm/deepseek.ts 完全一致） ----------
const usage = { prompt: 0, completion: 0, calls: 0, retries: 0 }
/** 中转站限流：limit 30 次/分钟（实测 429 RATE_LIMITED），故保持 ≥2.1s 调用间隔 */
const MIN_GAP_MS = 2100
let lastCallAt = 0
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function chat(system, user, attempt = 1) {
  // 主动节流：先等够最小间隔，再发请求
  const gap = MIN_GAP_MS - (Date.now() - lastCallAt)
  if (gap > 0) await sleep(gap)
  lastCallAt = Date.now()

  const t0 = Date.now()
  const r = await fetch(`${LLM_BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LLM_KEY}`, Accept: 'application/json' },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: TEMP,
      max_tokens: 2000,
      enable_thinking: false
    })
  })
  const text = await r.text()
  usage.calls++

  // 429：按服务端给的 retryAfterSeconds 退避重试（否则整轮回测会被限流毁掉）
  if (r.status === 429 && attempt <= 3) {
    const m = text.match(/"retryAfterSeconds":\s*(\d+)/)
    const wait = ((m ? Number(m[1]) : 3) + 1) * 1000
    usage.retries++
    console.log(`  [限流 429] 等待 ${wait / 1000}s 后重试（第 ${attempt} 次）`)
    await sleep(wait)
    return chat(system, user, attempt + 1)
  }

  if (!r.ok) return { raw: '', error: `HTTP ${r.status}: ${text.slice(0, 160)}`, ms: Date.now() - t0 }
  const j = JSON.parse(text)
  usage.prompt += j.usage?.prompt_tokens ?? 0
  usage.completion += j.usage?.completion_tokens ?? 0
  const content = (j.choices?.[0]?.message?.content ?? '').trim()
  // HTTP 200 但空内容（中转站空返回 / 思考 token 吃满）也要能区分出来
  if (!content) return { raw: '', error: `空响应（finish_reason=${j.choices?.[0]?.finish_reason ?? '?'}）`, ms: Date.now() - t0 }
  return { raw: content, error: null, ms: Date.now() - t0 }
}

/** 宽松解析建议 JSON（复刻 analyzer/parse.ts 的意图） */
function parseAdvice(raw) {
  const m = raw.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    if (!['add', 'reduce', 'hold'].includes(j.action)) return null
    return {
      action: j.action,
      confidence: Number(j.confidence) || 0,
      reason: String(j.reason ?? ''),
      suggestedPct: j.suggestedPct === null || j.suggestedPct === undefined ? null : Number(j.suggestedPct)
    }
  } catch {
    return null
  }
}

// ---------- 4. 逐基金 A/B ----------
const bench = await loadBenchmark()
const capital = await loadCapital(userId)
const positions = await loadPositions(userId)
const today = new Date().toISOString().slice(0, 10)

const rows = []
for (const code of codes) {
  const { basic, nav, holdings, est, news, tags, valuation } = await loadFund(code)
  const position = positions.find((p) => p.fundCode === code) ?? null
  const latestNavDate = nav[nav.length - 1]?.date ?? null

  // 两版共用的数据块
  const timeCtx = newMod.formatTimeContext(newMod.buildTimeContext(new Date(), latestNavDate, true))
  const metricsBlock = formatMetricsBlock(computeFundMetrics(nav), bench ? computeRelativeStrength(nav, bench, [20, 60], '沪深300') : null)
  const estBlockParams = {
    nav,
    holdings,
    position,
    timeCtx,
    estimate: est,
    metricsBlock,
    portfolioBlock: null,
    ruleBlock: null
  }

  // 新版：估值块 + 资金块 + 新选材新闻
  const valuationBlock = valuation ? formatValuationBlock(valuation) : null
  const newPrompt = newMod.buildUserPrompt({
    ...estBlockParams,
    fundName: basic.name,
    code,
    news,
    valuationBlock,
    capital
  })

  // 旧版：无估值块、无资金块、旧选材新闻（旧代码自己渲染旧格式）
  const oldNews = await loadOldNews(tags)
  const oldPrompt = oldMod.buildUserPrompt({
    ...estBlockParams,
    fundName: basic.name,
    code,
    news: oldNews
  })

  if (dumpPrompts) {
    writeFileSync(`${TMP}/prompt-${code}-old.txt`, oldPrompt)
    writeFileSync(`${TMP}/prompt-${code}-new.txt`, newPrompt)
  }

  // 两版各跑 repeat 次：单次结果含 LLM 随机性（实测同一 prompt 两次可能出现 add / hold 不同），
  // 只有"两版各自稳定、且方向不同"才算真实差异，否则归为噪声不可判定。
  for (const [version, sys, prompt, newsCount] of [
    ['old', oldMod.SYSTEM_PROMPT, oldPrompt, oldNews.length],
    ['new', newMod.SYSTEM_PROMPT, newPrompt, news.length]
  ]) {
    for (let k = 1; k <= repeat; k++) {
      const res = await chat(sys, prompt)
      const adv = res.error ? null : parseAdvice(res.raw)
      const reason = adv?.reason ?? res.error ?? ''
      rows.push({
        code,
        name: basic.name,
        version,
        run: k,
        action: adv?.action ?? '失败',
        confidence: adv?.confidence ?? null,
        suggestedPct: adv?.suggestedPct ?? null,
        reason,
        usesValuation: /估值|分位|低估|高估|便宜|贵/.test(reason),
        usesCapital: /闲钱|本金|预算|计划投入/.test(reason),
        promptLen: prompt.length,
        newsCount,
        valuationBlock,
        raw: res.raw
      })
    }
  }

  const seqOf = (v) => rows.filter((r) => r.code === code && r.version === v).map((r) => r.action).join('/')
  console.log(`[${code}] ${basic.name}\n  旧版: ${seqOf('old')}\n  新版: ${seqOf('new')}`)
}

// ---------- 5. 汇总（每基金 × 每版 × repeat 次） ----------
const perFund = codes.map((code) => {
  const o = rows.filter((r) => r.code === code && r.version === 'old')
  const nw = rows.filter((r) => r.code === code && r.version === 'new')
  const uniq = (a) => [...new Set(a.map((r) => r.action))]
  const oU = uniq(o)
  const nU = uniq(nw)
  const stable = oU.length === 1 && nU.length === 1
  const verdict = !stable
    ? '不稳定（LLM 噪声主导）'
    : oU[0] !== nU[0]
      ? '★真实差异（两版各自稳定且方向不同）'
      : '无方向差异'
  const avgConf = (a) => (a.length ? Math.round(a.reduce((s, r) => s + (r.confidence ?? 0), 0) / a.length) : null)
  const avgPct = (a) => {
    const v = a.map((r) => r.suggestedPct).filter((x) => x !== null)
    return v.length ? Math.round(v.reduce((s, x) => s + x, 0) / v.length) : null
  }
  return {
    code,
    名称: (o[0]?.name ?? '').slice(0, 12),
    旧版序列: o.map((r) => r.action).join('/'),
    新版序列: nw.map((r) => r.action).join('/'),
    旧置信: avgConf(o),
    新置信: avgConf(nw),
    旧建议占比: avgPct(o),
    新建议占比: avgPct(nw),
    判定: verdict,
    新提估值: `${nw.filter((r) => r.usesValuation).length}/${nw.length}`,
    新提资金: `${nw.filter((r) => r.usesCapital).length}/${nw.length}`,
    'prompt长度': `${o[0]?.promptLen}→${nw[0]?.promptLen}`,
    新闻条数: `${o[0]?.newsCount}→${nw[0]?.newsCount}`
  }
})

console.log(`\n\n===== A/B 汇总（同日 ${today}，同数据，仅 prompt 版本不同；每版重复 ${repeat} 次）=====`)
console.table(perFund)

const newRows = rows.filter((r) => r.version === 'new')
const realDiff = perFund.filter((r) => r.判定.startsWith('★')).length
const unstable = perFund.filter((r) => r.判定.startsWith('不稳定')).length
console.log(`\n可信的方向差异：${realDiff}/${codes.length}（另有 ${unstable} 只因版本内不稳定而不可判定）`)
console.log(`新版理由提及"估值/分位"：${newRows.filter((r) => r.usesValuation).length}/${newRows.length}`)
console.log(`新版理由提及"资金/闲钱/预算"：${newRows.filter((r) => r.usesCapital).length}/${newRows.length}`)
console.log(
  `\nLLM 用量：${usage.calls} 次调用（含 ${usage.retries} 次限流重试），prompt ${usage.prompt} + completion ${usage.completion} = ${usage.prompt + usage.completion} tokens`
)

const outFile = `${TMP}/ab-result.json`
writeFileSync(
  outFile,
  JSON.stringify(
    { generatedAt: new Date().toISOString(), asof: today, oldRef: OLD_REF, model: LLM_MODEL, repeat, usage, perFund, rows },
    null,
    2
  )
)
console.log(`\n完整结果（含两版 prompt 与原始响应）：${outFile}`)

await fundPool.end().catch(() => {})
await newsPool.end().catch(() => {})
