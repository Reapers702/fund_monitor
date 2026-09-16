// Prompt 组装单测（analyzer/analyze.buildUserPrompt）
// 目的：把"数据确实进了提示词"这件事钉住——指标块、持仓、新闻、时点上下文、估值块
// 分别在且只在该出现的时候出现（此前这几处只有代码走查，没有测试兜底）。
import { describe, it, expect } from 'vitest'
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/main/analyzer/analyze'
import type { NavPoint, HoldingWithStock } from '../src/main/storage/queries'
import type { EstPoint } from '../src/main/storage/queries'
import type { PositionSummary } from '../src/main/position/position'

const nav: NavPoint[] = [
  { date: '2026-08-12', nav: 1.5, changePct: 0.5 },
  { date: '2026-08-13', nav: 1.52, changePct: 1.33 },
  { date: '2026-08-14', nav: 1.48, changePct: -2.63 }
]

const holdings = {
  reportDate: '2026-06-30',
  rows: [
    { rank: 1, stockCode: '300308', stockName: '中际旭创', weight: 5.59, lastClose: 92.5, lastPct: 7.76, klineCount: 10 },
    { rank: 2, stockCode: '603019', stockName: '中科曙光', weight: 6.3, lastClose: 82.25, lastPct: -5.1, klineCount: 10 }
  ] as HoldingWithStock[]
}

const news = [
  { title: '光模块需求旺盛', summary: '头部厂商订单饱满', sentiment: 'positive', llmTags: ['光通信'] },
  { title: '某公司遭减持', summary: '大股东计划减持', sentiment: 'negative', llmTags: ['减持'] }
]

const position: PositionSummary = {
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

/** 当日盘中估值采样（时间落在今天，才会被 formatEstimateBlock 收录） */
function todayEstimate(): EstPoint[] {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  return [
    { time: new Date(`${date}T10:00:00`).toISOString(), pct: 0.6, source: 'theme_etf' },
    { time: new Date(`${date}T14:00:00`).toISOString(), pct: -0.8, source: 'theme_etf' }
  ]
}

function build(opts: { metricsBlock?: string | null; portfolioBlock?: string | null; estimate?: EstPoint[]; position?: PositionSummary | null } = {}): string {
  return buildUserPrompt({
    fundName: '东财云计算指数增强C',
    code: '012322',
    nav,
    holdings,
    news,
    position: opts.position === undefined ? position : opts.position,
    timeCtx: '分析时点：2026-08-19（周三，交易日，盘后）。最新净值截至 2026-08-18。',
    estimate: opts.estimate ?? todayEstimate(),
    metricsBlock:
      opts.metricsBlock === undefined
        ? '量化指标（基于近 400 个交易日净值，年化按 244 交易日）：\n区间收益 +12.00%｜夏普 0.85'
        : opts.metricsBlock,
    portfolioBlock: opts.portfolioBlock === undefined ? null : opts.portfolioBlock
  })
}

describe('buildUserPrompt（提示词组装）', () => {
  it('量化指标块进入提示词（本次改动的关键闭环）', () => {
    const p = build()
    expect(p).toContain('量化指标')
    expect(p).toContain('夏普 0.85')
  })

  it('指标块为 null 时不出现该块（基准/指标计算失败也不影响主流程）', () => {
    const p = build({ metricsBlock: null })
    expect(p).not.toContain('量化指标（基于')
    expect(p).not.toContain('夏普')
    // 其余块照常
    expect(p).toContain('近 30 日净值')
  })

  it('时点上下文/净值/重仓股/新闻/持仓各块齐备', () => {
    const p = build()
    expect(p).toContain('分析时点：2026-08-19')
    expect(p).toContain('净值样本数：3 条')
    expect(p).toContain('最新净值：1.4800（2026-08-14）')
    expect(p).toContain('最新重仓股（报告期 2026-06-30）')
    expect(p).toContain('1. 中际旭创 权重5.59% 近10日7.76%')
    expect(p).toContain('相关新闻（最近 8 条')
    expect(p).toContain('光模块需求旺盛')
    expect(p).toContain('持有 1000 份')
    expect(p).toContain('浮动盈亏 -120.00')
  })

  it('当日盘中估值块进入提示词并带来源名', () => {
    const p = build()
    expect(p).toContain('盘中估值（主题ETF，最新')
    expect(p).toContain('当日估值走势')
  })

  it('无当日估值采样时省略估值块（盘前/非交易日）', () => {
    const p = build({ estimate: [] })
    expect(p).not.toContain('盘中估值（')
    expect(p).toContain('近 30 日净值')
  })

  it('组合上下文块进入提示词（单基金判断看不到跨基金重叠）', () => {
    const block = '组合上下文（该基金占组合 25%，权重口径：等权）：\n- 与「富国天惠成长混合（LOF）A」重仓重叠度 38.9%（共同重仓 2 只：中际旭创、宁德时代）'
    const p = build({ portfolioBlock: block })
    expect(p).toContain('组合上下文')
    expect(p).toContain('重仓重叠度 38.9%')
  })

  it('无组合上下文/无指标块时不出现空标题（避免模型追着不存在的数据解释）', () => {
    const p = build({ portfolioBlock: null })
    expect(p).not.toContain('组合上下文')
  })

  it('SYSTEM_PROMPT 要求把组合重叠纳入判断', () => {
    expect(SYSTEM_PROMPT).toContain('组合上下文')
    expect(SYSTEM_PROMPT).toContain('放大同一风险敞口')
  })

  it('无持仓时给出提示而非空白（AI 需知道是否未录入持仓）', () => {
    const p = build({ position: null })
    expect(p).toContain('未录入持仓')
  })

  it('SYSTEM_PROMPT 约束了 JSON 格式并要求直接用算好的指标', () => {
    expect(SYSTEM_PROMPT).toContain('{"action":"add|reduce|hold","confidence":0~100,"reason"')
    expect(SYSTEM_PROMPT).toContain('不要自行重算')
  })
})
