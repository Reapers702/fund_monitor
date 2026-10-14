import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { runCheck } from './check'
import { runFund } from './fund'
import { runQuotes } from './quotes'
import { runNews } from './news'
import { runAlerts } from './alerts'
import { runAnalyzeAll, runAnalyzeOne } from './analyze'
import { runBacktest } from './backtest'
import { startScheduler, stopScheduler } from './scheduler'
import { initLogger, logInfo, logWarn, logError } from './logger'
import { destroyBrowserChannel } from './crawler/pageFetcher'
import { initUser, ensureDefaultUser } from './user'
import { loadConfig } from './config'
import { createPool, ensureSchema } from './storage/db'
import { redirectUserData } from './userData'

// ── 主进程级错误兜底（必须在任何可能抛错的动作之前注册） ─────────────────────────
// Electron 内置了默认处理：若进程上只有它自己的 uncaughtException 监听（listenerCount === 1），
// 就 dialog.showErrorBox 弹出「A JavaScript error occurred in the main process / Uncaught Exception」
// 的原始堆栈模态框（见 electron/lib/browser/init.ts）。挂上我们自己的监听后，该弹窗不再出现；
// 应用继续运行（与原先一致）——这类异常绝大多数是网络/远端库抖动（例如 pg 连接被掐断），
// 调度器 30s 后自然重试；信息落 userData/logs 与 GUI「抓取日志」页，需要时再查，不再打断使用。
function logMainProcessError(kind: string, e: Error): void {
  const head = `[${kind}] 主进程异常（已记录，应用继续运行）: ${e.name}: ${e.message}`
  logError(`${head}\n${(e.stack ?? '').slice(0, 4000)}`)
}

process.on('uncaughtException', (err) => logMainProcessError('uncaught', err))
process.on('unhandledRejection', (reason) => {
  logMainProcessError('unhandled', reason instanceof Error ? reason : new Error(String(reason)))
})
logInfo('[guard] 主进程错误兜底已安装：未捕获异常/未处理拒绝只记日志，不再弹「Uncaught Exception」模态框')

// 启动最早：userData 重定向到英文目录 fund_monitor（默认是中文 productName 目录），并迁移旧 config/logs。
// 必须先于 config.ts configPath / logger.ts initLogger 对 userData 的读取。
redirectUserData()

// 统一 userData 目录名为 fund_monitor（避免 macOS 用中文 productName 生成中文目录）。
// 必须在任何 app.getPath('userData') 调用之前执行。
app.setName('fund_monitor')

