import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// 渲染进程可用的业务 API，与 src/main/ipc.ts 的 handler 一一对应。
const api: FundApi = {
  ping: (): Promise<string> => ipcRenderer.invoke('app:ping'),
  getAppInfo: (): Promise<AppInfo> => ipcRenderer.invoke('app:getAppInfo'),

  fundsList: (): Promise<FundCard[]> => ipcRenderer.invoke('funds:list'),
  fundsAdd: (code: string): Promise<FundSyncResult> => ipcRenderer.invoke('funds:add', code),
  fundsToggle: (code: string, active: boolean): Promise<void> => ipcRenderer.invoke('funds:toggle', code, active),

  fundDetail: (code: string, days = 120): Promise<FundDetail> => ipcRenderer.invoke('fund:detail', code, days),
  adviceAnalyze: (code: string): Promise<AdviceRunResult> => ipcRenderer.invoke('advice:analyze', code),

  positionList: (): Promise<PositionSummary[]> => ipcRenderer.invoke('position:list'),
  positionDetail: (code: string): Promise<{ summary: PositionSummary; trades: TradeRow[] }> =>
    ipcRenderer.invoke('position:detail', code),
  positionAddTrade: (t: TradeInput): Promise<{ id: number; summary: PositionSummary }> =>
    ipcRenderer.invoke('position:addTrade', t),
  positionDeleteTrade: (id: number): Promise<boolean> => ipcRenderer.invoke('position:deleteTrade', id),
  positionProfile: (patch?: { buyFeePct?: number; sellFeePct?: number }): Promise<FundProfile> =>
    ipcRenderer.invoke('position:profile', patch),

  newsRecent: (limit?: number): Promise<NewsRow[]> => ipcRenderer.invoke('news:recent', limit),

  configGet: (): Promise<AppConfig> => ipcRenderer.invoke('config:get'),
  configSave: (patch: Record<string, unknown>): Promise<AppConfig> => ipcRenderer.invoke('config:save', patch)
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
