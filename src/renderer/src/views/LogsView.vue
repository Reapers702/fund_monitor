<script setup lang="ts">
// 抓取日志页（P1）：把"抓了什么、抓了多少、谁在失败、是否被风控"集中到一屏。
// 数据来源：主进程 crawler/requestLog.ts（结构化请求统计）+ logger.ts（应用日志环形缓冲）。
// 与文件日志同源——文件日志用于事后排障，本页用于"打开就能看明白"。
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  NAlert,
  NButton,
  NCard,
  NEmpty,
  NGrid,
  NGi,
  NSpace,
  NSpin,
  NStatistic,
  NSwitch,
  NTabPane,
  NTabs,
  NTable,
  NTag,
  useMessage
} from 'naive-ui'

const message = useMessage()

const loading = ref(false)
const autoRefresh = ref(true)
const stats = ref<CrawlStats | null>(null)
const logs = ref<LogsPayload>({ entries: [], dir: null, file: null })
const logLevel = ref<'ALL' | 'WARN'>('WARN')

let timer: number | null = null

const successRate = computed(() => {
  const s = stats.value
  if (!s || s.total === 0) return null
  return (s.ok / s.total) * 100
})

/** 主行情源当前是否处于熔断（= 已被风控拦截，正在走降级源） */
const push2Blocked = computed(() => stats.value?.push2.blocked === true)

/** 当前抓取通道中文名（设置页可改，无需重启即生效） */
const channelName = computed(() => {
  switch (stats.value?.channel) {
    case 'browser':
      return '浏览器隐藏窗口'
    case 'auto':
      return '自动（Node 失败切浏览器）'
    default:
      return 'Node 直连'
  }
})

const activeDegradations = computed(() => {
  const s = stats.value
  if (!s) return []
  const out: string[] = []
  if (s.push2.blocked) out.push(`${s.push2.source} 熔断中（被风控，改走腾讯行情）`)
  if (s.benchmark.backoffUntil && s.benchmark.backoffUntil > Date.now()) out.push('沪深300 基准日K 退避中')
  if (s.calendar.tencentBackoffUntil && s.calendar.tencentBackoffUntil > Date.now()) out.push('腾讯交易日历退避中（改走百度/静态表）')
  return out
})

const shownLogs = computed(() =>
  logLevel.value === 'ALL' ? logs.value.entries : logs.value.entries.filter((e) => e.level === 'WARN' || e.level === 'ERROR')
)

