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
  estimateIntervalSeconds: 30,
  analyzerMinutes: '35',
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
