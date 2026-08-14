// CLI 读取入口：electron . --news（计划书 M4 调整）
// 新闻不抓取——由另一个 24h 程序写入 ai_fund 库 raw_news 表。此命令仅验证只读链路并打印最新几条。
import { configPath, ensureConfigFile } from './config'
import { createAiFundPool } from './storage/db'
import { recentNews, newsStats } from './news/reader'

export async function runNews(): Promise<number> {
  const cfg = ensureConfigFile()
  console.log(`[news] 配置文件: ${configPath()}`)
  console.log(`[news] 数据源: ${cfg.aiFund.host}:${cfg.aiFund.port}/${cfg.aiFund.db}（只读，采集由另一个程序完成）`)
  const pool = createAiFundPool(cfg)
  try {
    await pool.query('SELECT 1')
  } catch (e) {
    console.error(`[news] ai_fund 库连接失败: ${(e as Error).message}`)
    console.error('[news] 请确认 config.json 中 aiFund 配置正确（通常与 pg 同实例，仅 db 名为 ai_fund）。')
    return 1
  }

  try {
    const stats = await newsStats(pool)
    console.log(`[news] 累计 ${stats.count} 条，最新: ${stats.latest ? stats.latest.toISOString() : '无'}`)
    const rows = await recentNews(pool, 5)
    if (rows.length === 0) {
      console.log('[news] 库中暂无新闻')
      return 0
    }
    rows.forEach((n, i) => {
      const t = n.pubTime ? n.pubTime.toLocaleString('zh-CN', { hour12: false }) : '?'
      console.log(`  ${i + 1}. [${t}] ${n.title ?? '(无标题)'}`)
      if (n.summary) console.log(`      摘要: ${n.summary.slice(0, 80)}`)
      if (n.llmTags.length > 0) console.log(`      标签: ${n.llmTags.join(' / ')}`)
    })
    console.log('[news] 完成')
    return 0
  } catch (e) {
    console.error(`[news] 读取失败: ${(e as Error).message}`)
    return 1
  } finally {
    await pool.end().catch(() => {})
  }
}
