/**
 * 一次性/可复用的建库工具：在本机连接串指向的 PostgreSQL 上确保存在 fund_monitor 数据库。
 * 读取项目根 .env 的 PG_* 配置，连接到其中已有库，若 fund_monitor 不存在则创建。
 *
 * 用法：node scripts/ensure-db.js
 * 仅创建缺失的库，绝不删除或修改任何已有对象。
 */
const { Client } = require('pg')
const { readFileSync, existsSync } = require('fs')
const { join } = require('path')

const envFile = join(__dirname, '..', '.env')
if (!existsSync(envFile)) {
  console.error('缺少 .env（含 PG_* 配置），请先创建。')
  process.exit(1)
}

const env = {}
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
  if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const TARGET_DB = 'fund_monitor'
const need = (k) => {
  if (!env[k]) {
    console.error(`.env 缺少 ${k}`)
    process.exit(1)
  }
}
need('PG_USER')
need('PG_HOST')
need('PG_PORT')

async function main() {
  // 先连到 .env 里已有的库（如 gold_monitor 的库），再检查/创建目标库
  const client = new Client({
    user: env.PG_USER,
    password: env.PG_PASSWORD,
    host: env.PG_HOST,
    port: Number(env.PG_PORT),
    database: env.PG_DB || 'postgres'
  })
  await client.connect()
  const r = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [TARGET_DB])
  if (r.rowCount > 0) {
    console.log(`数据库 ${TARGET_DB} 已存在，跳过。`)
  } else {
    // 数据库名不可作绑定参数，白名单校验后拼接
    if (!/^[a-z_][a-z0-9_]*$/.test(TARGET_DB)) throw new Error('非法库名: ' + TARGET_DB)
    await client.query(`CREATE DATABASE ${TARGET_DB}`)
    console.log(`已创建数据库 ${TARGET_DB}。`)
  }
  await client.end()
}

main().catch((e) => {
  console.error('建库失败:', e.message)
  process.exit(1)
})
