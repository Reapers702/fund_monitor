// 交易时段判断（纯函数，独立便于单测）

/** 本地当前时刻的 小时×60+分钟 */
export function nowMinutes(d = new Date()): number {
  return d.getHours() * 60 + d.getMinutes()
}

/** 是否交易日：周一到周五（法定节假日不处理，属低频个人工具合理取舍） */
export function isTradingDay(d = new Date()): boolean {
  const day = d.getDay()
  return day >= 1 && day <= 5
}

/** 盘中时段：9:30-11:30 或 13:00-15:00 */
export function isIntraday(m = nowMinutes()): boolean {
  return (m >= 9 * 60 + 30 && m <= 11 * 60 + 30) || (m >= 13 * 60 && m <= 15 * 60)
}

/** 盘后（净值/AI 分析可跑）：>= 15:30 */
export function isAfterClose(m = nowMinutes()): boolean {
  return m >= 15 * 60 + 30
}
