import { app, shell, BrowserWindow, Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerIpcHandlers } from './ipc'
import { runCheck } from './check'
import { runFund } from './fund'
import { runQuotes } from './quotes'
import { runNews } from './news'
import { runAnalyzeAll, runAnalyzeOne } from './analyze'
import { startScheduler, stopScheduler } from './scheduler'
import { initLogger, logInfo, logWarn } from './logger'
import { initUser, ensureDefaultUser } from './user'
import { loadConfig } from './config'
import { createPool, ensureSchema } from './storage/db'
import { redirectUserData } from './userData'

// 启动最早：userData 重定向到英文目录 fund_monitor（默认是中文 productName 目录），并迁移旧 config/logs。
// 必须先于 config.ts configPath / logger.ts initLogger 对 userData 的读取。
redirectUserData()

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
} else if (process.argv.includes('--page-test')) {
  const idx = process.argv.indexOf('--page-test')
  const url = process.argv[idx + 1]
  app.whenReady().then(async () => {
    if (!url) {
      console.error('用法: electron . --page-test <url>')
      app.exit(1)
      return
    }
    try {
      const { pageFetchText } = await import('./crawler/pageFetcher')
      const text = await pageFetchText(url, 1500)
      console.log(`[page-test] OK ${text.length} chars`)
      app.exit(0)
    } catch (e) {
      console.error(`[page-test] FAIL: ${(e as Error).message}`)
      app.exit(1)
    }
  })
} else if (process.argv.includes('--quotes')) {
  app.whenReady().then(async () => {
    app.exit(await runQuotes())
  })
} else if (process.argv.includes('--news')) {
  app.whenReady().then(async () => {
    app.exit(await runNews())
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
} else if (process.argv.includes('--ai-test')) {
  // 开发辅助：electron . --ai-test ["提示词"] 验证 DeepSeek 连通性
  app.whenReady().then(async () => {
    const idx = process.argv.indexOf('--ai-test')
    const prompt = process.argv[idx + 1] ?? '请回复：连通正常'
    try {
      const { chatComplete } = await import('./llm/deepseek')
      const out = await chatComplete([{ role: 'user', content: prompt }], { maxTokens: 200 })
      console.log(`[ai-test] OK: ${out.slice(0, 200)}`)
      app.exit(0)
    } catch (e) {
      console.error(`[ai-test] FAIL: ${(e as Error).message}`)
      app.exit(1)
    }
  })
} else if (process.argv.includes('--calendar-test')) {
  // 开发辅助：electron . --calendar-test 验证交易日历（腾讯/百度/静态表三级降级）
  app.whenReady().then(async () => {
    try {
      const { isTradingDay, isTradingDayStatic } = await import('./scheduler/tradingCalendar')
      // 腾讯列表范围内（当前约 2025-10 ~ 2026-08）→ 走腾讯层
      // 超范围（2027 等）→ 降级百度节假日层（2027 未公布则落静态表）
      const cases: [string, string][] = [
        ['2026-08-14', '周五(腾讯层)'],
        ['2026-08-15', '周六(腾讯层)'],
        ['2026-01-01', '元旦(百度层? 超腾讯范围)'],
        ['2026-02-17', '春节(超腾讯范围)'],
        ['2026-02-23', '春节调休(超腾讯范围)'],
        ['2026-02-24', '春节后恢复(超腾讯范围)'],
        ['2026-05-05', '劳动节最后一天(超腾讯范围)'],
        ['2027-10-01', '2027国庆(百度未公布→静态表)']
      ]
      for (const [ds, label] of cases) {
        const d = new Date(ds + 'T00:00:00')
        const net = await isTradingDay(d)
        const st = isTradingDayStatic(d)
        console.log(`[calendar-test] ${ds}(${label}) 判断=${net ? '交易日' : '休市'} | 静态表=${st ? '交易日' : '休市'}`)
      }
      app.exit(0)
    } catch (e) {
      console.error(`[calendar-test] FAIL: ${(e as Error).message}`)
      app.exit(1)
    }
  })
} else if (process.argv.includes('--screenshot')) {
  // 开发辅助：electron . --screenshot <path> [--route <hash>]
  // 加载完成等待渲染后截屏保存（配合 M5 前端验证）
  const idx = process.argv.indexOf('--screenshot')
  const shotPath = process.argv[idx + 1]
  const rIdx = process.argv.indexOf('--route')
  const hashRoute = rIdx >= 0 ? process.argv[rIdx + 1] : '/'
  const { writeFileSync } = require('fs') as typeof import('fs')
  app.whenReady().then(() => {
    const win = createWindow()
    // 开发辅助：--viewport-height <px> 加高视口，便于整页截图（默认 900）
    const vIdx = process.argv.indexOf('--viewport-height')
    if (vIdx >= 0) {
      win.setContentSize(1280, Number(process.argv[vIdx + 1]) || 900)
    }
    registerIpcHandlers(win)
    // 截图诊断：打印渲染进程 console 错误（排查 ECharts/Vue 渲染问题）
    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log(`[renderer console ${level}] ${message}`)
    })
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          // 路由就绪后再切 hash（executeJavaScript 在 did-finish-load 前执行会被 Vue 路由初始化覆盖）
          await win.webContents.executeJavaScript(`window.location.hash = '#' + ${JSON.stringify(hashRoute)}`).catch(() => {})
          // 等 Vue 路由渲染（hashchange → 组件挂载）
          await new Promise((res) => setTimeout(res, 800))
          const curHash = await win.webContents.executeJavaScript('location.hash').catch(() => '')
          console.log('[screenshot] hash:', curHash)
          // 开发验证：--expand-form 时点击"录入交易"按钮展开表单（持仓页截图用）
          if (process.argv.includes('--expand-form')) {
            await win.webContents
              .executeJavaScript(
                `[...document.querySelectorAll('button')].find(b => b.textContent?.includes('录入交易'))?.click()`
              )
              .catch(() => {})
            await new Promise((res) => setTimeout(res, 500))
          }
          // 开发验证：--ipc-test 时加载完成后调一次 quotes:run 并打印结果
          if (process.argv.includes('--ipc-test')) {
            const r = await win.webContents.executeJavaScript(
              `window.api.quotesRun().then(r => JSON.stringify({ok: r.ok, funds: r.result?.fundCount, stocks: r.result?.stockCount, est: r.result?.estimates?.length}))`
            )
            console.log('[ipc-test] quotes:run →', r)
          }
          // --ipc-test-ai 时验证 advice:analyzeAll
          if (process.argv.includes('--ipc-test-ai')) {
            const r = await win.webContents.executeJavaScript(
              `window.api.adviceAnalyzeAll().then(r => JSON.stringify({ok: r.ok, done: r.result?.done, total: r.result?.total, notified: r.result?.notified}))`
            )
            console.log('[ipc-test-ai] advice:analyzeAll →', r)
          }
          // 详情页诊断：--fund-detail-diag 打印 fundDetail 返回的净值序列尾部（验证渲染进程拿到的最新净值）
          if (process.argv.includes('--fund-detail-diag')) {
            const code = hashRoute.replace('/fund/', '').split('/')[0]
            const r = await win.webContents
              .executeJavaScript(
                `window.api.fundDetail('${code}', 120).then(d => JSON.stringify({ navN: d.nav.length, last: d.nav[d.nav.length - 1] }))`
              )
              .catch((e) => 'FAIL: ' + (e as Error).message)
            console.log('[fund-detail-diag]', code, '→', r)
          }
          // 详情页图表模式验证：--nav-mode pct 时点击"区间涨跌"（默认截图验证 APP 视角"单位净值"）
          if (process.argv.includes('--nav-mode')) {
            const target = process.argv[process.argv.indexOf('--nav-mode') + 1] === 'pct' ? '区间涨跌' : '单位净值'
            await win.webContents
              .executeJavaScript(
                `[...document.querySelectorAll('.n-radio-button')].find(b => b.textContent?.includes(${JSON.stringify(target)}))?.click()`
              )
              .catch(() => {})
            await new Promise((res) => setTimeout(res, 500))
          }
          const diag = await win.webContents
            .executeJavaScript(`({
              adviceBtn: [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(t => t && t.includes('分析')),
              adviceEmpty: document.querySelector('.advice-card .n-empty')?.textContent ?? null,
              adviceCount: document.querySelectorAll('.advice-item').length,
              guideRows: document.querySelectorAll('.funds-table tbody tr').length,
              guideTags: [...document.querySelectorAll('.funds-table tbody tr .n-tag')].map(t => t.textContent?.trim()).filter(Boolean)
            })`)
            .catch(() => null)
          if (diag) console.log('[screenshot] diag:', JSON.stringify(diag))
          const img = await win.webContents.capturePage()
          writeFileSync(shotPath, img.toPNG())
          console.log(`[screenshot] OK -> ${shotPath}`)
          app.exit(0)
        } catch (e) {
          console.error(`[screenshot] FAIL: ${(e as Error).message}`)
          app.exit(1)
        }
      }, 2500)
    })
  })
} else {
  // This method will be called when Electron has finished
  // initialization and is ready to create browser windows.
  // Some APIs can only be used after this event occurs.
  app.whenReady().then(() => {
    // Set app user model id for windows
    electronApp.setAppUserModelId('top.reapers.fundmonitor')

    // 文件日志（userData/logs，按日滚动）
    initLogger()
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
