<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NCard, NDescriptions, NDescriptionsItem, NTag, NButton, NSpin, NEmpty,
  NTable, NAlert, NRadioGroup, NRadioButton, useMessage
} from 'naive-ui'
import * as echarts from 'echarts'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const code = route.params.code as string
const detail = ref<FundDetail | null>(null)
const loading = ref(true)
const range = ref<number>(120) // 图表范围（天）
const navMode = ref<'nav' | 'pct'>('nav') // 默认 APP 视角：单位净值绝对值；可切换"区间涨跌"（归一化 100%）

const chartEl = ref<HTMLDivElement | null>(null)
let chart: echarts.ECharts | null = null

function fmtPct(v: number | null): string {
  if (v === null || Number.isNaN(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

function pctClass(v: number | null): string {
  if (v === null) return 'muted'
  return v > 0 ? 'up' : v < 0 ? 'down' : 'muted'
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（AI 建议生成时间，精确到秒） */
function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function renderChart(): void {
  if (!chartEl.value || !detail.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
  }

  const d = detail.value
  const nav = d.nav
  const isPct = navMode.value === 'pct'
  // 净值模式：单位净值绝对值（元，APP 默认视角）；区间涨跌模式：归一化到范围起点 100%（相对涨跌幅，可与盘中估值散点同量纲叠加）
  const base = isPct && nav.length > 0 ? nav[0].nav : 1
  const navPct = nav.map((p) => ({
    date: p.date,
    value: isPct ? +(((p.nav / base) * 100).toFixed(2)) : p.nav
  }))
  // 盘中估值只画最新一次采样（estimateSeries 按时间升序，末条即当前估算）；全天采样点全部映射到同一日期列，画全部会重叠成一团
  const latestEst = d.estimate[d.estimate.length - 1]
  const hasEst = isPct && !!latestEst && latestEst.pct !== null

  chart.setOption(
    {
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        valueFormatter: (v: unknown) => {
          if (v === null || v === undefined || v === '') return '--'
          const n = Number(v)
          if (Number.isNaN(n)) return String(v)
          return isPct ? n.toFixed(2) + '%' : n.toFixed(4)
        }
      },
      legend: { data: hasEst ? ['净值走势', '盘中估值(实时采样)'] : ['净值走势'], top: 0 },
      grid: { left: 48, right: 48, top: 36, bottom: 28 },
      xAxis: {
        type: 'category',
        boundaryGap: false,
        data: navPct.map((p) => p.date),
        axisLabel: { fontSize: 10 }
      },
      yAxis: {
        type: 'value',
        scale: true,
        axisLabel: { fontSize: 10, formatter: isPct ? '{value}%' : (v: string) => Number(v).toFixed(2) }
      },
      series: [
        {
          name: '净值走势',
          type: 'line',
          smooth: true,
          showSymbol: false,
          data: navPct.map((p) => p.value),
          lineStyle: { width: 2 },
          areaStyle: { opacity: 0.06 }
        },
        // 盘中估值散点（相对前收的估算涨跌幅，百分比量纲）：仅区间涨跌模式叠加，单位净值模式量纲不同不混画
        ...(hasEst
          ? [
              {
                name: '盘中估值(实时采样)',
                type: 'scatter',
                data: [[navPct.length > 0 ? navPct[navPct.length - 1].date : '', latestEst.pct]],
                symbolSize: 8,
                itemStyle: { color: '#e5484d' }
              }
            ]
          : [])
      ]
    },
    { notMerge: true } // 模式切换时 series 数量会变（估值散点有无），需全量重绘避免旧 series 残留
  )
}

function changeMode(mode: string): void {
  navMode.value = mode === 'pct' ? 'pct' : 'nav'
  renderChart()
}

function resizeChart(): void {
  chart?.resize()
}

async function load(): Promise<void> {
  loading.value = true
  try {
    detail.value = await window.api.fundDetail(code, range.value)
    if (detail.value) {
      // 图表容器在 v-if="detail" 分支内，需等 Vue 完成 DOM 更新后 init
      await nextTick()
      renderChart()
    }
  } catch (e) {
    message.error(`加载详情失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

function changeRange(days: number): void {
  range.value = days
  void load()
}

function actionTag(action: string): { type: 'success' | 'warning' | 'info'; text: string } {
  if (action === 'add') return { type: 'success', text: '加仓' }
  if (action === 'reduce') return { type: 'warning', text: '减仓' }
  return { type: 'info', text: '持有' }
}

// ---------- 建议复盘（analyzer/review 计算，随 fund:detail 返回） ----------

/** 建议 id → 复盘结果（入场日 + 后续各周期涨跌/是否命中） */
const reviewItems = computed(() => {
  const m = new Map<number, AdviceReviewItem>()
  for (const it of detail.value?.adviceReview.items ?? []) m.set(it.id, it)
  return m
})

const reviewStats = computed(() => detail.value?.adviceReview.stats ?? [])
const reviewHorizons = computed(() => detail.value?.adviceReview.horizons ?? [])
/** 是否已有满期可复盘样本（含 hold——hold 虽无方向，其后续收益仍有参考价值） */
const hasReviewSamples = computed(() => reviewStats.value.some((s) => s.evaluated > 0))

/** 命中率最小样本数（由主进程下发，避免此处另存一份阈值） */
const minSampleForRate = computed(() => detail.value?.adviceReview.minSampleForRate ?? 10)

/** 样本不足的周期（有样本但达不到给结论的门槛），用于提示"别当结论看" */
const insufficientHorizons = computed(() => reviewStats.value.filter((s) => s.evaluated > 0 && s.matured < minSampleForRate.value))

/** 命中率/占比文本：样本不足时只给"命中数/总数"，不折算百分比（避免用噪声下结论） */
function rate(hit: number, total: number): string {
  if (total <= 0) return '--'
  if (total < minSampleForRate.value) return `${hit}/${total}(样本不足)`
  return `${((hit / total) * 100).toFixed(0)}%（${hit}/${total}）`
}

/** 复盘用的涨跌文本（与图表一致的 up/down 配色） */
function fmtRet(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}

/** 取某条建议的复盘结果（模板内用，避免非空断言） */
function revOf(id: number): AdviceReviewItem | undefined {
  return reviewItems.value.get(id)
}

// ---------- 量化指标（analyzer/metrics 计算，随 fund:detail 返回） ----------

/** 指标卡展示项：值为 null 显示 --，涨跌类按 up/down 上色 */
const metricItems = computed(() => {
  const m = detail.value?.metrics
  if (!m) return []
  const pct = (v: number | null) => (v === null ? '--' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
  return [
    { label: '区间收益', text: pct(m.periodReturn), tone: m.periodReturn },
    { label: '年化收益', text: pct(m.annualizedReturn), tone: m.annualizedReturn },
    { label: '年化波动率', text: m.annualizedVol === null ? '--' : `${m.annualizedVol.toFixed(2)}%`, tone: null },
    { label: '夏普比率', text: m.sharpe === null ? '--' : m.sharpe.toFixed(2), tone: m.sharpe },
    { label: '最大回撤', text: pct(m.maxDrawdown), tone: m.maxDrawdown },
    { label: '当前回撤', text: pct(m.currentDrawdown), tone: m.currentDrawdown },
    { label: '日涨占比', text: m.winRate === null ? '--' : `${m.winRate.toFixed(1)}%`, tone: null },
    { label: '近 20 日', text: pct(m.ret20), tone: m.ret20 },
    { label: '近 60 日', text: pct(m.ret60), tone: m.ret60 },
    {
      label: '20 日均线',
      text: m.ma20 === null ? '--' : m.ma20.toFixed(4),
      tone: null,
      extra: m.aboveMa20 === null ? '' : m.aboveMa20 ? '上方' : '下方'
    }
  ]
})

/** 相对基准超额（基准取不到时为空数组，卡片只显示基金自身指标） */
const excessItems = computed(() => detail.value?.relativeStrength?.windows.filter((w) => w.excess !== null) ?? [])

/** 夏普等指标取 null 时不参与涨跌配色 */
function toneClass(tone: number | null): string {
  if (tone === null) return 'muted'
  return tone > 0 ? 'up' : tone < 0 ? 'down' : 'muted'
}

// ---------- AI 分析 ----------

const analyzing = ref(false)

async function runAdvice(): Promise<void> {
  analyzing.value = true
  try {
    const r = await window.api.adviceAnalyze(code)
    if (r.skipped || !r.advice) {
      message.warning(r.reason ?? '分析跳过（可能未配置 DeepSeek Key 或数据不足）')
    } else if (r.advice.inserted) {
      message.success(`分析完成：${actionTag(r.advice.action).text}（置信度 ${r.advice.confidence}%）`)
    } else {
      message.info(`已完成（今日已有记录）：${actionTag(r.advice.action).text}`)
    }
    await load() // 刷新建议列表
  } catch (e) {
    message.error(`AI 分析失败: ${(e as Error).message}`)
  } finally {
    analyzing.value = false
  }
}

onMounted(() => {
  void load()
  window.addEventListener('resize', resizeChart)
})

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeChart)
  chart?.dispose()
  chart = null
})

watch(
  () => detail.value?.nav,
  () => renderChart()
)
</script>

<template>
  <div class="fund-detail">
    <n-button text type="primary" @click="router.back()">← 返回</n-button>

    <n-spin :show="loading">
      <template v-if="detail">
        <n-card class="head-card">
          <template #header>
            <div class="head-title">
              <span>{{ detail.basic?.name ?? code }}</span>
              <n-tag size="small" type="info" :bordered="false">{{ code }}</n-tag>
            </div>
          </template>
          <n-descriptions size="small" :column="4" label-placement="left">
            <n-descriptions-item label="最新净值">
              <span class="strong">{{ detail.nav[detail.nav.length - 1]?.nav.toFixed(4) ?? '--' }}</span>
            </n-descriptions-item>
            <n-descriptions-item label="当日涨跌">
              <span :class="pctClass(detail.nav[detail.nav.length - 1]?.changePct ?? null)">
                {{ fmtPct(detail.nav[detail.nav.length - 1]?.changePct ?? null) }}
              </span>
            </n-descriptions-item>
            <n-descriptions-item label="基金经理">{{ detail.basic?.manager ?? '--' }}</n-descriptions-item>
            <n-descriptions-item label="成立日">{{ detail.basic?.foundDate ?? '--' }}</n-descriptions-item>
            <n-descriptions-item label="净值样本">{{ detail.basic?.navCount ?? 0 }} 条</n-descriptions-item>
            <n-descriptions-item label="重仓股季报">{{ detail.holdings.reportDate ?? '--' }}</n-descriptions-item>
            <n-descriptions-item label="盘中估值">
              <span :class="pctClass(detail.estimate[detail.estimate.length - 1]?.pct ?? null)">
                {{ fmtPct(detail.estimate[detail.estimate.length - 1]?.pct ?? null) }}
              </span>
            </n-descriptions-item>
            <n-descriptions-item label="估值来源">
              <n-tag
                size="tiny"
                :type="detail.estimate[detail.estimate.length - 1]?.source === 'tracking_index' ? 'success' : detail.estimate[detail.estimate.length - 1]?.source === 'theme_etf' ? 'info' : 'warning'"
                :bordered="false"
              >
                {{
                  detail.estimate[detail.estimate.length - 1]?.source === 'tracking_index'
                    ? '跟踪指数 T1'
                    : detail.estimate[detail.estimate.length - 1]?.source === 'theme_etf'
                      ? '主题ETF T2'
                      : detail.estimate[detail.estimate.length - 1]?.source === 'holdings_weighted'
                        ? '重仓股加权 T3（基于季报估算）'
                        : '无估值'
                }}
              </n-tag>
            </n-descriptions-item>
          </n-descriptions>

          <div class="range-bar">
            <n-button
              v-for="d in [30, 60, 120, 365]"
              :key="d"
              size="small"
              :type="range === d ? 'primary' : 'default'"
              @click="changeRange(d)"
            >
              {{ d === 365 ? '1年' : d + '日' }}
            </n-button>
          </div>
        </n-card>

        <n-card title="净值走势" class="chart-card">
          <template #header-extra>
            <n-radio-group size="small" :value="navMode" @update:value="changeMode">
              <n-radio-button value="nav">单位净值</n-radio-button>
              <n-radio-button value="pct">区间涨跌</n-radio-button>
            </n-radio-group>
          </template>
          <div ref="chartEl" class="chart"></div>
          <p v-if="detail.nav.length === 0" class="chart-empty">暂无净值数据，请先执行 --fund {{ code }} 补数据。</p>
        </n-card>

        <n-card title="量化指标" class="metric-card">
          <template #header-extra>
            <span class="metric-note">
              AI 分析依据（近 {{ detail.metrics.sampleDays }} 个交易日，年化按 244 交易日）
            </span>
          </template>
          <div class="metric-grid">
            <div v-for="it in metricItems" :key="it.label" class="metric-item">
              <div class="metric-label">{{ it.label }}</div>
              <div class="metric-value" :class="toneClass(it.tone)">
                {{ it.text }}<span v-if="it.extra" class="metric-extra">{{ it.extra }}</span>
              </div>
            </div>
          </div>
          <div v-if="excessItems.length > 0" class="excess-row">
            <span class="metric-label">相对{{ detail.relativeStrength?.benchmark }}超额</span>
            <n-tag
              v-for="w in excessItems"
              :key="w.window"
              size="small"
              :bordered="false"
              :type="(w.excess ?? 0) >= 0 ? 'success' : 'error'"
            >
              近 {{ w.window }} 日 {{ fmtPct(w.excess) }}
              <span class="excess-detail">（基金 {{ fmtPct(w.fundRet) }} / 基准 {{ fmtPct(w.benchRet) }}）</span>
            </n-tag>
          </div>
          <p v-else class="metric-note muted">基准指数日K暂不可用，本次只展示基金自身指标。</p>
        </n-card>

        <n-card title="重仓股（近10日表现）" class="hold-card">
          <n-empty v-if="detail.holdings.rows.length === 0" description="暂无持仓数据" />
          <n-table v-else size="small" :bordered="false">
            <thead>
              <tr>
                <th>#</th>
                <th>股票</th>
                <th>权重</th>
                <th>最新收盘</th>
                <th>近10日涨跌</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="h in detail.holdings.rows" :key="h.rank">
                <td>{{ h.rank }}</td>
                <td>
                  <span v-if="h.stockCode" class="stock-cell">
                    <span class="stock-name">{{ h.stockName ?? '--' }}</span>
                    <span class="stock-code">{{ h.stockCode }}</span>
                  </span>
                  <span v-else>{{ h.stockName ?? '--' }}</span>
                </td>
                <td>{{ h.weight === null ? '--' : h.weight.toFixed(2) + '%' }}</td>
                <td>{{ h.lastClose === null ? '--' : h.lastClose.toFixed(2) }}</td>
                <td :class="pctClass(h.lastPct)">{{ fmtPct(h.lastPct) }}</td>
              </tr>
            </tbody>
          </n-table>
        </n-card>

        <n-card title="AI 建议（ds_advice）" class="advice-card">
          <template #header-extra>
            <n-button size="small" type="primary" :loading="analyzing" @click="runAdvice">
              {{ analyzing ? '分析中…' : '立即分析' }}
            </n-button>
          </template>
          <n-empty v-if="detail.advice.length === 0" description="暂无建议记录，点击右上角「立即分析」生成" />
          <div v-else class="advice-list">
            <n-alert v-for="a in detail.advice" :key="a.id" :type="actionTag(a.action).type" class="advice-item">
              <div class="advice-head">
                <n-tag size="small" :type="actionTag(a.action).type" :bordered="false">
                  {{ actionTag(a.action).text }}
                </n-tag>
                <span class="advice-date">{{ fmtDateTime(a.createdAt) }}</span>
                <span class="advice-trade-date">交易日 {{ a.tradeDate }}</span>
                <span v-if="a.confidence !== null" class="advice-conf">置信度 {{ a.confidence }}%</span>
                <span v-if="a.suggestedPct !== null" class="advice-position">
                  建议仓位 {{ a.suggestedPct }}%
                  <template v-if="detail.currentWeightPct !== null">（当前 {{ detail.currentWeightPct }}%）</template>
                </span>
              </div>
              <div class="advice-reason">{{ a.reason ?? '（无理由）' }}</div>
              <!-- 事后实际走势：入场日 = 建议后首个交易日 -->
              <div v-if="revOf(a.id)?.entryDate" class="advice-actual">
                <span class="actual-label">建议后（{{ revOf(a.id)?.entryDate }} 起）</span>
                <span v-for="(h, i) in reviewHorizons" :key="h" class="actual-cell">
                  {{ h }}日
                  <span :class="pctClass(revOf(a.id)?.returns[i] ?? null)">{{ fmtRet(revOf(a.id)?.returns[i]) }}</span>
                  <span
                    v-if="revOf(a.id)?.hits[i] !== null && revOf(a.id)?.hits[i] !== undefined"
                    :class="revOf(a.id)?.hits[i] ? 'hit' : 'miss'"
                  >
                    {{ revOf(a.id)?.hits[i] ? '✓' : '✗' }}
                  </span>
                </span>
              </div>
              <div v-else class="advice-actual muted">建议后走势数据不足（净值未更新或建议过新）</div>
            </n-alert>
          </div>
        </n-card>

        <n-card title="AI 建议复盘" class="review-card">
          <template #header-extra>
            <span class="review-note">对照实际净值检验建议方向</span>
          </template>
          <n-empty v-if="!hasReviewSamples" description="暂无可复盘样本：建议需满 5/10/20 个交易日才能评估后续走势" />
          <template v-else>
            <n-table size="small" :bordered="false">
              <thead>
                <tr>
                  <th>周期</th>
                  <th>已评估</th>
                  <th>样本（加/减）</th>
                  <th>命中率</th>
                  <th>加仓命中</th>
                  <th>减仓命中</th>
                  <th>加仓后均涨</th>
                  <th>减仓后均涨</th>
                  <th>持有后均涨</th>
                  <th>高置信命中率</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="s in reviewStats" :key="s.horizon">
                  <td>{{ s.horizon }} 交易日</td>
                  <td>{{ s.evaluated }}</td>
                  <td>{{ s.matured }}</td>
                  <td>{{ rate(s.hits, s.matured) }}</td>
                  <td>{{ rate(s.addHit, s.addTotal) }}</td>
                  <td>{{ rate(s.reduceHit, s.reduceTotal) }}</td>
                  <td :class="pctClass(s.avgRetAdd)">{{ fmtRet(s.avgRetAdd) }}</td>
                  <td :class="pctClass(s.avgRetReduce)">{{ fmtRet(s.avgRetReduce) }}</td>
                  <td :class="pctClass(s.avgRetHold)">{{ fmtRet(s.avgRetHold) }}</td>
                  <td>{{ rate(s.highConfHit, s.highConfTotal) }}</td>
                </tr>
              </tbody>
            </n-table>
            <n-alert v-if="insufficientHorizons.length > 0" type="info" :bordered="false" class="review-warn">
              {{ insufficientHorizons.map((s) => s.horizon + ' 日').join('、') }}周期样本不足
              {{ minSampleForRate }} 条，命中率只给到"命中数/总数"、不折算百分比——样本太少时百分比会随噪声剧烈跳动，还不足以下结论。
            </n-alert>
            <p class="review-hint">
              入场日取建议交易日之后第一个交易日（收盘后出建议，当日净值尚未公布，避免前视偏差）。
              命中率只统计有方向的加仓/减仓建议；hold 无方向不进命中率，其后续收益单列「持有后均涨」。
              「高置信」指置信度 ≥ 70 的建议。若加仓后均涨为负、或减仓后均涨为正，说明该方向上判断有偏差。
            </p>
          </template>
        </n-card>
      </template>

      <n-empty v-else-if="!loading" description="基金不存在或未添加" />
    </n-spin>
  </div>
</template>

<style scoped>
.fund-detail {
  max-width: 1000px;
  margin: 0 auto;
}

.head-card {
  margin-top: 12px;
}

.head-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 18px;
  font-weight: 700;
}

.strong {
  font-weight: 700;
}

.range-bar {
  display: flex;
  gap: 8px;
  margin-top: 16px;
}

.chart-card,
.hold-card,
.advice-card,
.review-card,
.metric-card {
  margin-top: 16px;
}

/* ---------- 量化指标卡 ---------- */

.metric-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 12px 16px;
}

.metric-label {
  font-size: 12px;
  color: var(--text-color-3);
}

.metric-value {
  margin-top: 2px;
  font-size: 16px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.metric-extra {
  margin-left: 4px;
  font-size: 11px;
  font-weight: 400;
  color: var(--text-color-3);
}

.metric-note {
  font-size: 12px;
  color: var(--text-color-3);
}

.excess-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}

.excess-detail {
  font-size: 11px;
  opacity: 0.85;
}

.chart {
  height: 320px;
  width: 100%;
}

.chart-empty {
  color: var(--text-color-3);
  text-align: center;
  padding: 20px;
}

.stock-cell {
  display: flex;
  flex-direction: column;
}

.stock-name {
  font-weight: 500;
}

.stock-code {
  font-size: 11px;
  color: var(--text-color-3);
}

.advice-item {
  margin-bottom: 12px;
}

.advice-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
}

.advice-date,
.advice-trade-date,
.advice-conf {
  font-size: 12px;
  color: var(--text-color-3);
}

.advice-position {
  font-size: 12px;
  font-weight: 600;
  color: var(--primary-color, #3b82f6);
}

.advice-reason {
  font-size: 13px;
  line-height: 1.6;
}

/* 建议后的实际走势（复盘内联） */
.advice-actual {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-top: 6px;
  font-size: 12px;
}

.actual-label {
  color: var(--text-color-3);
}

.actual-cell {
  color: var(--text-color-3);
}

.hit {
  color: #1f9d55;
  font-weight: 700;
}

.miss {
  color: #e5484d;
  font-weight: 700;
}

.review-note {
  font-size: 12px;
  color: var(--text-color-3);
}

.review-warn {
  margin-bottom: 10px;
  font-size: 12px;
  line-height: 1.7;
}

.review-hint {
  margin: 10px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-color-3);
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
</style>
