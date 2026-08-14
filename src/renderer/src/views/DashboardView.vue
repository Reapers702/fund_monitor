<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { NEmpty, NInput, NButton, NSpace, NCard, NTag, NSwitch, NSpin, useMessage } from 'naive-ui'

const router = useRouter()
const message = useMessage()

const funds = ref<FundCard[]>([])
const loading = ref(true)
const adding = ref(false)
const newCode = ref('')

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

onMounted(load)
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
    </n-space>

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
              <div class="metric-sub">{{ f.latestNavDate ?? '' }}</div>
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
                {{ f.estSource === 'tracking_index' ? 'T1 跟踪指数' : f.estSource === 'theme_etf' ? 'T2 主题ETF' : '无估值' }}
              </div>
            </div>
          </div>
          <div class="card-foot">
            <n-tag v-if="f.isActive !== 1" size="tiny" type="default">已停用</n-tag>
            <n-tag v-else size="tiny" type="success">启用中</n-tag>
            <span v-if="f.holdingsDate" class="holdings-date">持仓 {{ f.holdingsDate }}</span>
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

.code-input {
  width: 260px;
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
