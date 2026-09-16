<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NForm, NFormItem, NInput, NInputNumber, NSelect, NButton, NDivider, NSpace, NSpin, NAlert, NSwitch, NTable, NTag, useMessage } from 'naive-ui'

const message = useMessage()
const loading = ref(true)
const saving = ref(false)
const info = ref<AppInfo | null>(null)
const currentUser = ref<CurrentUser | null>(null)
const users = ref<AppUserRow[]>([])
const newUserName = ref('')
const creatingUser = ref(false)

/** 切换用户（多用户 M9：自选/持仓/建议按用户隔离；切换后整页刷新） */
async function switchUser(u: AppUserRow): Promise<void> {
  if (u.id === currentUser.value?.id) return
  try {
    await window.api.userSwitch(u.id)
    window.location.reload()
  } catch (e) {
    message.error(`切换用户失败: ${(e as Error).message}`)
  }
}

async function createNewUser(): Promise<void> {
  const name = newUserName.value.trim()
  if (!name) {
    message.warning('请输入用户名')
    return
  }
  creatingUser.value = true
  try {
    const u = await window.api.userCreate(name)
    message.success(`用户「${u.name}」已创建并切换`)
    newUserName.value = ''
    window.location.reload()
  } catch (e) {
    message.error(`创建用户失败: ${(e as Error).message}`)
  } finally {
    creatingUser.value = false
  }
}

// 表单数据（仅编辑允许改动的部分：pg 只读展示，可改 deepseek/fetcher/analyzer/fetch）
const form = ref({
  pgHost: '',
  pgPort: 5432,
  pgDb: '',
  pgUser: '',
  deepseekApiKey: '',
  deepseekBaseUrl: '',
  deepseekModel: '',
  navCheckMinutes: 10,
  holdingsRefreshDays: 7,
  estimateIntervalSeconds: 300,
  analyzerMinutes: '35',
  alertsEnabled: true,
  navMovePct: 3,
  estimateMovePct: 3,
  estimateOffPct: 2,
  badNews: true,
  takeProfitPct: 20,
  stopLossPct: 10,
  fetchChannel: 'node' as 'node' | 'browser' | 'auto',
  autoLaunch: false
})

