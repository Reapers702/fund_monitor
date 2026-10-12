// 长任务登记与单飞（防重复点击）契约测试。
// 这些行为是"刷新行情/估值""全部 AI 分析"按钮正确性的核心：
// 进度状态必须活在主进程（跨页面不丢），且同名任务同时只能有一个在跑。
import { beforeEach, describe, expect, it } from 'vitest'
import {
  beginTask,
  failTask,
  finishTask,
  isTaskBusy,
  isTaskRunning,
  resetTasks,
  taskPhase,
  taskProgressList,
  taskStep,
  taskTick
} from '../src/main/tasks'

beforeEach(() => resetTasks())

describe('任务登记 tasks.ts', () => {
  it('同名任务只放行一个：第二次 beginTask 抛 TaskBusyError', () => {
    beginTask('quotes', 10, '准备')
    expect(isTaskRunning('quotes')).toBe(true)

    let caught: unknown
    try {
      beginTask('quotes', 10, '准备')
    } catch (e) {
      caught = e
    }
    expect(isTaskBusy(caught)).toBe(true)
    expect((caught as Error).message).toContain('正在进行中')
  })

  it('不同类型的任务互不阻塞', () => {
    beginTask('quotes', 10)
    expect(() => beginTask('analyzeAll', 3)).not.toThrow()
    expect(isTaskRunning('quotes')).toBe(true)
    expect(isTaskRunning('analyzeAll')).toBe(true)
  })

  it('阶段切换重置计数，tick 逐项累加并记录当前标的', () => {
    beginTask('quotes', 2)
    taskPhase('quotes', '日K补拉', 3)
    taskTick('quotes', '600519')
    taskTick('quotes', '000001')

    const t = taskProgressList().find((x) => x.kind === 'quotes')!
    expect(t.phase).toBe('日K补拉')
    expect(t.total).toBe(3)
    expect(t.done).toBe(2)
    expect(t.current).toBe('000001')
  })

  it('未开始的任务忽略 tick/step（调度器采样不该污染手动刷新的进度）', () => {
    taskTick('quotes', '600519')
    taskStep('quotes', '不该出现')
    const t = taskProgressList().find((x) => x.kind === 'quotes')!
    expect(t.state).toBe('idle')
    expect(t.done).toBe(0)
    expect(t.recent).toEqual([])
  })

  it('recent 最新在前且有上限（不会无限增长）', () => {
    beginTask('quotes', 1)
    for (let i = 0; i < 60; i++) taskStep('quotes', `第 ${i} 项`)
    const t = taskProgressList().find((x) => x.kind === 'quotes')!
    expect(t.recent[0]).toBe('第 59 项')
    expect(t.recent.length).toBeLessThanOrEqual(40)
    expect(t.recent).not.toContain('第 0 项')
  })

  it('完成后可再次开始，且保留上次的摘要与完成时间（切页面回来能看到）', () => {
    beginTask('quotes', 1)
    finishTask('quotes', '行情刷新完成：1 只基金')
    let t = taskProgressList().find((x) => x.kind === 'quotes')!
    expect(t.state).toBe('done')
    expect(t.summary).toBe('行情刷新完成：1 只基金')
    expect(t.finishedAt).not.toBeNull()
    expect(isTaskRunning('quotes')).toBe(false)

    expect(() => beginTask('quotes', 2)).not.toThrow()
    t = taskProgressList().find((x) => x.kind === 'quotes')!
    expect(t.state).toBe('running')
    expect(t.summary).toBeNull() // 新一轮开始清掉上次摘要
    expect(t.done).toBe(0)
  })

  it('失败后可以重新开始', () => {
    beginTask('analyzeAll', 2)
    failTask('analyzeAll', 'DeepSeek 超时')
    let t = taskProgressList().find((x) => x.kind === 'analyzeAll')!
    expect(t.state).toBe('error')
    expect(t.error).toBe('DeepSeek 超时')

    expect(() => beginTask('analyzeAll', 2)).not.toThrow()
    t = taskProgressList().find((x) => x.kind === 'analyzeAll')!
    expect(t.state).toBe('running')
    expect(t.error).toBeNull()
  })

  it('未跑过的任务返回 idle 占位（前端可直接渲染，不必判空）', () => {
    const list = taskProgressList()
    expect(list.map((t) => t.kind)).toEqual(['quotes', 'analyzeAll'])
    expect(list.every((t) => t.state === 'idle')).toBe(true)
    expect(list.every((t) => t.label.length > 0)).toBe(true)
  })
})
