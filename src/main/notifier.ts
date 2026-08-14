// 桌面通知（计划书 §7.3：AI 建议非 hold 时弹出；M7 持仓收益提醒复用）
import { Notification } from 'electron'

export interface NotifyPayload {
  title: string
  body: string
}

const ACTION_TEXT: Record<string, string> = {
  add: '加仓',
  reduce: '减仓',
  hold: '持有'
}

/** 发送桌面通知；Electron 未就绪/平台不支持时静默降级为 console */
export function notify(payload: NotifyPayload): void {
  try {
    if (!Notification.isSupported()) {
      console.log(`[notify] 平台不支持通知: ${payload.title} | ${payload.body}`)
      return
    }
    new Notification({ title: payload.title, body: payload.body, silent: false }).show()
    console.log(`[notify] ${payload.title} | ${payload.body.slice(0, 80)}`)
  } catch (e) {
    console.warn(`[notify] 通知失败: ${(e as Error).message}`)
  }
}

/** 将 AI 建议转为通知文案（action != hold 时调用） */
export function notifyAdvice(fundName: string, code: string, action: string, confidence: number, reason: string): void {
  const actionText = ACTION_TEXT[action] ?? action
  notify({
    title: `【AI 建议】${fundName}（${code}）→ ${actionText}`,
    body: `置信度 ${confidence}%。${reason}`
  })
}
