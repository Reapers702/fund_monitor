// 提醒规则（纯函数，独立便于单测）：把"数据 + 阈值"映射成待推送的提醒列表。
// 只负责判断与文案，不碰数据库、不发通知（IO 与去重在 run.ts）。
//
// 阈值语义（0 = 关闭该项）：
//   navMovePct      最新净值单日涨跌绝对值达到该值 → 净值异动
//   estimateMovePct 最新盘中估值涨跌绝对值达到该值 → 盘中估值异动
//   estimateOffPct  盘中估值与实际净值偏离达到该值 → 估值失真预警（T3 可信度下降）
//   badNews         重仓股出现负面新闻 → 提醒
//   takeProfitPct   持仓收益率 ≥ 该值 → 止盈提醒
//   stopLossPct     持仓收益率 ≤ −该值 → 止损提醒

import { ESTIMATE_SOURCE_NAMES } from '../crawler/estimate'
import { localDateStr, localClockStr } from '../utils'

export type AlertType = 'nav_move' | 'estimate_move' | 'estimate_off' | 'bad_news' | 'take_profit' | 'stop_loss'

export interface AlertThresholds {
  navMovePct: number
  estimateMovePct: number
  estimateOffPct: number
  badNews: boolean
  takeProfitPct: number
  stopLossPct: number
}

/** 数据新鲜度上下文（必传）。提醒的文案是"当前/当日"，只能建立在当期数据上：
 *  拿一个月前的估值采样推"当前估算 -4%"既误导，又会占掉当天去重名额，
 *  真实数据到达后反而不再提醒（去重键含交易日）。 */
export interface AlertTimeContext {
  /** 本地日期 YYYY-MM-DD（判断盘中估值是否为"今天"的采样） */
  today: string
  /** 当前应已确认的数据日期：交易日=今天，非交易日=最近交易日（周五净值周六凌晨才公布，周末仍要补评） */
  expectedDataDate: string
}

export interface AlertFundInput {
  code: string
  name: string
  navChangePct: number | null // 最新净值当日涨跌 %
  navDate: string | null
  estPct: number | null // 最新盘中估值涨跌 %
  estSource: string | null
  estTime: string | null // 估值采样时间（ISO，用于判断是否今天采的）
  estimateOffPct: number | null // 最近一次"估值 vs 实际净值"偏差（百分点）
  estimateOffDate: string | null
  pnlPct: number | null // 持仓收益率 %（无持仓为 null）
  badNewsTitles: string[] // 命中该基金重仓股/主题的负面新闻标题
}

export interface AlertItem {
  type: AlertType
  fundCode: string
  fundName: string
  title: string
  body: string
}

