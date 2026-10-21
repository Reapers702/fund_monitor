/**
 * 自选基金批量管理（加入 / 同步 / 启用 / 禁用 / 列表）
 *
 * 为什么需要：GUI「我的基金」页只能一只只添加，批量换仓（加一批、停用一批）非常繁琐。
 * 本工具与 GUI 走**同一套同步逻辑**（`src/main/fund.ts` 的 `syncFund`：基金详情 + 历史净值 +
 * 季报持仓），因此入库数据的完整性一致，不是裸写 SQL。
 *
 * 用法：
 *   node scripts/manage-watchlist.mjs list                    # 列出自选与启用状态
 *   node scripts/manage-watchlist.mjs add 008591,013180       # 同步数据 + 加入当前用户自选
 *   node scripts/manage-watchlist.mjs disable 001550,004069   # 停用（保留数据，可再启用）
 *   node scripts/manage-watchlist.mjs enable 001550
 *
 * 说明：只改 `user_fund`（自选与启用状态）与各基金的业务数据；不会删除任何记录。
 * 停用是 `is_active=0`，随时可 `enable` 回来。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { Pool } from 'pg'

// ---------- env / pool ----------
const env = {}
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/)
  if (m) env[m[1]] = m[2].trim()
}
const pool = new Pool({
  user: env.PG_USER,
  password: env.PG_PASSWORD,
  host: env.PG_HOST,
  port: Number(env.PG_PORT),
  database: env.PG_DB || 'fund_monitor'
})
/** 当前用户：与 analyze.ts 默认一致（1 = guanxin）；可用 USER_ID 环境变量覆盖 */
const USER_ID = Number(process.env.USER_ID || 1)

// ---------- 打包 syncFund（electron 用 stub，脚本不需要 Electron 运行时） ----------
const TMP = '.tmp-wl'
mkdirSync(TMP, { recursive: true })
const stub = resolve(`${TMP}/electron-stub.mjs`)
if (!existsSync(stub)) {
  writeFileSync(
    stub,
    `export const app = { getPath: () => '.', getVersion: () => '0.0.0', isPackaged: false, on: () => {}, whenReady: async () => {} }
export const BrowserWindow = class { static getAllWindows() { return [] } }
export const shell = { openPath: async () => '', openExternal: async () => {} }
export const ipcMain = { handle: () => {}, on: () => {} }
export const Notification = class { static isSupported() { return false } show() {} }
export const Tray = class {}
export const Menu = { buildFromTemplate: () => ({}), setApplicationMenu: () => {} }
export const nativeImage = { createFromPath: () => ({}) }
export default { app, BrowserWindow, shell, ipcMain, Notification, Tray, Menu, nativeImage }
`
  )
}
const outfile = `${TMP}/fund.mjs`
await build({
  entryPoints: ['src/main/fund.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['pg'],
  alias: { electron: stub },
  outfile,
  logLevel: 'error'
})
const { syncFund } = await import(`../${outfile}`)

// ---------- 命令 ----------
const [cmd, arg] = process.argv.slice(2)
const codes = (arg ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

async function list() {
  const r = await pool.query(
    `SELECT uf.fund_code AS 代码, b.fund_name AS 名称, uf.is_active AS 启用,
       (SELECT count(*)::int FROM fund_nav_daily n WHERE n.fund_code = uf.fund_code) AS 净值条数,
       CASE WHEN EXISTS (SELECT 1 FROM fund_trade t WHERE t.user_id=uf.user_id AND t.fund_code=uf.fund_code) THEN '有' ELSE '' END AS 持仓
     FROM user_fund uf LEFT JOIN fund_basic b USING (fund_code)
     WHERE uf.user_id = $1 ORDER BY uf.is_active DESC, uf.fund_code`,
    [USER_ID]
  )
  console.table(r.rows)
  const on = r.rows.filter((x) => x.启用 === 1).length
  console.log(`共 ${r.rows.length} 条自选，启用 ${on} 只，停用 ${r.rows.length - on} 只`)
}

async function add() {
  console.log(`加入自选并同步数据：${codes.length} 只（用户 ${USER_ID}）\n`)
  for (const code of codes) {
    const t0 = Date.now()
    try {
      const r = await syncFund(pool, code, (s) => console.log(`    ${s}`))
      await pool.query(
        `INSERT INTO user_fund (user_id, fund_code, is_active) VALUES ($1, $2, 1)
         ON CONFLICT (user_id, fund_code) DO UPDATE SET is_active = 1, updated_at = now()`,
        [USER_ID, code]
      )
      console.log(`  ✅ ${code} 已同步并启用（${((Date.now() - t0) / 1000).toFixed(1)}s）`)
    } catch (e) {
      console.error(`  ❌ ${code} 失败: ${e.message}`)
    }
  }
}

async function setActive(active) {
  const r = await pool.query(
    `UPDATE user_fund SET is_active = $3, updated_at = now() WHERE user_id = $1 AND fund_code = ANY($2) RETURNING fund_code`,
    [USER_ID, codes, active]
  )
  console.log(
    `${active ? '启用' : '停用'} ${r.rowCount ?? 0} 只：${r.rows.map((x) => x.fund_code).join(', ')}`
  )
  const miss = codes.filter((c) => !r.rows.some((x) => x.fund_code === c))
  if (miss.length) console.log(`未在自选中（跳过）：${miss.join(', ')}`)
}

if (cmd === 'list') await list()
else if (cmd === 'add') await add()
else if (cmd === 'disable') await setActive(0)
else if (cmd === 'enable') await setActive(1)
else {
  console.log('用法：')
  console.log('  node scripts/manage-watchlist.mjs list')
  console.log('  node scripts/manage-watchlist.mjs add <code,code,...>')
  console.log('  node scripts/manage-watchlist.mjs disable <code,...>')
  console.log('  node scripts/manage-watchlist.mjs enable <code,...>')
}

await pool.end().catch(() => {})
