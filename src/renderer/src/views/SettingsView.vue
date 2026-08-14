<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { NCard, NForm, NFormItem, NInput, NInputNumber, NSelect, NButton, NDivider, NSpace, NSpin, NAlert, useMessage } from 'naive-ui'

const message = useMessage()
const loading = ref(true)
const saving = ref(false)
const info = ref<AppInfo | null>(null)

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
  fetchChannel: 'node' as 'node' | 'browser' | 'auto'
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
      fetchChannel: cfg.fetch.channel
    }
    info.value = await window.api.getAppInfo()
  } catch (e) {
    message.error(`读取配置失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
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

.env-info {
  margin-top: 20px;
  font-size: 12px;
  color: var(--text-color-3);
}
</style>
