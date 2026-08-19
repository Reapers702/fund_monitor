// userData 迁移纯函数（不依赖 Electron，便于单测；vitest 配置明确不 mock electron）
// 背景：Electron 默认 userData = <appData>/<productName>，而 productName 是中文
// "基金监控与AI推荐系统"，导致配置/日志落在中文目录。目标目录统一为 <appData>/fund_monitor
// （与 README 记载 %APPDATA%\fund_monitor\config.json 一致），仅迁移 config.json 与 logs；
// Electron/Chromium 运行时缓存（Cache/GPUCache/Local Storage 等）不迁移，新目录首启自动重建。
import { copyFileSync, cpSync, existsSync, mkdirSync, statSync } from 'fs'
import { join } from 'path'

/** 目标 userData 目录名（英文） */
export const USER_DATA_DIR = 'fund_monitor'

export interface MigrationReport {
  legacy: string
  target: string
  migratedConfig: boolean
  migratedLogs: boolean
}

/** 把旧 userData 中的 config.json 与 logs 复制到新目录。
 *  config.json：目标不存在时复制；双方都存在时按 mtime 取新者（防历史遗留目录里的旧配置覆盖当前配置）。
 *  logs：目标已有则跳过（日志低价值，旧目录的丢失无碍）。
 *  legacy 不存在或与 target 相同视为无需迁移。 */
export function migrateUserDataFiles(legacy: string, target: string): MigrationReport {
  const report: MigrationReport = { legacy, target, migratedConfig: false, migratedLogs: false }
  if (legacy === target || !existsSync(legacy)) return report

  mkdirSync(target, { recursive: true })

  const srcCfg = join(legacy, 'config.json')
  const dstCfg = join(target, 'config.json')
  if (existsSync(srcCfg) && (!existsSync(dstCfg) || statSync(srcCfg).mtimeMs > statSync(dstCfg).mtimeMs)) {
    copyFileSync(srcCfg, dstCfg)
    report.migratedConfig = true
  }

  const srcLogs = join(legacy, 'logs')
  const dstLogs = join(target, 'logs')
  if (existsSync(srcLogs) && !existsSync(dstLogs)) {
    cpSync(srcLogs, dstLogs, { recursive: true })
    report.migratedLogs = true
  }

  return report
}
