<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { NEmpty, NInput, NButton, NSpace, NCard, NTag, NSwitch, NSpin, NTooltip, NDivider, NProgress, useMessage } from 'naive-ui'
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

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function pctClass(v: number | null): string {
  if (v === null) return 'muted'
  return v > 0 ? 'up' : v < 0 ? 'down' : 'muted'
}

/** 数据拉取/采样时间短格式：当天 → HH:MM，跨天 → MM-DD HH:MM（避免旧数据只见时分而误判新鲜度） */
function fmtFetchTime(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  const hm = `${p(d.getHours())}:${p(d.getMinutes())}`
  const now = new Date()
  if (d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate()) {
    return hm
  }
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${hm}`
}

function estSourceLabel(f: FundCard): string {
  if (f.estSource === 'tracking_index') return 'T1 跟踪指数'
  if (f.estSource === 'theme_etf') return 'T2 主题ETF'
  if (f.estSource === 'holdings_weighted') return 'T3 重仓股加权（基于季报）'
  return '无估值'
}

/** AI 建议 → 标签（A股习惯：加仓红 / 减仓绿 / 持有蓝） */
function adviceTag(action: string): { color: { text: string; border: string; color: string }; text: string } {
  if (action === 'add') {
    return { text: '建议加仓', color: { text: '#fff', border: '#e5484d', color: '#e5484d' } }
  }
  if (action === 'reduce') {
    return { text: '建议减仓', color: { text: '#fff', border: '#1f9d55', color: '#1f9d55' } }
  }
  return { text: '建议持有', color: { text: '#fff', border: '#2080f0', color: '#2080f0' } }
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
    <n-space align="center" class="toolbar">
      <n-input
        v-model:value="newCode"
        placeholder="输入 6 位基金代码，如 110020"
        :maxlength="6"
        class="code-input"
        @keyup.enter="addFund"
      />
      <n-button type="primary" :loading="adding" @click="addFund">添加基金</n-button>
      <n-divider vertical />
      <n-button :loading="quotesRunning" :disabled="quotesRunning" @click="refreshQuotes">
        {{ quotesRunning ? btnText(quotesTask, '刷新行情/估值') : '刷新行情/估值' }}
      </n-button>
      <n-button :loading="analyzeRunning" :disabled="analyzeRunning" @click="analyzeAll">
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
    </n-space>

    <!-- 任务进度面板：跑起来显示阶段/进度/当前标的/最近完成项；跑完保留"上次完成"，切页面回来也能看到结果 -->
    <n-card v-if="visibleTasks.length > 0" size="small" class="task-panel">
      <div v-for="t in visibleTasks" :key="t.kind" class="task-row">
        <div class="task-head">
          <n-tag size="tiny" :type="t.state === 'running' ? 'warning' : t.state === 'error' ? 'error' : 'success'" :bordered="false">
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
            {{ t.state === 'running' ? `开始于 ${fmtClock(t.startedAt)}` : t.finishedAt ? `${fmtClock(t.finishedAt)} 结束` : '' }}
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
          v-for="f in funds"
          :key="f.code"
          class="fund-card"
          :class="{ inactive: f.isActive !== 1 }"
          @click="openDetail(f.code)"
        >
          <div class="card-head">
            <div class="fund-name" :title="f.name">{{ f.name }}</div>
            <n-switch
              size="small"
              :value="f.isActive === 1"
              @update:value="(v: boolean) => toggle(f.code, v)"
              @click.stop
            />
          </div>
          <div class="fund-code">{{ f.code }}</div>
          <div class="metrics">
            <div class="metric">
              <div class="metric-label">最新净值</div>
              <div class="metric-value">{{ f.latestNav ?? '--' }}</div>
              <div class="metric-sub">
                {{ f.latestNavDate ?? '' }}{{ f.navFetchedAt ? ' · ' + fmtFetchTime(f.navFetchedAt) + ' 拉取' : '' }}
              </div>
            </div>
            <div class="metric">
              <div class="metric-label">当日涨跌</div>
              <div class="metric-value" :class="pctClass(f.navChangePct)">
                {{ fmtPct(f.navChangePct) }}
              </div>
              <div class="metric-sub">净值</div>
            </div>
            <div class="metric">
              <div class="metric-label">盘中估值</div>
              <div class="metric-value" :class="pctClass(f.estPct)">
                {{ fmtPct(f.estPct) }}
              </div>
              <div class="metric-sub">
                {{ estSourceLabel(f) }}{{ f.estTime ? ' · ' + fmtFetchTime(f.estTime) + ' 采样' : '' }}
              </div>
            </div>
          </div>
          <div class="advice-bar">
            <n-tag v-if="f.adviceAction" size="small" :color="adviceTag(f.adviceAction).color" :bordered="false" class="advice-tag">
              {{ adviceTag(f.adviceAction).text }}
            </n-tag>
            <span v-if="f.adviceDate" class="advice-date">建议日期 {{ f.adviceDate }}</span>
            <span v-if="f.adviceConfidence !== null" class="advice-conf">置信 {{ f.adviceConfidence }}%</span>
            <span v-if="!f.adviceAction" class="advice-none">暂无 AI 建议</span>
          </div>
          <div class="card-foot">
            <n-tag v-if="f.isActive !== 1" size="tiny" type="default">已停用</n-tag>
            <n-tag v-else size="tiny" type="success">启用中</n-tag>
            <span v-if="f.holdingsDate" class="holdings-date">重仓股季报 {{ f.holdingsDate }}</span>
          </div>
        </n-card>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.toolbar {
  margin-bottom: 20px;
}

/* 任务进度面板 */
.task-panel {
  margin-bottom: 16px;
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
  color: #e5484d;
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

.code-input {
  width: 260px;
}

.sched-badge {
  font-size: 12px;
  padding: 2px 10px;
  border-radius: 10px;
  cursor: default;
}

.sched-badge.on {
  color: #1f9d55;
  background: rgba(31, 157, 85, 0.12);
}

.sched-badge.off {
  color: var(--text-color-3);
  background: rgba(128, 128, 128, 0.12);
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}

.fund-card {
  cursor: pointer;
  transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.fund-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.08);
}

.fund-card.inactive {
  opacity: 0.55;
}

.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fund-name {
  font-weight: 600;
  font-size: 15px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fund-code {
  font-size: 12px;
  color: var(--text-color-3);
  margin-top: 2px;
}

.metrics {
  display: flex;
  justify-content: space-between;
  margin-top: 14px;
}

.metric {
  text-align: center;
  flex: 1;
}

.metric-label {
  font-size: 12px;
  color: var(--text-color-3);
}

.metric-value {
  font-size: 17px;
  font-weight: 700;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
}

.metric-sub {
  font-size: 11px;
  color: var(--text-color-3);
  margin-top: 2px;
}

.up {
  color: #e5484d;
}

.down {
  color: #1f9d55;
}

.muted {
  color: var(--text-color-3);
}

.advice-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color, rgba(128, 128, 128, 0.2));
}

.advice-tag {
  font-weight: 600;
}

.advice-date,
.advice-conf {
  font-size: 12px;
  color: var(--text-color-3);
}

.advice-none {
  font-size: 12px;
  color: var(--text-color-3);
}

.card-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.holdings-date {
  font-size: 12px;
  color: var(--text-color-3);
}

.empty-box {
  padding: 60px 0;
}
</style>
