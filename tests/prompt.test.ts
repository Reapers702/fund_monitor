// Prompt 组装单测（analyzer/analyze.buildUserPrompt）
// 目的：把"数据确实进了提示词"这件事钉住——指标块、持仓、新闻、时点上下文、估值块
// 分别在且只在该出现的时候出现（此前这几处只有代码走查，没有测试兜底）。
import { describe, it, expect } from 'vitest'
import { buildUserPrompt, SYSTEM_PROMPT } from '../src/main/analyzer/analyze'
import type { NavPoint, HoldingWithStock } from '../src/main/storage/queries'
import type { EstPoint } from '../src/main/storage/queries'
import type { PositionSummary, CapitalSummary } from '../src/main/position/position'

const nav: NavPoint[] = [
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
  ] as HoldingWithStock[]
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

/** 资金全景 fixture：计划投入 10 万、已投本金 4.5 万、闲钱 5.5 万；本基金占计划 1.6% */
const capital: CapitalSummary = {
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

function build(
  opts: {
    metricsBlock?: string | null
    portfolioBlock?: string | null
    valuationBlock?: string | null
    estimate?: EstPoint[]
    position?: PositionSummary | null
    capital?: CapitalSummary | null
  } = {}
): string {
  return buildUserPrompt({
    fundName: '东财云计算指数增强C',
    code: '012322',
    nav,
    holdings,
    news,
    position: opts.position === undefined ? position : opts.position,
    capital: opts.capital === undefined ? capital : opts.capital,
    timeCtx: '分析时点：2026-08-19（周三，交易日，盘后）。最新净值截至 2026-08-18。',
    estimate: opts.estimate ?? todayEstimate(),
    metricsBlock:
      opts.metricsBlock === undefined
        ? '量化指标（基于近 400 个交易日净值，年化按 244 交易日）：\n区间收益 +12.00%｜夏普 0.85'
        : opts.metricsBlock,
    portfolioBlock: opts.portfolioBlock === undefined ? null : opts.portfolioBlock,
    valuationBlock: opts.valuationBlock === undefined ? null : opts.valuationBlock
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
    expect(p).toContain('相关新闻（最多 8 条')
    expect(p).toContain('光模块需求旺盛')
    // 新闻需标注归属（行业/大盘）与时效（今天/N天前）。时效标签用正则匹配，
    // 避免"刚过 0 点跑测试"时整日差向下取整导致断言抖动；日期段（如 10-20）不能省。
    expect(p).toContain('[行业][')
    expect(p).toMatch(/- \[行业\]\[\d{1,2}-\d{2}\|(今天|昨天|\d+天前)\|positive\]/)
    expect(p).toMatch(/- \[行业\]\[\d{1,2}-\d{2}\|(今天|昨天|\d+天前)\|negative\]/)
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
    const block =
      '组合上下文（该基金占组合 25%，权重口径：等权）：\n- 与「富国天惠成长混合（LOF）A」重仓重叠度 38.9%（共同重仓 2 只：中际旭创、宁德时代）'
    const p = build({ portfolioBlock: block })
    expect(p).toContain('组合上下文')
    expect(p).toContain('重仓重叠度 38.9%')
  })

  it('无组合上下文/无指标块时不出现空标题（避免模型追着不存在的数据解释）', () => {
    const p = build({ portfolioBlock: null })
    expect(p).not.toContain('组合上下文')
  })

  it('板块估值分位块进入提示词（长周期贵/便宜参考轴）', () => {
    const block =
      '板块估值分位（中证白酒，截至 2026-10-18，数据源估值标签【低估】）：PE 分位 20.7%（中低）｜PB 分位 3.3%（偏低）'
    const p = build({ valuationBlock: block })
    expect(p).toContain('板块估值分位')
    expect(p).toContain('PE 分位 20.7%')
  })

  it('无估值分位数据时不出现该块', () => {
    const p = build({ valuationBlock: null })
    expect(p).not.toContain('板块估值分位')
  })

  it('净值样本行不再重复区间涨跌（区间收益只由指标块给一次）', () => {
    const p = build()
    // 指标块给"区间收益"，样本行只提示去看指标块，避免同一数字出现两次
    expect(p).toContain('区间累计涨跌见下方量化指标')
    expect(p).not.toContain('区间涨跌：')
  })

  it('SYSTEM_PROMPT 允许估值分位参与判断但禁止单独成为依据', () => {
    expect(SYSTEM_PROMPT).toContain('板块估值分位')
    expect(SYSTEM_PROMPT).toContain('禁止仅凭估值分位下单')
  })

  it('SYSTEM_PROMPT 说明新闻的行业/大盘归属与时效含义', () => {
    expect(SYSTEM_PROMPT).toContain('[行业]=与该基金或其重仓股相关')
    expect(SYSTEM_PROMPT).toContain('距今天数越大参考价值越低')
  })

  it('大盘兜底新闻被标为 [大盘]，不会被误读成该基金的消息', () => {
    const p = buildUserPrompt({
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
    expect(p).toContain('[大盘][')
    expect(p).not.toContain('[行业][')
  })

  it('SYSTEM_PROMPT 要求把组合重叠纳入判断', () => {
    expect(SYSTEM_PROMPT).toContain('组合上下文')
    expect(SYSTEM_PROMPT).toContain('放大同一风险敞口')
  })

  it('无持仓时给出提示而非空白（AI 需知道是否未录入持仓）', () => {
    const p = build({ position: null })
    expect(p).toContain('本基金：未录入持仓')
  })

  it('资金与仓位块进入提示词（买入本金/持仓/闲钱/三个占比）', () => {
    const p = build()
    expect(p).toContain('资金与仓位（用户实盘口径')
    expect(p).toContain('计划投入基金市场 100000.00')
    expect(p).toContain('已投入本金 45000.00（占计划 45.00%）')
    expect(p).toContain('剩余闲钱 55000.00（占计划 55.00%）')
    // 该基金三个口径的占比都要给出（只看盈亏比例会误判仓位轻重）
    expect(p).toContain('买入本金 1600.00（占已投入本金 3.56%、占计划投入 1.60%）')
    expect(p).toContain('占组合市值 3.10%')
  })

  it('未设置预算时不编造闲钱，并提示用户去填写', () => {
    const p = build({
      capital: {
        ...capital,
        marketBudget: 0,
        usedPct: null,
        spareCash: null,
        sparePct: null,
        totalAsset: null
      }
    })
    expect(p).toContain('未设置「计划投入基金市场金额」')
    expect(p).not.toContain('占计划 45.00%')
  })

  it('已超支时明确提示不要再加仓', () => {
    const p = build({
      capital: {
        ...capital,
        investedCost: 110000,
        usedPct: 110,
        spareCash: -10000,
        sparePct: -10,
        totalAsset: 37800
      }
    })
    expect(p).toContain('已超支')
    expect(p).toContain('-10000.00')
  })

  it('SYSTEM_PROMPT 把资金与仓位当资金约束（不得超出闲钱）', () => {
    expect(SYSTEM_PROMPT).toContain('剩余闲钱')
    expect(SYSTEM_PROMPT).toContain('已超支）时只考虑持有或减仓')
  })

  it('SYSTEM_PROMPT 约束了 JSON 格式并要求直接用算好的指标', () => {
    expect(SYSTEM_PROMPT).toContain('{"action":"add|reduce|hold","confidence":0~100,"reason"')
    expect(SYSTEM_PROMPT).toContain('不要自行重算')
  })
})
