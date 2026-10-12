// 抓取通道状态（计划书 §3.2：node 直连 / browser 隐藏窗口 / auto 失败切换）
//
// 这里只放**纯状态**，刻意不 import 任何东西（尤其不碰 electron/clipboard）：
//   - httpClient.ts 需要读它决定走哪条通道，而 httpClient 被抓取层与单测广泛引用，
//     一旦间接引入 electron，tests/trading-calendar.test.ts 等纯函数单测就会崩；
//   - config.ts（本身依赖 electron）在 loadConfig/saveConfig 时调用 setFetchChannel() 注入配置值，
//     这样 GUI、调度器、所有 CLI 分支都自动跟随 config.fetch.channel，无需各自接线。
//
// 注意（重要）：browser 通道能改善的是**指纹/签名/JS 挑战**类反爬（真实 Chromium 的 TLS/JA3、
// Header 顺序、Cookie、执行页面脚本）。它**不能**改善 IP 与请求频率两个维度——风控的主要成因仍是
// 请求量，对应措施在采集侧（批量取价、缓存、限流，见 market.ts / quotes.ts / httpClient.ts）。

export type FetchChannel = 'node' | 'browser' | 'auto'

let channel: FetchChannel = 'node'

/** 设置抓取通道（由 config.ts 在读取/保存配置时调用） */
export function setFetchChannel(c: FetchChannel): void {
  if (c === 'node' || c === 'browser' || c === 'auto') channel = c
}

/** 当前抓取通道（GUI 抓取日志页展示用） */
export function getFetchChannel(): FetchChannel {
  return channel
}

/** 当前通道下每次尝试的策略顺序（true = 浏览器通道，false = Node 直连） */
export function channelStrategy(): boolean[] {
  if (channel === 'browser') return [true]
  // auto：先 Node 直连，失败再走浏览器通道
  if (channel === 'auto') return [false, true]
  return [false]
}