function createWindow(): BrowserWindow {
  // 主窗口（渲染进程 UI；爬虫走主进程 Node 通道 + 隐藏窗口，不依赖此窗口）
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 960,
    minHeight: 640,
    title: '基金监控与 AI 推荐系统',
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// CLI 模式：electron . --check（校验配置/数据库/建表，不启动窗口）
if (process.argv.includes('--check')) {
  app.whenReady().then(async () => {
    const code = await runCheck()
    app.exit(code)
  })
} else if (process.argv.includes('--fund')) {
  const idx = process.argv.indexOf('--fund')
  const code = process.argv[idx + 1]
  app.whenReady().then(async () => {
    if (!code || !/^\d{6}$/.test(code)) {
      console.error('用法: electron . --fund <6位基金代码>')
      app.exit(1)
      return
    }
    app.exit(await runFund(code))
  })
} else if (process.argv.includes('--quotes')) {
  app.whenReady().then(async () => {
    app.exit(await runQuotes())
  })
} else if (process.argv.includes('--news')) {
  app.whenReady().then(async () => {
    app.exit(await runNews())
  })
} else if (process.argv.includes('--alerts')) {
  app.whenReady().then(async () => {
    app.exit(await runAlerts())
  })
} else if (process.argv.includes('--analyze-all')) {
  app.whenReady().then(async () => {
    app.exit(await runAnalyzeAll())
  })
} else if (process.argv.includes('--analyze')) {
  const idx = process.argv.indexOf('--analyze')
  const code = process.argv[idx + 1]
  app.whenReady().then(async () => {
    if (!code || !/^\d{6}$/.test(code)) {
      console.error('用法: electron . --analyze <6位基金代码>')
      app.exit(1)
      return
    }
    app.exit(await runAnalyzeOne(code))
  })
} else if (process.argv.includes('--backtest')) {
  // 推荐可信度回溯评估：electron . --backtest [--codes 012322,017193] [--days 5] [--range 30]
  app.whenReady().then(async () => {
    let codesOverride: string[] | undefined
    const cIdx = process.argv.indexOf('--codes')
    if (cIdx >= 0 && process.argv[cIdx + 1]) codesOverride = process.argv[cIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    const dIdx = process.argv.indexOf('--days')
    const days = dIdx >= 0 ? Number(process.argv[dIdx + 1]) || 5 : 5
    const rIdx = process.argv.indexOf('--range')
    const range = rIdx >= 0 ? Number(process.argv[rIdx + 1]) || 30 : 30
    app.exit(await runBacktest(codesOverride, days, range))
  })
} else if (process.argv.includes('--rules-backtest')) {
  // 规则打分回测（确定性，无 LLM）：electron . --rules-backtest [--codes ...] [--days N] [--range M]
  // 对比纯 LLM 回测的 33% 基线，验证"信号本身能否给出方向"
  app.whenReady().then(async () => {
    const { runRulesBacktest } = await import('./rulesBacktest')
    let codesOverride: string[] | undefined
    const cIdx = process.argv.indexOf('--codes')
    if (cIdx >= 0 && process.argv[cIdx + 1]) codesOverride = process.argv[cIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    const dIdx = process.argv.indexOf('--days')
    const days = dIdx >= 0 ? Number(process.argv[dIdx + 1]) || 30 : 30
    const rIdx = process.argv.indexOf('--range')
    const range = rIdx >= 0 ? Number(process.argv[rIdx + 1]) || 120 : 120
    app.exit(await runRulesBacktest(codesOverride, days, range))
  })
} else if (process.argv.includes('--rotate-backtest')) {
  // 相对强弱轮动回测（无前视）：electron . --rotate-backtest [--codes ...] [--days N] [--range M]
  // 检验"过去跑得快 → 未来继续跑得赢"是否成立（相对强弱排名持续性）
  app.whenReady().then(async () => {
    const { runRotateBacktest } = await import('./rotateBacktest')
    let codesOverride: string[] | undefined
    const cIdx = process.argv.indexOf('--codes')
    if (cIdx >= 0 && process.argv[cIdx + 1]) codesOverride = process.argv[cIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    const dIdx = process.argv.indexOf('--days')
    const days = dIdx >= 0 ? Number(process.argv[dIdx + 1]) || 40 : 40
    const rIdx = process.argv.indexOf('--range')
    const range = rIdx >= 0 ? Number(process.argv[rIdx + 1]) || 500 : 500
    app.exit(await runRotateBacktest(codesOverride, days, range))
  })
} else if (process.argv.includes('--sim-backtest')) {
  // 模拟交易回测（paper trading）：electron . --sim-backtest [--codes ...] [--range N] [--capital C]
  //   [--step S]（或 --days S）[--add 0.2] [--reduce 0.2] [--add-thresh 1.2] [--reduce-thresh -1.2]
  //   [--fee-buy 0.0015] [--fee-sell 0.005]
  // 按规则引擎信号固定档位连续调仓，看累计收益，并对比买入持有/空仓基准
  app.whenReady().then(async () => {
    const { runSimBacktest } = await import('./simBacktest')
    let codes: string[] = []
    const cIdx = process.argv.indexOf('--codes')
    if (cIdx >= 0 && process.argv[cIdx + 1]) codes = process.argv[cIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    const rIdx = process.argv.indexOf('--range')
    const range = rIdx >= 0 ? Number(process.argv[rIdx + 1]) || 500 : 500
    const capIdx = process.argv.indexOf('--capital')
    const capital = capIdx >= 0 ? Number(process.argv[capIdx + 1]) || 100000 : 100000
    const sIdx = process.argv.indexOf('--step')
    const dIdx = process.argv.indexOf('--days')
    const step = (sIdx >= 0 ? Number(process.argv[sIdx + 1]) : dIdx >= 0 ? Number(process.argv[dIdx + 1]) : 0) || 5
    const aIdx = process.argv.indexOf('--add')
    const addPct = aIdx >= 0 ? Number(process.argv[aIdx + 1]) : 0.2
    const rpIdx = process.argv.indexOf('--reduce')
    const reducePct = rpIdx >= 0 ? Number(process.argv[rpIdx + 1]) : 0.2
    const atIdx = process.argv.indexOf('--add-thresh')
    const addThresh = atIdx >= 0 ? Number(process.argv[atIdx + 1]) : undefined
    const rtIdx = process.argv.indexOf('--reduce-thresh')
    const reduceThresh = rtIdx >= 0 ? Number(process.argv[rtIdx + 1]) : undefined
    const fbIdx = process.argv.indexOf('--fee-buy')
    const feeBuy = fbIdx >= 0 ? Number(process.argv[fbIdx + 1]) : 0.0015
    const fsIdx = process.argv.indexOf('--fee-sell')
    const feeSell = fsIdx >= 0 ? Number(process.argv[fsIdx + 1]) : 0.005
    app.exit(await runSimBacktest({ codes, capital: capital < 0 ? 100000 : capital, rangeDays: range, step, addPct, reducePct, addThresh, reduceThresh, feeBuy, feeSell }))
  })
} else if (process.argv.includes('--valuation')) {
  // 指数估值分位（价值因子）：electron . --valuation [--codes ...]
  // 拉蛋卷快照落库 + 打印每只自选基金对应板块的 PE/PB 历史分位（长周期参考，非短周期方向）
  app.whenReady().then(async () => {
    const { runIndexValuation } = await import('./crawler/indexValuation')
    let codesOverride: string[] | undefined
    const cIdx = process.argv.indexOf('--codes')
    if (cIdx >= 0 && process.argv[cIdx + 1]) codesOverride = process.argv[cIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    app.exit(await runIndexValuation(codesOverride))
  })
} else {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('top.reapers.fundmonitor')

    // 文件日志（userData/logs，按日滚动）。传入目录而非让 logger 依赖 electron，
    // 使 httpClient 等抓取层模块也能安全记录日志（单测 import 时不会拉起 electron）
    initLogger(app.getPath('userData'))
    logInfo(`应用启动（版本 ${app.getVersion()}）`)
    // 恢复上次使用的用户（多用户 M9）
    initUser()
    // 启动即建表 + 确保默认用户 guanxin 存在（后续 IPC 依赖表结构）
    ;(async () => {
      try {
        const pool = createPool(loadConfig())
        await ensureSchema(pool)
        await ensureDefaultUser(pool)
        await pool.end().catch(() => {})
      } catch (e) {
        logWarn(`[startup] 建表/默认用户失败（后续 IPC 会重试）: ${(e as Error).message}`)
      }
    })()

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    const win = createWindow()
    // 注册全部 IPC 处理器（app:ping / app:getAppInfo，业务模块后续在此扩展）
    registerIpcHandlers(win)

    // 托盘常驻（Windows/Linux）：关窗最小化到托盘，后台调度器继续运行；托盘菜单"退出"才是真正退出
    // macOS 走系统 Dock（不建托盘），"显示主窗口"由 activate 事件处理
    let tray: Tray | null = null
    let isQuitting = false
    if (process.platform !== 'darwin') {
      const trayIcon = nativeImage.createFromPath(icon).resize({ width: 16, height: 16 })
      tray = new Tray(trayIcon)
      tray.setToolTip('基金监控与 AI 推荐系统')
      const showWin = (): void => {
        win.show()
        win.focus()
      }
      tray.on('click', showWin) // Windows 单击托盘图标显示窗口
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: '显示主窗口', click: showWin },
          { type: 'separator' },
          {
            label: '退出',
            click: () => {
              isQuitting = true
              app.quit()
            }
          }
        ])
      )
      // 关闭按钮 → 隐藏到托盘（不退出，采集/AI 分析继续）；真正退出走托盘菜单或 app.quit()
      win.on('close', (e) => {
        if (!isQuitting) {
          e.preventDefault()
          win.hide()
        }
      })
    }
    app.on('before-quit', () => {
      isQuitting = true
      // 关掉浏览器通道的隐藏窗口：它上面可能还有未完成的页面加载，会拖慢退出
      destroyBrowserChannel()
    })

    // 后台调度器：盘中估值采样 / 盘后净值增量 / 收盘后 AI 分析（托盘常驻时也持续运行）
    startScheduler()

    app.on('activate', function () {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  // Quit when all windows are closed, except on macOS. There, it's common
  // for applications and their menu bar to stay active until the user quits
  // explicitly with Cmd + Q.
  app.on('window-all-closed', () => {
    stopScheduler()
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
