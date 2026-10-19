/**
 * prompt 组装行为验证（直接执行 tests/prompt.test.ts 的断言集，但用 esbuild 打包真实 analyze.ts）。
 *
 * 为什么单独存在：受限沙箱（workspace-write）内 vitest / esbuild 起不了原生子进程（spawn EPERM），
 * 跑不了单测。本脚本在可 spawn 的环境里能跑，用来核对"各数据块是否按预期进入 prompt"。
 * 常规单测仍以 `npm test`（tests/prompt.test.ts）为准，本脚本是补充手段。
 *
 * electron 被 stub 掉：analyze.ts 的依赖链（config/pageFetcher 等）会 import electron，
 * 而这里只需要纯函数组装 prompt，不需要真实 Electron 运行时。
 *
 * 用法：node scripts/verify-prompt-blocks.mjs   （需可用的 esbuild，退出码 0=全部通过）
 */
import { build } from 'esbuild'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

// 生成 electron stub（放 .tmp-verify/，已被 .gitignore 忽略）
mkdirSync('.tmp-verify', { recursive: true })
const stubPath = resolve('.tmp-verify/electron-stub.mjs')
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

const out = await build({
  entryPoints: ['src/main/analyzer/analyze.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['pg'],
  alias: { electron: stubPath },
  outfile: '.tmp-verify/analyze.mjs',
  logLevel: 'error'
})
console.log('打包完成:', out.errors.length, 'errors')

const { buildUserPrompt, SYSTEM_PROMPT } = await import('../.tmp-verify/analyze.mjs')

// ---- 复刻 tests/prompt.test.ts 的 fixture 与断言 ----
const nav = [
  { date: '2026-08-12', nav: 1.5, changePct: 0.5 },
  { date: '2026-08-13', nav: 1.52, changePct: 1.33 },
  { date: '2026-08-14', nav: 1.48, changePct: -2.63 }
]
const holdings = {
  reportDate: '2026-06-30',
  rows: [
    {
      rank: 1,
      stockCode: '300308',
      stockName: '中际旭创',
      weight: 5.59,
      lastClose: 92.5,
      lastPct: 7.76,
      klineCount: 10
    },
    {
      rank: 2,
      stockCode: '603019',
      stockName: '中科曙光',
      weight: 6.3,
      lastClose: 82.25,
      lastPct: -5.1,
      klineCount: 10
    }
  ]
}
const news = [
  {
    title: '光模块需求旺盛',
    summary: '头部厂商订单饱满',
    sentiment: 'positive',
    llmTags: ['光通信'],
    pubTime: new Date()
  },
  {
    title: '某公司遭减持',
    summary: '大股东计划减持',
    sentiment: 'negative',
    llmTags: ['减持'],
    pubTime: new Date(Date.now() - 3 * 86400000)
  }
]
const position = {
  fundCode: '012322',
  fundName: '东财云计算指数增强C',
  shares: 1000,
  avgCost: 1.6,
  totalCost: 1600,
  realizedPnl: 0,
  latestNav: 1.48,
  marketValue: 1480,
  floatingPnl: -120,
  pnlPct: -7.5
}
const capital = {
  marketBudget: 100000,
  investedCost: 45000,
  marketValue: 47800,
  floatingPnl: 2800,
  usedPct: 45,
  spareCash: 55000,
  sparePct: 55,
  totalAsset: 102800,
  funds: [
    {
      fundCode: '012322',
      fundName: '东财云计算指数增强C',
      shares: 1000,
      avgCost: 1.6,
      investedCost: 1600,
      marketValue: 1480,
      floatingPnl: -120,
      pnlPct: -7.5,
      weightPct: 3.1,
      costWeightPct: 3.56,
      budgetPct: 1.6
    }
  ]
}
function todayEstimate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return [
    { time: new Date(`${date}T10:00:00`).toISOString(), pct: 0.6, source: 'theme_etf' },
    { time: new Date(`${date}T14:00:00`).toISOString(), pct: -0.8, source: 'theme_etf' }
  ]
}
function buildPrompt(o = {}) {
  return buildUserPrompt({
    fundName: '东财云计算指数增强C',
    code: '012322',
    nav,
    holdings,
    news,
    position: o.position === undefined ? position : o.position,
    capital: o.capital === undefined ? capital : o.capital,
    timeCtx: '分析时点：2026-08-19（周三，交易日，盘后）。最新净值截至 2026-08-18。',
    estimate: o.estimate ?? todayEstimate(),
    metricsBlock:
      o.metricsBlock === undefined
        ? '量化指标（基于近 400 个交易日净值，年化按 244 交易日）：\n区间收益 +12.00%｜夏普 0.85'
        : o.metricsBlock,
    portfolioBlock: o.portfolioBlock === undefined ? null : o.portfolioBlock,
    valuationBlock: o.valuationBlock === undefined ? null : o.valuationBlock
  })
}

let pass = 0,
  fail = 0
const checks = []
const want = (name, cond) => {
  checks.push([name, !!cond])
  cond ? pass++ : fail++
}
const wantNot = (name, cond) => {
  checks.push([name, !cond])
  !cond ? pass++ : fail++
}