async function load(): Promise<void> {
  loading.value = true
  try {
    const cfg = await window.api.configGet()
    form.value = {
      pgHost: cfg.pg.host,
      pgPort: cfg.pg.port,
      pgDb: cfg.pg.db,
      pgUser: cfg.pg.user,
      deepseekApiKey: cfg.deepseek.apiKey,
      deepseekBaseUrl: cfg.deepseek.baseUrl,
      deepseekModel: cfg.deepseek.model,
      navCheckMinutes: cfg.fetcher.navCheckMinutes,
      holdingsRefreshDays: cfg.fetcher.holdingsRefreshDays,
      estimateIntervalSeconds: cfg.fetcher.estimateIntervalSeconds,
      analyzerMinutes: cfg.analyzer.minutes,
      alertsEnabled: cfg.alerts.enabled,
      navMovePct: cfg.alerts.navMovePct,
      estimateMovePct: cfg.alerts.estimateMovePct,
      estimateOffPct: cfg.alerts.estimateOffPct,
      badNews: cfg.alerts.badNews,
      takeProfitPct: cfg.alerts.takeProfitPct,
      stopLossPct: cfg.alerts.stopLossPct,
      fetchChannel: cfg.fetch.channel,
      autoLaunch: false
    }
    info.value = await window.api.getAppInfo()
    form.value.autoLaunch = await window.api.getAutoLaunch()
    const [cur, all] = await Promise.all([window.api.userGetCurrent(), window.api.userList()])
    currentUser.value = cur
    users.value = all
  } catch (e) {
    message.error(`读取配置失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

/** 开机自启开关即时生效（写系统登录项），失败回滚 */
async function onAutoLaunchChange(v: boolean): Promise<void> {
  try {
    form.value.autoLaunch = await window.api.setAutoLaunch(v)
    if (form.value.autoLaunch) message.success('已开启开机自启（启动后最小化到托盘）')
  } catch (e) {
    form.value.autoLaunch = !v
    message.error(`设置开机自启失败: ${(e as Error).message}`)
  }
}

async function save(): Promise<void> {
  saving.value = true
  try {
    await window.api.configSave({
      deepseek: {
        apiKey: form.value.deepseekApiKey,
        baseUrl: form.value.deepseekBaseUrl,
        model: form.value.deepseekModel
      },
      fetcher: {
        navCheckMinutes: form.value.navCheckMinutes,
        holdingsRefreshDays: form.value.holdingsRefreshDays,
        estimateIntervalSeconds: form.value.estimateIntervalSeconds
      },
      analyzer: { minutes: form.value.analyzerMinutes },
      alerts: {
        enabled: form.value.alertsEnabled,
        navMovePct: form.value.navMovePct,
        estimateMovePct: form.value.estimateMovePct,
        estimateOffPct: form.value.estimateOffPct,
        badNews: form.value.badNews,
        takeProfitPct: form.value.takeProfitPct,
        stopLossPct: form.value.stopLossPct
      },
      fetch: { channel: form.value.fetchChannel }
    })
    message.success('配置已保存')
  } catch (e) {
    message.error(`保存失败: ${(e as Error).message}`)
  } finally {
    saving.value = false
  }
}

onMounted(load)

// ---------- 提醒：手动检查 ----------

const checkingAlerts = ref(false)

async function runAlerts(): Promise<void> {
  checkingAlerts.value = true
  try {
    const r = await window.api.alertsRun()
    if (r.notified > 0) {
      message.success(`已推送 ${r.notified} 条提醒（评估 ${r.evaluated} 只，命中 ${r.triggered} 条）`)
    } else {
      message.info(`无新提醒（评估 ${r.evaluated} 只，命中 ${r.triggered} 条；同类提醒当天只推一次）`)
    }
  } catch (e) {
    message.error(`检查提醒失败: ${(e as Error).message}`)
  } finally {
    checkingAlerts.value = false
  }
}
</script>

<template>
  <div class="settings-view">
    <n-spin :show="loading">
      <n-card title="用户（多人共用：自选基金 / 持仓 / AI 建议按用户隔离）" class="card">
        <n-table :bordered="false" size="small">
          <thead>
            <tr>
              <th>用户名</th>
              <th>创建时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="u in users" :key="u.id">
              <td>
                {{ u.name }}
                <n-tag v-if="u.id === currentUser?.id" size="tiny" type="success" :bordered="false">当前</n-tag>
              </td>
              <td class="mono">{{ u.createdAt.slice(0, 10) }}</td>
              <td>
                <n-button v-if="u.id !== currentUser?.id" size="tiny" quaternary type="primary" @click="switchUser(u)">
                  切换
                </n-button>
              </td>
            </tr>
          </tbody>
        </n-table>
        <n-space class="new-user" align="center" :size="8">
          <n-input v-model:value="newUserName" placeholder="新用户名（如 zhangsan）" :maxlength="20" style="width: 200px" @keyup.enter="createNewUser" />
          <n-button size="small" type="primary" :loading="creatingUser" @click="createNewUser">新建用户</n-button>
        </n-space>
        <n-alert type="info" :bordered="false" class="tip">
          基金基本信息、净值/估值/重仓股等数据全局共享（同一基金不会重复抓取）；自选列表、持仓、费率、AI 建议（基于各自持仓）按用户分开。切换用户后页面自动刷新。
        </n-alert>
      </n-card>

      <n-card title="数据库（只读展示，请编辑 config.json 修改）" class="card">
        <n-form label-placement="left" label-width="110" size="small">
          <n-form-item label="主机 / 端口">
            <n-input :value="form.pgHost + ':' + form.pgPort" disabled />
          </n-form-item>
          <n-form-item label="数据库">
            <n-input :value="form.pgDb" disabled />
          </n-form-item>
          <n-form-item label="用户">
            <n-input :value="form.pgUser" disabled />
          </n-form-item>
        </n-form>
        <n-alert type="info" :bordered="false" class="tip">
          新闻数据源 aiFund 通常与 pg 同实例同凭证、仅库名不同（ai_fund），字段留空自动继承 pg。
        </n-alert>
      </n-card>

      <n-card title="DeepSeek" class="card">
        <n-form label-placement="left" label-width="110" size="small">
          <n-form-item label="API Key">
            <n-input v-model:value="form.deepseekApiKey" type="password" show-password-on="click" placeholder="sk-..." />
          </n-form-item>
          <n-form-item label="Base URL">
            <n-input v-model:value="form.deepseekBaseUrl" placeholder="https://api.deepseek.com" />
          </n-form-item>
          <n-form-item label="模型">
            <n-input v-model:value="form.deepseekModel" placeholder="deepseek-chat" />
          </n-form-item>
        </n-form>
      </n-card>

      <n-card title="抓取与调度" class="card">
        <n-form label-placement="left" label-width="160" size="small">
          <n-form-item label="净值检查间隔（分钟）">
            <n-input-number v-model:value="form.navCheckMinutes" :min="1" :max="120" />
          </n-form-item>
          <n-form-item label="持仓刷新周期（天）">
            <n-input-number v-model:value="form.holdingsRefreshDays" :min="1" :max="90" />
          </n-form-item>
          <n-form-item label="盘中估值采样间隔（秒）">
            <n-input-number v-model:value="form.estimateIntervalSeconds" :min="10" :max="600" />
          </n-form-item>
          <n-form-item label="AI 分析时间（分钟）">
            <n-input v-model:value="form.analyzerMinutes" placeholder="如 35（每日 15:35）" />
          </n-form-item>
          <n-form-item label="抓取通道">
            <n-select
              v-model:value="form.fetchChannel"
              :options="[
                { label: 'Node 直连（默认）', value: 'node' },
                { label: '浏览器隐藏窗口', value: 'browser' },
                { label: '自动（失败切换）', value: 'auto' }
              ]"
            />
          </n-form-item>
          <n-form-item label="开机自启">
            <n-space align="center" :size="10">
              <n-switch v-model:value="form.autoLaunch" :disabled="loading" @update:value="onAutoLaunchChange" />
              <span class="opt-hint">开启后随系统启动并最小化到托盘，后台采集持续运行</span>
            </n-space>
          </n-form-item>
        </n-form>
      </n-card>

      <n-card title="桌面提醒" class="card">
        <n-form label-placement="left" label-width="200" size="small">
          <n-form-item label="总开关">
            <n-space align="center" :size="10">
              <n-switch v-model:value="form.alertsEnabled" />
              <span class="opt-hint">关闭后不再推送任何阈值提醒（AI 建议通知不受影响）</span>
            </n-space>
          </n-form-item>
          <n-form-item label="净值异动阈值（%）">
            <n-input-number v-model:value="form.navMovePct" :min="0" :max="20" :precision="1" />
          </n-form-item>
          <n-form-item label="盘中估值异动阈值（%）">
            <n-input-number v-model:value="form.estimateMovePct" :min="0" :max="20" :precision="1" />
          </n-form-item>
          <n-form-item label="估值失真阈值（百分点）">
            <n-input-number v-model:value="form.estimateOffPct" :min="0" :max="20" :precision="1" />
          </n-form-item>
          <n-form-item label="止盈阈值（收益率 %）">
            <n-input-number v-model:value="form.takeProfitPct" :min="0" :max="500" :precision="1" />
          </n-form-item>
          <n-form-item label="止损阈值（收益率 %）">
            <n-input-number v-model:value="form.stopLossPct" :min="0" :max="100" :precision="1" />
          </n-form-item>
          <n-form-item label="重仓股负面新闻">
            <n-space align="center" :size="10">
              <n-switch v-model:value="form.badNews" />
              <span class="opt-hint">重仓股出现负面情绪新闻时提醒</span>
            </n-space>
          </n-form-item>
          <n-form-item label="手动检查">
            <n-space align="center" :size="10">
              <n-button size="small" :loading="checkingAlerts" @click="runAlerts">立即检查提醒</n-button>
              <span class="opt-hint">盘中 + 盘后两轮都跑（与自动调度一致）：估值异动 / 净值异动 / 估值失真 / 止盈止损 / 重仓股负面新闻</span>
            </n-space>
          </n-form-item>
        </n-form>
        <n-alert type="info" :bordered="false" class="tip">
          阈值填 0 表示关闭该项。盘中只检查估值异动（净值/持仓在盘中仍是昨日数据，提前判断会误报）；净值异动、估值失真、止盈止损、负面新闻在盘后净值确认时检查。
          同一只基金的同类提醒每天只推一次，避免盘中采样重复轰炸。止损阈值填 10 表示收益率 ≤ −10% 时提醒。
        </n-alert>
      </n-card>

      <n-divider />

      <n-space>
        <n-button type="primary" :loading="saving" @click="save">保存配置</n-button>
      </n-space>

      <p v-if="info" class="env-info">
        Electron {{ info.electron }} · Chromium {{ info.chrome }} · Node {{ info.node }} · {{ info.platform }}
      </p>
    </n-spin>
  </div>
</template>

<style scoped>
.settings-view {
  max-width: 720px;
  margin: 0 auto;
}

.card {
  margin-bottom: 16px;
}

.tip {
  margin-top: 4px;
}

.new-user {
  margin-top: 12px;
}

.mono {
  font-family: monospace;
  font-size: 12px;
}

.opt-hint {
  font-size: 12px;
  color: var(--text-color-3);
}

.env-info {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-color-3);
}
</style>
