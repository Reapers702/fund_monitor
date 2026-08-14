// 东方财富基金数据源（计划书 §4.1 #1/#2/#4）
// 注意：lsjz / jjcc 需携带 Referer；均为页面级接口，个人低频使用
import { httpGetJson, httpGetText } from './httpClient'
import { parseNum, stripThousand } from '../utils'

const EASTMONEY_REFERER = 'https://fund.eastmoney.com/'
const F10_REFERER = 'http://fundf10.eastmoney.com/'

// ---------- 每日净值（f10/lsjz，分页，主增量源） ----------

export interface NavRow {
  fsrq: string // 2026-08-12（数据源自带日期，作时间键，§8）
  dwjz: number | null
  ljjz: number | null
  jzzzl: number | null
  sgzt: string | null
  shzt: string | null
}

interface LsjzResp {
  Data: { LSJZList: Record<string, unknown>[] }
  ErrCode?: number
  TotalCount?: number
  PageIndex?: number
  PageSize?: number
}

/** 分页拉取净值。服务端单页上限 20，以 TotalCount 为准循环；返回按日期倒序。
 *  - 全量补种：不带 since，拉满为止（安全上限 400 页 ≈ 8000 条）
 *  - 每日增量：带 since（本地最新日期），页面数据全部 ≤ since 即停，通常只拉 1~2 页
 */
export async function lsjzNav(
  code: string,
  opts: { since?: string; maxPages?: number } = {}
): Promise<{ totalCount: number; rows: NavRow[] }> {
  const pageSize = 20
  const maxPages = opts.maxPages ?? (opts.since ? 10 : 400)
  const rows: NavRow[] = []
  let totalCount = 0

  for (let pageIndex = 1; pageIndex <= maxPages; pageIndex++) {
    const url = `https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=${pageIndex}&pageSize=${pageSize}`
    const resp = await httpGetJson<LsjzResp>(url, { referer: EASTMONEY_REFERER })
    if (resp.ErrCode !== 0 && resp.ErrCode !== undefined) {
      throw new Error(`lsjz 业务错误码 ${resp.ErrCode}`)
    }
    totalCount = resp.TotalCount ?? rows.length
    const list = resp.Data?.LSJZList ?? []
    for (const item of list) {
      rows.push({
        fsrq: String(item.FSRQ ?? ''),
        dwjz: parseNum(item.DWJZ),
        ljjz: parseNum(item.LJJZ),
        jzzzl: parseNum(item.JZZZL),
        sgzt: item.SGZT ? String(item.SGZT) : null,
        shzt: item.SHZT ? String(item.SHZT) : null
      })
    }
    if (list.length === 0) break
    if (opts.since) {
      // 增量：本页全部 ≤ 本地最新日期即停
      if (list.every((item) => String(item.FSRQ ?? '') <= opts.since!)) break
    } else if (rows.length >= totalCount) {
      break
    }
  }
  return { totalCount, rows }
}

// ---------- 全量历史净值（pingzhongdata.js，辅助补种源） ----------

export interface PingzhongData {
  name: string
  code: string
  netWorthTrend: { x: number; y: number; equityReturn: number | null }[]
}