/** 带符号百分比文本 */
function pct(v: number): string {
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** 新闻情绪是否为负面（库里是大写英文 NEGATIVE，容错大小写与中文） */
export function isNegativeSentiment(sentiment: string | null): boolean {
  if (!sentiment) return false
  const s = sentiment.trim().toUpperCase()
  return s === 'NEGATIVE' || s === '利空'
}

/** 盘中只评估估值类（净值/持仓在盘中还是昨日数据，提前用会误报并占掉当天去重名额） */
export const INTRADAY_ALERT_TYPES: AlertType[] = ['estimate_move']
/** 盘后评估收盘净值、估值失真、止盈止损、重仓股负面新闻 */
export const CLOSE_ALERT_TYPES: AlertType[] = ['nav_move', 'estimate_off', 'take_profit', 'stop_loss', 'bad_news']

/**
 * 逐基金评估提醒。同一基金可能触发多条（如同时净值异动 + 止盈），
 * 去重由调用方按 (用户, 基金, 类型, 日期) 处理——同一天同类只提醒一次。
 * types 传入时只返回这些类型（盘中/盘后分流用）；ctx 为数据新鲜度上下文（见 AlertTimeContext）。
 */
export function evaluateAlerts(
  funds: AlertFundInput[],
  t: AlertThresholds,
  ctx: AlertTimeContext,
  types?: AlertType[]
): AlertItem[] {
  const out: AlertItem[] = []
  const want = (ty: AlertType): boolean => !types || types.includes(ty)
  // 净值/估值失真/持仓收益率都取自"最近一次已确认净值"，数据日期必须等于当期数据日期
  const navFresh = (f: AlertFundInput): boolean => f.navDate !== null && f.navDate === ctx.expectedDataDate
  // 盘中估值是当天盘中的点值：必须是今天采的，隔夜/隔周的采样不能当"当前"
  const estFresh = (f: AlertFundInput): boolean => localDateStr(f.estTime) === ctx.today

  for (const f of funds) {
    // ① 净值异动（收盘确认值）
    if (want('nav_move') && t.navMovePct > 0 && navFresh(f) && f.navChangePct !== null && Math.abs(f.navChangePct) >= t.navMovePct) {
      out.push({
        type: 'nav_move',
        fundCode: f.code,
        fundName: f.name,
        title: `【净值异动】${f.name}（${f.code}）${pct(f.navChangePct)}`,
        body: `${f.navDate ?? ''} 单位净值当日${f.navChangePct >= 0 ? '上涨' : '下跌'} ${Math.abs(f.navChangePct).toFixed(2)}%，已达提醒阈值 ${t.navMovePct}%。`
      })
    }

    // ② 盘中估值异动（预测值，盘中参考）
    if (want('estimate_move') && t.estimateMovePct > 0 && estFresh(f) && f.estPct !== null && Math.abs(f.estPct) >= t.estimateMovePct) {
      const src = ESTIMATE_SOURCE_NAMES[f.estSource ?? ''] ?? '盘中估值'
      const clock = localClockStr(f.estTime)
      out.push({
        type: 'estimate_move',
        fundCode: f.code,
        fundName: f.name,
        title: `【盘中估值异动】${f.name}（${f.code}）${pct(f.estPct)}`,
        body: `${src}${clock ? ` ${clock} 采样` : ''}显示当前估算 ${pct(f.estPct)}，已达阈值 ${t.estimateMovePct}%。盘中估值为预测值、存在误差，仅供盘中参考。`
      })
    }

    // ③ 估值失真（估值方式可信度下降）：偏差是"某交易日估值 vs 该日实际净值"，需当日已确认净值
    if (
      want('estimate_off') &&
      t.estimateOffPct > 0 &&
      f.estimateOffPct !== null &&
      f.estimateOffDate === ctx.expectedDataDate &&
      Math.abs(f.estimateOffPct) >= t.estimateOffPct
    ) {
      out.push({
        type: 'estimate_off',
        fundCode: f.code,
        fundName: f.name,
        title: `【估值失真】${f.name}（${f.code}）偏差 ${Math.abs(f.estimateOffPct).toFixed(2)} 个百分点`,
        body: `${f.estimateOffDate ?? ''} 盘中估值与实际净值相差 ${f.estimateOffPct >= 0 ? '+' : ''}${f.estimateOffPct.toFixed(2)} 个百分点，超过阈值 ${t.estimateOffPct}。该估值方式近期参考价值下降（主动型基金多因季报持仓滞后）。`
      })
    }

    // ④ 重仓股负面新闻（消息本身即当期，由取数方限定时间窗）
    if (want('bad_news') && t.badNews && f.badNewsTitles.length > 0) {
      out.push({
        type: 'bad_news',
        fundCode: f.code,
        fundName: f.name,
        title: `【重仓股负面】${f.name}（${f.code}）`,
        body: f.badNewsTitles
          .slice(0, 2)
          .map((x) => `· ${x}`)
          .join('\n')
      })
    }

    // ⑤ 止盈 / 止损（基于持仓收益率，收益率随净值走 → 同样要求净值当期）
    if (want('take_profit') && t.takeProfitPct > 0 && navFresh(f) && f.pnlPct !== null && f.pnlPct >= t.takeProfitPct) {
      out.push({
        type: 'take_profit',
        fundCode: f.code,
        fundName: f.name,
        title: `【止盈提醒】${f.name}（${f.code}）收益 ${pct(f.pnlPct)}`,
        body: `持仓收益率已达 ${f.pnlPct.toFixed(2)}%，超过止盈阈值 ${t.takeProfitPct}%，可考虑分批止盈。`
      })
    }
    if (want('stop_loss') && t.stopLossPct > 0 && navFresh(f) && f.pnlPct !== null && f.pnlPct <= -t.stopLossPct) {
      out.push({
        type: 'stop_loss',
        fundCode: f.code,
        fundName: f.name,
        title: `【止损提醒】${f.name}（${f.code}）收益 ${pct(f.pnlPct)}`,
        body: `持仓收益率已跌至 ${f.pnlPct.toFixed(2)}%，触及止损阈值 −${t.stopLossPct}%，请评估是否减仓。`
      })
    }
  }

  return out
}

/** UI/日志用：提醒类型中文名 */
export const ALERT_TYPE_NAMES: Record<AlertType, string> = {
  nav_move: '净值异动',
  estimate_move: '盘中估值异动',
  estimate_off: '估值失真',
  bad_news: '重仓股负面新闻',
  take_profit: '止盈',
  stop_loss: '止损'
}
