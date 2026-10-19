// 指数估值分位块（喂给 AI 的长周期"贵/便宜"参考轴）。
//
// 为什么需要：动量/超额/回撤都是短周期信号，AI 此前完全看不到"板块已经很贵/很便宜"。
// index_valuation 表（蛋卷每日快照，见 schema.ts）已入库 60+ 指数的 PE/PB 历史分位与
// 估值状态，但从未进入 prompt。行业主题基金（本项目自选多为医药/银行/证券/白酒/芯片等）
// 恰恰最需要这一轴：分位极低时深跌未必是趋势恶化，分位极高时反弹也未必值得追。
//
// 口径说明：
//  - 分位 0~1，来自数据源自身的历史窗口，统一换算成百分比展示；
//  - eva_type 是数据源给的区间标签（low/mid/high），与分位可能略有出入，一并给出；
//  - 匹配不到对应行业指数时返回 null，调用方不拼该块（不猜、不硬套宽基）。
import type { Pool } from 'pg'

/** 基金主题关键词 → 估值指数名（按顺序匹配，先命中者优先；长词在前避免「证券」抢「证券公司」之外的情况） */
const THEME_INDEX: readonly [string, string][] = [
  ['白酒', '中证白酒'],
  ['食品饮料', '国证食品'],
  ['消费', '主要消费'],
  ['医药', '全指医药'],
  ['医疗', '中证医疗'],
  ['生物', '全指医药'],
  ['银行', '中证银行'],
  ['证券', '证券公司'],
  ['非银', '证券公司'],
  ['保险', '证券公司'],
  ['军工', '中证军工'],
  ['国防', '中证军工'],
  ['半导体', '中证电子'],
  ['芯片', '中证电子'],
  ['电子', '中证电子'],
  ['科技', '科技龙头'],
  ['信息', '全指信息'],
  ['传媒', '中证传媒'],
  ['通信', '5G通讯'],
  ['5G', '5G通讯'],
  ['计算机', '全指信息'],
  ['软件', '全指信息'],
  ['人工智能', '科技龙头'],
  ['云计算', '全指信息'],
  ['数字', '全指信息'],
  ['新能源车', '新能源车'],
  ['新能源汽车', '新能源车'],
  ['光伏', '新能源车'],
  ['电池', '新能源车'],
  ['新能源', '新能源车'],
  ['煤炭', '中证煤炭'],
  ['有色', '中证有色'],
  ['钢铁', '中证煤炭'],
  ['环保', '中证环保'],
  ['地产', '国证地产'],
  ['房地产', '国证地产'],
  ['红利', '中证红利'],
  ['恒生科技', '恒生科技'],
  ['港股', '恒生指数'],
  ['中概', '中概互联50'],
  ['互联', '中国互联'],
  ['纳斯达克', '纳指100'],
  ['标普', '标普500'],
  ['沪深300', '沪深300'],
  ['中证500', '中证500'],
  ['中证1000', '中证1000'],
  ['上证50', '上证50'],
  ['创业板', '创业板'],
  ['科创', '科创50']
]

export interface IndexValuation {
  indexName: string
  /** 估值日期 YYYY-MM-DD */
  asof: string | null
  /** PE 历史分位 0~1 */
  pePercentile: number | null
  /** PB 历史分位 0~1 */
  pbPercentile: number | null
  pe: number | null
  roe: number | null
  /** 数据源估值标签：low/mid/high */
  evaType: string | null
}

/**
 * 按基金名匹配最合适的估值指数，读取其最新一版估值分位。
 * 匹配不到 → null（调用方跳过该块）。查询失败由调用方 catch。
 */
export async function loadIndexValuation(
  pool: Pool,
  fundName: string
): Promise<IndexValuation | null> {
  const hit = THEME_INDEX.find(([kw]) => fundName.includes(kw))
  if (!hit) return null
  const indexName = hit[1]

  const r = await pool.query<{
    index_name: string
    trade_date: Date | null
    pe: string | null
    pe_percentile: string | null
    pb_percentile: string | null
    roe: string | null
    eva_type: string | null
  }>(
    `SELECT index_name, trade_date, pe, pe_percentile, pb_percentile, roe, eva_type
       FROM index_valuation
      WHERE index_name = $1
      ORDER BY trade_date DESC
      LIMIT 1`,
    [indexName]
  )
  const row = r.rows[0]
  if (!row) return null

  const num = (v: string | null): number | null => (v === null ? null : Number(v))
  return {
    indexName: row.index_name,
    asof: row.trade_date ? toDateOnly(row.trade_date) : null,
    pePercentile: num(row.pe_percentile),
    pbPercentile: num(row.pb_percentile),
    pe: num(row.pe),
    roe: num(row.roe),
    evaType: row.eva_type
  }
}

function toDateOnly(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const EVA_CN: Record<string, string> = { low: '低估', mid: '适中', high: '高估' }

/** 分位 0~1 → 「23.4%（偏低）」这类可读描述 */
export function describePercentile(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return '--'
  const pct = p * 100
  const tag = pct < 20 ? '偏低' : pct < 50 ? '中低' : pct < 80 ? '中高' : '偏高'
  return `${pct.toFixed(1)}%（${tag}）`
}

/**
 * 估值分位 → 给 AI 看的文字块。强调这是长周期参考轴，避免模型拿它当短线择时信号。
 * 数据缺失的字段按 -- 展示，不省略整块（分位缺失时 PE 绝对值仍有参考意义）。
 */
export function formatValuationBlock(v: IndexValuation): string {
  const parts: string[] = [
    `PE 分位 ${describePercentile(v.pePercentile)}`,
    `PB 分位 ${describePercentile(v.pbPercentile)}`
  ]
  if (v.pe !== null) parts.push(`PE ${v.pe.toFixed(2)}`)
  if (v.roe !== null) parts.push(`ROE ${(v.roe * 100).toFixed(2)}%`)
  const eva = v.evaType ? `，数据源估值标签【${EVA_CN[v.evaType] ?? v.evaType}】` : ''
  return `板块估值分位（${v.indexName}，截至 ${v.asof ?? '--'}${eva}）：${parts.join('｜')}
（说明：这是该板块自身历史的长周期参考轴，不是短线择时信号；分位低≠马上涨，分位高≠马上跌，请与动量/相对强弱/催化剂交叉判断。）`
}
