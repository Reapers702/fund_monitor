// 长任务进度的渲染进程共享状态
//
// 为什么放在模块级单例而不是各页面自己的 ref：
//   1) 首页按钮与顶栏指示器都要这份数据，各自轮询等于双倍 IPC；
//   2) 切页面时组件销毁，但任务还在主进程跑——单例保证切回来立刻能看到真实进度，
//      而不是像以前那样按钮又变成可点、进度归零。
import { computed, ref } from 'vue'
import type { ComputedRef } from 'vue'

const tasks = ref<TaskProgress[]>([])
let timer: number | null = null

async function poll(): Promise<void> {
  try {
    tasks.value = await window.api.taskStatus()
  } catch {
    // 主进程尚未注册 handler / 正在退出：忽略本次，等下一轮
  }
}

/** 有任务在跑时快轮询（进度要跟手），空闲时慢轮询（几乎零开销） */
function schedule(): void {
  const running = tasks.value.some((t) => t.state === 'running')
  timer = window.setTimeout(() => {
    void poll().then(schedule)
  }, running ? 1200 : 4000)
}

/** 启动共享轮询（App 挂载时调一次即可；重复调用无副作用） */
export function startTaskMonitor(): void {
  if (timer !== null) return
  void poll().then(schedule)
}

export function stopTaskMonitor(): void {
  if (timer !== null) {
    window.clearTimeout(timer)
    timer = null
  }
}

/** 取某类任务的进度（computed，随轮询自动更新） */
export function taskOf(kind: TaskKind): ComputedRef<TaskProgress | null> {
  return computed(() => tasks.value.find((t) => t.kind === kind) ?? null)
}

/** 全部在跑的任务（顶栏指示器用） */
export function runningTasks(): ComputedRef<TaskProgress[]> {
  return computed(() => tasks.value.filter((t) => t.state === 'running'))
}

/** 进度百分比（当前阶段），总数未知时返回 null 交给界面显示不确定态 */
export function taskPercent(t: TaskProgress | null): number | null {
  if (!t || t.total <= 0) return null
  return Math.min(100, Math.round((t.done / t.total) * 100))
}

/** 进程内是否在跑（用于禁用按钮） */
export function isRunning(t: TaskProgress | null): boolean {
  return t?.state === 'running'
}
