// 盘中估值（计划书 §4.4/§5 风险表 #7）
// T1：跟踪指数实时行情 → 估算涨跌幅（source='tracking_index'）
// T2：同主题 ETF 实时行情 → 估算涨跌幅（source='theme_etf'；页面估值接口 fundgz 已下线，用主题 ETF 替代）
// T3：无匹配 → 返回 null（主动型基金无盘中估值，界面标注"无估值"）
import { quoteBySecid } from './market'

// 第一层：基金简称关键词 → 跟踪指数 secid
// 顺序敏感：更具体的关键词在前（如"科创50"在"中证A50"前）
const INDEX_RULES: { re: RegExp; secid: string; name: string }[] = [
  { re: /沪深300/, secid: '1.000300', name: '沪深300' },
  { re: /中证1000/, secid: '1.000852', name: '中证1000' },
  { re: /中证500/, secid: '1.000905', name: '中证500' },
  { re: /上证50/, secid: '1.000016', name: '上证50' },
  { re: /科创50|科创板/, secid: '1.000688', name: '科创50' },
  { re: /科创100/, secid: '1.000698', name: '科创100' },
  { re: /创业板/, secid: '0.399006', name: '创业板指' },
  { re: /中证2000/, secid: '1.932000', name: '中证2000' },
  { re: /中证A500/, secid: '1.000510', name: '中证A500' },
  { re: /中证A50/, secid: '1.930050', name: '中证A50' },
  { re: /中证800/, secid: '1.000906', name: '中证800' },
  { re: /上证180/, secid: '1.000010', name: '上证180' },
  { re: /深证100|深100/, secid: '0.399330', name: '深证100' },
  { re: /中证红利/, secid: '1.000922', name: '中证红利' },
  { re: /上证指数|沪指/, secid: '1.000001', name: '上证指数' },
  { re: /深证成指/, secid: '0.399001', name: '深证成指' },
  { re: /国证/, secid: '0.399997', name: '国证A指' }
]

// 第二层：基金简称关键词 → 同主题 ETF secid（T2）
// 命中指数的基金已优先；此处承接"行业/主题"型基金（页面估值接口 fundgz 已下线，用主题 ETF 实时价替代）
const ETF_RULES: { re: RegExp; secid: string; name: string }[] = [
  { re: /有色金属|工业有色/, secid: '1.512400', name: '有色金属ETF' },
  { re: /新能源/, secid: '0.159875', name: '新能源ETF' },
  { re: /证券|券商/, secid: '1.512880', name: '证券ETF' },
  { re: /半导体|芯片/, secid: '1.512480', name: '半导体ETF' },
  { re: /医药|医疗/, secid: '0.159929', name: '医药ETF' },
  { re: /消费/, secid: '1.510150', name: '消费ETF' },
  { re: /军工|国防/, secid: '1.512660', name: '军工ETF' },
  { re: /银行/, secid: '1.512800', name: '银行ETF' },
  { re: /煤炭/, secid: '1.515220', name: '煤炭ETF' },
  { re: /白酒|食品饮料/, secid: '1.512690', name: '酒ETF' },
  { re: /光伏/, secid: '1.515790', name: '光伏ETF' },
  { re: /人工智能|AI/, secid: '1.515070', name: 'AIETF' },
  { re: /房地产/, secid: '1.512200', name: '房地产ETF' },
  { re: /钢铁/, secid: '1.515210', name: '钢铁ETF' },
  { re: /基建/, secid: '1.516950', name: '基建ETF' },
  { re: /化工/, secid: '1.516020', name: '化工ETF' },
  { re: /农业/, secid: '1.516920', name: '农业ETF' },
  { re: /计算机|软件/, secid: '1.512720', name: '计算机ETF' },
  { re: /传媒/, secid: '1.512980', name: '传媒ETF' }
]

export type EstimateSource = 'tracking_index' | 'theme_etf'

export interface TrackingMatch {
  secid: string
  name: string
  source: EstimateSource
}

export function findTrackingIndex(fundName: string): TrackingMatch | null {
  for (const r of INDEX_RULES) {
    if (r.re.test(fundName)) return { secid: r.secid, name: r.name, source: 'tracking_index' }
  }
  for (const r of ETF_RULES) {
    if (r.re.test(fundName)) return { secid: r.secid, name: r.name, source: 'theme_etf' }
  }
  return null
}

export interface EstimateT1Result {
  secid: string
  indexName: string
  pct: number | null
  ts: Date
  source: EstimateSource
}

/** T1/T2：取跟踪指数或主题 ETF 实时涨跌幅 */
export async function estimateT1(fundName: string): Promise<EstimateT1Result | null> {
  const idx = findTrackingIndex(fundName)
  if (!idx) return null
  const q = await quoteBySecid(idx.secid)
  return { secid: idx.secid, indexName: idx.name, pct: q.pct, ts: new Date(), source: idx.source }
}
