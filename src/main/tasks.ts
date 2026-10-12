// 长任务进度登记（主进程单例）
//
// 解决的问题：渲染进程里的 `refreshing` 这类局部状态在切换页面时随组件销毁，
// 于是"刷新中"的按钮切回来又能点，用户也看不到任务跑到哪了、哪个完成了。
// 真正的任务在主进程跑（IPC handler 里的 runQuotesCore / runAnalyzeAllCore），
// 所以把进度登记在主进程：渲染进程轮询展示即可，切页面、重开页面都不丢状态。
//
// 这里同时承担**单飞（single-flight）**职责：beginTask() 对同名任务只放行一个，
// 重复触发直接抛 TaskBusyError。防重复点击的权威判定在主进程，而不是靠前端禁用按钮
// （前端禁用只防手滑，防不住多窗口/快捷键/重复 IPC）。

export type TaskKind = 'quotes' | 'analyzeAll'
export type TaskState = 'idle' | 'running' | 'done' | 'error'

/** 任务进度快照（IPC 返回给渲染进程，结构须可安全序列化） */
export interface TaskProgress {
  kind: TaskKind
  label: string // 中文名（主进程持有，前端不再各写一份映射）
  state: TaskState
  startedAt: number // 本次运行开始时刻（ms）
  finishedAt: number | null
  phase: string | null // 当前阶段，如"日K补拉"/"估值采样"/"逐基金分析"
  total: number // 当前阶段的条目总数
  done: number // 当前阶段已完成数
  current: string | null // 当前正在处理的标的（代码/名称）
  recent: string[] // 最近完成的条目（最新在前，给"哪个刷新完了"看）
  summary: string | null // 完成时的结果摘要（切页面回来也能看到刷完了什么）
  error: string | null
}

/** 同名任务已在运行时抛出：调用方据此提示"正在进行中"而不是重复执行 */
export class TaskBusyError extends Error {
  constructor(readonly kind: TaskKind) {
    super(`${TASK_LABELS[kind]}正在进行中，请等当前任务完成`)
    this.name = 'TaskBusyError'
  }
}

export function isTaskBusy(e: unknown): e is TaskBusyError {
  return e instanceof TaskBusyError
}

const TASK_LABELS: Record<TaskKind, string> = {
  quotes: '刷新行情/估值',
  analyzeAll: '全部 AI 分析'
}

const KINDS: TaskKind[] = ['quotes', 'analyzeAll']
const MAX_RECENT = 40
const tasks = new Map<TaskKind, TaskProgress>()

function idle(kind: TaskKind): TaskProgress {
  return {
    kind,
    label: TASK_LABELS[kind],
    state: 'idle',
    startedAt: 0,
    finishedAt: null,
    phase: null,
    total: 0,
    done: 0,
    current: null,
    recent: [],
    summary: null,
    error: null
  }
}

/**
 * 开始任务；同名任务已在运行则抛 TaskBusyError（单飞）。
 * 调用方应在**昂贵的取数/调用之前**调用它，让"防重复"尽早生效。
 */
export function beginTask(kind: TaskKind, total: number, phase?: string): TaskProgress {
  const cur = tasks.get(kind)
  if (cur?.state === 'running') throw new TaskBusyError(kind)
  const t: TaskProgress = {
    kind,
    label: TASK_LABELS[kind],
    state: 'running',
    startedAt: Date.now(),
    finishedAt: null,
    phase: phase ?? null,
    total,
    done: 0,
    current: null,
    recent: [],
    summary: null,
    error: null
  }
  tasks.set(kind, t)
  console.log(`[task] ${t.label} 开始（${total} 项${phase ? `，阶段：${phase}` : ''}）`)
  return t
}

/** 切换阶段（重置该阶段的计数） */
export function taskPhase(kind: TaskKind, phase: string, total?: number): void {
  const t = tasks.get(kind)
  if (!t || t.state !== 'running') return
  t.phase = phase
  if (total !== undefined) t.total = total
  t.done = 0
  t.current = null
}

/** 当前阶段完成一项（可选更新"正在处理"的标的） */
export function taskTick(kind: TaskKind, current?: string | null): void {
  const t = tasks.get(kind)
  if (!t || t.state !== 'running') return
  t.done++
  if (current !== undefined) t.current = current
}

/** 记一条"已完成"的明细（最新在前），用于界面展示逐项进度 */
export function taskStep(kind: TaskKind, line: string): void {
  const t = tasks.get(kind)
  if (!t || t.state !== 'running') return
  t.recent.unshift(line)
  if (t.recent.length > MAX_RECENT) t.recent.length = MAX_RECENT
}

/** 标记成功结束 */
export function finishTask(kind: TaskKind, summary: string): void {
  const t = tasks.get(kind)
  if (!t) return
  t.state = 'done'
  t.finishedAt = Date.now()
  t.phase = null
  t.current = null
  t.summary = summary
  t.error = null
  console.log(`[task] ${t.label} 完成：${summary}`)
}

/** 标记失败结束 */
export function failTask(kind: TaskKind, error: string): void {
  const t = tasks.get(kind)
  if (!t) return
  t.state = 'error'
  t.finishedAt = Date.now()
  t.phase = null
  t.current = null
  t.error = error
  console.error(`[task] ${t.label} 失败：${error}`)
}

/** 当前是否在跑（供 IPC 快速判断） */
export function isTaskRunning(kind: TaskKind): boolean {
  return tasks.get(kind)?.state === 'running'
}

/** 全部任务的进度快照（未跑过的返回 idle 占位，前端可直接渲染） */
export function taskProgressList(): TaskProgress[] {
  return KINDS.map((k) => tasks.get(k) ?? idle(k))
}

/** 清空登记（测试/调试用） */
export function resetTasks(): void {
  tasks.clear()
}
