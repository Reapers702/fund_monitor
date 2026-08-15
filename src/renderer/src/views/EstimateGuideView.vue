<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NGrid, NGi, NTable, NTag, NSpin, NAlert, NSpace, useMessage } from 'naive-ui'

const message = useMessage()
const loading = ref(true)
const funds = ref<EstimateGuideFund[]>([])
const diffs = ref<EstimateDiffStat[]>([])

interface MethodInfo {
  tag: string
  source: string
  title: string
  color: 'success' | 'info' | 'warning'
  desc: string
  note: string
  warning?: boolean
}

const methods: MethodInfo[] = [
  {
    tag: 'T1',
    source: 'tracking_index',
    title: '跟踪指数实时',
    color: 'success',
    desc: '基金名称命中跟踪指数关键词（如"沪深300"、"中证500"），直接用该指数实时涨跌幅代表基金盘中涨跌。',
    note: '适用于被动指数基金，基金基本复制指数，误差很小。'
  },
  {
    tag: 'T2',
    source: 'theme_etf',
    title: '主题 ETF 实时',
    color: 'info',
    desc: '基金名称命中行业/主题关键词（如"云计算"、"半导体"），用同主题 ETF 的实时价格估算涨跌幅（原页面估值接口 fundgz 已下线，改用主题 ETF 替代）。',
    note: '适用于行业/主题型基金（含指数增强），持仓与主题 ETF 相近，误差中等。'
  },
  {
    tag: 'T3',
    source: 'holdings_weighted',
    title: '重仓股加权估算',
    color: 'warning',
    warning: true,
    desc: '名称未命中任何规则的基金（主要是主动型基金，无跟踪标的），用最近一期季报披露的前十大重仓股实时涨跌，按持仓权重加权估算。',
    note: '误差较大：季报可能已过 1-3 个月，基金经理可能已调仓。仅作参考，界面标注"基于季报估算"，不构成投资依据。'
  }
]

function sourceTag(source: string | null): { text: string; color: 'success' | 'info' | 'warning' | 'default' } {
  switch (source) {
    case 'tracking_index':
      return { text: 'T1 跟踪指数', color: 'success' }
    case 'theme_etf':
      return { text: 'T2 主题 ETF', color: 'info' }
    case 'holdings_weighted':
      return { text: 'T3 重仓股加权', color: 'warning' }
    default:
      return { text: '暂无估值', color: 'default' }
  }
}

function matchText(f: EstimateGuideFund): string {
  if (f.match) {
    return `${f.match.source === 'tracking_index' ? '跟踪指数' : '主题 ETF'}：${f.match.name}`
  }
  return f.holdingsDate ? '无规则命中 → T3 重仓股加权' : '无规则命中且无持仓数据，暂无估值'
}

