<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { NSpin, NEmpty, NTag, NButton, NInput, useMessage } from 'naive-ui'

const message = useMessage()
const news = ref<NewsRow[]>([])
const loading = ref(true)
const keyword = ref('')

// 情绪 → 色标
const sentimentMap: Record<string, { type: 'success' | 'warning' | 'error' | 'default'; text: string }> = {
  POSITIVE: { type: 'success', text: '看多' },
  NEGATIVE: { type: 'error', text: '看空' },
  NEUTRAL: { type: 'warning', text: '中性' }
}

async function load(): Promise<void> {
  loading.value = true
  try {
    news.value = await window.api.newsRecent(50)
  } catch (e) {
    message.error(`加载新闻失败: ${(e as Error).message}`)
  } finally {
    loading.value = false
  }
}

// 过滤后的展示列表（关键字匹配标题/摘要/标签）
const filtered = computed(() => {
  const kw = keyword.value.trim()
  if (!kw) return news.value
  return news.value.filter(
    (n) =>
      (n.title ?? '').includes(kw) ||
      (n.content ?? '').includes(kw) ||
      (n.summary ?? '').includes(kw) ||
      n.llmTags.some((t) => t.includes(kw)) ||
      n.tags.some((t) => t.includes(kw))
  )
})

function fmtTime(t: Date | string | null): string {
  if (!t) return ''
  const d = t instanceof Date ? t : new Date(t)
  return d.toLocaleString('zh-CN', { hour12: false })
}

let timer: number | null = null

onMounted(() => {
  void load()
  // 每 60s 轮询刷新（采集程序 24h 运行，新闻持续增长）
  timer = window.setInterval(() => void load(), 60_000)
})

onBeforeUnmount(() => {
  if (timer) window.clearInterval(timer)
})
</script>

<template>
  <div class="news-view">
    <div class="toolbar">
      <n-input v-model:value="keyword" placeholder="筛选：关键词 / 标签（如 半导体）" clearable class="kw" />
      <n-button @click="load">刷新</n-button>
    </div>

    <n-spin :show="loading">
      <n-empty v-if="filtered.length === 0 && !loading" description="暂无新闻" />
      <div v-else class="list">
        <div v-for="n in filtered" :key="n.id" class="news-item">
          <div class="news-head">
            <span class="time">{{ fmtTime(n.pubTime) }}</span>
            <n-tag v-if="n.sentiment" size="tiny" :type="sentimentMap[n.sentiment]?.type ?? 'default'" :bordered="false">
              {{ sentimentMap[n.sentiment]?.text ?? n.sentiment }}
            </n-tag>
          </div>
          <div class="news-title">{{ n.title || '(无标题)' }}</div>
          <div v-if="n.summary" class="news-summary">{{ n.summary }}</div>
          <div v-if="n.content && n.content !== n.title" class="news-content">{{ n.content }}</div>
          <div v-if="n.llmTags.length > 0 || n.tags.length > 0" class="news-tags">
            <n-tag v-for="t in n.llmTags" :key="'l' + t" size="tiny" type="primary" :bordered="false">{{ t }}</n-tag>
            <n-tag v-for="t in n.tags" :key="'o' + t" size="tiny" type="default" :bordered="false">{{ t }}</n-tag>
          </div>
        </div>
      </div>
    </n-spin>
  </div>
</template>

<style scoped>
.news-view {
  max-width: 860px;
  margin: 0 auto;
}

.toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 20px;
}

.kw {
  width: 300px;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.news-item {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 12px 16px;
  background-color: var(--card-color);
}

.news-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.time {
  font-size: 12px;
  color: var(--text-color-3);
}

.news-title {
  font-weight: 600;
  font-size: 14px;
  line-height: 1.5;
}

.news-summary {
  margin-top: 6px;
  font-size: 13px;
  color: var(--text-color-2);
  line-height: 1.6;
}

.news-content {
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-color-3);
  line-height: 1.5;
}

.news-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}
</style>
