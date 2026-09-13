<script setup lang="ts">
import { ref, onMounted, computed, h } from 'vue'
import {
  NCard, NTable, NTag, NButton, NInput, NInputNumber, NSelect, NDatePicker,
  NSpace, NEmpty, NForm, NFormItem, NAlert, useMessage
} from 'naive-ui'

const message = useMessage()
const positions = ref<PositionSummary[]>([])
const tradesByFund = ref<Record<string, TradeRow[]>>({})
const loading = ref(true)
const profile = ref<FundProfile>({ buyFeePct: 0, sellFeePct: 0 })
/** 组合视角（跨基金重仓股重叠/集中度/相关性）；由 main/portfolio/portfolio.ts 计算 */
const portfolio = ref<PortfolioAnalysis | null>(null)
/** 集中度提示阈值（与 main/portfolio/portfolio.ts 的 CONCENTRATION_WARN_PCT 保持一致） */
const CONCENTRATION_WARN_PCT = 10

// 录入表单
const showForm = ref(false)
const formFunds = ref<{ label: string; value: string; name: string; code: string }[]>([])

/** 基金下拉选项渲染：名称（大）+ 代码（小灰副行），避免超长名称被截断 */
function renderFundLabel(option: { label: string; name?: string; code?: string }) {
  const name = option.name ?? option.label
  const code = option.code ?? ''
  return h('div', { class: 'fund-option' }, [
    h('div', { class: 'fund-option-name' }, name),
    code ? h('div', { class: 'fund-option-code' }, code) : null
  ])
}
const form = ref<TradeInput & { rawDate: number | null }>({
  fundCode: '',
  tradeType: 'buy',
  shares: 0,
  price: 0,
  fee: 0,
  tradeDate: new Date().toISOString(),
  rawDate: Date.now(),
  note: ''
})