function fmtTime(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 带符号的百分比：+0.32 表示估值比实际净值高 0.32 个百分点 */
function fmtSignedPct(v: number | null): string {
  if (v === null) return '—'
  return (v > 0 ? '+' : '') + v.toFixed(2) + '%'
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const [f, d] = await Promise.all([window.api.estimateGuide(), window.api.estimateDiff(20)])
    funds.value = f
    diffs.value = d
  } catch (e) {
    message.error(`加载估值方式失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="guide-view">
    <h2 class="page-title">盘中估值说明</h2>
    <p class="page-sub">基金净值一天只更新一次（收盘后）。盘中估值用实时行情近似推算当日涨跌幅，便于盘中参考；不同基金可用手段不同，精度差异大，请务必了解当前基金用的是哪种方式。</p>

    <n-grid :cols="1" :x-gap="16" :y-gap="16" responsive="screen" item-responsive class="methods">
      <n-gi v-for="m in methods" :key="m.source" span="1 s:1 m:1 l:1">
        <n-card :class="['method-card', { warning: m.warning }]">
          <template #header>
            <n-space align="center" :size="10">
              <n-tag :type="m.color" size="small" :bordered="false">{{ m.tag }}</n-tag>
              <span class="method-title">{{ m.title }}</span>
              <n-tag size="small" :bordered="false" class="source-tag">{{ m.source }}</n-tag>
            </n-space>
          </template>
          <p class="method-desc">{{ m.desc }}</p>
          <n-alert v-if="m.warning" type="warning" :bordered="false">{{ m.note }}</n-alert>
          <p v-else class="method-note">{{ m.note }}</p>
        </n-card>
      </n-gi>
    </n-grid>

    <n-card title="我的基金 · 当前估值方式" class="funds-card">
      <n-spin :show="loading">
        <n-table :bordered="false" size="small" class="funds-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>方式</th>
              <th>匹配标的</th>
              <th>最近季报</th>
              <th>最新估值</th>
              <th>采样时间</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="f in funds" :key="f.code" :class="{ inactive: f.isActive !== 1 }">
              <td class="mono">{{ f.code }}</td>
              <td>
                {{ f.name }}
                <n-tag v-if="f.isActive !== 1" size="tiny" type="default" :bordered="false" class="off-tag">已停用</n-tag>
              </td>
              <td>
                <n-tag :type="sourceTag(f.latestSource).color" size="small" :bordered="false">
                  {{ sourceTag(f.latestSource).text }}
                </n-tag>
              </td>
              <td class="match-cell">{{ matchText(f) }}</td>
              <td class="mono">{{ f.holdingsDate ?? '—' }}</td>
              <td>{{ f.latestPct === null ? '—' : f.latestPct.toFixed(2) + '%' }}</td>
              <td class="mono">{{ fmtTime(f.latestTime) }}</td>
            </tr>
          </tbody>
        </n-table>
        <n-alert type="info" :bordered="false" class="foot-note">
          「方式」列显示该基金最近一次采样的实际来源，与「匹配标的」列对应：有规则命中的走 T1/T2，未命中的主动型基金走 T3（最近季报重仓股加权）。T3 结果误差较大，仅作盘中参考。
        </n-alert>
      </n-spin>
    </n-card>

    <n-card title="估值误差 · 最近 20 日（盘中估值 vs 收盘实际净值）" class="funds-card">
      <n-spin :show="loading">
        <n-table :bordered="false" size="small" class="funds-table">
          <thead>
            <tr>
              <th>代码</th>
              <th>名称</th>
              <th>方式</th>
              <th>样本日数</th>
              <th>平均绝对误差</th>
              <th>平均误差</th>
              <th>最近交易日</th>
              <th>最近差值</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in diffs" :key="d.fundCode + d.source">
              <td class="mono">{{ d.fundCode }}</td>
              <td>{{ d.fundName }}</td>
              <td>
                <n-tag :type="sourceTag(d.source).color" size="small" :bordered="false">
                  {{ sourceTag(d.source).text }}
                </n-tag>
              </td>
              <td>{{ d.samples }}</td>
              <td class="num">{{ d.avgAbsDiff === null ? '—' : d.avgAbsDiff.toFixed(3) + '%' }}</td>
              <td class="num">{{ fmtSignedPct(d.avgDiff) }}</td>
              <td class="mono">{{ d.latestTradeDate ?? '—' }}</td>
              <td class="num">{{ fmtSignedPct(d.latestDiff) }}</td>
            </tr>
          </tbody>
        </n-table>
        <n-alert type="info" :bordered="false" class="foot-note">
          差值 = 当日最后一次盘中估值 − 当日收盘实际净值涨跌（正 = 估值偏高）。样本日数需积累数周才有意义；T3 误差一般明显大于 T1，若平均绝对误差持续过大，说明该基金重仓股与季报偏离较多，估值仅供参考。
        </n-alert>
      </n-spin>
    </n-card>
  </div>
</template>

<style scoped>
.guide-view {
  max-width: 960px;
  margin: 0 auto;
}

.page-title {
  margin: 0 0 4px;
}

.page-sub {
  margin: 0 0 16px;
  color: var(--text-color-3);
  font-size: 13px;
  line-height: 1.6;
}

.method-card.warning {
  border-color: rgba(240, 160, 32, 0.4);
}

.method-title {
  font-weight: 600;
  font-size: 15px;
}

.source-tag {
  color: var(--text-color-3);
  font-family: monospace;
}

.method-desc {
  margin: 0 0 10px;
  line-height: 1.7;
  font-size: 13px;
}

.method-note {
  margin: 0;
  font-size: 12px;
  color: var(--text-color-3);
}

.funds-card {
  margin-top: 16px;
}

.funds-table :deep(th) {
  white-space: nowrap;
}

.mono {
  font-family: monospace;
  font-size: 12px;
}

.num {
  font-family: monospace;
  font-size: 12px;
  text-align: right;
}

.match-cell {
  font-size: 12px;
}

.inactive td {
  opacity: 0.55;
}

.off-tag {
  margin-left: 6px;
}

.foot-note {
  margin-top: 12px;
}
</style>
