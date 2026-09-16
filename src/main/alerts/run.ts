// 提醒执行器：取数 → 纯规则评估（alerts/rules.ts）→ 去重入库 → 桌面通知。
// 去重口径：(user_id, fund_code, alert_type, 交易日) 唯一，同一天同类只推一次——
// 盘中估值每 5 分钟采样一次，没有去重会把同一件事推上百遍。
import type { Pool } from 'pg'
import { evaluateAlerts, isNegativeSentiment, INTRADAY_ALERT_TYPES, CLOSE_ALERT_TYPES } from './rules'
import type { AlertFundInput, AlertItem, AlertThresholds } from './rules'
import { listFunds, estimateDiffStats, latestHoldingsBatch } from '../storage/queries'
import { listPositions } from '../position/position'
import { recentNewsSince } from '../news/reader'
import { isTradingDay, latestTradingDayStr } from '../scheduler/tradingCalendar'
import { notify } from '../notifier'
import { todayStr } from '../quotes'
import { logInfo, logWarn } from '../logger'
import type { AppConfig } from '../config'

export interface AlertRunResult {
  evaluated: number // 参与评估的（用户, 基金）对数
  triggered: number // 命中规则的提醒条数（去重前）
  notified: number // 实际推送条数（去重后）
  items: { userId: number; fundCode: string; type: string; title: string }[]
}

/** 负面新闻匹配用：标题/摘要里是否出现该关键词 */
function matchesKeyword(text: string, keywords: string[]): boolean {
  return keywords.some((k) => k.length >= 2 && text.includes(k))
}

/**
 * 跑一轮提醒检查（供 scheduler / 手动触发调用）。
 * @param scope 仅用于日志区分：intraday=盘中（估值类）、close=盘后（净值/亏损/新闻类）
 */
export async function runAlertCheck(pool: Pool, aiFundPool: Pool, cfg: AppConfig, scope: 'intraday' | 'close'): Promise<AlertRunResult> {
  const result: AlertRunResult = { evaluated: 0, triggered: 0, notified: 0, items: [] }
  const t: AlertThresholds = cfg.alerts
  // 盘中只评估估值类：净值/持仓在盘中仍是昨日数据，提前触发会误报且占掉当天去重名额
  const types = scope === 'intraday' ? INTRADAY_ALERT_TYPES : CLOSE_ALERT_TYPES

  // 数据新鲜度：交易日的当期数据=today；非交易日=最近交易日（周五净值周六凌晨才公布，周末仍要补评）。
  // 手动触发（--alerts / 设置页按钮）时库里数据可能陈旧，不校验就会拿旧数据推"当前"提醒。
  const today = todayStr()
  let expectedDataDate = today
  try {
    const trading = await isTradingDay(new Date())
    if (!trading) expectedDataDate = latestTradingDayStr()
  } catch (e) {
    logWarn(`[alerts] 交易日判断失败（按今日校验新鲜度）: ${(e as Error).message}`)
  }
  const ctx = { today, expectedDataDate }

  // 负面新闻只需取一次，再在本地按各基金重仓股名匹配（避免逐基金查库）。
  // 按 24h 时间窗取而非"最新 N 条"：新闻高峰期条数窗口只覆盖几小时，会漏掉当天早间的消息。
  let negativeNews: { title: string; text: string }[] = []
  if (t.badNews && types.includes('bad_news')) {
    try {
      const news = await recentNewsSince(aiFundPool, 24)
      negativeNews = news
        .filter((n) => isNegativeSentiment(n.sentiment))
        .map((n) => ({ title: n.title ?? '', text: `${n.title ?? ''} ${n.summary ?? ''}` }))
        .filter((n) => n.title)
    } catch (e) {
      logWarn(`[alerts] 负面新闻读取失败（跳过新闻类提醒）: ${(e as Error).message}`)
    }
  }

  const users = await pool.query<{ id: number }>('SELECT id FROM app_user ORDER BY id')
  for (const u of users.rows) {
    // 每个用户的阈值目前共用全局配置；按用户隔离数据（自选/持仓）
    const [funds, positions] = await Promise.all([listFunds(pool, u.id), listPositions(pool, u.id)])
    const active = funds.filter((f) => f.isActive === 1)
    if (active.length === 0) continue
    const codes = active.map((f) => f.code)

    const [diffStats, holdings] = await Promise.all([
      estimateDiffStats(pool, u.id, 20).catch(() => []),
      latestHoldingsBatch(pool, codes)
    ])
    const diffByFund = new Map<string, { diff: number | null; date: string | null }>()
    for (const d of diffStats) {
      if (!diffByFund.has(d.fundCode)) diffByFund.set(d.fundCode, { diff: d.latestDiff, date: d.latestTradeDate })
    }
    const pnlByFund = new Map(positions.map((p) => [p.fundCode, p.pnlPct]))

    const inputs: AlertFundInput[] = active.map((f) => {
      const diff = diffByFund.get(f.code)
      const keywords = [f.name.replace(/[联接A-C0-9]+$/g, '').slice(0, 6), ...(holdings.get(f.code) ?? []).map((h) => h.stockName ?? '')]
        .filter((s) => Boolean(s))
        .slice(0, 11)
      return {
        code: f.code,
        name: f.name,
        navChangePct: f.navChangePct,
        navDate: f.latestNavDate,
        estPct: f.estPct,
        estSource: f.estSource,
        estTime: f.estTime,
        estimateOffPct: diff?.diff ?? null,
        estimateOffDate: diff?.date ?? null,
        pnlPct: pnlByFund.get(f.code) ?? null,
        badNewsTitles: negativeNews.filter((n) => matchesKeyword(n.text, keywords)).map((n) => n.title)
      }
    })

    result.evaluated += inputs.length
    const alerts = evaluateAlerts(inputs, t, ctx, types)
    result.triggered += alerts.length
    result.notified += await insertAndNotify(pool, u.id, alerts, result)
  }

  console.log(`[alerts] ${scope} 完成：评估 ${result.evaluated} 只，命中 ${result.triggered} 条，推送 ${result.notified} 条`)
  if (result.notified > 0) logInfo(`[alerts] ${scope} 推送 ${result.notified} 条提醒`)
  return result
}

/** 入库（唯一约束冲突=今日已推过）→ 仅新插入的才发通知；返回新推送条数 */
async function insertAndNotify(pool: Pool, userId: number, alerts: AlertItem[], result: AlertRunResult): Promise<number> {
  let notified = 0
  const day = todayStr()
  for (const a of alerts) {
    try {
      const r = await pool.query(
        `INSERT INTO alert_log (user_id, fund_code, alert_type, trade_date, detail)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, fund_code, alert_type, trade_date) DO NOTHING`,
        [userId, a.fundCode, a.type, day, `${a.title}\n${a.body}`]
      )
      if ((r.rowCount ?? 0) === 0) continue // 今日已推过同类提醒
      notify({ title: a.title, body: a.body })
      result.items.push({ userId, fundCode: a.fundCode, type: a.type, title: a.title })
      notified++
    } catch (e) {
      logWarn(`[alerts] 提醒入库失败 ${a.type}/${a.fundCode}: ${(e as Error).message}`)
    }
  }
  return notified
}

/** 清理过期提醒记录（保留最近 days 天，避免表无限增长） */
export async function cleanupAlertLog(pool: Pool, days = 90): Promise<number> {
  const r = await pool.query(`DELETE FROM alert_log WHERE trade_date < CURRENT_DATE - make_interval(days => $1)`, [days])
  return r.rowCount ?? 0
}
