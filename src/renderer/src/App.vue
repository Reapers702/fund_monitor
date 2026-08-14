<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRoute } from 'vue-router'
import { NConfigProvider, NMessageProvider, NLayout, NLayoutHeader, NLayoutContent, NMenu, NTag, zhCN, dateZhCN, darkTheme } from 'naive-ui'

const route = useRoute()
const dark = ref(false)

const activeKey = computed(() => {
  if (route.path.startsWith('/fund')) return 'dashboard'
  if (route.path.startsWith('/position')) return 'position'
  if (route.path.startsWith('/news')) return 'news'
  if (route.path.startsWith('/settings')) return 'settings'
  return 'dashboard'
})

const menuOptions = [
  { label: '我的基金', key: 'dashboard' },
  { label: '我的持仓', key: 'position' },
  { label: '新闻流', key: 'news' },
  { label: '设置', key: 'settings' }
]

function onMenuSelect(key: string): void {
  const path = key === 'dashboard' ? '/' : `/${key}`
  if (route.path !== path) {
    window.location.hash = `#${path}`
  }
}
</script>

<template>
  <n-config-provider :locale="zhCN" :date-locale="dateZhCN" :theme="dark ? darkTheme : null">
    <n-message-provider>
      <n-layout class="app-layout">
        <n-layout-header bordered class="app-header">
          <div class="brand">
            <span class="logo">💰</span>
            <span class="title">基金监控与 AI 推荐系统</span>
            <n-tag size="small" type="info" :bordered="false">v0.1</n-tag>
          </div>
          <n-menu
            class="app-menu"
            mode="horizontal"
            :options="menuOptions"
            :value="activeKey"
            @update:value="onMenuSelect"
          />
        </n-layout-header>

        <n-layout-content class="app-content" :native-scrollbar="false">
          <router-view />
        </n-layout-content>
      </n-layout>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.app-layout {
  height: 100vh;
}

.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 24px;
  height: 52px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
}

.logo {
  font-size: 18px;
}

.title {
  font-size: 15px;
  font-weight: 600;
}

.app-menu {
  width: 280px;
}

.app-content {
  height: calc(100vh - 52px);
  padding: 20px 24px;
  overflow: auto;
}
</style>
