import { describe, expect, it } from 'vitest'
import { buildRows, hours, linkPull, parseTaskMeta, renderCsv, renderMarkdown,
  type PlanIssue, type PullRequest, type TaskIssue } from '../src/sources/timesheet.ts'

const plan = (overrides: Partial<PlanIssue> = {}): PlanIssue => ({
  number: 1,
  title: '计划：数字人语音交互演示程序 POC',
  createdAt: '2026-11-16T10:04:03Z',
  closedAt: '2026-11-18T09:26:10Z',
  ...overrides,
})

const task = (overrides: Partial<TaskIssue> = {}): TaskIssue => ({
  number: 2,
  title: '任务：设计岗 — 产品说明与 UI 设计稿',
  body: '归属计划：#1\n\n**角色**：设计岗（产品 + UI）· 陈小二 · 顺序 1',
  createdAt: '2026-11-16T10:04:13Z',
  closedAt: '2026-11-17T07:34:09Z',
  ...overrides,
})

const pull = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  number: 4,
  title: '设计：产品说明与设计稿',
  body: 'Closes #2',
  createdAt: '2026-11-17T02:45:37Z',
  mergedAt: '2026-11-17T07:34:07Z',
  ...overrides,
})

const threadStart = '2026-11-16T09:51:16Z'

describe('parseTaskMeta', () => {
  it('reads plan, role and person', () => {
    expect(parseTaskMeta(task().body)).toEqual({ plan: 1, role: '设计岗（产品 + UI）', person: '陈小二' })
  })
  it('never invents a person', () => {
    expect(parseTaskMeta('无模板正文')).toEqual({ role: '', person: '' })
  })
})

describe('linkPull', () => {
  it('prefers a pull request that names the task', () => {
    const other = pull({ number: 9, body: 'Closes #3', createdAt: '2026-11-18T00:00:00Z', mergedAt: '2026-11-18T00:00:00Z' })
    expect(linkPull(task(), [other, pull()])?.number).toBe(4)
  })
  it('returns undefined when nothing names the task and it is still open', () => {
    expect(linkPull(task({ closedAt: null }), [pull({ body: 'no reference' })])).toBeUndefined()
  })
})

describe('hours', () => {
  it('subtracts two timestamps', () => expect(hours('2026-11-16T10:00:00Z', '2026-11-16T12:30:00Z')).toBe(2.5))
  it('is undefined when a side is missing or negative', () => {
    expect(hours(undefined, '2026-11-16T12:00:00Z')).toBeUndefined()
    expect(hours('2026-11-16T12:00:00Z', '2026-11-16T10:00:00Z')).toBeUndefined()
  })
})

describe('buildRows', () => {
  it('fills B1–B4 and the three spans', () => {
    const [row] = buildRows({ plan: plan(), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart })
    expect(row!.b1).toBe(threadStart)
    expect(row!.b2).toBe('2026-11-16T10:04:03Z')
    expect(row!.b3).toBe('2026-11-17T02:45:37Z')
    expect(row!.b4).toBe('2026-11-18T09:26:10Z')
    expect(row!.missing).toEqual([])
    expect(row!.planning).toBeCloseTo(0.21, 2)
    expect(row!.response).toBeCloseTo(16.69, 1)
    expect(row!.closing).toBeCloseTo(30.68, 1)
    expect(row!.total).toBeCloseTo(47.58, 1)
  })

  it('marks a missing submission instead of guessing', () => {
    const [row] = buildRows({ plan: plan(), tasks: [task({ closedAt: null })], pulls: [], threadStartedAt: threadStart })
    expect(row!.missing).toContain('b3')
    expect(row!.b3).toBeUndefined()
    expect(row!.response).toBeUndefined()
  })

  it('keeps an unfinished plan open with B4 missing', () => {
    const [row] = buildRows({ plan: plan({ closedAt: null }), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart })
    expect(row!.missing).toContain('b4')
    expect(row!.total).toBeUndefined()
  })

  it('marks B1 missing when the thread start is unknown', () => {
    const [row] = buildRows({ plan: plan(), tasks: [task()], pulls: [pull()] })
    expect(row!.missing).toContain('b1')
    expect(row!.planning).toBeUndefined()
  })
})

describe('render', () => {
  it('carries the idempotency marker and shows 缺失', () => {
    const [row] = buildRows({ plan: plan(), tasks: [task({ closedAt: null })], pulls: [], threadStartedAt: threadStart })
    const markdown = renderMarkdown(plan(), [row!])
    expect(markdown).toContain('<!-- dsh-timesheet -->')
    expect(markdown).toContain('缺失')
    expect(markdown).toContain('#2')
  })
  it('escapes quotes in CSV output', () => {
    const [row] = buildRows({ plan: plan(), tasks: [task({ title: '任务：含"引号"的标题' })], pulls: [pull()], threadStartedAt: threadStart })
    const csv = renderCsv([row!])
    expect(csv.split('\n')[0]).toContain('totalHours')
    expect(csv).toContain('""引号""')
  })
})