async function load(): Promise<void> {
  loading.value = true
  try {
    positions.value = await window.api.positionList()
    profile.value = await window.api.positionProfile()
    const funds = await window.api.fundsList()
    formFunds.value = funds
      .filter((f) => f.isActive === 1)
      .map((f) => ({
        label: `${f.name}（${f.code}）`,
        value: f.code,
        // 供 renderLabel 使用
        name: f.name,
        code: f.code
      }))
    // 逐基金加载交易明细（并挂载当前汇总）
    tradesByFund.value = {}
    for (const p of positions.value) {
      const d = await window.api.positionDetail(p.fundCode)
      tradesByFund.value[p.fundCode] = d.trades
    }
    portfolio.value = await window.api.portfolioAnalysis()
  } catch (e) {
    message.error(`加载持仓失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

const totalValue = computed(() => positions.value.reduce((s, p) => s + (p.marketValue ?? 0), 0))
const totalCost = computed(() => positions.value.reduce((s, p) => s + p.totalCost, 0))
const totalPnl = computed(() => totalValue.value - totalCost.value)
const totalPnlPct = computed(() => (totalCost.value > 0 ? ((totalValue.value - totalCost.value) / totalCost.value) * 100 : null))

function fmtMoney(v: number | null): string {
  if (v === null) return '--'
  return v.toFixed(2)
}
function fmtPct(v: number | null): string {
  if (v === null) return '--'
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`
}
function fmtTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', { hour12: false })
}
function pctClass(v: number | null): string {
  if (v === null) return 'muted'
  return v > 0 ? 'up' : v < 0 ? 'down' : 'muted'
}

/** 达到集中度提示阈值的个股（隐性集中度） */
const highStocks = computed(() => (portfolio.value?.topStocks ?? []).filter((s) => s.high))

/** 相关系数配色：≥0.8 同涨同跌严重（分散效果差），≥0.5 偏高 */
function corrClass(v: number): string {
  if (v >= 0.8) return 'risk-high'
  if (v >= 0.5) return 'risk-mid'
  return 'muted'
}

async function submit(): Promise<void> {
  if (!/^\d{6}$/.test(form.value.fundCode)) {
    message.warning('请选择基金')
    return
  }
  if (form.value.shares <= 0 || form.value.price <= 0) {
    message.warning('份额和价格必须大于 0')
    return
  }
  try {
    const payload: TradeInput = {
      fundCode: form.value.fundCode,
      tradeType: form.value.tradeType,
      shares: form.value.shares,
      price: form.value.price,
      fee: form.value.fee ?? 0,
      tradeDate: form.value.rawDate ? new Date(form.value.rawDate).toISOString() : new Date().toISOString(),
      note: form.value.note || null
    }
    await window.api.positionAddTrade(payload)
    message.success('已录入')
    showForm.value = false
    Object.assign(form.value, { fundCode: '', shares: 0, price: 0, fee: 0, note: '' })
    await load()
  } catch (e) {
    message.error(`录入失败: ${(e as Error).message}`)
  }
}

async function removeTrade(id: number): Promise<void> {
  try {
    const ok = await window.api.positionDeleteTrade(id)
    if (ok) message.success('已删除')
    await load()
  } catch (e) {
    message.error(`删除失败: ${(e as Error).message}`)
  }
}

async function saveProfile(): Promise<void> {
  try {
    await window.api.positionProfile({ buyFeePct: profile.value.buyFeePct, sellFeePct: profile.value.sellFeePct })
    message.success('费率已保存')
  } catch (e) {
    message.error(`保存费率失败: ${(e as Error).message}`)
  }
}

onMounted(load)
</script>

<template>
  <div class="position-view">
    <n-card title="持仓汇总" class="card">
      <div class="totals">
        <div class="total-item">
          <div class="total-label">持仓市值</div>
          <div class="total-value">{{ fmtMoney(totalValue) }}</div>
        </div>
        <div class="total-item">
          <div class="total-label">持仓成本</div>
          <div class="total-value">{{ fmtMoney(totalCost) }}</div>
        </div>
        <div class="total-item">
          <div class="total-label">浮动盈亏</div>
          <div class="total-value" :class="pctClass(totalPnl)">{{ fmtMoney(totalPnl) }}</div>
        </div>
        <div class="total-item">
          <div class="total-label">收益率</div>
          <div class="total-value" :class="pctClass(totalPnlPct)">{{ fmtPct(totalPnlPct) }}</div>
        </div>
      </div>

      <n-empty v-if="positions.length === 0" description="还没有持仓记录，点击下方「录入交易」开始" />

      <n-table v-else size="small" :bordered="false">
        <thead>
          <tr>
            <th>基金</th>
            <th>份额</th>
            <th>平均成本</th>
            <th>最新净值</th>
            <th>市值</th>
            <th>浮动盈亏</th>
            <th>收益率</th>
            <th>已实现盈亏</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in positions" :key="p.fundCode">
            <td class="fund-cell">
              <div class="fund-name">{{ p.fundName ?? p.fundCode }}</div>
              <div class="fund-code">{{ p.fundCode }}</div>
            </td>
            <td>{{ p.shares }}</td>
            <td>{{ p.avgCost === null ? '--' : p.avgCost.toFixed(4) }}</td>
            <td>{{ p.latestNav === null ? '--' : p.latestNav.toFixed(4) }}</td>
            <td>{{ fmtMoney(p.marketValue) }}</td>
            <td :class="pctClass(p.floatingPnl)">{{ fmtMoney(p.floatingPnl) }}</td>
            <td :class="pctClass(p.pnlPct)">{{ fmtPct(p.pnlPct) }}</td>
            <td :class="pctClass(p.realizedPnl)">{{ fmtMoney(p.realizedPnl) }}</td>
          </tr>
        </tbody>
      </n-table>
    </n-card>

    <n-card title="组合视角" class="card">
      <template #header-extra>
        <n-space align="center" size="small">
          <n-tag size="tiny" :bordered="false" type="info">
            权重口径：{{ portfolio?.weightBasis === 'position' ? '按持仓市值' : '等权' }}
          </n-tag>
          <n-tag size="tiny" :bordered="false">前十大重仓口径</n-tag>
        </n-space>
      </template>

      <n-empty v-if="!portfolio || portfolio.fundCount === 0" description="暂无自选基金，先在「我的基金」添加" />
      <template v-else>
        <div class="totals">
          <div class="total-item">
            <div class="total-label">自选基金</div>
            <div class="total-value">{{ portfolio.fundCount }}</div>
          </div>
          <div class="total-item">
            <div class="total-label">已知个股暴露</div>
            <div class="total-value">{{ portfolio.totalExposure.toFixed(2) }}%</div>
          </div>
          <div class="total-item">
            <div class="total-label">涉及个股</div>
            <div class="total-value">{{ portfolio.stockCount }}</div>
          </div>
          <div class="total-item">
            <div class="total-label">Top3 集中度（占已知暴露）</div>
            <div class="total-value">{{ portfolio.concentration.top3.toFixed(1) }}%</div>
          </div>
          <div class="total-item">
            <div class="total-label">HHI</div>
            <div class="total-value">{{ portfolio.concentration.hhi.toFixed(3) }}</div>
          </div>
        </div>

        <n-alert v-if="highStocks.length > 0" type="warning" :bordered="false" class="portfolio-alert">
          隐性集中度：{{ highStocks.map((s) => `${s.stockName ?? s.key} ${s.exposure.toFixed(1)}%`).join('、') }}
          ——单只股票在组合内合计暴露已达 {{ CONCENTRATION_WARN_PCT }}% 以上，多只基金很可能买的是同一批股票。
        </n-alert>

        <div class="sub-title">重仓股组合暴露（Top {{ portfolio.topStocks.length }}）</div>
        <p v-if="portfolio.topStocks.length === 0" class="muted-line">暂无重仓股数据（基金季报持仓未采集）</p>
        <n-table v-else size="small" :bordered="false">
          <thead>
            <tr>
              <th>股票</th>
              <th>组合暴露</th>
              <th>基金数</th>
              <th>涉及基金（组合贡献）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in portfolio.topStocks" :key="s.key">
              <td class="fund-cell">
                <div class="fund-name">{{ s.stockName ?? s.key }}</div>
                <div class="fund-code">{{ s.stockCode ?? '--' }}</div>
              </td>
              <td :class="s.high ? 'risk-high' : ''">{{ s.exposure.toFixed(2) }}%</td>
              <td>{{ s.fundCount }}</td>
              <td class="chips">
                <span v-for="f in s.funds" :key="f.code" class="chip">{{ f.name }} {{ f.contribution.toFixed(2) }}%</span>
              </td>
            </tr>
          </tbody>
        </n-table>

        <div class="sub-title">重仓股重叠（{{ portfolio.overlaps.length }} 对）</div>
        <p v-if="portfolio.overlaps.length === 0" class="muted-line">未发现共同重仓股（或持仓数据不足）</p>
        <n-table v-else size="small" :bordered="false">
          <thead>
            <tr>
              <th>基金对</th>
              <th>共同重仓</th>
              <th>重叠度</th>
              <th>共同股票（各自权重）</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in portfolio.overlaps" :key="o.fundA.code + o.fundB.code">
              <td>{{ o.fundA.name }} × {{ o.fundB.name }}</td>
              <td>{{ o.commonCount }} 只</td>
              <td :class="o.overlapPct >= 50 ? 'risk-high' : o.overlapPct >= 25 ? 'risk-mid' : ''">
                {{ o.overlapPct.toFixed(1) }}%
              </td>
              <td class="chips">
                <span v-for="c in o.commonStocks" :key="c.stockCode ?? c.stockName ?? ''" class="chip">
                  {{ c.stockName ?? c.stockCode }}（{{ c.weightA.toFixed(1) }}/{{ c.weightB.toFixed(1) }}%）
                </span>
              </td>
            </tr>
          </tbody>
        </n-table>

        <div class="sub-title">基金相关性（日收益，需 ≥ 20 个共同交易日）</div>
        <p v-if="portfolio.correlations.length === 0" class="muted-line">共同交易日不足，暂无法计算</p>
        <n-table v-else size="small" :bordered="false">
          <thead>
            <tr>
              <th>基金对</th>
              <th>相关系数</th>
              <th>共同交易日</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in portfolio.correlations" :key="c.fundA.code + c.fundB.code">
              <td>{{ c.fundA.name }} × {{ c.fundB.name }}</td>
              <td :class="corrClass(c.corr)">{{ c.corr.toFixed(3) }}</td>
              <td>{{ c.commonDays }}</td>
            </tr>
          </tbody>
        </n-table>

        <p class="portfolio-hint">
          暴露 = Σ（基金组合权重 × 该股在基金内权重），仅统计前十大重仓股，故合计暴露通常低于 100%。
          重叠度 = 共同持股 min 权重和 ÷ 较小基金权重合计，越高说明两只基金持仓越像。相关系数 ≥ 0.8 表示同涨同跌严重、分散效果有限。
        </p>
      </template>
    </n-card>

    <n-card class="card">
      <template #header>
        <n-space align="center">
          <span>交易记录</span>
          <n-button size="small" type="primary" @click="showForm = !showForm">
            {{ showForm ? '收起' : '录入交易' }}
          </n-button>
        </n-space>
      </template>

      <div v-if="showForm" class="trade-form">
        <n-form label-placement="left" label-width="90" :show-feedback="false" class="trade-form-inner">
          <n-form-item label="基金">
            <n-select
              v-model:value="form.fundCode"
              :options="formFunds"
              placeholder="选择要录入的基金"
              filterable
              clearable
              :render-label="renderFundLabel"
              popup-class="fund-select-popup"
              class="f-field f-field-fund"
            />
          </n-form-item>
          <n-form-item label="操作">
            <n-select
              v-model:value="form.tradeType"
              :options="[
                { label: '买入（加仓）', value: 'buy' },
                { label: '卖出（减仓）', value: 'sell' }
              ]"
              class="f-field"
            />
          </n-form-item>
          <n-form-item label="份额">
            <n-input-number v-model:value="form.shares" :min="0" :precision="2" placeholder="如 1000.00" class="f-field" />
          </n-form-item>
          <n-form-item label="成交净值">
            <n-input-number v-model:value="form.price" :min="0" :precision="4" placeholder="如 1.8500" class="f-field" />
          </n-form-item>
          <n-form-item label="手续费">
            <n-input-number v-model:value="form.fee" :min="0" :precision="2" placeholder="如 1.50，可填 0" class="f-field" />
          </n-form-item>
          <n-form-item label="交易时间">
            <n-date-picker v-model:value="form.rawDate" type="datetime" class="f-field" />
          </n-form-item>
          <n-form-item label="备注">
            <n-input v-model:value="form.note" placeholder="可选，如：定投 / 止盈" class="f-field" />
          </n-form-item>
        </n-form>
        <div class="trade-form-foot">
          <n-button type="primary" @click="submit">保存交易</n-button>
          <n-button @click="showForm = false">取消</n-button>
        </div>
        <n-alert type="info" :bordered="false" class="trade-form-tip">
          份额 = 买入/卖出的基金份数；成交净值 = 交易当日的基金单位净值。买入按份额×净值+手续费计入成本，卖出按（净值−平均成本）×份额−手续费计已实现盈亏。
        </n-alert>
      </div>

      <div class="trade-list">
        <div v-if="positions.length === 0" class="no-trade">暂无交易</div>
        <div v-for="p in positions" :key="p.fundCode" class="fund-block">
          <div class="fund-block-head">
            <span class="fund-name">{{ p.fundName ?? p.fundCode }}</span>
            <span class="fund-code">{{ p.fundCode }}</span>
          </div>
          <n-table size="small" :bordered="false">
            <thead>
              <tr>
                <th>时间</th>
                <th>类型</th>
                <th>份额</th>
                <th>价格</th>
                <th>手续费</th>
                <th>备注</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in (tradesByFund[p.fundCode] ?? [])" :key="t.id">
                <td>{{ fmtTime(t.tradeDate) }}</td>
                <td>
                  <n-tag size="tiny" :type="t.tradeType === 'buy' ? 'success' : 'warning'" :bordered="false">
                    {{ t.tradeType === 'buy' ? '买入' : '卖出' }}
                  </n-tag>
                </td>
                <td>{{ t.shares }}</td>
                <td>{{ t.price.toFixed(4) }}</td>
                <td>{{ t.fee.toFixed(2) }}</td>
                <td>{{ t.note ?? '' }}</td>
                <td>
                  <n-button size="tiny" text type="error" @click="removeTrade(t.id)">删除</n-button>
                </td>
              </tr>
            </tbody>
          </n-table>
        </div>
      </div>
    </n-card>

    <n-card title="费率设置" class="card">
      <n-space align="center">
        <span>买入费率 %</span>
        <n-input-number v-model:value="profile.buyFeePct" :min="0" :precision="4" style="width: 120px" />
        <span>卖出费率 %</span>
        <n-input-number v-model:value="profile.sellFeePct" :min="0" :precision="4" style="width: 120px" />
        <n-button @click="saveProfile">保存</n-button>
      </n-space>
    </n-card>
  </div>
