// 指数估值分位（价值因子，M10）—— 数据源：蛋卷指数估值快照（免鉴权）
//
// 背景：净值/新闻/动量/轮动等"价格衍生信号"对未来短周期方向均无预测力（命中率恒≈50%）。
// 价值因子（估值分位）是**不同类别**的信号：历史上低估值板块长期跑赢高估值（跨数年慢变量）。
// 但本快照 API 只给"当日"估值分位，无历史序列 → 无法做严格的"无前视短周期价值回测"。
// 本模块目标务实：把所有指数当日估值分位每日落库（日复一日累积出历史），
// 并把每只自选基金映射到其板块指数，展示"当前贵/便宜"作为**长周期参考轴**，
// 供用户在定投/补仓时做估值维度的辅助判断（不直接驱动 add/reduce 短周期操作）。
//
// 注意：数据源 index_code 为蛋卷自有代码（SZ399975 等），与行情 secid（1.512480 等）不同，
// 因此基金→板块靠"名称关键词"映射（bi-gram 相似度），仅 best-effort，命不中则留空。

import type { Pool } from 'pg'
import { httpGetJson } from './httpClient'
import { loadConfig } from '../config'
import { createPool, ensureSchema } from '../storage/db'

// ---------- 数据源 ----------

const DANJUAN_URL = 'https://danjuanfunds.com/djapi/index_eva/dj'
const DANJUAN_REFERER = 'https://danjuanapp.com/djmodule/value-center'

export interface IndexValuation {
  indexCode: string
  indexName: string
  pe: number | null
  pePercentile: number | null // 0~1
  pb: number | null
  pbPercentile: number | null
  roe: number | null
  peOverHistory: number | null // 当前PE相对历史倍数（>1=贵）
  pbOverHistory: number | null
  evaType: 'low' | 'mid' | 'high' | null
}

