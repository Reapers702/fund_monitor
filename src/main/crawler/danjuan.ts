// 蛋卷基金详情（计划书 §4.1 #3；失败降级东财 pingzhongdata 的 fS_name）
import { httpGetJson } from './httpClient'
import { pingzhongdata } from './eastmoney'

export interface FundDetail {
  code: string
  name: string
  fullName: string | null
  foundDate: string | null
  manager: string | null
  keeper: string | null
}

interface DanjuanResp {
  data?: {
    fd_code?: string
    fd_name?: string
    fd_full_name?: string | null
    found_date?: string | null
    manager_name?: string | null
    keeper_name?: string | null
  }
}

export async function danjuanFundDetail(code: string): Promise<FundDetail> {
  const url = `https://danjuanfunds.com/djapi/fund/${code}`
  const resp = await httpGetJson<DanjuanResp>(url, { referer: 'https://danjuanfunds.com/', retries: 2 })
  const d = resp.data
  if (!d?.fd_name) throw new Error('蛋卷未返回基金详情')
  return {
    code: d.fd_code ?? code,
    name: d.fd_name,
    fullName: d.fd_full_name ?? null,
    foundDate: d.found_date ?? null,
    manager: d.manager_name ?? null,
    keeper: d.keeper_name ?? null
  }
}

/** 东财侧最小详情（降级用）：仅名称 */
export async function eastmoneyFundName(code: string): Promise<{ name: string } | null> {
  try {
    const data = await pingzhongdata(code)
    return data.name ? { name: data.name } : null
  } catch {
    return null
  }
}

/** 组合：蛋卷为主，失败降级东财名称 */
export async function fundDetailWithFallback(code: string): Promise<FundDetail | null> {
  try {
    return await danjuanFundDetail(code)
  } catch (e) {
    console.warn(`[danjuan] 详情获取失败，降级东财名称: ${(e as Error).message}`)
    const fallback = await eastmoneyFundName(code)
    if (!fallback) return null
    return { code, name: fallback.name, fullName: null, foundDate: null, manager: null, keeper: null }
  }
}

/** 净值历史归一化：lsjz 分页全量 > pingzhongdata 全量（M3 补种策略） */
export function normalizePingzhongToNavs(data: {
  netWorthTrend: { x: number; y: number; equityReturn: number | null }[]
}): { fsrq: string; dwjz: number | null; ljjz: number | null; jzzzl: number | null; sgzt: null; shzt: null }[] {
  return data.netWorthTrend.map((r) => ({
    fsrq: new Date(r.x).toISOString().slice(0, 10),
    dwjz: r.y,
    ljjz: null,
    jzzzl: r.equityReturn,
    sgzt: null,
    shzt: null
  }))
}
