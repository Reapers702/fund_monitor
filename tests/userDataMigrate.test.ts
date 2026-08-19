// userData 迁移单测：migrateUserDataFiles（config.json/logs 复制、目标已存在不覆盖、无需迁移场景）
import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { USER_DATA_DIR, migrateUserDataFiles } from '../src/main/userDataMigrate'

const dirs: string[] = []
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'userdata-test-'))
  dirs.push(d)
  return d
}
function mkFile(base: string, rel: string, content = 'x'): string {
  const p = join(base, rel)
  mkdirSync(join(base, rel.split('/').slice(0, -1).join('/')), { recursive: true })
  writeFileSync(p, content)
  return p
}
/** 把文件 mtime 拨到过去，模拟"旧"文件 */
function ageFile(p: string, msAgo: number): void {
  const t = new Date(Date.now() - msAgo)
  utimesSync(p, t, t)
}

afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
  dirs.length = 0
})

describe('migrateUserDataFiles（旧中文目录 → fund_monitor）', () => {
  it('目标目录名固定为 fund_monitor', () => {
    expect(USER_DATA_DIR).toBe('fund_monitor')
  })

  it('legacy 不存在则跳过迁移', () => {
    const target = tmpDir()
    const r = migrateUserDataFiles(join(tmpdir(), 'no-such-dir'), target)
    expect(r.migratedConfig).toBe(false)
    expect(r.migratedLogs).toBe(false)
  })

  it('legacy 与 target 相同则跳过迁移', () => {
    const d = tmpDir()
    const r = migrateUserDataFiles(d, d)
    expect(r.migratedConfig).toBe(false)
    expect(r.migratedLogs).toBe(false)
  })

  it('迁移 config.json 与 logs，内容完整', () => {
    const legacy = tmpDir()
    mkFile(legacy, 'config.json', '{"pg":{}}')
    mkFile(legacy, 'logs/app-2026-08-19.log', 'hello log')
    const target = tmpDir()

    const r = migrateUserDataFiles(legacy, target)
    expect(r.migratedConfig).toBe(true)
    expect(r.migratedLogs).toBe(true)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toBe('{"pg":{}}')
    expect(readFileSync(join(target, 'logs/app-2026-08-19.log'), 'utf8')).toBe('hello log')
    // 源文件保留（复制而非移动）
    expect(existsSync(join(legacy, 'config.json'))).toBe(true)
  })

  it('目标已有且更新时保留目标配置', () => {
    const legacy = tmpDir()
    mkFile(legacy, 'config.json', '{"pg":{"db":"legacy"}}')
    const target = tmpDir()
    mkFile(target, 'config.json', '{"pg":{"db":"target"}}')

    const r = migrateUserDataFiles(legacy, target)
    expect(r.migratedConfig).toBe(false)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toContain('"db":"target"')
  })

  it('源配置更新时覆盖目标（历史遗留目录里的旧配置不应胜出）', () => {
    const legacy = tmpDir()
    mkFile(legacy, 'config.json', '{"pg":{"db":"legacy"}}')
    const target = tmpDir()
    mkFile(target, 'config.json', '{"pg":{"db":"target-old"}}')
    ageFile(join(target, 'config.json'), 3 * 86400000) // 目标 config 是 3 天前的旧文件
    ageFile(join(legacy, 'config.json'), 0)

    const r = migrateUserDataFiles(legacy, target)
    expect(r.migratedConfig).toBe(true)
    expect(readFileSync(join(target, 'config.json'), 'utf8')).toContain('"db":"legacy"')
  })

  it('只有 config.json 无 logs 时只迁移 config', () => {
    const legacy = tmpDir()
    mkFile(legacy, 'config.json', '{}')
    const target = tmpDir()

    const r = migrateUserDataFiles(legacy, target)
    expect(r.migratedConfig).toBe(true)
    expect(r.migratedLogs).toBe(false)
    expect(readdirSync(target)).toEqual(['config.json'])
  })
})
