// 抓取通道调度（计划书 §3.2：node 直连 > browser 隐藏窗口兜底；config.fetch.channel 控制）
import { httpGetText, type GetOptions } from './httpClient'
import { pageFetchText } from './pageFetcher'

export type Channel = 'node' | 'browser' | 'auto'

/** 按通道取文本：node 直连；browser 隐藏窗口；auto 先 node，失败切 browser */
export async function getTextWithChannel(
  channel: Channel,
  url: string,
  opts: GetOptions = {}
): Promise<string> {
  if (channel === 'browser') return pageFetchText(url)
  try {
    return await httpGetText(url, opts)
  } catch (e) {
    if (channel === 'auto') {
      console.warn(`[channel] Node 直连失败，切换隐藏窗口: ${(e as Error).message}`)
      return pageFetchText(url)
    }
    throw e
  }
}
