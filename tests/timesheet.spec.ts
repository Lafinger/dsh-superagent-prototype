import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildRows, declaresPlan, hours, linkPull, parseTaskMeta, renderMarkdown,
  type PlanIssue, type PullRequest, type TaskIssue, type TimesheetRow } from '../src/sources/timesheet.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

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
  it('accepts 所属计划 as well as 归属计划', () => {
    expect(parseTaskMeta('所属计划：#6\n\n**角色**：设计岗（产品）· 陈小二'))
      .toEqual({ plan: 6, role: '设计岗（产品）', person: '陈小二' })
  })
})

describe('declaresPlan', () => {
  it('accepts both plan-link wordings the plan templates have used', () => {
    expect(declaresPlan('归属计划：#1', 1)).toBe(true)
    expect(declaresPlan('所属计划：#6', 6)).toBe(true)
  })
  it('does not match another plan, a longer number, or a missing line', () => {
    expect(declaresPlan('所属计划：#6', 1)).toBe(false)
    expect(declaresPlan('所属计划：#66', 6)).toBe(false)
    expect(declaresPlan('无模板正文', 6)).toBe(false)
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
  it('reads a task named after a colon, so a sibling PR is not mistaken for it', () => {
    const design = pull({ number: 9, title: 'design: 交付知识库功能产品说明与 CSV 模板',
      body: '## 关联\n\n- 计划：#6\n- 设计任务：#7',
      createdAt: '2026-11-19T10:21:42Z', mergedAt: '2026-11-20T02:03:01Z' })
    const implement = pull({ number: 10, title: 'feat: 实现数字人 CSV 知识库',
      body: '## 关联\n\n- 计划：#6\n- 实施任务：#8',
      createdAt: '2026-11-19T10:38:59Z', mergedAt: '2026-11-20T02:03:32Z' })
    const seven = task({ number: 7, body: '所属计划：#6', closedAt: '2026-11-20T02:04:02Z' })
    // 关闭时间兜底会选到 #10（差 32 秒）；显式引用必须优先。
    expect(linkPull(seven, [design, implement])?.number).toBe(9)
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
  it('names the deployment project in the title, and stays unchanged without one', () => {
    const row = one({ plan: plan(), tasks: [task()], pulls: [pull()], threadStartedAt: threadStart, base })
    expect(renderMarkdown(plan(), [row], 'Web数字人项目'))
      .toContain('## 工时（交付时长）：Web数字人项目 · 计划：数字人语音交互演示程序 POC')
    expect(renderMarkdown(plan(), [row])).toContain('## 工时（交付时长）：计划：数字人语音交互演示程序 POC')
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

describe('flattenPages', () => {
  it('merges every page into one list, so nothing past the first 100 entries is lost', async () => {
    const { flattenPages } = await import('../src/app/timesheet-data.ts')
    expect(flattenPages([[{ number: 1 }], [{ number: 2 }, { number: 3 }]])).toHaveLength(3)
  })
  it('returns nothing instead of throwing when the response is not a list', async () => {
    const { flattenPages } = await import('../src/app/timesheet-data.ts')
    expect(flattenPages({ message: 'Not Found' })).toEqual([])
  })
})

describe('isNotFound', () => {
  it('recognises the gh 404 in a message or on stderr, and nothing else', async () => {
    const { isNotFound } = await import('../src/app/timesheet-data.ts')
    expect(isNotFound(new Error('Command failed: gh api repos/o/r/issues/99\ngh: Not Found (HTTP 404)\n'))).toBe(true)
    expect(isNotFound(Object.assign(new Error('failed'), { stderr: Buffer.from('gh: Not Found (HTTP 404)') }))).toBe(true)
    expect(isNotFound(new Error('Command failed: gh api …\ngh: Server Error (HTTP 502)\n'))).toBe(false)
  })
})

describe('task body contract', () => {
  it('is stated by the project skill with the two lines the timesheet reads', () => {
    const text = readFileSync(join(ROOT, 'skills/dsh-superagent-project/SKILL.md'), 'utf8')
    expect(text).toContain('归属计划：#<plan number>')
    expect(text).toContain('**角色**：<role> · <person>')
  })
})

describe('parseApprover', () => {
  it('reads the approver block and stops at the next top-level key', async () => {
    const { parseApprover } = await import('../src/app/timesheet-data.ts')
    const yaml = ['approver:', '  name: 管理岗', '  feishu_open_id: ou_x', '  feishu_name: Lafinger', 'roles:', '  - key: design'].join('\n')
    expect(parseApprover(yaml)).toEqual({ role: '管理岗', person: 'Lafinger', openId: 'ou_x' })
  })
  it('returns undefined when team.yml has no approver block', async () => {
    const { parseApprover } = await import('../src/app/timesheet-data.ts')
    expect(parseApprover('roles:\n  - key: design')).toBeUndefined()
  })
})

describe('coordinationOf', () => {
  const plan = { number: 1, title: 'p', body: '', createdAt: '2026-11-16T10:04:03Z', closedAt: '2026-11-18T09:26:10Z' }
  it('reuses b1/b2/b4 and derives the two waits', async () => {
    const { coordinationOf } = await import('../src/app/timesheet-data.ts')
    const rows = [{ b1: '2026-11-16T09:51:13Z' } as TimesheetRow]
    const result = coordinationOf({ plan, rows, events: [], approver: { role: '管理岗', person: 'Lafinger' } })
    expect(result?.requirement_start).toBe('2026-11-16T09:51:13Z')
    expect(result?.plan_published).toBe('2026-11-16T10:04:03Z')
    expect(result?.plan_completed).toBe('2026-11-18T09:26:10Z')
    expect(result?.wait_confirm_hours).toBeCloseTo(0.21, 2)
    expect(result?.wait_close_hours).toBeCloseTo(47.37, 1)
  })
  it('is null when team.yml names no approver', async () => {
    const { coordinationOf } = await import('../src/app/timesheet-data.ts')
    expect(coordinationOf({ plan, rows: [], events: [] })).toBeNull()
  })
})

describe('coordinationEvents', () => {
  it('keeps only the approver messages and classifies them', async () => {
    const { coordinationEvents } = await import('../src/app/timesheet-data.ts')
    const tickets = [{ inputs: [{ triggerId: 'a' }, { triggerId: 'b' }, { triggerId: 'c' }] }] as never
    const triggers: Record<string, unknown> = {
      a: { at: '2026-11-16T10:00:00Z', text: '同意', actor: { id: 'ou_boss' } },
      b: { at: '2026-11-17T10:00:00Z', text: '不接受这个成果，请返工', actor: { id: 'ou_boss' } },
      c: { at: '2026-11-18T10:00:00Z', text: '终止本计划', actor: { id: 'ou_other' } },
    }
    const events = coordinationEvents(tickets, id => triggers[id] as never, { role: '管理岗', person: 'L', openId: 'ou_boss' }, 6)
    expect(events).toEqual([
      { at: '2026-11-16T10:00:00Z', kind: 'confirm', plan: 6 },
      { at: '2026-11-17T10:00:00Z', kind: 'rework', plan: 6 },
    ])
  })
})
