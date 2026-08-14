// browser 通道兜底（计划书 §3.2 / §4.2-6）：隐藏 BrowserWindow 加载第三方页面，
// 建立真实站点 origin 后读取内容 —— 绕过 Node 直连被反爬/限流的场景。
// M3 为通用版本：导航 + 取整页文本；T2 估值嗅探（DOM/页面接口）在 M8 完善。
import { BrowserWindow } from 'electron'
import { sleep } from '../utils'

let win: BrowserWindow | null = null

function getWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true }
  })
  return win
}

/** 隐藏窗口加载 URL，等待页面脚本/反爬逻辑执行，返回页面 HTML 文本 */
export async function pageFetchText(url: string, settleMs = 2000, timeoutMs = 20000): Promise<string> {
  const w = getWindow()
  let timeoutId: NodeJS.Timeout
  // 超时则停止加载，让 loadURL 按失败路径 reject
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      w.webContents.stop()
      reject(new Error(`pageFetch 超时 ${url}`))
    }, timeoutMs)
  })
  try {
    await Promise.race([w.loadURL(url), timeout])
    // 等待页面内脚本执行完（估值接口/动态渲染）
    await sleep(settleMs)
    return (await w.webContents.executeJavaScript('document.documentElement.outerHTML')) as string
  } finally {
    clearTimeout(timeoutId!)
  }
}

/** 隐藏窗口直接对已导航站点发同源 fetch（API 兜底，CORS 随 origin 生效） */
export async function pageFetchApi(url: string): Promise<string> {
  const w = getWindow()
  const origin = new URL(url).origin
  await w.loadURL(origin + '/')
  const body = (await w.webContents.executeJavaScript(
    `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    })()`
  )) as string
  return body
}
