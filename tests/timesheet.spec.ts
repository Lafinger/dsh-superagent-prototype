import { describe, expect, it } from 'vitest'
import { buildTasks, declaresPlan, hours, linkPull, parseTaskMeta, renderMarkdown,
  type PlanIssue, type PullRequest, type RoleTimesheet, type TaskIssue } from '../src/sources/timesheet.ts'

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
const build = (input: Partial<Parameters<typeof buildTasks>[0]> = {}) => buildTasks({
  plan: plan(), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart, base, ...input,
})[0]!

describe('hours', () => {
  it('subtracts two timestamps', () => expect(hours('2026-11-16T10:00:00Z', '2026-11-16T12:30:00Z')).toBe(2.5))
  it('is undefined when a side is missing or negative', () => {
    expect(hours(undefined, '2026-11-16T12:00:00Z')).toBeUndefined()
    expect(hours('2026-11-16T12:00:00Z', '2026-11-16T10:00:00Z')).toBeUndefined()
  })
})

describe('declaresPlan', () => {
  it('accepts both 归属计划 and 所属计划 with either colon', () => {
    expect(declaresPlan('归属计划：#3', 3)).toBe(true)
    expect(declaresPlan('所属计划: #3', 3)).toBe(true)
    expect(declaresPlan('归属计划：#4', 3)).toBe(false)
  })
})

describe('parseTaskMeta', () => {
  it('reads plan, role, person and order', () => {
    expect(parseTaskMeta(task().body)).toEqual({ plan: 1, role: '设计岗（产品 + UI）', person: '陈小二', order: 1 })
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

describe('buildTasks', () => {
  it('fills the four timestamps, the durations and the pull link', () => {
    const built = build()
    expect(built.timestamps).toEqual({
      requirement_start: threadStart,
      plan_published: '2026-11-16T10:04:03Z',
      submitted: '2026-11-17T02:45:37Z',
      plan_completed: '2026-11-18T09:26:10Z',
    })
    expect(built.durations.planning).toBeCloseTo(0.21, 2)
    expect(built.durations.response).toBeCloseTo(16.69, 1)
    expect(built.durations.closing).toBeCloseTo(30.68, 1)
    expect(built.durations.total).toBeCloseTo(47.58, 1)
    expect(built.missing).toEqual([])
    expect(built.url).toBe(`${base}/issues/2`)
    expect(built.pull?.url).toBe(`${base}/pull/4`)
    expect(built.pull?.content).toContain('Closes #2')
  })

  it('omits the pull fields and marks submitted missing when there is no result PR', () => {
    const built = build({ pulls: [], tasks: [task({ closedAt: null })] })
    expect(built.pull).toBeUndefined()
    expect(built.missing).toContain('submitted')
    expect(built.durations.response).toBeUndefined()
  })

  it('marks plan_completed missing while the plan is open', () => {
    const built = build({ plan: plan({ closedAt: null }) })
    expect(built.missing).toContain('plan_completed')
    expect(built.durations.total).toBeUndefined()
  })

  it('marks requirement_start missing when the thread start is unknown', () => {
    const built = build({ threadStartedAt: undefined })
    expect(built.missing).toContain('requirement_start')
    expect(built.durations.planning).toBeUndefined()
  })
})

describe('renderMarkdown', () => {
  it('carries the idempotency marker, the role column and 缺失', () => {
    const built = build({ pulls: [], tasks: [task({ closedAt: null })] })
    const roles: RoleTimesheet[] = [{ key: 'design', name: '设计岗（产品 + UI）', person: '陈小二', tasks: [built] }]
    const markdown = renderMarkdown(plan(), roles)
    expect(markdown).toContain('<!-- dsh-timesheet -->')
    expect(markdown).toContain('设计岗（产品 + UI）')
    expect(markdown).toContain('缺失')
    expect(markdown).toContain('#2')
  })
})

describe('parseTeam', () => {
  it('reads the approver and the role keys with their order', async () => {
    const { parseTeam } = await import('../src/app/timesheet-data.ts')
    const yaml = [
      'approver:', '  name: 管理岗', '  feishu_open_id: ou_boss', '  feishu_name: 陈锦鸿', '',
      'roles:', '  - key: design', '    name: 设计岗（产品+UI）', '    order: 1',
      '    feishu_open_id: ou_design', '', '  - key: implement', '    name: 实施岗（全栈）', '    order: 2',
    ].join('\n')
    const team = parseTeam(yaml)
    expect(team.approver).toEqual({ role: '管理岗', person: '陈锦鸿' })
    expect(team.roles).toEqual([
      { key: 'design', name: '设计岗（产品+UI）', order: 1 },
      { key: 'implement', name: '实施岗（全栈）', order: 2 },
    ])
  })
  it('returns no approver when the block is absent', async () => {
    const { parseTeam } = await import('../src/app/timesheet-data.ts')
    expect(parseTeam('roles:\n  - key: design\n    name: 设计岗').approver).toBeUndefined()
  })
})
