import { app, shell, BrowserWindow } from 'electron'
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
import { initLogger, logInfo } from './logger'

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
    registerIpcHandlers(win)
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
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
          const diag = await win.webContents
            .executeJavaScript(`({
              adviceBtn: [...document.querySelectorAll('button')].map(b => b.textContent?.trim()).filter(t => t && t.includes('分析')),
              adviceEmpty: document.querySelector('.advice-card .n-empty')?.textContent ?? null,
              adviceCount: document.querySelectorAll('.advice-item').length
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
    win.webContents.executeJavaScript(`window.location.hash = '#' + ${JSON.stringify(hashRoute)}`).catch(() => {})
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

    // Default open or close DevTools by F12 in development
    // and ignore CommandOrControl + R in production.
    // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    // 注册全部 IPC 处理器（app:ping / app:getAppInfo，业务模块后续在此扩展）
    registerIpcHandlers(createWindow())

    // 后台调度器：盘中估值采样 / 盘后净值增量 / 收盘后 AI 分析（主窗口常驻时运行）
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
