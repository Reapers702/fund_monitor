// userData 目录重定向（Electron 集成层）：启动最早执行，把 userData 从中文 productName
// 目录改到 <appData>/fund_monitor（英文），并迁移旧目录的 config.json 与 logs。
// 必须在任何 app.getPath('userData') 调用（config.ts configPath / logger.ts initLogger）之前运行。
import { app } from 'electron'
import { join } from 'path'
import { USER_DATA_DIR, migrateUserDataFiles } from './userDataMigrate'
import type { MigrationReport } from './userDataMigrate'

/** 启动最早执行：重定向 userData 并迁移存量数据；异常仅告警不阻断启动（沿用默认目录）。 */
export function redirectUserData(): MigrationReport | null {
  try {
    const legacy = app.getPath('userData') // 尚未重定向时即默认目录（中文 productName）
    const target = join(app.getPath('appData'), USER_DATA_DIR)
    if (legacy === target) return null

    app.setPath('userData', target)
    const r = migrateUserDataFiles(legacy, target)
    if (r.migratedConfig || r.migratedLogs) {
      console.log(`[userData] 已从 ${legacy} 迁移到 ${target}（config=${r.migratedConfig}, logs=${r.migratedLogs}）`)
    }
    return r
  } catch (e) {
    console.warn(`[userData] 重定向失败，沿用默认目录: ${(e as Error).message}`)
    return null
  }
}
