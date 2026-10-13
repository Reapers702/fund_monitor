<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import {
  NEmpty,
  NInput,
  NButton,
  NCard,
  NTag,
  NSwitch,
  NSpin,
  NTooltip,
  NDivider,
  NProgress,
  NSelect,
  NCheckbox,
  useMessage
} from 'naive-ui'
import { isRunning, taskOf, taskPercent } from '../taskMonitor'

const router = useRouter()
const message = useMessage()

const funds = ref<FundCard[]>([])
const loading = ref(true)
const adding = ref(false)
const newCode = ref('')
const scheduler = ref<SchedulerStatus | null>(null)

// 刷新/AI 分析的"进行中"状态来自主进程任务登记（tasks.ts），不是本组件的局部 ref——
// 这样切到别的页面再回来，按钮依然是禁用+进度状态，而不是误以为没在跑而能重复点击
const quotesTask = taskOf('quotes')
const analyzeTask = taskOf('analyzeAll')
const quotesRunning = computed(() => isRunning(quotesTask.value))
const analyzeRunning = computed(() => isRunning(analyzeTask.value))

/** 面板只展示"本次会话跑过"的任务（idle 占位不显示，否则闲置时也常驻两行"未运行"） */
const visibleTasks = computed(() =>
  [quotesTask.value, analyzeTask.value].filter((t): t is TaskProgress => !!t && t.state !== 'idle')
)

/** 按钮文案：跑起来时直接显示阶段与进度，用户不用去猜"到底在刷什么" */
function btnText(t: TaskProgress | null, idle: string): string {
  if (!t || t.state !== 'running') return idle
  const ph = t.phase ? `${t.phase} ` : ''
  const cnt = t.total > 0 ? `${t.done}/${t.total}` : ''
  return `${ph}${cnt}`.trim() || idle
}

/** 任务完成/失败时提示一次。
 *  为什么要按 finishedAt 去重：完成通知有两条来源——① 点击后 IPC 返回；② 轮询观察到
 *  running→done（例如调度器自动跑的 AI 分析，或用户在别的页面时跑完）。两条都可能触发，
 *  用 finishedAt 作为"这一次运行"的唯一标识，保证只弹一次。
 *  切页面回来时另有"上次完成"面板兜底，不依赖这里。 */
const notified = new Set<number>()
function notifyDone(t: TaskProgress | null, label: string): void {
  if (!t?.finishedAt || notified.has(t.finishedAt)) return
  notified.add(t.finishedAt)
  if (t.state === 'error') message.error(`${label}失败: ${t.error ?? '未知错误'}`)
  else if (t.state === 'done') message.success(t.summary ?? `${label}完成`)
}
watch(quotesTask, (t) => notifyDone(t, '行情刷新'))
watch(analyzeTask, (t) => notifyDone(t, 'AI 分析'))

