<script setup lang="ts">
import { ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  NCard, NDescriptions, NDescriptionsItem, NTag, NButton, NSpin, NEmpty,
  NTable, NAlert, useMessage
} from 'naive-ui'
import * as echarts from 'echarts'

const route = useRoute()
const router = useRouter()
const message = useMessage()

const code = route.params.code as string
const detail = ref<FundDetail | null>(null)
const loading = ref(true)
const range = ref<number>(120) // 图表范围（天）

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

function renderChart(): void {
  if (!chartEl.value || !detail.value) return
  if (!chart) {
    chart = echarts.init(chartEl.value)
  }

  const d = detail.value
  const nav = d.nav
  // 净值归一化到 1（起点 100%），便于观察走势
  const base = nav.length > 0 ? nav[0].nav : 1
  const navPct = nav.map((p) => ({
    date: p.date,
    value: +(((p.nav / base) * 100).toFixed(2))
  }))

  chart.setOption({
    backgroundColor: 'transparent',
    tooltip: { trigger: 'axis' },
    legend: { data: ['净值走势', '盘中估值(实时采样)'], top: 0 },
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
      axisLabel: { fontSize: 10, formatter: '{value}%' }
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
      {
        name: '盘中估值(实时采样)',
        type: 'scatter',
        // 估值为当日盘中采样，x 落在最新交易日、y 为相对前收的估算涨跌幅
        data: d.estimate.map((e) => [navPct.length > 0 ? navPct[navPct.length - 1].date : '', e.pct === null ? null : e.pct]),
        symbolSize: 8,
        itemStyle: { color: '#e5484d' }
      }
    ]
  })
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
            <n-descriptions-item label="持仓报告期">{{ detail.holdings.reportDate ?? '--' }}</n-descriptions-item>
            <n-descriptions-item label="盘中估值">
              <span :class="pctClass(detail.estimate[detail.estimate.length - 1]?.pct ?? null)">
                {{ fmtPct(detail.estimate[detail.estimate.length - 1]?.pct ?? null) }}
              </span>
            </n-descriptions-item>
            <n-descriptions-item label="估值来源">
              <n-tag
                size="tiny"
                :type="detail.estimate[detail.estimate.length - 1]?.source === 'tracking_index' ? 'success' : 'info'"
                :bordered="false"
              >
                {{
                  detail.estimate[detail.estimate.length - 1]?.source === 'tracking_index'
                    ? '跟踪指数 T1'
                    : detail.estimate[detail.estimate.length - 1]?.source === 'theme_etf'
                      ? '主题ETF T2'
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

        <n-card title="净值走势（归一化）" class="chart-card">
          <div ref="chartEl" class="chart"></div>
          <p v-if="detail.nav.length === 0" class="chart-empty">暂无净值数据，请先执行 --fund {{ code }} 补数据。</p>
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
                <span class="advice-date">{{ a.tradeDate }}</span>
                <span v-if="a.confidence !== null" class="advice-conf">置信度 {{ a.confidence }}%</span>
              </div>
              <div class="advice-reason">{{ a.reason ?? '（无理由）' }}</div>
            </n-alert>
          </div>
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
.advice-card {
  margin-top: 16px;
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
.advice-conf {
  font-size: 12px;
  color: var(--text-color-3);
}

.advice-reason {
  font-size: 13px;
  line-height: 1.6;
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
