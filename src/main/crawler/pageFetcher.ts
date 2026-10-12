// browser 通道（计划书 §3.2 / §4.2-6）：隐藏 BrowserWindow 加载站点 → 同源 fetch 取**原始响应体**。
//
// 与 Node 通道的差别：请求由真实 Chromium 发出（TLS/JA3 指纹、Header 顺序、Cookie 持久化、可执行
// 站点 JS 挑战/签名脚本），因此对"指纹/签名类"反爬有效。**不能**改善 IP 与频率维度的风控——那两项与
// 用哪个 HTTP 栈无关，靠采集侧降频（批量取价/缓存/限流）解决。
//
// 两个关键实现点（原实现的两个硬伤）：
//   1. 取原始响应体：原 pageFetchText 返回 `document.documentElement.outerHTML`——
//      加载 JSON/JS 接口时 Chromium 会渲染成 HTML 包装，调用方无法 JSON.parse，接上就崩。
//      这里在页面上下文里 fetch() 后 `.text()`，拿到的才是接口原文（对 JSON/JS/HTML 都成立）。
//   2. 串行化：隐藏窗口是共享资源，并发 loadURL/executeJavaScript 会互相打断（原实现无任何排队）。
//      所有浏览器通道请求经内部队列串行执行；同 origin 时复用已加载页面，不重复导航。
import { BrowserWindow } from 'electron'
import { sleep } from '../utils'
import { logInfo } from '../logger'

let win: BrowserWindow | null = null
let loadedOrigin: string | null = null
// 串行队列：浏览器通道一次只跑一个任务（共享窗口并发会互相打断）
let queue: Promise<unknown> = Promise.resolve()

function getWindow(): BrowserWindow {
  if (win && !win.isDestroyed()) return win
  win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    webPreferences: { sandbox: true }
  })
  win.on('closed', () => {
    win = null
    loadedOrigin = null
  })
  logInfo('[pageFetcher] 创建隐藏窗口（浏览器通道生效中）')
  return win
}

/** 串行执行（单次失败不阻塞后续任务） */
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => {})
  return run
}

function withTimeout<T>(p: Promise<T>, timeoutMs: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), timeoutMs)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      }
    )
  })
}

/**
 * 浏览器通道取原始响应体（JSON/JS/HTML 均可直接解析）。
 * 流程：导航到目标 origin（建立站点上下文、种 Cookie）→ 页面内同源 fetch → 返回响应文本。
 * 非 2xx 会抛错（与 Node 通道语义一致，便于调用方走降级/重试）。
 */
export async function browserGetText(url: string, timeoutMs = 20000): Promise<string> {
  return serialize(async () => {
    const w = getWindow()
    const origin = new URL(url).origin

    if (loadedOrigin !== origin) {
      if (w.webContents.isLoading()) w.webContents.stop()
      try {
        await withTimeout(w.loadURL(`${origin}/`), timeoutMs, `浏览器通道加载 ${origin} 超时`)
      } catch (e) {
        loadedOrigin = null // 导航失败不缓存 origin，下次重新尝试
        throw e
      }
      loadedOrigin = origin
      // 等站点首屏脚本/反爬逻辑跑完，再发同源请求（否则可能拿到未就绪的上下文）
      await sleep(500)
    }

    const script = `(async () => {
      const r = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    })()`
    const body = (await withTimeout(
      w.webContents.executeJavaScript(script) as Promise<string>,
      timeoutMs,
      `浏览器通道取数超时 ${url}`
    )) as string
    if (!body) throw new Error('浏览器通道空响应')
    return body
  })
}

/** 隐藏窗口加载 URL，等待页面脚本执行后返回整页 HTML 文本。
 *  仅用于**必须渲染 DOM** 的页面（表格/无接口的页面）；接口类数据请用 browserGetText()。 */
export async function pageFetchText(url: string, settleMs = 2000, timeoutMs = 20000): Promise<string> {
  return serialize(async () => {
    const w = getWindow()
    try {
      await withTimeout(w.loadURL(url), timeoutMs, `pageFetch 超时 ${url}`)
    } catch (e) {
      w.webContents.stop()
      throw e
    }
    loadedOrigin = new URL(url).origin
    await sleep(settleMs)
    return (await w.webContents.executeJavaScript('document.documentElement.outerHTML')) as string
  })
}

/** 隐藏窗口直接对已导航站点发同源 fetch（等价 browserGetText，保留旧名以免外部引用失效） */
export async function pageFetchApi(url: string): Promise<string> {
  return browserGetText(url)
}

/** 关闭隐藏窗口（退出时调用：窗口上可能还有未完成的页面加载，会拖慢退出） */
export function destroyBrowserChannel(): void {
  if (win && !win.isDestroyed()) {
    win.destroy()
  }
  win = null
  loadedOrigin = null
}
