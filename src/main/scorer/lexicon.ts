// 新闻情绪词典（纯函数，独立便于单测）
//
// 打分规则引擎的"词典通道"：对新闻 title+summary 做确定性词频命中，归一化到 [-2,+2]。
// 设计意图：
//   - 确定性：同一文本永远得同一分，是可回测的"锚"（LLM 通道有随机性，用它兜底）；
//   - 低成本：不依赖 LLM，历史新闻样本 100% 可复现；
//   - 语义兜底：LLM 语义打分与词典分按 α/β 加权，词典保证即使 LLM 抽风也有下界。
//
// 词表刻意保持精简 + 高频明确语义，避免把"中性词"误判为情绪（宁可少报不可乱报）。

/** 正情绪关键词（利好/偏暖） */
const POSITIVE_WORDS = [
  '突破', '涨价', '提价', '超预期', '创新高', '历史新高', '新高', '中标', '获批',
  '增持', '回购', '扩产', '产能释放', '涨停', '大涨', '领涨', '净流入', '主力流入',
  '业绩预增', '扭亏', '净利润增长', '营收增长', '需求旺盛', '供不应求', '景气',
  '政策利好', '资金加仓', '评级上调', '目标价上调', '大单', '订单饱满', '出货量高増'
]

/** 负情绪关键词（利空/偏空） */
const NEGATIVE_WORDS = [
  '暴雷', '爆雷', '跌停', '大跌', '领跌', '净流出', '主力出逃', '减持', '套现',
  '下调', '评级下调', '目标价下调', '业绩预亏', '亏损', '业绩下滑', '业绩低于预期',
  '营收下滑', '需求疲软', '库存高企', '去库存', '滞销', '停产', '限产', '退市风险',
  '诉讼', '立案', '处罚', '董事长被抓', '爆仓', '跑路', '踩雷', '商誉减值', '资金紧张'
]

// 词表构建一次，避免每次匹配重建数组
const POSITIVE = POSITIVE_WORDS.map((w) => w)
const NEGATIVE = NEGATIVE_WORDS.map((w) => w)

/** 命中计数（子串匹配；用 includes 而非 split，避免分词边界误判） */
function countHits(text: string, words: readonly string[]): number {
  let n = 0
  for (const w of words) {
    if (text.includes(w)) n++
  }
  return n
}

/**
 * 字典情绪分 → [-2, +2]。
 * 公式：raw = (pos − neg) / √(词数 + 1)，再 clamp 到 [-2, +2]。
 * √ 归一化防止长文本堆叠正/负词把分数撑爆；+1 防止除零。
 */
export function dictScore(text: string): number {
  const t = text || ''
  if (t.trim().length === 0) return 0
  const pos = countHits(t, POSITIVE)
  const neg = countHits(t, NEGATIVE)
  if (pos === 0 && neg === 0) return 0
  const raw = (pos - neg) / Math.sqrt(pos + neg + 1)
  return Math.max(-2, Math.min(2, raw))
}

/**
 * 一组新闻的聚合情绪分 → [-3, +3]。
 * 对每条新闻 dictScore，用「相关性权重(默认全 1，由调用方传) × 时间衰减」加权平均，再放大到 ±3。
 * 时间衰减系数 λ：-λ·天数，调用方可传 0（忽略时间）或 >0（近期权重更高）。
 */
export function aggregateNewsScore(
  items: { text: string; weight?: number; daysAgo?: number }[],
  lambda = 0.15
): number {
  if (items.length === 0) return 0
  let num = 0
  let den = 0
  for (const it of items) {
    const w = (it.weight ?? 1) * (lambda >= 0 ? Math.exp(-lambda * (it.daysAgo ?? 0)) : 1)
    if (w <= 0) continue
    num += dictScore(it.text) * w
    den += w
  }
  if (den <= 0) return 0
  // 聚合到 [-3, +3]（词典单条上限 ±2，聚合上限 ±3，留出 LLM 通道叠加空间）
  return Math.max(-3, Math.min(3, (num / den) * 1.5))
}