async function refresh(): Promise<void> {
  if (loading.value) return
  loading.value = true
  try {
    const [s, l] = await Promise.all([window.api.crawlStats(), window.api.logsRecent(400)])
    stats.value = s
    logs.value = l
  } catch (e) {
    message.error(`读取抓取日志失败：${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function openDir(): Promise<void> {
  const err = await window.api.logsOpenDir()
  if (err) message.warning(err)
  else message.success('已打开日志目录')
}

function startTimer(): void {
  stopTimer()
  timer = window.setInterval(() => {
    if (autoRefresh.value) void refresh()
  }, 3000)
}

function stopTimer(): void {
  if (timer !== null) {
    window.clearInterval(timer)
    timer = null
  }
}

onMounted(async () => {
  await refresh()
  startTimer()
})

onUnmounted(stopTimer)

// ---------- 格式化 ----------

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtDateTime(ts: number | null): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
  return `${(n / 1024 / 1024).toFixed(2)}MB`
}

/** 状态码色标：2xx 绿、4xx 橙（多为限流/风控/参数）、其他红 */
function statusTag(r: CrawlRequestRecord | CrawlDimensionStat): { text: string; type: 'success' | 'warning' | 'error' | 'default' } {
  const status = 'status' in r ? r.status : null
  if (status === null || status === undefined) return { text: '连接失败', type: 'error' }
  if (status >= 200 && status < 300) return { text: String(status), type: 'success' }
  if (status >= 400 && status < 500) return { text: String(status), type: 'warning' }
  return { text: String(status), type: 'error' }
}

function levelType(level: LogEntry['level']): 'default' | 'info' | 'warning' | 'error' {
  if (level === 'ERROR') return 'error'
  if (level === 'WARN') return 'warning'
  if (level === 'DEBUG') return 'default'
  return 'info'
}
</script>

<template>
  <div class="logs-page">
    <n-card class="card">
      <template #header>
        <div class="card-header">
          <span>抓取概览（本次运行累计）</span>
          <n-space align="center" :size="10">
            <span class="hint">自动刷新</span>
            <n-switch v-model:value="autoRefresh" size="small" />
            <n-button size="small" :loading="loading" @click="refresh">刷新</n-button>
            <n-button size="small" quaternary @click="openDir">打开日志目录</n-button>
          </n-space>
        </div>
      </template>

      <n-spin :show="loading">
        <n-grid :cols="5" :x-gap="16" :y-gap="8" item-responsive responsive="screen">
          <n-gi span="5 m:1">
            <n-statistic label="请求总数" :value="stats?.total ?? 0" />
          </n-gi>
          <n-gi span="5 m:1">
            <n-statistic label="成功" :value="stats?.ok ?? 0" />
          </n-gi>
          <n-gi span="5 m:1">
            <n-statistic label="失败" :value="stats?.fail ?? 0" />
          </n-gi>
          <n-gi span="5 m:1">
            <n-statistic label="成功率" :value="successRate === null ? '—' : successRate.toFixed(1) + '%'" />
          </n-gi>
          <n-gi span="5 m:1">
            <n-statistic label="正在发送 / 排队" :value="`${stats?.limiter.active ?? 0} / ${stats?.limiter.queued ?? 0}`" />
          </n-gi>
        </n-grid>

        <div class="status-row">
          <n-space align="center" :size="8" wrap>
            <n-tag :type="push2Blocked ? 'error' : 'success'" size="small" :bordered="false">
              {{ push2Blocked ? '主行情源：熔断中（已被风控）' : '主行情源：正常' }}
            </n-tag>
            <n-tag size="small" :bordered="false">
              抓取通道：{{ channelName }}
            </n-tag>
            <n-tag size="small" :bordered="false">
              限流：并发 ≤{{ stats?.limiter.maxConcurrent ?? '—' }}，最小间隔 {{ stats?.limiter.minGapMs ?? '—' }}ms
            </n-tag>
            <n-tag size="small" :bordered="false">
              统计起点 {{ fmtDateTime(stats?.since ?? null) }}
            </n-tag>
          </n-space>
        </div>

        <n-alert v-if="activeDegradations.length > 0" type="warning" :bordered="false" class="degrade-alert">
          当前降级链路：{{ activeDegradations.join('；') }}
        </n-alert>
        <n-alert v-else type="success" :bordered="false" class="degrade-alert">
          所有数据源正常，没有触发任何熔断或退避。
        </n-alert>

        <div class="path-hint">
          日志文件：{{ logs.file ?? '（未初始化）' }}
          <template v-if="logs.dir">｜目录：{{ logs.dir }}</template>
        </div>
      </n-spin>
    </n-card>

    <n-card class="card">
      <n-tabs type="line" animated>
        <n-tab-pane name="tags" :tab="`抓取内容（${stats?.byTag.length ?? 0}）`">
          <n-empty v-if="!stats || stats.byTag.length === 0" description="本次运行还没有抓取请求" />
          <n-table v-else :bordered="false" size="small">
            <thead>
              <tr>
                <th>抓取内容</th>
                <th>次数</th>
                <th>成功</th>
                <th>失败</th>
                <th>平均耗时</th>
                <th>最近一次</th>
                <th>最近失败原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in stats.byTag" :key="d.key">
                <td>{{ d.key }}</td>
                <td class="num">{{ d.total }}</td>
                <td class="num">{{ d.ok }}</td>
                <td class="num" :class="{ bad: d.fail > 0 }">{{ d.fail }}</td>
                <td class="num">{{ fmtMs(d.avgMs) }}</td>
                <td class="mono">{{ fmtTime(d.lastTs) }}</td>
                <td class="err-cell">{{ d.lastError ?? '—' }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-tab-pane>

        <n-tab-pane name="hosts" :tab="`目标主机（${stats?.byHost.length ?? 0}）`">
          <n-table v-if="stats && stats.byHost.length > 0" :bordered="false" size="small">
            <thead>
              <tr>
                <th>主机</th>
                <th>次数</th>
                <th>成功</th>
                <th>失败</th>
                <th>平均耗时</th>
                <th>最近一次</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in stats.byHost" :key="d.key">
                <td class="mono">{{ d.key }}</td>
                <td class="num">{{ d.total }}</td>
                <td class="num">{{ d.ok }}</td>
                <td class="num" :class="{ bad: d.fail > 0 }">{{ d.fail }}</td>
                <td class="num">{{ fmtMs(d.avgMs) }}</td>
                <td class="mono">{{ fmtTime(d.lastTs) }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-tab-pane>

        <n-tab-pane name="fails" :tab="`最近失败（${stats?.failures.length ?? 0}）`">
          <n-empty v-if="!stats || stats.failures.length === 0" description="本次运行没有失败请求" />
          <n-table v-else :bordered="false" size="small">
            <thead>
              <tr>
                <th>时间</th>
                <th>抓取内容</th>
                <th>主机</th>
                <th>状态</th>
                <th>耗时</th>
                <th>第几次</th>
                <th>原因</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in stats.failures" :key="`${r.ts}-${i}`">
                <td class="mono">{{ fmtTime(r.ts) }}</td>
                <td>{{ r.tag }}</td>
                <td class="mono">{{ r.host }}</td>
                <td><n-tag :type="statusTag(r).type" size="tiny" :bordered="false">{{ statusTag(r).text }}</n-tag></td>
                <td class="num">{{ fmtMs(r.ms) }}</td>
                <td class="num">{{ r.attempt }}</td>
                <td class="err-cell">{{ r.error }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-tab-pane>

        <n-tab-pane name="recent" :tab="`最近请求（${stats?.recent.length ?? 0}）`">
          <n-table v-if="stats && stats.recent.length > 0" :bordered="false" size="small">
            <thead>
              <tr>
                <th>时间</th>
                <th>抓取内容</th>
                <th>主机</th>
                <th>状态</th>
                <th>耗时</th>
                <th>大小</th>
                <th>路径</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in stats.recent" :key="`${r.ts}-${i}`">
                <td class="mono">{{ fmtTime(r.ts) }}</td>
                <td>{{ r.tag }}</td>
                <td class="mono">{{ r.host }}</td>
                <td><n-tag :type="statusTag(r).type" size="tiny" :bordered="false">{{ statusTag(r).text }}</n-tag></td>
                <td class="num">{{ fmtMs(r.ms) }}</td>
                <td class="num">{{ fmtBytes(r.bytes) }}</td>
                <td class="path-cell">{{ r.path }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-tab-pane>

        <n-tab-pane name="applog" :tab="`应用日志（${logs.entries.length}）`">
          <div class="log-toolbar">
            <n-space align="center" :size="10">
              <n-button size="tiny" :type="logLevel === 'WARN' ? 'primary' : 'default'" @click="logLevel = 'WARN'">
                只看警告/错误
              </n-button>
              <n-button size="tiny" :type="logLevel === 'ALL' ? 'primary' : 'default'" @click="logLevel = 'ALL'">全部</n-button>
              <span class="hint">共 {{ shownLogs.length }} 条（内存保留最近 500 条，完整历史见日志文件）</span>
            </n-space>
          </div>
          <n-empty v-if="shownLogs.length === 0" description="暂无日志" />
          <div v-else class="log-list">
            <div v-for="(e, i) in shownLogs" :key="`${e.ts}-${i}`" class="log-line" :class="`lv-${e.level}`">
              <span class="log-time">{{ fmtTime(e.ts) }}</span>
              <n-tag :type="levelType(e.level)" size="tiny" :bordered="false" class="log-level">{{ e.level }}</n-tag>
              <span class="log-msg">{{ e.msg }}</span>
            </div>
          </div>
        </n-tab-pane>
      </n-tabs>
    </n-card>
  </div>
</template>

<style scoped>
.logs-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.hint {
  color: var(--text-color-3);
  font-size: 12px;
}

.status-row {
  margin-top: 14px;
}

.degrade-alert {
  margin-top: 12px;
}

.path-hint {
  margin-top: 10px;
  color: var(--text-color-3);
  font-size: 12px;
  word-break: break-all;
}

.num {
  font-variant-numeric: tabular-nums;
}

.num.bad {
  color: #d03050;
  font-weight: 600;
}

.mono {
  font-family: Consolas, Monaco, monospace;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.err-cell {
  color: #d03050;
  font-size: 12px;
  word-break: break-all;
  max-width: 420px;
}

.path-cell {
  font-family: Consolas, Monaco, monospace;
  font-size: 11px;
  color: var(--text-color-2);
  word-break: break-all;
  max-width: 420px;
}

.log-toolbar {
  margin-bottom: 8px;
}

.log-list {
  max-height: 520px;
  overflow: auto;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  padding: 6px 8px;
}

.log-line {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  padding: 2px 0;
  font-size: 12px;
  line-height: 1.6;
}

.log-time {
  flex: 0 0 auto;
  color: var(--text-color-3);
  font-variant-numeric: tabular-nums;
}

.log-level {
  flex: 0 0 auto;
}

.log-msg {
  flex: 1 1 auto;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: Consolas, Monaco, monospace;
}

.lv-WARN .log-msg {
  color: #f0a020;
}

.lv-ERROR .log-msg {
  color: #d03050;
}

.lv-DEBUG .log-msg {
  color: var(--text-color-3);
}
</style>
