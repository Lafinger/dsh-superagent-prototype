import { describe, expect, it } from 'vitest'
import { buildRows, hours, linkPull, parseTaskMeta, renderMarkdown,
  type PlanIssue, type PullRequest, type TaskIssue, type TimesheetRow } from '../src/sources/timesheet.ts'

const one = (input: Parameters<typeof buildRows>[0]): TimesheetRow => buildRows(input)[0]!

const base = 'https://github.com/lafinger-agent/dsh-metahuman-demo'

const plan = (overrides: Partial<PlanIssue> = {}): PlanIssue => ({
  number: 1,
  title: '计划：数字人语音交互演示程序 POC',
  body: '## 背景\n\n展厅演示用的 3D 数字人。',
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
  body: '## 关联\n\nCloses #2',
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
  it('fills B1–B4, the three spans, links and bodies', () => {
    const row = one({ plan: plan(), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart, base })
    expect(row.b1).toBe(threadStart)
    expect(row.b2).toBe('2026-11-16T10:04:03Z')
    expect(row.b3).toBe('2026-11-17T02:45:37Z')
    expect(row.b4).toBe('2026-11-18T09:26:10Z')
    expect(row.missing).toEqual([])
    expect(row.planning).toBeCloseTo(0.21, 2)
    expect(row.response).toBeCloseTo(16.69, 1)
    expect(row.closing).toBeCloseTo(30.68, 1)
    expect(row.total).toBeCloseTo(47.58, 1)
    expect(row.plan_url).toBe(`${base}/issues/1`)
    expect(row.plan_content).toContain('展厅演示')
    expect(row.task_url).toBe(`${base}/issues/2`)
    expect(row.task_content).toContain('归属计划：#1')
    expect(row.pull_url).toBe(`${base}/pull/4`)
    expect(row.pull_content).toContain('Closes #2')
  })

  it('omits the pull fields entirely when the task has no result PR', () => {
    const row = one({ plan: plan(), tasks: [task({ closedAt: null })], pulls: [], threadStartedAt: threadStart, base })
    expect(row.pull).toBeUndefined()
    expect(row.pull_url).toBeUndefined()
    expect(row.pull_title).toBeUndefined()
    expect(row.pull_content).toBeUndefined()
    expect(row.missing).toContain('b3')
    expect(row.response).toBeUndefined()
  })

  it('keeps an unfinished plan open with B4 missing', () => {
    const row = one({ plan: plan({ closedAt: null }), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart, base })
    expect(row.missing).toContain('b4')
    expect(row.total).toBeUndefined()
  })

  it('marks B1 missing when the thread start is unknown', () => {
    const row = one({ plan: plan(), tasks: [task()], pulls: [pull()], base })
    expect(row.missing).toContain('b1')
    expect(row.planning).toBeUndefined()
  })
})

describe('renderMarkdown', () => {
  it('carries the idempotency marker and shows 缺失', () => {
    const row = one({ plan: plan(), tasks: [task({ closedAt: null })], pulls: [], threadStartedAt: threadStart, base })
    const markdown = renderMarkdown(plan(), [row])
    expect(markdown).toContain('<!-- dsh-timesheet -->')
    expect(markdown).toContain('缺失')
    expect(markdown).toContain('#2')
    expect(markdown).toContain('B1 话题开始')
  })
})


describe('threadStartByPlan', () => {
  it('maps each plan number to the earliest trigger that links it', async () => {
    const { threadStartByPlan } = await import('../src/app/timesheet-data.ts')
    const triggers: Record<string, { at: string; text: string }> = {
      origin: { at: '2026-11-16T09:51:00Z', text: '【需求】数字人 POC' },
      later: { at: '2026-11-16T18:04:00Z', text: '计划已建：https://github.com/o/r/issues/1' },
      other: { at: '2026-11-17T09:00:00Z', text: '新计划 https://github.com/o/r/issues/2' },
    }
    const tickets = [{ id: 't', origin: { triggerId: 'origin' }, inputs: [{ triggerId: 'later' }, { triggerId: 'other' }] }]
    const plans = [{ number: 1, title: '计划一', body: '', createdAt: '2026-11-16T10:04:03Z' },
      { number: 2, title: '计划二', body: '', createdAt: '2026-11-17T09:30:00Z' },
      { number: 3, title: '计划三', body: '', createdAt: '2026-11-18T09:30:00Z' }]
    const starts = threadStartByPlan(plans, tickets as never, id => triggers[id] as never)
    expect(starts.get(1)).toBe('2026-11-16T09:51:00Z')
    expect(starts.get(2)).toBe('2026-11-16T09:51:00Z')
    // 没有链接的计划留空，不做推断。
    expect(starts.has(3)).toBe(false)
  })
})




describe('asPull', () => {
  it('reads a PR from an issues list entry, with no separate detail request', async () => {
    const { asPull } = await import('../src/app/timesheet-data.ts')
    const pull = asPull({ number: 4, title: 'PR 标题', body: 'Closes #2', created_at: '2026-11-17T02:45:37Z',
      pull_request: { merged_at: '2026-11-17T07:34:07Z' } }, 4)
    expect(pull).toEqual({ number: 4, title: 'PR 标题', body: 'Closes #2',
      createdAt: '2026-11-17T02:45:37Z', mergedAt: '2026-11-17T07:34:07Z' })
  })
  it('keeps mergedAt null while the PR is open', async () => {
    const { asPull } = await import('../src/app/timesheet-data.ts')
    const pull = asPull({ number: 5, title: 'x', body: '', created_at: '2026-11-17T08:26:05Z', pull_request: { merged_at: null } }, 5)
    expect(pull.mergedAt).toBeNull()
  })
})