</template>

<style scoped>
.card {
  margin-bottom: 16px;
}

.totals {
  display: flex;
  gap: 40px;
  padding: 8px 0 16px;
}

.total-label {
  font-size: 12px;
  color: var(--text-color-3);
}

.total-value {
  font-size: 20px;
  font-weight: 700;
  margin-top: 4px;
  font-variant-numeric: tabular-nums;
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

/* ---------- 组合视角 ---------- */

.risk-high {
  color: #e5484d;
  font-weight: 700;
}

.risk-mid {
  color: #d48806;
}

.portfolio-alert {
  margin: 8px 0 4px;
}

.sub-title {
  margin: 18px 0 8px;
  font-size: 13px;
  font-weight: 600;
}

.muted-line {
  margin: 0;
  font-size: 12px;
  color: var(--text-color-3);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  display: inline-block;
  padding: 1px 6px;
  font-size: 11px;
  border-radius: 3px;
  background: var(--action-color, rgba(128, 128, 128, 0.12));
  color: var(--text-color-2);
}

.portfolio-hint {
  margin: 14px 0 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--text-color-3);
}

.fund-cell .fund-name {
  font-weight: 600;
}

.fund-cell .fund-code {
  font-size: 11px;
  color: var(--text-color-3);
}

.trade-form {
  padding: 12px 0 16px;
}

.trade-form-inner {
  max-width: 640px;
}

.f-field {
  width: 220px;
}

/* 基金下拉触发框加宽，完整显示基金名称 */
.f-field-fund {
  width: 320px;
}

/* 下拉面板宽度（两行布局：名称 + 代码） */
:global(.fund-select-popup) {
  width: 340px !important;
}

.fund-option-name {
  font-size: 13px;
  line-height: 1.4;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fund-option-code {
  font-size: 11px;
  color: var(--text-color-3);
  margin-top: 2px;
}

.trade-form-foot {
  display: flex;
  gap: 12px;
  margin-top: 8px;
  padding-left: 90px;
}

.trade-form-tip {
  margin-top: 12px;
  max-width: 640px;
}

.no-trade {
  color: var(--text-color-3);
  padding: 12px 0;
}

.fund-block {
  margin-bottom: 12px;
}

.fund-block-head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 6px;
}

.fund-block-head .fund-name {
  font-weight: 600;
}

.fund-block-head .fund-code {
  font-size: 11px;
  color: var(--text-color-3);
}
</style>