/** 一次性拉全量净值（正则提取 JS 变量；data 量大，仅首启/手动刷新用） */
export async function pingzhongdata(code: string): Promise<PingzhongData> {
  const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`
  const text = await httpGetText(url, { referer: EASTMONEY_REFERER, timeoutMs: 30000, retries: 3 })

  const name = /var fS_name = "([^"]*)"/.exec(text)?.[1] ?? ''
  const codeRaw = /var fS_code = "([^"]*)"/.exec(text)?.[1] ?? code

  let netWorthTrend: { x: number; y: number; equityReturn: number | null }[] = []
  const m = text.match(/Data_netWorthTrend = (\[.*?\]);/s)
  if (m) {
    try {
      const arr = JSON.parse(m[1]) as { x: number; y: number; equityReturn?: number | null }[]
      netWorthTrend = arr.map((r) => ({
        x: r.x,
        y: r.y,
        equityReturn: r.equityReturn === undefined ? null : r.equityReturn
      }))
    } catch (e) {
      throw new Error(`pingzhongdata 解析 Data_netWorthTrend 失败: ${(e as Error).message}`)
    }
  }
  if (netWorthTrend.length === 0) throw new Error('pingzhongdata 未取到净值数据')
  return { name, code: codeRaw, netWorthTrend }
}

// ---------- 季度重仓股（FundArchivesDatas?type=jjcc） ----------

export interface HoldingRow {
  rank: number
  stockCode: string | null
  stockName: string | null
  weight: number | null
}

export interface HoldingsReport {
  reportDate: string // 截止至日期（2026-06-30）
  rows: HoldingRow[]
}

/** 解析 apidata JS 内容：按 h4「截止至」日期与表格配对，表头按列名映射（兼容季度表结构差异） */
export async function jjccHoldings(code: string): Promise<HoldingsReport[]> {
  const url = `http://fundf10.eastmoney.com/FundArchivesDatas.aspx?type=jjcc&code=${code}&topline=10`
  const text = await httpGetText(url, { referer: F10_REFERER })
  // content 是 JS 字符串字面量，以 "…",arryear:[…] 结尾；捕获到闭合引号为止（兼容内部 \" 转义）
  const content = /var apidata=\s*\{\s*content:\s*"((?:[^"\\]|\\.)*)"/s.exec(text)?.[1]?.replace(/\\(.)/g, '$1')
  if (!content) throw new Error('jjcc 未取到 content')

  // 按文档顺序匹配 h4（带日期）与 table，交替配对
  const dateRe = /截止至：<font[^>]*>(\d{4}-\d{2}-\d{2})<\/font>/
  const blockRe = /<h4[^>]*>[\s\S]*?<\/h4>|<table[^>]*>[\s\S]*?<\/table>/g
  const reports: HoldingsReport[] = []
  let currentDate: string | null = null

  for (const m of content.matchAll(blockRe)) {
    const block = m[0]
    if (block.startsWith('<h4')) {
      currentDate = dateRe.exec(block)?.[1] ?? null
      continue
    }
    // 是 table：解析列头与数据行
    const header = tableHeader(block)
    const colIdx = {
      code: header.findIndex((h) => h.includes('股票代码')),
      name: header.findIndex((h) => h.includes('股票名称')),
      weight: header.findIndex((h) => h.includes('占净值比例'))
    }
    if (colIdx.code === -1 && colIdx.name === -1) continue // 非持仓表（如债券表）跳过

    const rows: HoldingRow[] = []
    for (const rowHtml of tableRows(block)) {
      const cells = rowCells(rowHtml)
      const rank = parseNum(stripTags(cells[0]))
      if (rank === null) continue
      const stockCode = colIdx.code >= 0 ? stripTags(cells[colIdx.code]) : null
      const stockName = colIdx.name >= 0 ? stripTags(cells[colIdx.name]).replace(/\s+/g, '') : null
      const weightText = colIdx.weight >= 0 ? stripTags(cells[colIdx.weight]) : ''
      const weight = parseNum(stripThousand(weightText.replace('%', '')))
      rows.push({ rank, stockCode, stockName, weight })
    }
    if (rows.length > 0 && currentDate) {
      reports.push({ reportDate: currentDate, rows })
    }
    currentDate = null
  }
  return reports
}

function tableHeader(tableHtml: string): string[] {
  const thRow = /<tr[^>]*>\s*<th[^>]*>[\s\S]*?<\/tr>/.exec(tableHtml)?.[0] ?? ''
  // 表头单元格是 <th>（含 class='first' 的序号列），需同时匹配 th/td
  const cells: string[] = []
  for (const m of thRow.matchAll(/<th[^>]*>[\s\S]*?<\/th>|<td[^>]*>[\s\S]*?<\/td>/g)) {
    cells.push(m[0])
  }
  return cells.map((c) => stripTags(c).replace(/[\s<br>]/g, ''))
}

function tableRows(tableHtml: string): string[] {
  const rows: string[] = []
  for (const m of tableHtml.matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/g)) {
    if (/<th/i.test(m[0])) continue // 表头行跳过
    rows.push(m[0])
  }
  return rows
}

function rowCells(rowHtml: string): string[] {
  const cells: string[] = []
  for (const m of rowHtml.matchAll(/<td[^>]*>[\s\S]*?<\/td>/g)) {
    cells.push(m[0])
  }
  return cells
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').trim()
}