interface DanjuanItem {
  index_code: string
  name: string
  pe?: number
  pe_percentile?: number
  pb?: number
  pb_percentile?: number
  roe?: number
  pe_over_history?: number
  pb_over_history?: number
  eva_type?: string
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function evaTypeOf(s: string | undefined): IndexValuation['evaType'] {
  if (s === 'low' || s === 'mid' || s === 'high') return s
  return null
}

// 通用"指数家族前缀/泛词"，出现在大量指数名里，无板块区分度——共享这些 bigram 不算有效命中
const STOP_BIGRAMS = new Set(['上证', '中证', '深证', '国证', '沪深', '证券', '指数', '板块', '行业', '股份', '公司', '东证'])

// 中文 bi-gram：把名称切成连续的 CJK 二元组集合（去掉字母/数字/标点）
function cjkBigrams(name: string): Set<string> {
  const core = name.replace(/[^\u4e00-\u9fa5]/g, '')
  const out = new Set<string>()
  for (let i = 0; i + 1 < core.length; i++) out.add(core.slice(i, i + 2))
  return out
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let n = 0
  for (const x of a) if (b.has(x) && !STOP_BIGRAMS.has(x)) n++
  return n
}

/** 拉取蛋卷当日指数估值快照 */
export async function fetchIndexValuations(): Promise<IndexValuation[]> {
  const d = await httpGetJson<{ data: { items: DanjuanItem[] } }>(DANJUAN_URL, {
    referer: DANJUAN_REFERER,
    retries: 2,
    tag: '估值:蛋卷快照'
  })
  return (d.data?.items ?? []).map((it) => ({
    indexCode: it.index_code,
    indexName: it.name,
    pe: num(it.pe),
    pePercentile: num(it.pe_percentile),
    pb: num(it.pb),
    pbPercentile: num(it.pb_percentile),
    roe: num(it.roe),
    peOverHistory: num(it.pe_over_history),
    pbOverHistory: num(it.pb_over_history),
    evaType: evaTypeOf(it.eva_type)
  }))
}

/** 一次性落库当日快照（幂等：同源同日已存在则更新） */
export async function storeIndexValuations(
  pool: Pool,
  tradeDate: string,
  items: IndexValuation[]
): Promise<number> {
  let n = 0
  for (const it of items) {
    const r = await pool.query(
      `INSERT INTO index_valuation
         (index_code, index_name, trade_date, source, pe, pe_percentile, pb, pb_percentile,
          roe, pe_over_history, pb_over_history, eva_type)
       VALUES ($1,$2,$3,'danjuan',$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (index_code, trade_date, source)
       DO UPDATE SET index_name=EXCLUDED.index_name, pe=EXCLUDED.pe, pe_percentile=EXCLUDED.pe_percentile,
         pb=EXCLUDED.pb, pb_percentile=EXCLUDED.pb_percentile, roe=EXCLUDED.roe,
         pe_over_history=EXCLUDED.pe_over_history, pb_over_history=EXCLUDED.pb_over_history,
         eva_type=EXCLUDED.eva_type`,
      [
        it.indexCode,
        it.indexName,
        tradeDate,
        it.pe,
        it.pePercentile,
        it.pb,
        it.pbPercentile,
        it.roe,
        it.peOverHistory,
        it.pbOverHistory,
        it.evaType
      ]
    )
    n += r.rowCount ?? 0
  }
  return n
}

// 板块关键词 → 期望的蛋卷指数名片段。bi-gram 对"证券/医药/红利"这类通用词区分度不足（且会被
// 停用词表过滤），先按此表精确归属常见自选板块；命中即返回，否则回退 bi-gram 相似度。
const SECTOR_OVERRIDES: [kw: string, want: string][] = [
  ['证券', '证券公司'],
  ['券商', '证券公司'],
  ['银行', '中证银行'],
  ['医疗', '中证医疗'],
  ['医药', '中证医疗'],
  ['芯片', '科创50'],
  ['半导体', '科创50'],
  ['科创', '科创50'],
  ['信息技术', '科创50'],
  ['红利', '中证红利'],
  ['军工', '中证军工'],
  ['白酒', '中证白酒'],
  ['食品', '中证消费'],
  ['消费', '中证消费'],
  ['新能源', '新能源车'],
  ['汽车', '新能源车']
]

/**
 * 基金 → 板块指数估值。先查 SECTOR_OVERRIDES（基金名含关键词→期望指数名）；没命中再回退
 * CJK bi-gram 相似度选最优匹配（best-effort，要求 ≥1 个有效二元组，平局取指数名更短者）。
 */
export function matchIndex(
  fundName: string,
  items: IndexValuation[]
): { item: IndexValuation; score: number } | null {
  if (!fundName || items.length === 0) return null
  for (const [kw, want] of SECTOR_OVERRIDES) {
    if (!fundName.includes(kw)) continue
    const hit = items.find((it) => it.indexName && it.indexName.includes(want))
    if (hit) return { item: hit, score: 99 }
  }
  const fundGrams = cjkBigrams(fundName)
  let best: IndexValuation | null = null
  let bestScore = 0
  for (const it of items) {
    const s = it.indexName ? intersectionSize(fundGrams, cjkBigrams(it.indexName)) : 0
    if (s >= 1 && (s > bestScore || (s === bestScore && best && it.indexName.length < best.indexName.length))) {
      best = it
      bestScore = s
    }
  }
  return best ? { item: best, score: bestScore } : null
}

// ---------- 查询侧（详情页 IPC 用） ----------

function rowToValuation(x: {
  index_code: string
  index_name: string
  pe: string | null
  pe_percentile: string | null
  pb: string | null
  pb_percentile: string | null
  eva_type: string | null
}): IndexValuation {
  return {
    indexCode: x.index_code,
    indexName: x.index_name,
    pe: num(x.pe),
    pePercentile: num(x.pe_percentile),
    pb: num(x.pb),
    pbPercentile: num(x.pb_percentile),
    roe: null,
    peOverHistory: null,
    pbOverHistory: null,
    evaType: evaTypeOf(x.eva_type ?? undefined)
  }
}

/** 取库里最新一版快照（trade_date 最大者）及其日期 */
export async function latestIndexValuations(
  pool: Pool
): Promise<{ tradeDate: string | null; items: IndexValuation[] }> {
  const r = await pool.query<{
    index_code: string
    index_name: string
    pe: string | null
    pe_percentile: string | null
    pb: string | null
    pb_percentile: string | null
    eva_type: string | null
    trade_date: Date
  }>(
    `SELECT index_code, index_name, pe, pe_percentile, pb, pb_percentile, eva_type, trade_date
     FROM index_valuation
     WHERE trade_date = (SELECT MAX(trade_date) FROM index_valuation)`
  )
  const items = r.rows.map(rowToValuation)
  return { tradeDate: r.rows[0] ? dateOnlyOf(r.rows[0].trade_date) : null, items }
}

const dateOnlyOf = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** 单只基金 → 板块估值分位（无匹配/无快照返回 null） */
export async function valuationForFund(
  pool: Pool,
  fundName: string
): Promise<FundValuation | null> {
  const { tradeDate, items } = await latestIndexValuations(pool)
  if (items.length === 0) return null
  const m = matchIndex(fundName, items)
  if (!m) return null
  return {
    indexCode: m.item.indexCode,
    indexName: m.item.indexName,
    pe: m.item.pe,
    pePercentile: m.item.pePercentile,
    pb: m.item.pb,
    pbPercentile: m.item.pbPercentile,
    evaType: m.item.evaType,
    tradeDate: tradeDate ?? ''
  }
}

export interface FundValuation {
  indexCode: string
  indexName: string
  pe: number | null
  pePercentile: number | null // 0~1
  pb: number | null
  pbPercentile: number | null
  evaType: IndexValuation['evaType']
  tradeDate: string
}

const pct = (v: number | null, d = 0): string => (v === null || v === 0 ? '--' : `${(v * 100).toFixed(d).padStart(2, ' ')}%`)
const zoneName = (t: IndexValuation['evaType']): string => (t === 'low' ? '低估' : t === 'high' ? '高估' : t === 'mid' ? '适中' : '--')

/** --valuation CLI：拉快照落库 + 为每只自选基金打印其板块估值分位 */
export async function runIndexValuation(codesOverride?: string[]): Promise<number> {
  const cfg = loadConfig()
  const pool = createPool(cfg)
  await ensureSchema(pool) // CLI 分支不走启动建表，这里补齐
  const today = new Date().toISOString().slice(0, 10)
  try {
    console.log('\n' + '='.repeat(96))
    console.log('指数估值分位（价值因子，快照 · 蛋卷）— 每日落库，累积历史，估值分位仅作长周期参考')
    console.log('='.repeat(96))
    const items = await fetchIndexValuations()
    console.log(`拉取当日快照成功：${items.length} 个指数/板块（${today}）`)
    const stored = await storeIndexValuations(pool, today, items)
    console.log(`落库/更新：${stored} 条`)
    if (items.length === 0) {
      console.error('没有取到估值数据，退出')
      return 1
    }

    let codes = codesOverride ?? null
    if (!codes) {
      const r = await pool.query<{ fund_code: string }>(
        `SELECT f.fund_code FROM user_fund uf JOIN fund_basic f ON f.fund_code = uf.fund_code
         WHERE uf.user_id = $1 AND uf.is_active = 1 ORDER BY f.fund_code`,
        [cfg.currentUserId]
      )
      codes = r.rows.map((x) => x.fund_code)
    }

    console.log('\n基金 → 板块估值分位（PE分位越低越便宜；低估区=历史低位）')
    console.log('-'.repeat(96))
    const byName = [...items].sort((a, b) => a.indexName.localeCompare(b.indexName, 'zh'))
    for (const code of codes) {
      const b = await pool.query<{ fund_name: string }>(`SELECT fund_name FROM fund_basic WHERE fund_code = $1`, [code])
      const fundName = b.rows[0]?.fund_name
      if (!fundName) {
        console.log(`[${code}] 无 fund_basic 记录，跳过`)
        continue
      }
      const m = matchIndex(fundName, items)
      if (!m) {
        console.log(`[${code}] ${fundName.trim().slice(0, 32).padEnd(32)} 未匹配到板块指数（不在快照列表）`)
        continue
      }
      const it = m.item
      const zone = zoneName(it.evaType)
      console.log(
        `[${code}] ${fundName.trim().slice(0, 32).padEnd(32)} → ${it.indexName} PE分位=${pct(it.pePercentile)} PB分位=${pct(it.pbPercentile)} PE=${it.pe?.toFixed(2) ?? '--'} PB=${it.pb?.toFixed(2) ?? '--'} 区间=${zone}`
      )
    }
    console.log('\n提示：估值分位是长周期（数年）参考——低估不等于短期会上涨，高估不等于短期会跌；')
    console.log('      它不能作为 T+5/T+10 的加减仓方向依据。累积历史后可用于长期定投择时。')
    console.log('-' .repeat(96))
    console.log(`快照指数清单（前 15）: ${byName.slice(0, 15).map((x) => x.indexName).join('、')}${items.length > 15 ? '…' : ''}`)
    return 0
  } catch (e) {
    console.error(`[index-valuation] FAIL: ${(e as Error).message}`)
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}