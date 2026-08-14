import type { ElectronAPI } from '@electron-toolkit/preload'

// 渲染进程 Window 全局声明（业务类型见 api.d.ts）
declare global {
  interface Window {
    electron: ElectronAPI
    api: FundApi
  }
}