// prompt.test.ts 原有断言
const p = buildPrompt()
want('量化指标块进入', p.includes('量化指标') && p.includes('夏普 0.85'))
wantNot('指标块为 null 时不出现', buildPrompt({ metricsBlock: null }).includes('量化指标（基于'))
want(
  '时点/净值/重仓股/新闻/持仓齐备',
  p.includes('分析时点：2026-08-19') &&
    p.includes('净值样本数：3 条') &&
    p.includes('最新净值：1.4800（2026-08-14）') &&
    p.includes('最新重仓股（报告期 2026-06-30）') &&
    p.includes('1. 中际旭创 权重5.59% 近10日7.76%') &&
    p.includes('持有 1000 份') &&
    p.includes('浮动盈亏 -120.00')
)
want('盘中估值块 + 来源名', p.includes('盘中估值（主题ETF，最新') && p.includes('当日估值走势'))
wantNot('无当日估值时省略', buildPrompt({ estimate: [] }).includes('盘中估值（'))
want(
  '组合上下文块',
  buildPrompt({
    portfolioBlock:
      '组合上下文（该基金占组合 25%，权重口径：等权）：\n- 与「富国天惠成长混合（LOF）A」重仓重叠度 38.9%'
  }).includes('组合上下文')
)
wantNot('无组合上下文时不出现', buildPrompt({ portfolioBlock: null }).includes('组合上下文'))
want(
  'SYSTEM_PROMPT 含组合重叠约束',
  SYSTEM_PROMPT.includes('组合上下文') && SYSTEM_PROMPT.includes('放大同一风险敞口')
)
want('无持仓时给提示', buildPrompt({ position: null }).includes('未录入持仓'))
want(
  'JSON 格式约束',
  SYSTEM_PROMPT.includes('{"action":"add|reduce|hold","confidence":0~100,"reason"') &&
    SYSTEM_PROMPT.includes('不要自行重算')
)

// 本次新增断言
want('新闻块标题', p.includes('相关新闻（最多 8 条'))
want('新闻归属标签 [行业]', p.includes('[行业]['))
want('新闻时效标签(positive)', /- \[行业\]\[\d{1,2}-\d{2}\|(今天|昨天|\d+天前)\|positive\]/.test(p))
want('新闻时效标签(negative)', /- \[行业\]\[\d{1,2}-\d{2}\|(今天|昨天|\d+天前)\|negative\]/.test(p))
want(
  '估值块进入',
  buildPrompt({
    valuationBlock:
      '板块估值分位（中证白酒，截至 2026-10-18，数据源估值标签【低估】）：PE 分位 20.7%（中低）'
  }).includes('PE 分位 20.7%')
)
wantNot('无估值分位时不出现该块', buildPrompt({ valuationBlock: null }).includes('板块估值分位'))
want(
  '净值样本行不重复区间涨跌',
  p.includes('区间累计涨跌见下方量化指标') && !p.includes('区间涨跌：')
)
want(
  'SYSTEM_PROMPT 估值规则',
  SYSTEM_PROMPT.includes('板块估值分位') && SYSTEM_PROMPT.includes('禁止仅凭估值分位下单')
)
want(
  'SYSTEM_PROMPT 新闻归属+时效规则',
  SYSTEM_PROMPT.includes('[行业]=与该基金或其重仓股相关') &&
    SYSTEM_PROMPT.includes('距今天数越大参考价值越低')
)

// 资金与仓位块（本次新增能力）
want(
  '资金与仓位块进入（本金/闲钱/三个占比）',
  p.includes('资金与仓位（用户实盘口径') &&
    p.includes('计划投入基金市场 100000.00') &&
    p.includes('已投入本金 45000.00（占计划 45.00%）') &&
    p.includes('剩余闲钱 55000.00（占计划 55.00%）') &&
    p.includes('买入本金 1600.00（占已投入本金 3.56%、占计划投入 1.60%）') &&
    p.includes('占组合市值 3.10%')
)
want(
  '未设预算时不编造闲钱',
  buildPrompt({
    capital: {
      ...capital,
      marketBudget: 0,
      usedPct: null,
      spareCash: null,
      sparePct: null,
      totalAsset: null
    }
  }).includes('未设置「计划投入基金市场金额」')
)
want(
  '已超支时提示不要再加仓',
  buildPrompt({
    capital: {
      ...capital,
      investedCost: 110000,
      usedPct: 110,
      spareCash: -10000,
      sparePct: -10,
      totalAsset: 37800
    }
  }).includes('已超支')
)
want(
  'SYSTEM_PROMPT 资金约束',
  SYSTEM_PROMPT.includes('剩余闲钱') && SYSTEM_PROMPT.includes('已超支）时只考虑持有或减仓')
)

// [大盘] 标记（relevance='market'）
const pMarket = buildUserPrompt({
  fundName: '某宽基联接',
  code: '110020',
  nav,
  holdings,
  news: [
    {
      title: '纳指收涨',
      summary: '美股走强',
      sentiment: 'positive',
      llmTags: [],
      pubTime: new Date(),
      relevance: 'market'
    }
  ],
  position: null,
  capital: null,
  timeCtx: '分析时点：2026-08-19',
  estimate: [],
  metricsBlock: null,
  portfolioBlock: null,
  ruleBlock: null,
  valuationBlock: null
})
want('[大盘] 标记生效', pMarket.includes('[大盘][') && !pMarket.includes('[行业]['))

console.log('\n断言结果：')
for (const [n, ok] of checks) console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`)
console.log(`\n通过 ${pass} / ${pass + fail}`)

// 输出一段真实渲染结果供人工核对
console.log('\n---------- 真实渲染样例（无估值块）----------')
console.log(p)

writeFileSync('.tmp-verify/ok', String(fail === 0))
process.exit(fail === 0 ? 0 : 1)