/** 进度面板时间格式 */
function fmtClock(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ---------- 列表：排序 / 过滤 / 概览 ----------

type SortKey = 'default' | 'estDesc' | 'estAsc' | 'name'

const sortKey = ref<SortKey>('default')
const showInactive = ref(true)

const sortOptions = [
  { label: '默认（按代码）', value: 'default' },
  { label: '估值涨幅优先', value: 'estDesc' },
  { label: '估值跌幅优先', value: 'estAsc' },
  { label: '按名称', value: 'name' }
]

const activeFunds = computed(() => funds.value.filter((f) => f.isActive === 1))
const inactiveCount = computed(() => funds.value.length - activeFunds.value.length)

/** 列表排序：停用的一律沉底（Array.sort 稳定，内部保持所选规则） */
const shownFunds = computed(() => {
  const arr = funds.value.filter((f) => showInactive.value || f.isActive === 1)
  if (sortKey.value === 'estDesc') {
    arr.sort((a, b) => rank(b.estPct, -1) - rank(a.estPct, -1) || a.code.localeCompare(b.code))
  } else if (sortKey.value === 'estAsc') {
    arr.sort((a, b) => rank(a.estPct, 1) - rank(b.estPct, 1) || a.code.localeCompare(b.code))
  } else if (sortKey.value === 'name') {
    arr.sort((a, b) => a.name.localeCompare(b.name, 'zh') || a.code.localeCompare(b.code))
  } else {
    arr.sort((a, b) => a.code.localeCompare(b.code))
  }
  return arr.sort((a, b) => (a.isActive === 1 ? 0 : 1) - (b.isActive === 1 ? 0 : 1))
})

/** 排序权重：缺失值（null）永远排末尾（降序给 -Infinity，升序给 +Infinity） */
function rank(v: number | null, dir: 1 | -1): number {
  if (v === null || Number.isNaN(v))
    return dir === -1 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  return v
}

/** 概览：估值均值 / 涨跌分布 / 数据新鲜度（只看启用中的基金） */
const overview = computed(() => {
  const vals = activeFunds.value
    .map((f) => f.estPct)
    .filter((v): v is number => v !== null && !Number.isNaN(v))
  const up = vals.filter((v) => v > 0).length
  const down = vals.filter((v) => v < 0).length
  const avg = vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  const times = activeFunds.value
    .map((f) => (f.estTime ? new Date(f.estTime).getTime() : 0))
    .filter((t) => t > 0)
  const navDates = [
    ...new Set(activeFunds.value.map((f) => f.latestNavDate).filter(Boolean))
  ].sort() as string[]
  return {
    total: activeFunds.value.length,
    up,
    down,
    flat: vals.length - up - down,
    sampled: vals.length,
    avg,
    lastEst: times.length > 0 ? new Date(Math.max(...times)).toISOString() : null,
    navDate: navDates.length > 0 ? navDates[navDates.length - 1] : null,
    navPending: activeFunds.value.length > 0 && activeFunds.value.some((f) => f.navPending)
  }
})

async function load(): Promise<void> {
  loading.value = true
  try {
    funds.value = await window.api.fundsList()
  } catch (e) {
    message.error(`加载基金列表失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

async function loadScheduler(): Promise<void> {
  try {
    scheduler.value = await window.api.schedulerStatus()
  } catch {
    scheduler.value = null
  }
}

async function addFund(): Promise<void> {
  const code = newCode.value.trim()
  if (!/^\d{6}$/.test(code)) {
    message.warning('请输入 6 位基金代码')
    return
  }
  adding.value = true
  try {
    const r = await window.api.fundsAdd(code)
    message.success(
      `添加成功：${r.name ?? code}（净值 ${r.navInserted} 条，持仓 ${r.holdingsInserted} 行）`
    )
    newCode.value = ''
    await load()
  } catch (e) {
    message.error(`添加失败: ${(e as Error).message}`)
  } finally {
    adding.value = false
  }
}

async function toggle(code: string, active: boolean): Promise<void> {
  try {
    await window.api.fundsToggle(code, active)
    message.success(active ? '已启用' : '已停用')
    await load()
  } catch (e) {
    message.error(`切换失败: ${(e as Error).message}`)
  }
}

/** 手动刷新行情+估值（调用主进程 runQuotesCore）。
 *  成功/失败的提示交给 task 状态 watch（进度是主进程登记的，跨页面也准）；
 *  这里只处理"已在运行被拒"这类预期拒绝，以及完成后刷新卡片。 */
async function refreshQuotes(): Promise<void> {
  try {
    const r = await window.api.quotesRun()
    if (!r.ok) {
      // 重复触发被主进程拒绝：不算错误，也不弹红字（进度条已经在显示那一次）
      if (!/正在进行中/.test(r.error ?? '')) message.error(`行情刷新失败: ${r.error ?? '未知错误'}`)
      return
    }
    await load() // 刷新卡片（估值/涨跌可能变化）
    notifyDone(quotesTask.value, '行情刷新')
  } catch (e) {
    message.error(`行情刷新失败: ${(e as Error).message}`)
  }
}

/** 手动触发全部基金 AI 分析 */
async function analyzeAll(): Promise<void> {
  try {
    const r = await window.api.adviceAnalyzeAll()
    if (!r.ok) {
      if (!/正在进行中/.test(r.error ?? '')) message.error(`AI 分析失败: ${r.error ?? '未知错误'}`)
      return
    }
    await load()
    notifyDone(analyzeTask.value, 'AI 分析')
  } catch (e) {
    message.error(`AI 分析失败: ${(e as Error).message}`)
  }
}

function openDetail(code: string): void {
  router.push(`/fund/${code}`)
}

// ---------- 展示格式化 ----------

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** 涨跌方向 → 类名（红涨绿跌；无数据/持平用中性色） */
function dirOf(v: number | null): 'up' | 'down' | 'flat' {
  if (v === null || Number.isNaN(v) || v === 0) return 'flat'
  return v > 0 ? 'up' : 'down'
}

/** 数据拉取/采样时间短格式：当天 → HH:MM，跨天 → MM-DD HH:MM（避免旧数据只见时分而误判新鲜度） */
function fmtFetchTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const now = new Date()
  if (
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate()
  ) {
    return hm
  }
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

function estSourceLabel(f: FundCard): string {
  if (f.estSource === 'tracking_index') return 'T1 跟踪指数'
  if (f.estSource === 'theme_etf') return 'T2 主题ETF'
  if (f.estSource === 'holdings_weighted') return 'T3 重仓股加权'
  return '无估值'
}

/** AI 建议文案（颜色由 advice-* 类给：A股习惯 加仓红 / 减仓绿 / 持有蓝） */
function adviceText(action: string | null): string {
  if (action === 'add') return '建议加仓'
  if (action === 'reduce') return '建议减仓'
  if (action === 'hold') return '建议持有'
  return '暂无 AI 建议'
}

let schedulerTimer: number | null = null

onMounted(() => {
  void load()
  void loadScheduler()
  schedulerTimer = window.setInterval(() => void loadScheduler(), 15_000)
})

onBeforeUnmount(() => {
  if (schedulerTimer) window.clearInterval(schedulerTimer)
})
</script>

<template>
  <div class="dashboard">
    <!-- 概览条：一眼看清"几只、涨跌分布、数据新鲜不新鲜" -->
    <div class="overview">
      <div class="ov">
        <div class="ov-label">自选基金</div>
        <div class="ov-value">{{ overview.total }}<span class="ov-unit">只</span></div>
        <div class="ov-note">
          {{ inactiveCount > 0 ? `含已停用 ${inactiveCount} 只` : '全部启用中' }}
        </div>
      </div>
      <div class="ov">
        <div class="ov-label">盘中估值 · 均值</div>
        <div class="ov-value" :class="`v-${dirOf(overview.avg)}`">{{ fmtPct(overview.avg) }}</div>
        <div class="ov-note">{{ overview.sampled }} 只已采样</div>
      </div>
      <div class="ov">
        <div class="ov-label">涨跌分布</div>
        <div class="ov-value split">
          <span class="v-up">↑ {{ overview.up }}</span>
          <span class="v-flat">– {{ overview.flat }}</span>
          <span class="v-down">↓ {{ overview.down }}</span>
        </div>
        <div class="ov-note">按盘中估值统计 · 红涨绿跌</div>
      </div>
      <div class="ov">
        <div class="ov-label">数据时间</div>
        <div class="ov-value small">
          估值 {{ overview.lastEst ? fmtFetchTime(overview.lastEst) : '--' }}
        </div>
        <div class="ov-note">
          净值 {{ overview.navDate ?? '--' }}
          <template v-if="overview.navPending">（待 T+1 公布）</template>
        </div>
      </div>
    </div>

    <div class="toolbar">
      <div class="toolbar-left">
        <n-input
          v-model:value="newCode"
          placeholder="输入 6 位基金代码，如 110020"
          :maxlength="6"
          class="code-input"
          @keyup.enter="addFund"
        />
        <n-button type="primary" :loading="adding" @click="addFund">添加基金</n-button>
      </div>
      <div class="toolbar-right">
        <n-select v-model:value="sortKey" size="small" :options="sortOptions" class="sort-select" />
        <n-checkbox v-model:checked="showInactive" size="small">显示已停用</n-checkbox>
        <n-divider vertical />
        <n-button
          size="small"
          :loading="quotesRunning"
          :disabled="quotesRunning"
          @click="refreshQuotes"
        >
          {{ quotesRunning ? btnText(quotesTask, '刷新行情/估值') : '刷新行情/估值' }}
        </n-button>
        <n-button
          size="small"
          :loading="analyzeRunning"
          :disabled="analyzeRunning"
          @click="analyzeAll"
        >
          {{ analyzeRunning ? btnText(analyzeTask, '全部 AI 分析') : '全部 AI 分析' }}
        </n-button>
        <n-tooltip v-if="scheduler" placement="bottom">
          <template #trigger>
            <span class="sched-badge" :class="scheduler.running ? 'on' : 'off'">
              {{ scheduler.running ? '调度运行中' : '调度未启动' }}
            </span>
          </template>
          {{ scheduler.lastLog || '后台任务：盘中估值采样 / 盘后净值增量 / 收盘后 AI 分析' }}
        </n-tooltip>
      </div>
    </div>

    <!-- 任务进度面板：跑起来显示阶段/进度/当前标的/最近完成项；跑完保留"上次完成"，切页面回来也能看到结果 -->
    <n-card v-if="visibleTasks.length > 0" size="small" class="task-panel">
      <div v-for="t in visibleTasks" :key="t.kind" class="task-row">
        <div class="task-head">
          <n-tag
            size="tiny"
            :type="t.state === 'running' ? 'warning' : t.state === 'error' ? 'error' : 'success'"
            :bordered="false"
          >
            {{ t.state === 'running' ? '进行中' : t.state === 'error' ? '失败' : '已完成' }}
          </n-tag>
          <span class="task-label">{{ t.label }}</span>
          <span v-if="t.state === 'running'" class="task-phase">
            {{ t.phase ?? '准备中' }}
            <template v-if="t.total > 0"> · {{ t.done }}/{{ t.total }}</template>
            <template v-if="t.current"> · 当前 {{ t.current }}</template>
          </span>
          <span v-else-if="t.summary" class="task-phase">{{ t.summary }}</span>
          <span v-else-if="t.error" class="task-phase err">{{ t.error }}</span>
          <span class="task-time">
            {{
              t.state === 'running'
                ? `开始于 ${fmtClock(t.startedAt)}`
                : t.finishedAt
                  ? `${fmtClock(t.finishedAt)} 结束`
                  : ''
            }}
          </span>
        </div>
        <n-progress
          v-if="t.state === 'running'"
          type="line"
          :height="6"
          :percentage="taskPercent(t) ?? 0"
          :indeterminate="taskPercent(t) === null"
          :show-indicator="false"
          processing
        />
        <div v-if="t.recent.length > 0" class="task-recent">
          <div v-for="(line, i) in t.recent.slice(0, 6)" :key="i" class="task-line">{{ line }}</div>
        </div>
      </div>
    </n-card>

    <n-spin :show="loading">
      <div v-if="funds.length === 0 && !loading" class="empty-box">
        <n-empty description="还没有自选基金，先添加一个吧（如 110020 沪深300）">
          <template #extra>
            <n-button type="primary" @click="load">刷新</n-button>
          </template>
        </n-empty>
      </div>

      <div v-else class="cards">
        <n-card
          v-for="f in shownFunds"
          :key="f.code"
          class="fund-card"
          :class="[`dir-${dirOf(f.estPct)}`, { inactive: f.isActive !== 1 }]"
          @click="openDetail(f.code)"
        >
          <div class="card-head">
            <div class="ident">
              <div class="fund-name" :title="f.name">{{ f.name }}</div>
              <div class="ident-sub">
                <span class="fund-code">{{ f.code }}</span>
                <span v-if="f.isActive !== 1" class="pill pill-off">已停用</span>
                <span
                  v-else-if="f.navPending"
                  class="pill pill-warn"
                  title="基金净值 T+1 公布：今天盘中的净值/涨跌要等今晚更新后才有"
                >
                  净值待公布
                </span>
              </div>
            </div>
            <n-switch
              size="small"
              :value="f.isActive === 1"
              @update:value="(v: boolean) => toggle(f.code, v)"
              @click.stop
            />
          </div>

          <div class="hero">
            <div class="hero-left">
              <div class="hero-label">盘中估值</div>
              <div class="hero-value" :class="`v-${dirOf(f.estPct)}`">{{ fmtPct(f.estPct) }}</div>
            </div>
            <div class="hero-right">
              <div class="hero-source" :title="estSourceLabel(f)">{{ estSourceLabel(f) }}</div>
              <div class="hero-time">
                {{ f.estTime ? `${fmtFetchTime(f.estTime)} 采样` : '今日暂无采样' }}
              </div>
            </div>
          </div>

          <div class="facts">
            <div class="fact">
              <div class="fact-label">最新净值</div>
              <div class="fact-value">{{ f.latestNav ?? '--' }}</div>
              <div class="fact-note">{{ f.latestNavDate ?? '--' }}</div>
            </div>
            <div class="fact">
              <div class="fact-label">净值涨跌</div>
              <div class="fact-value" :class="`v-${dirOf(f.navChangePct)}`">
                {{ fmtPct(f.navChangePct) }}
              </div>
              <div class="fact-note">{{ f.latestNavDate ? `${f.latestNavDate} 收盘` : '--' }}</div>
            </div>
          </div>

          <div class="card-foot">
            <span class="advice" :class="`advice-${f.adviceAction ?? 'none'}`">{{
              adviceText(f.adviceAction)
            }}</span>
            <span v-if="f.adviceAction && f.adviceConfidence !== null" class="foot-muted"
              >置信 {{ f.adviceConfidence }}%</span
            >
            <span v-if="f.adviceDate" class="foot-muted">{{ f.adviceDate }}</span>
            <span class="spacer" />
            <span v-if="f.holdingsDate" class="foot-muted" title="最新季报重仓股报告期"
              >重仓 {{ f.holdingsDate }}</span
            >
          </div>
        </n-card>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.dashboard {
  padding-bottom: 8px;
}

/* ---------- 概览条 ---------- */

.overview {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 1px;
  background: var(--divider-color);
  border: 1px solid var(--border-color);
  border-radius: var(--card-radius);
  overflow: hidden;
  margin-bottom: 14px;
}

.ov {
  background: #fff;
  padding: 12px 16px;
}

.ov-label {
  font-size: 12px;
  color: var(--text-color-3);
}

.ov-value {
  font-size: 20px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  margin-top: 2px;
  line-height: 1.3;
}

.ov-value.small {
  font-size: 15px;
}

.ov-value.split {
  display: flex;
  gap: 10px;
  font-size: 16px;
}

.ov-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-color-3);
  margin-left: 2px;
}

.ov-note {
  font-size: 11px;
  color: var(--text-color-3);
  margin-top: 2px;
}

/* ---------- 工具栏 ---------- */

.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}

.toolbar-left,
.toolbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.code-input {
  width: 240px;
}

.sort-select {
  width: 150px;
}

.sched-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  cursor: default;
}

.sched-badge.on {
  color: var(--down-color);
  background: var(--down-bg);
}

.sched-badge.off {
  color: var(--text-color-3);
  background: rgba(128, 128, 128, 0.12);
}

/* ---------- 任务进度面板 ---------- */

.task-panel {
  margin-bottom: 14px;
}

.task-row + .task-row {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--divider-color);
}

.task-head {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  font-size: 13px;
}

.task-label {
  font-weight: 600;
}

.task-phase {
  color: var(--text-color-2);
}

.task-phase.err {
  color: var(--up-color);
}

.task-time {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-color-3);
}

.task-recent {
  margin-top: 6px;
  max-height: 96px;
  overflow: auto;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-color-3);
  font-variant-numeric: tabular-nums;
}

.task-line {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ---------- 基金卡片 ---------- */

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 14px;
}

.fund-card {
  cursor: pointer;
  border-radius: var(--card-radius);
  border-left: 3px solid var(--border-color);
  transition:
    transform 0.15s ease,
    box-shadow 0.15s ease,
    border-color 0.15s ease;
}

.fund-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 8px 22px rgba(0, 0, 0, 0.1);
}

/* 左侧色条 = 盘中估值方向（红涨绿跌），扫一眼就能看出好坏 */
.fund-card.dir-up {
  border-left-color: var(--up-color);
}

.fund-card.dir-down {
  border-left-color: var(--down-color);
}

.fund-card.dir-flat {
  border-left-color: var(--border-color);
}

.fund-card.inactive {
  opacity: 0.6;
}

.card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.ident {
  min-width: 0;
}

.fund-name {
  font-weight: 600;
  font-size: 15px;
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ident-sub {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
}

.fund-code {
  font-size: 12px;
  color: var(--text-color-3);
  font-variant-numeric: tabular-nums;
}

.pill {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 8px;
  line-height: 1.6;
}

.pill-off {
  color: var(--text-color-3);
  background: rgba(128, 128, 128, 0.14);
}

.pill-warn {
  color: #b26a00;
  background: rgba(240, 160, 32, 0.16);
}

/* 主指标：盘中估值（视觉主角，带方向底色） */
.hero {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 10px;
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: rgba(128, 128, 128, 0.06);
}

.dir-up .hero {
  background: var(--up-bg);
}

.dir-down .hero {
  background: var(--down-bg);
}

.hero-label {
  font-size: 12px;
  color: var(--text-color-2);
}

.hero-value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.5px;
}

.hero-right {
  text-align: right;
  min-width: 0;
}

.hero-source {
  font-size: 11px;
  color: var(--text-color-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  margin-left: auto;
}

.hero-time {
  font-size: 11px;
  color: var(--text-color-3);
  margin-top: 2px;
}

/* 次指标：净值两列 */
.facts {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.fact {
  flex: 1;
  min-width: 0;
}

.fact-label {
  font-size: 12px;
  color: var(--text-color-3);
}

.fact-value {
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  margin-top: 1px;
}

.fact-note {
  font-size: 11px;
  color: var(--text-color-3);
}

/* 底部：AI 建议 + 数据日期 */
.card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px dashed var(--divider-color);
}

.spacer {
  flex: 1;
}

.advice {
  font-size: 12px;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 8px;
  color: #fff;
  background: var(--flat-color);
}

.advice-add {
  background: var(--up-color);
}

.advice-reduce {
  background: var(--down-color);
}

.advice-hold {
  background: var(--info-color);
}

.advice-none {
  color: var(--text-color-3);
  background: rgba(128, 128, 128, 0.12);
  font-weight: 400;
}

.foot-muted {
  font-size: 11px;
  color: var(--text-color-3);
  font-variant-numeric: tabular-nums;
}

/* 涨跌色（红涨绿跌） */
.v-up {
  color: var(--up-color);
}

.v-down {
  color: var(--down-color);
}

.v-flat {
  color: var(--flat-color);
}

.empty-box {
  padding: 60px 0;
}
</style>
